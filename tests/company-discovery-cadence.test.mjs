import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { candidateConfigPatch, candidateSetupInitialize } from "../src/core/db/verbs/candidate.mjs";
import { companyProposalBatchPut } from "../src/core/db/verbs/company-discovery.mjs";
import { buildCompanySeedContext } from "../src/core/discovery/company-context.mjs";
import {
  COMPANY_DISCOVERY_CADENCE_DAYS,
  companyDiscoveryCadenceState,
  companyDiscoveryFingerprint,
} from "../src/core/discovery/company-discovery-cadence.mjs";

const cleanupRoots = [];

function setupRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-company-cadence-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  candidateSetupInitialize({ repoRoot, env: {} });
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "profile",
    patch: {
      candidate: { domain: "applied AI" },
      location: { home: "Denver, CO", remote: true },
    },
  });
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Applied AI", priority: "primary", titles: ["Applied AI Engineer"] }],
      keep_signals: ["customer-facing systems"],
      cut_signals: ["pure research"],
      excluded_companies: ["Excluded Co"],
      company_preferences: {
        confirmed: true,
        industries: ["fintech"],
        examples: ["Focus Co"],
      },
    },
  });
  return repoRoot;
}

function putBatch(repoRoot, overrides = {}) {
  const context = buildCompanySeedContext({ repoRoot, env: {} });
  const batch = {
    batchId: overrides.batchId || "batch-cadence",
    status: "approved",
    createdAt: "2026-08-10T12:00:00.000Z",
    version: 1,
    contextFingerprint: companyDiscoveryFingerprint(context),
    proposals: [],
    rejected: [],
    counts: { seeds: 0, proposals: 0, rejected: 0 },
    ...overrides,
  };
  companyProposalBatchPut({ repoRoot, env: {}, batch });
  return batch;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("company discovery is due before the first post-setup run", () => {
  const repoRoot = setupRepo();
  const state = companyDiscoveryCadenceState({
    repoRoot,
    env: {},
    now: new Date("2026-08-11T12:00:00.000Z"),
  });

  assert.equal(COMPANY_DISCOVERY_CADENCE_DAYS, 7);
  assert.equal(state.due, true);
  assert.equal(state.reason, "never-run");
  assert.equal(state.status, "due");
});

test("a recent completed batch stays current until its weekly due date", () => {
  const repoRoot = setupRepo();
  putBatch(repoRoot);
  const state = companyDiscoveryCadenceState({
    repoRoot,
    env: {},
    now: new Date("2026-08-12T12:00:00.000Z"),
  });

  assert.equal(state.due, false);
  assert.equal(state.status, "current");
  assert.equal(state.reason, "cadence-current");
  assert.equal(state.dueAt, "2026-08-17T12:00:00.000Z");
});

test("pending proposals require review instead of creating a duplicate recurring batch", () => {
  const repoRoot = setupRepo();
  putBatch(repoRoot, {
    status: "pending",
    proposals: [{ proposalId: "proposal-1", company: { name: "Review Co" }, version: 1 }],
    counts: { seeds: 1, proposals: 1, rejected: 0 },
  });
  const state = companyDiscoveryCadenceState({
    repoRoot,
    env: {},
    now: new Date("2026-08-20T12:00:00.000Z"),
  });

  assert.equal(state.due, false);
  assert.equal(state.status, "needs-review");
  assert.equal(state.reason, "pending-review");
  assert.equal(state.pendingCount, 1);
  assert.equal(state.batchId, "batch-cadence");
});

test("company discovery becomes due immediately when targeting context changes", () => {
  const repoRoot = setupRepo();
  putBatch(repoRoot);
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "targeting",
    patch: {
      company_preferences: {
        confirmed: true,
        industries: ["fintech", "healthcare"],
        examples: ["Focus Co"],
      },
    },
  });

  const state = companyDiscoveryCadenceState({
    repoRoot,
    env: {},
    now: new Date("2026-08-12T12:00:00.000Z"),
  });
  assert.equal(state.due, true);
  assert.equal(state.reason, "targeting-changed");
});

test("company discovery becomes due after seven days without targeting changes", () => {
  const repoRoot = setupRepo();
  putBatch(repoRoot);
  const state = companyDiscoveryCadenceState({
    repoRoot,
    env: {},
    now: new Date("2026-08-17T12:00:00.000Z"),
  });

  assert.equal(state.due, true);
  assert.equal(state.reason, "weekly-cadence");
});

test("company discovery fingerprints ignore object key insertion order", () => {
  const first = companyDiscoveryFingerprint({
    companyPreferences: {
      confirmed: true,
      values: { autonomy: "high", pace: "fast" },
    },
    locationPosture: { remote: true, home: "Denver, CO" },
  });
  const second = companyDiscoveryFingerprint({
    locationPosture: { home: "Denver, CO", remote: true },
    companyPreferences: {
      values: { pace: "fast", autonomy: "high" },
      confirmed: true,
    },
  });

  assert.equal(first, second);
});
