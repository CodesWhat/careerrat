import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createWorkspaceAgentRuntime } from "../src/core/agent/workspace-agent.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  searchExecutionEnsure,
  searchExecutionGet,
} from "../src/core/db/verbs/search-executions.mjs";
import { sourcingRunComplete, sourcingRunStart } from "../src/core/db/verbs/sourcing-runs.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-workspace-unified-search-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
});

test("workspace search.run uses one generated execution id and waits for deterministic before AI", async () => {
  const repoRoot = tempRepo();
  const events = [];
  const startInputs = [];
  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    createSearchExecutionIdImpl: () => "search-workspace-explicit",
    startManualSearchImpl: async (input) => {
      startInputs.push(input);
      return {
        ok: true,
        run: {
          id: "manual-workspace-explicit",
          purpose: "manual-search",
          status: "running",
          metadata: { searchExecutionId: input.searchExecutionId },
        },
      };
    },
    runSearchInBackgroundImpl: async ({ runId }) => {
      events.push(`deterministic:${runId}`);
      return {
        id: runId,
        purpose: "manual-search",
        status: "completed",
        summary: { scanned: 3, presented: 1 },
      };
    },
    companyDiscoveryCadenceImpl: () => ({ status: "current", due: false }),
  });
  runtime.registerAiWebSearchStarter({
    isAvailable: () => true,
    start: async ({ searchExecutionId, deterministic }) => {
      events.push(`ai:${searchExecutionId}:${deterministic.status}`);
      return { ok: true, run: { status: "completed" } };
    },
  });

  await runtime.executeIntent({
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: "workspace-main" },
      input: { purpose: "manual-search" },
    },
  });
  const result = await runtime.waitForUnifiedSearch("search-workspace-explicit");

  assert.equal(startInputs[0].searchExecutionId, "search-workspace-explicit");
  assert.deepEqual(events, [
    "deterministic:manual-workspace-explicit",
    "ai:search-workspace-explicit:succeeded",
  ]);
  assert.equal(result.id, "search-workspace-explicit");
  await runtime.shutdownSourcingWorkers();
});

test("automatic first search stays deterministic-only", async () => {
  const repoRoot = tempRepo();
  let aiCalls = 0;
  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    startFirstSearchImpl: async () => ({
      ok: true,
      run: { id: "first-search-cold-start", purpose: "first-search", status: "running" },
    }),
    runSearchInBackgroundImpl: async ({ runId }) => ({
      id: runId,
      purpose: "first-search",
      status: "completed",
      summary: { scanned: 1, presented: 0 },
    }),
  });
  runtime.registerAiWebSearchStarter({
    isAvailable: () => true,
    start: async () => {
      aiCalls += 1;
      return { ok: true };
    },
  });

  await runtime.executeIntent({
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: "workspace-main" },
      input: { purpose: "first-search" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(aiCalls, 0);
  await runtime.shutdownSourcingWorkers();
});

test("restart recovery resumes a pre-AI manual search through the same coordinator", async () => {
  const repoRoot = tempRepo();
  sourcingRunStart({
    repoRoot,
    env: {},
    purpose: "manual-search",
    inputFingerprint: "restart-fixture",
    metadata: { searchExecutionId: "search-recovered" },
  });
  const events = [];
  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    runSearchInBackgroundImpl: async ({ runId }) => {
      events.push(`deterministic:${runId}`);
      return { id: runId, purpose: "manual-search", status: "completed", summary: {} };
    },
  });
  runtime.registerAiWebSearchStarter({
    isAvailable: () => true,
    start: async ({ searchExecutionId }) => {
      events.push(`ai:${searchExecutionId}`);
      return { ok: true, run: { status: "completed" } };
    },
  });

  runtime.recoverOrphanedSourcingRuns();
  await runtime.waitForUnifiedSearch("search-recovered");

  assert.equal(events[0]?.startsWith("deterministic:"), true);
  assert.equal(events[1], "ai:search-recovered");
  await runtime.shutdownSourcingWorkers();
});

test("same-input overlap adopts the original durable execution and starts each lane once", async () => {
  const repoRoot = tempRepo();
  let deterministicCalls = 0;
  let aiCalls = 0;
  let releaseDeterministic;
  const deterministicGate = new Promise((resolve) => {
    releaseDeterministic = resolve;
  });
  let durableRun = null;
  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    startManualSearchImpl: async ({ searchExecutionId }) => {
      if (durableRun) return { ok: true, reused: true, run: durableRun };
      durableRun = sourcingRunStart({
        repoRoot,
        env: {},
        purpose: "manual-search",
        inputFingerprint: "same-input",
        metadata: { searchExecutionId },
      }).run;
      return { ok: true, reused: false, run: durableRun };
    },
    runSearchInBackgroundImpl: async ({ runId }) => {
      deterministicCalls += 1;
      await deterministicGate;
      return { id: runId, purpose: "manual-search", status: "completed", summary: {} };
    },
    companyDiscoveryCadenceImpl: () => ({ status: "current", due: false }),
  });
  runtime.registerAiWebSearchStarter({
    isAvailable: () => true,
    start: async () => {
      aiCalls += 1;
      return { ok: true, run: { id: "ai-overlap", status: "completed" } };
    },
  });

  const first = await runtime.executeIntent({
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: "workspace-main" },
      input: { purpose: "manual-search", searchExecutionId: "search-original" },
    },
  });
  const second = await runtime.executeIntent({
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: "workspace-main" },
      input: { purpose: "manual-search", searchExecutionId: "search-unused" },
    },
  });
  assert.equal(first.operationResult.searchExecutionId, "search-original");
  assert.equal(second.operationResult.searchExecutionId, "search-original");
  releaseDeterministic();
  await runtime.waitForUnifiedSearch("search-original");
  assert.equal(deterministicCalls, 1);
  assert.equal(aiCalls, 1);
  assert.throws(() => searchExecutionGet({ repoRoot, env: {}, id: "search-unused" }), /not found/);
  await runtime.shutdownSourcingWorkers();
});

