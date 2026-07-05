import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import {
  sourcingRunComplete,
  sourcingRunFail,
  sourcingRunLatest,
  sourcingRunStart,
} from "../src/core/db/verbs/sourcing-runs.mjs";
import { candidateSetupInitialize } from "../src/core/db/verbs.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-sourcing-runs-"));
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
