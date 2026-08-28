import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createWorkspaceAgentRuntime } from "../src/core/agent/workspace-agent.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { sourcingRunStart } from "../src/core/db/verbs/sourcing-runs.mjs";

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
    available: true,
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
  assert.equal(result.searchExecutionId, "search-workspace-explicit");
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
    available: true,
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
    available: true,
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
