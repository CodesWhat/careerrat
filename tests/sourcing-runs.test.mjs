import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  sourcingRunComplete,
  sourcingRunFail,
  sourcingRunGet,
  sourcingRunLatest,
  sourcingRunProgress,
  sourcingRunStart,
} from "../src/core/db/verbs/sourcing-runs.mjs";
import { candidateSetupInitialize } from "../src/core/db/verbs.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-sourcing-runs-"));
  cleanupRoots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sourcingRunLatest returns not_started when no run exists for the purpose", () => {
  const repoRoot = tempRepo();

  const latest = sourcingRunLatest({ repoRoot, purpose: "first-search" });

  assert.deepEqual(latest, {
    ok: true,
    purpose: "first-search",
    status: "not_started",
    run: null,
  });
});

test("AI web-search runs use the same durable run ledger", () => {
  const repoRoot = tempRepo();
  const started = sourcingRunStart({
    repoRoot,
    purpose: "ai-web-search",
    metadata: { promptIds: ["p1"] },
  });

  assert.equal(started.run.purpose, "ai-web-search");
  assert.match(started.run.id, /^ai-web-search-/);
  assert.deepEqual(started.run.metadata.promptIds, ["p1"]);
  assert.equal(sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run.id, started.run.id);
});

test("sourcingRunStart persists running state and complete persists summary JSON", () => {
  const repoRoot = tempRepo();

  const started = sourcingRunStart({
    repoRoot,
    purpose: "first-search",
    trigger: "search_ready",
  });

  assert.equal(started.ok, true);
  assert.equal(started.reused, false);
  assert.equal(started.run.purpose, "first-search");
  assert.equal(started.run.status, "running");
  assert.match(started.run.id, /^first-search-/);
  assert.match(started.run.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(started.run.completed_at, null);

  const completed = sourcingRunComplete({
    repoRoot,
    id: started.run.id,
    summary: {
      scanned: 3,
      new: 2,
      errors: [],
      offers: [{ company: "Acme", title: "AI Engineer", url: "https://jobs.lever.co/acme/1" }],
    },
  });

  assert.equal(completed.run.status, "completed");
  assert.equal(completed.run.summary.scanned, 3);
  assert.equal(completed.run.summary.new, 2);
  assert.equal(completed.run.summary.offers[0].company, "Acme");
  assert.match(completed.run.completed_at, /^\d{4}-\d{2}-\d{2}T/);

  const latest = sourcingRunLatest({ repoRoot, purpose: "first-search" });
  assert.equal(latest.status, "completed");
  assert.deepEqual(latest.run.summary, completed.run.summary);
});

test("sourcingRunProgress merges live found counts into a running run", () => {
  const repoRoot = tempRepo();
  const started = sourcingRunStart({ repoRoot, purpose: "first-search" });

  const first = sourcingRunProgress({
    repoRoot,
    id: started.run.id,
    progress: {
      foundCount: 1,
      offerCount: 1,
      scannedCount: 3,
      completedSources: 1,
      totalSources: 2,
    },
  });
  const second = sourcingRunProgress({
    repoRoot,
    id: started.run.id,
    progress: { foundCount: 2, offerCount: 2, scannedCount: 5, completedSources: 2 },
  });

  assert.equal(first.run.status, "running");
  assert.deepEqual(second.run.progress, {
    foundCount: 2,
    offerCount: 2,
    scannedCount: 5,
    completedSources: 2,
    totalSources: 2,
  });
  assert.ok(Date.parse(first.run.updated_at) > Date.parse(started.run.updated_at));
  assert.ok(Date.parse(second.run.updated_at) > Date.parse(first.run.updated_at));

  const latest = sourcingRunLatest({ repoRoot, purpose: "first-search" });
  assert.deepEqual(latest.run.progress, second.run.progress);
});

test("sourcingRunFail persists actionable error JSON", () => {
  const repoRoot = tempRepo();
  const started = sourcingRunStart({ repoRoot, purpose: "first-search" });

  const failed = sourcingRunFail({
    repoRoot,
    id: started.run.id,
    error: {
      code: "NO_DETERMINISTIC_SOURCES",
      message: "Add an RSS source or supported public ATS company before searching.",
      action: "source_setup",
    },
  });

  assert.equal(failed.run.status, "failed");
  assert.equal(failed.run.error.code, "NO_DETERMINISTIC_SOURCES");
  assert.match(failed.run.error.message, /RSS source|ATS company/);
  assert.equal(failed.run.error.action, "source_setup");

  const latest = sourcingRunLatest({ repoRoot, purpose: "first-search" });
  assert.deepEqual(latest.run.error, failed.run.error);
});

test("sourcingRunFail's error normalization preserves bounded per-offer failure metadata (CR-29 round 7)", () => {
  const repoRoot = tempRepo();
  const started = sourcingRunStart({ repoRoot, purpose: "ai-web-search" });

  const failedOffers = [
    { id: "sourced-acme-example-1", url: "https://jobs.example.test/acme/example-1" },
  ];
  const failed = sourcingRunFail({
    repoRoot,
    id: started.run.id,
    error: {
      code: "AI_WEB_SEARCH_ARTIFACT_WRITE_FAILED",
      message: "Failed to persist 1 job description artifact(s).",
      action: "retry-failed",
      failedIds: ["sourced-acme-example-1"],
      failedOffers,
    },
  });

  assert.deepEqual(failed.run.error.failedIds, ["sourced-acme-example-1"]);
  assert.deepEqual(failed.run.error.failedOffers, failedOffers);

  const latest = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" });
  assert.deepEqual(latest.run.error.failedOffers, failedOffers);
});

test("duplicate first-search starts are idempotent while running and after completion", () => {
  const repoRoot = tempRepo();
  const first = sourcingRunStart({ repoRoot, purpose: "first-search" });

  const runningReuse = sourcingRunStart({ repoRoot, purpose: "first-search" });
  assert.equal(runningReuse.reused, true);
  assert.equal(runningReuse.run.id, first.run.id);
  assert.equal(runningReuse.run.status, "running");

  sourcingRunComplete({
    repoRoot,
    id: first.run.id,
    summary: { scanned: 1, new: 0, errors: [], offers: [] },
  });

  const reused = sourcingRunStart({ repoRoot, purpose: "first-search" });
  assert.equal(reused.reused, true);
  assert.equal(reused.run.id, first.run.id);
  assert.equal(reused.run.status, "completed");

  const manual = sourcingRunStart({ repoRoot, purpose: "manual-search", force: true });
  assert.equal(manual.reused, false);
  assert.equal(manual.run.purpose, "manual-search");
  assert.notEqual(manual.run.id, first.run.id);
});

test("failed first-search starts are displayable until retryFailed creates new retry work", () => {
  const repoRoot = tempRepo();
  const first = sourcingRunStart({ repoRoot, purpose: "first-search" });
  const failed = sourcingRunFail({
    repoRoot,
    id: first.run.id,
    error: {
      code: "NO_DETERMINISTIC_SOURCES",
      message: "Add an RSS source or supported public ATS company before searching.",
      action: "source_setup",
    },
  });

  const display = sourcingRunStart({ repoRoot, purpose: "first-search" });
  assert.equal(display.reused, true);
  assert.equal(display.run.id, failed.run.id);
  assert.equal(display.run.status, "failed");

  const retry = sourcingRunStart({
    repoRoot,
    purpose: "first-search",
    retryFailed: true,
  });
  assert.equal(retry.reused, false);
  assert.equal(retry.run.status, "running");
  assert.notEqual(retry.run.id, failed.run.id);
  assert.equal(retry.run.metadata.retryOf, failed.run.id);

  const latest = sourcingRunLatest({ repoRoot, purpose: "first-search" });
  assert.equal(latest.run.id, retry.run.id);
  assert.equal(latest.run.metadata.retryOf, failed.run.id);
});

test("completed first-search reuse is scoped to the same input fingerprint", () => {
  const repoRoot = tempRepo();
  const first = sourcingRunStart({
    repoRoot,
    purpose: "first-search",
    inputFingerprint: "inputs-v1",
  });
  sourcingRunComplete({
    repoRoot,
    id: first.run.id,
    summary: { scanned: 1, new: 0, errors: [], offers: [] },
  });

  const sameInputs = sourcingRunStart({
    repoRoot,
    purpose: "first-search",
    inputFingerprint: "inputs-v1",
  });
  assert.equal(sameInputs.reused, true);
  assert.equal(sameInputs.run.id, first.run.id);

  const changedInputs = sourcingRunStart({
    repoRoot,
    purpose: "first-search",
    inputFingerprint: "inputs-v2",
  });
  assert.equal(changedInputs.reused, false);
  assert.equal(changedInputs.run.status, "running");
  assert.notEqual(changedInputs.run.id, first.run.id);
  assert.equal(changedInputs.run.metadata.inputFingerprint, "inputs-v2");
});

test("equivalent concurrent starts coalesce while changed inputs supersede the old run", () => {
  const repoRoot = tempRepo();
  const first = sourcingRunStart({
    repoRoot,
    purpose: "first-search",
    inputFingerprint: "inputs-v1",
  });

  const equivalent = sourcingRunStart({
    repoRoot,
    purpose: "first-search",
    inputFingerprint: "inputs-v1",
  });
  assert.equal(equivalent.reused, true);
  assert.equal(equivalent.run.id, first.run.id);

  const changed = sourcingRunStart({
    repoRoot,
    purpose: "first-search",
    inputFingerprint: "inputs-v2",
  });
  assert.equal(changed.reused, false);
  assert.notEqual(changed.run.id, first.run.id);

  const oldRow = JSON.parse(
    openDb({ repoRoot }).prepare("SELECT data FROM sourcing_runs WHERE id = ?").get(first.run.id)
      .data
  );
  assert.equal(oldRow.status, "failed");
  assert.equal(oldRow.error.code, "SOURCING_RUN_SUPERSEDED");
});

test("stale running rows are failed and recovered instead of reused forever", () => {
  const repoRoot = tempRepo();
  const first = sourcingRunStart({
    repoRoot,
    purpose: "first-search",
    inputFingerprint: "inputs-v1",
  });
  const db = openDb({ repoRoot });
  const stale = JSON.parse(
    db.prepare("SELECT data FROM sourcing_runs WHERE id = ?").get(first.run.id).data
  );
  stale.updated_at = "2000-01-01T00:00:00.000Z";
  db.prepare("UPDATE sourcing_runs SET data = ? WHERE id = ?").run(
    JSON.stringify(stale),
    first.run.id
  );

  const recovered = sourcingRunStart({
    repoRoot,
    purpose: "first-search",
    inputFingerprint: "inputs-v1",
  });
  assert.equal(recovered.reused, false);
  assert.notEqual(recovered.run.id, first.run.id);
  assert.equal(recovered.run.metadata.recoveredFrom, first.run.id);

  const failedStale = JSON.parse(
    db.prepare("SELECT data FROM sourcing_runs WHERE id = ?").get(first.run.id).data
  );
  assert.equal(failedStale.status, "failed");
  assert.equal(failedStale.error.code, "SOURCING_RUN_LEASE_EXPIRED");
});

test("durable reads recover expired running rows without refreshing their recency", () => {
  const repoRoot = tempRepo();
  const staleAt = "2000-01-01T00:00:00.000Z";
  const db = openDb({ repoRoot });
  const markStale = (id) => {
    const data = JSON.parse(db.prepare("SELECT data FROM sourcing_runs WHERE id = ?").get(id).data);
    data.updated_at = staleAt;
    db.prepare("UPDATE sourcing_runs SET data = ? WHERE id = ?").run(JSON.stringify(data), id);
  };

  const firstSearch = sourcingRunStart({ repoRoot, purpose: "first-search" });
  markStale(firstSearch.run.id);
  const latest = sourcingRunLatest({ repoRoot, purpose: "first-search" });

  assert.equal(latest.status, "failed");
  assert.equal(latest.run.error.code, "SOURCING_RUN_LEASE_EXPIRED");
  assert.equal(latest.run.updated_at, staleAt);

  const aiWeb = sourcingRunStart({ repoRoot, purpose: "ai-web-search" });
  markStale(aiWeb.run.id);
  const exact = sourcingRunGet({ repoRoot, purpose: "ai-web-search", id: aiWeb.run.id });

  assert.equal(exact.status, "failed");
  assert.equal(exact.run.error.code, "SOURCING_RUN_LEASE_EXPIRED");
  assert.equal(exact.run.updated_at, staleAt);
});
