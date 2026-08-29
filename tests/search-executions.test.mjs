import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  searchExecutionEnsure,
  searchExecutionGet,
  searchExecutionListRecoverable,
  searchExecutionSetLane,
} from "../src/core/db/verbs/search-executions.mjs";

const roots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-search-execution-"));
  roots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("search execution status is durable, exact, and lane-aware", () => {
  const repoRoot = tempRepo();
  const started = searchExecutionEnsure({
    repoRoot,
    env: {},
    id: "search-one",
    deterministicRunId: "manual-one",
    now: "2026-08-28T12:00:00.000Z",
  });
  assert.equal(started.execution.status, "running");
  assert.equal(started.execution.lanes.deterministic.status, "running");
  assert.equal(started.execution.lanes.aiWeb.status, "queued");

  searchExecutionSetLane({
    repoRoot,
    env: {},
    id: "search-one",
    lane: "deterministic",
    status: "completed",
    runId: "manual-one",
    summary: { presented: 3 },
  });
  searchExecutionSetLane({
    repoRoot,
    env: {},
    id: "search-one",
    lane: "aiWeb",
    status: "failed",
    runId: "ai-later",
    error: { code: "AI_FAILED", message: "AI lane failed." },
  });

  const exact = searchExecutionGet({ repoRoot, env: {}, id: "search-one" }).execution;
  assert.equal(exact.status, "completed");
  assert.equal(exact.partial, true);
  assert.equal(exact.lanes.deterministic.summary.presented, 3);
  assert.equal(exact.lanes.aiWeb.runId, "ai-later");
});

test("ensuring the same execution id is idempotent and recovery only returns unfinished work", () => {
  const repoRoot = tempRepo();
  const first = searchExecutionEnsure({
    repoRoot,
    env: {},
    id: "search-replay",
    deterministicRunId: "manual-replay",
  });
  const replay = searchExecutionEnsure({
    repoRoot,
    env: {},
    id: "search-replay",
    deterministicRunId: "different-child",
  });
  assert.equal(replay.created, false);
  assert.deepEqual(replay.execution, first.execution);
  assert.equal(replay.execution.lanes.deterministic.runId, "manual-replay");

  searchExecutionSetLane({
    repoRoot,
    env: {},
    id: "search-replay",
    lane: "deterministic",
    status: "completed",
    runId: "manual-replay",
  });
  assert.deepEqual(
    searchExecutionListRecoverable({ repoRoot, env: {} }).executions.map((item) => item.id),
    ["search-replay"]
  );
  searchExecutionSetLane({
    repoRoot,
    env: {},
    id: "search-replay",
    lane: "aiWeb",
    status: "skipped",
    reason: "unavailable",
  });
  assert.deepEqual(searchExecutionListRecoverable({ repoRoot, env: {} }).executions, []);
});
