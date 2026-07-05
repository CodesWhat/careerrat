// tests/db-scan-context.test.mjs
// Focused coverage for the DB scanner context helper. This intentionally stays
// below scripts/scan-sourced.mjs and src/cli/search-route.mjs so the helper
// contract is proven without route or scanner orchestration side effects.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { buildDbSeenSets, readDbScannerRows } from "../src/core/db/scan-context.mjs";
import { appUpsert, sourcedUpsertBatch } from "../src/core/db/verbs.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-db-scan-context-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "workspace"), { recursive: true });
  return repoRoot;
}

function seedRows(repoRoot) {
  openDb({ repoRoot });
  appUpsert({
    repoRoot,
    row: {
      id: "app-db-context",
      company: "Acme",
      role: "Director of IT",
      status: "applied",
      channel: "board",
      link: "https://job-boards.greenhouse.io/acme/jobs/123456",
      fitScore: 87,
      fitBucket: "high",
      appliedAt: "2026-07-01",
      loc: "Remote",
      base: "verify",
      tc: "+equity",
    },
  });
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "sourced-first",
        company: "Beta",
        role: "Principal Architect",
        status: "sourced",
        source: "scanner",
        channel: "board",
        link: "https://jobs.lever.co/beta/req-abc",
        loc: "Remote",
        base: "verify",
        fitScore: 82,
        fitBucket: "high",
        fitBasis: "triage",
        gate: "likely-keep",
        sourcedAt: "2026-07-02T00:00:00Z",
        updatedAt: "2026-07-02T00:00:00Z",
        artifacts: {},
      },
      {
        id: "sourced-second",
        company: "Gamma",
        role: "Applied AI Engineer",
        status: "sourced",
        source: "scanner",
        channel: "board",
        link: "https://jobs.lever.co/gamma/req-def",
        loc: "Remote",
        base: "verify",
        fitScore: 78,
        fitBucket: "med",
        fitBasis: "triage",
        gate: "review",
        sourcedAt: "2026-07-03T00:00:00Z",
        updatedAt: "2026-07-03T00:00:00Z",
        artifacts: {},
      },
    ],
  });
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

test("buildDbSeenSets: derives URL, req-id, company-role, and tracker context from DB rows", () => {
  const repoRoot = tempRepo();
  seedRows(repoRoot);

  const { seenUrls, seenReqIds, seenCompanyRoles, tracker } = buildDbSeenSets({
    repoRoot,
    env: {},
  });

  assert.equal(seenUrls.has("https://job-boards.greenhouse.io/acme/jobs/123456"), true);
  assert.equal(seenUrls.has("https://jobs.lever.co/beta/req-abc"), true);
  assert.equal(seenReqIds.has("greenhouse:123456"), true);
  assert.equal(seenReqIds.has("lever:req-abc"), true);
  assert.equal(seenCompanyRoles.has("acme::director of it"), true);
  assert.equal(seenCompanyRoles.has("beta::principal architect"), true);

  assert.equal(Array.isArray(tracker.apps), true);
  assert.equal(tracker.apps.length, 1);
  assert.equal(tracker.apps[0].co, "Acme");
  assert.equal(tracker.apps[0].role, "Director of IT");
  assert.equal(tracker.apps[0].score, 87);
  assert.equal(tracker.apps[0].link, "https://job-boards.greenhouse.io/acme/jobs/123456");
  assert.equal(Array.isArray(tracker.sourced), true);
  assert.equal(tracker.sourced.length, 2);
});

test("readDbScannerRows: returns sourced rows in stable database row order", () => {
  const repoRoot = tempRepo();
  seedRows(repoRoot);

  const rows = readDbScannerRows({ repoRoot, env: {} });

  assert.deepEqual(
    rows.map((row) => row.id),
    ["sourced-first", "sourced-second"]
  );
  assert.deepEqual(
    rows.map((row) => row.link),
    ["https://jobs.lever.co/beta/req-abc", "https://jobs.lever.co/gamma/req-def"]
  );
});

test("DB scanner context helpers propagate NO_DATABASE when SQLite is missing", () => {
  const repoRoot = tempRepo();

  assert.throws(() => buildDbSeenSets({ repoRoot, env: {} }), { code: "NO_DATABASE" });
  assert.throws(() => readDbScannerRows({ repoRoot, env: {} }), { code: "NO_DATABASE" });
});