test("AI availability resolves at invocation after an in-process runtime install", async () => {
  const repoRoot = tempRepo();
  let installed = false;
  let aiCalls = 0;
  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    startManualSearchImpl: async ({ searchExecutionId }) => ({
      ok: true,
      run: sourcingRunStart({
        repoRoot,
        env: {},
        purpose: "manual-search",
        inputFingerprint: searchExecutionId,
        metadata: { searchExecutionId },
      }).run,
    }),
    runSearchInBackgroundImpl: async ({ runId }) => {
      installed = true;
      return { id: runId, purpose: "manual-search", status: "completed", summary: {} };
    },
    companyDiscoveryCadenceImpl: () => ({ status: "current", due: false }),
  });
  runtime.registerAiWebSearchStarter({
    isAvailable: () => installed,
    start: async () => {
      aiCalls += 1;
      return { ok: true, run: { id: "ai-installed", status: "completed" } };
    },
  });
  await runtime.executeIntent({
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: "workspace-main" },
      input: { purpose: "manual-search", searchExecutionId: "search-installed" },
    },
  });
  await runtime.waitForUnifiedSearch("search-installed");
  assert.equal(aiCalls, 1);
  await runtime.shutdownSourcingWorkers();
});

test("restart recovery advances a completed deterministic execution whose AI lane never started", async () => {
  const repoRoot = tempRepo();
  const manual = sourcingRunStart({
    repoRoot,
    env: {},
    purpose: "manual-search",
    inputFingerprint: "crash-between-lanes",
    metadata: { searchExecutionId: "search-crash-gap" },
  }).run;
  sourcingRunComplete({ repoRoot, env: {}, id: manual.id, summary: { presented: 2 } });
  searchExecutionEnsure({
    repoRoot,
    env: {},
    id: "search-crash-gap",
    deterministicRunId: manual.id,
  });
  let aiCalls = 0;
  const runtime = createWorkspaceAgentRuntime({ repoRoot, env: {} });
  runtime.registerAiWebSearchStarter({
    isAvailable: () => true,
    start: async ({ onStarted }) => {
      aiCalls += 1;
      onStarted?.({ id: "ai-recovered", status: "running" });
      return { ok: true, run: { id: "ai-recovered", status: "completed" } };
    },
  });

  runtime.recoverOrphanedSourcingRuns();
  const execution = await runtime.waitForUnifiedSearch("search-crash-gap");
  assert.equal(aiCalls, 1);
  assert.equal(execution.status, "completed");
  assert.equal(execution.lanes.aiWeb.runId, "ai-recovered");
  await runtime.shutdownSourcingWorkers();
});

test("settled coordination is pruned and replaying its id does not run again", async () => {
  const repoRoot = tempRepo();
  let starts = 0;
  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    startManualSearchImpl: async ({ searchExecutionId }) => {
      starts += 1;
      return {
        ok: true,
        run: sourcingRunStart({
          repoRoot,
          env: {},
          purpose: "manual-search",
          inputFingerprint: searchExecutionId,
          metadata: { searchExecutionId },
        }).run,
      };
    },
    runSearchInBackgroundImpl: async ({ runId }) => ({
      id: runId,
      purpose: "manual-search",
      status: "completed",
      summary: {},
    }),
    companyDiscoveryCadenceImpl: () => ({ status: "current", due: false }),
  });
  runtime.registerAiWebSearchStarter({
    isAvailable: () => false,
    start: async () => assert.fail("unavailable AI must not start"),
  });
  const intent = {
    type: "search.run",
    entity: { type: "workspace", id: "workspace-main" },
    input: { purpose: "manual-search", searchExecutionId: "search-idempotent" },
  };
  await runtime.executeIntent({ intent });
  const settled = await runtime.waitForUnifiedSearch("search-idempotent");
  const replay = await runtime.executeIntent({ intent });
  assert.equal(starts, 1);
  assert.equal(replay.operationResult.reused, true);
  assert.deepEqual(replay.operationResult.execution, settled);
  await runtime.shutdownSourcingWorkers();
});
