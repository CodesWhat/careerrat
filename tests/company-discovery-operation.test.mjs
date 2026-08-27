import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { companyProposalBatchLatest } from "../src/core/db/verbs/company-discovery.mjs";
import { candidateSetupInitialize } from "../src/core/db/verbs.mjs";
import {
  COMPANY_DISCOVERY_OPERATION_KIND,
  createCompanyDiscoveryOperationKind,
  parseCompanyDiscoveryOperationRequest,
  startCompanyDiscoveryOperation,
} from "../src/core/discovery/company-operation.mjs";
import { createCompanyProposalBatch } from "../src/core/discovery/company-proposals.mjs";
import { createAppOperationManager } from "../src/core/runtime/app-operation-manager.mjs";

const roots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-company-operation-"));
  roots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

after(() => {
  closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("company operation input caps manual seed text before it becomes durable", () => {
  const parsed = parseCompanyDiscoveryOperationRequest({
    manualSeeds: [
      {
        name: ` Acme ${"x".repeat(500)} `,
        domain_hint: `https://${"a".repeat(900)}.example`,
        why: "w".repeat(2_000),
        role_family_hint: "r".repeat(800),
        source_hint: "s".repeat(800),
      },
    ],
  });

  assert.equal(parsed.manualSeeds[0].name.length, 200);
  assert.equal(parsed.manualSeeds[0].domain_hint.length, 500);
  assert.equal(parsed.manualSeeds[0].why.length, 500);
  assert.equal(parsed.manualSeeds[0].role_family_hint.length, 200);
  assert.equal(parsed.manualSeeds[0].source_hint.length, 200);
});

test("company discovery freezes its provider-neutral plan before deduped work starts", async () => {
  const repoRoot = tempRepo();
  const release = deferred();
  let preference = "balanced";
  const seen = [];
  const kind = createCompanyDiscoveryOperationKind({
    repoRoot,
    buildSeedContext: () => ({
      roleFamilies: [{ name: "Platform", titles: ["Platform Engineer"] }],
      locationPosture: { home: "New York, NY", remote: true },
    }),
    resolveExecutionPlan: () => ({
      operation: "research.web",
      runtimeId: "codex",
      requested: { quality: preference, reasoning: "medium" },
      resolved: { quality: preference, reasoning: "medium", model: preference },
    }),
    async createBatch({ body, executionPlan, signal, reportProgress }) {
      seen.push({ body, executionPlan, signal });
      await reportProgress({ phase: "resolving", completed: 1, total: 2 });
      await release.promise;
      return { data: { batchId: "cpb-frozen", proposals: [], rejected: [], counts: {} } };
    },
  });
  const manager = createAppOperationManager({
    repoRoot,
    ownerId: "company-owner",
    kinds: { [COMPANY_DISCOVERY_OPERATION_KIND]: kind },
  });

  const input = {
    manualSeeds: [{ name: " Acme AI ", domain_hint: "acme.example" }],
    requestedCount: 99,
    discoveryRequest: " Find adjacent companies ",
  };
  const first = await startCompanyDiscoveryOperation({ appOperations: manager, input });
  preference = "best";
  const duplicate = await startCompanyDiscoveryOperation({ appOperations: manager, input });
  assert.equal(duplicate.operation.id, first.operation.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].executionPlan.requested.quality, "balanced");
  assert.equal(seen[0].body.requestedCount, 12);
  assert.match(seen[0].body.contextFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(seen[0].body.context, undefined);
  assert.deepEqual(seen[0].body.manualSeeds, [
    {
      name: "Acme AI",
      domain_hint: "acme.example",
      why: "Manual company seed.",
      role_family_hint: "",
      confidence: "medium",
      source_hint: "manual",
    },
  ]);

  release.resolve();
  const completed = await manager.wait(first.operation.id);
  assert.deepEqual(completed.resultRef, {
    type: "company-proposal-batch",
    id: "cpb-frozen",
  });
  await manager.shutdown();
});

test("an interrupted company operation never commits a partial proposal batch", async () => {
  const repoRoot = tempRepo();
  const secondSeedStarted = deferred();
  const kind = createCompanyDiscoveryOperationKind({
    repoRoot,
    resolveExecutionPlan: () => null,
    createBatch: (options) =>
      createCompanyProposalBatch({
        ...options,
        generateSeeds: async () => ({
          status: 200,
          body: {
            ok: true,
            data: {
              companies: [
                { name: "First", domain_hint: "first.example" },
                { name: "Second", domain_hint: "second.example" },
              ],
            },
            ai: { used: false },
            manual: {},
          },
        }),
        resolveCompanyBoard: async ({ seed, signal }) => {
          if (seed.name === "Second") {
            secondSeedStarted.resolve();
            await new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          return {
            companyName: seed.name,
            companyDomain: seed.domain_hint,
            careersUrl: `https://jobs.lever.co/${seed.name.toLowerCase()}`,
            jobBoardUrl: `https://jobs.lever.co/${seed.name.toLowerCase()}`,
            atsProvider: "lever",
            apiUrl: `https://api.lever.co/v0/postings/${seed.name.toLowerCase()}`,
            confidence: "high",
            provenance: [],
          };
        },
        scanCompaniesImpl: async () => ({ offers: [], errors: [] }),
        offersWithCapturedJobs: ({ offers }) => offers,
      }),
  });
  const manager = createAppOperationManager({
    repoRoot,
    ownerId: "interrupt-owner",
    kinds: { [COMPANY_DISCOVERY_OPERATION_KIND]: kind },
  });
  const started = await startCompanyDiscoveryOperation({
    appOperations: manager,
    input: { manualSeeds: [{ name: "First" }, { name: "Second" }] },
  });

  await secondSeedStarted.promise;
  await manager.shutdown();
  const failed = manager.get({ id: started.operation.id });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "APP_OPERATION_SERVER_STOPPED");
  assert.equal(companyProposalBatchLatest({ repoRoot }).batch, null);
});

test("company operation retry keeps the original request and frozen route", async () => {
  const repoRoot = tempRepo();
  let call = 0;
  const plans = [];
  const kind = createCompanyDiscoveryOperationKind({
    repoRoot,
    resolveExecutionPlan: () => ({ operation: "research.web", runtimeId: "claude" }),
    async createBatch({ executionPlan }) {
      call += 1;
      plans.push(executionPlan);
      if (call === 1) {
        const error = new Error("provider stopped");
        error.code = "COMPANY_DISCOVERY_INTERRUPTED";
        throw error;
      }
      return { data: { batchId: "cpb-retry", proposals: [], rejected: [], counts: {} } };
    },
  });
  const manager = createAppOperationManager({
    repoRoot,
    ownerId: "retry-owner",
    kinds: { [COMPANY_DISCOVERY_OPERATION_KIND]: kind },
  });
  const first = await startCompanyDiscoveryOperation({
    appOperations: manager,
    input: { manualSeeds: [{ name: "Acme", domain_hint: "acme.example" }] },
  });
  assert.equal((await manager.wait(first.operation.id)).status, "failed");
  const retry = await manager.retry({ id: first.operation.id });
  const completed = await manager.wait(retry.operation.id);
  assert.equal(retry.operation.retryOf, first.operation.id);
  assert.equal(retry.operation.attempt, 2);
  assert.deepEqual(plans[1], plans[0]);
  assert.deepEqual(completed.resultRef, { type: "company-proposal-batch", id: "cpb-retry" });
  await manager.shutdown();
});
