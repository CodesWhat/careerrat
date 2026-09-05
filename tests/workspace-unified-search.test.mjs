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
  searchExecutionSetLane,
} from "../src/core/db/verbs/search-executions.mjs";
import {
  sourcingRunComplete,
  sourcingRunFail,
  sourcingRunGet,
  sourcingRunStart,
} from "../src/core/db/verbs/sourcing-runs.mjs";

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

test("graceful shutdown leaves the unified AI lane running for restart recovery", async () => {
  const repoRoot = tempRepo();
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
    runSearchInBackgroundImpl: async ({ runId }) => ({
      id: runId,
      purpose: "manual-search",
      status: "completed",
      summary: { scanned: 1, presented: 1 },
    }),
    companyDiscoveryCadenceImpl: () => ({ status: "current", due: false }),
  });
  runtime.registerAiWebSearchStarter({
    isAvailable: () => true,
    start: async ({ onStarted }) => {
      onStarted?.({ id: "ai-paused", purpose: "ai-web-search", status: "running" });
      return {
        ok: false,
        resumable: true,
        run: { id: "ai-paused", purpose: "ai-web-search", status: "running" },
      };
    },
  });

  await runtime.executeIntent({
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: "workspace-main" },
      input: { purpose: "manual-search", searchExecutionId: "search-paused" },
    },
  });
  const execution = await runtime.waitForUnifiedSearch("search-paused");

  assert.equal(execution.status, "running");
  assert.equal(execution.lanes.deterministic.status, "completed");
  assert.equal(execution.lanes.aiWeb.status, "running");
  assert.equal(execution.lanes.aiWeb.runId, "ai-paused");
  await runtime.shutdownSourcingWorkers();
});

test("restart reattaches the exact running AI child and settles its parent execution", async () => {
  const repoRoot = tempRepo();
  const manual = sourcingRunStart({
    repoRoot,
    env: {},
    purpose: "manual-search",
    inputFingerprint: "restart-running-ai",
    metadata: { searchExecutionId: "search-running-ai" },
  }).run;
  const completedManual = sourcingRunComplete({
    repoRoot,
    env: {},
    id: manual.id,
    summary: { scanned: 2, presented: 1 },
  }).run;
  searchExecutionEnsure({
    repoRoot,
    env: {},
    id: "search-running-ai",
    deterministicRunId: completedManual.id,
  });
  searchExecutionSetLane({
    repoRoot,
    env: {},
    id: "search-running-ai",
    lane: "deterministic",
    status: "completed",
    runId: completedManual.id,
    summary: completedManual.summary,
  });
  const ai = sourcingRunStart({
    repoRoot,
    env: {},
    purpose: "ai-web-search",
    inputFingerprint: "restart-running-ai",
    metadata: { searchExecutionId: "search-running-ai" },
  }).run;
  searchExecutionSetLane({
    repoRoot,
    env: {},
    id: "search-running-ai",
    lane: "aiWeb",
    status: "running",
    runId: ai.id,
  });

  const runtime = createWorkspaceAgentRuntime({ repoRoot, env: {} });
  runtime.registerSourcingWorker({
    purpose: "ai-web-search",
    execute: async ({ run }) => ({
      settlement: { status: "completed", summary: { searched: 3, new: 2 } },
      value: { searched: 3, new: 2, resumedRunId: run.id },
    }),
  });

  runtime.recoverOrphanedSourcingRuns();
  const execution = await runtime.waitForUnifiedSearch("search-running-ai");
  const child = sourcingRunGet({ repoRoot, env: {}, id: ai.id }).run;

  assert.equal(child.id, ai.id);
  assert.equal(child.status, "completed");
  assert.equal(execution.status, "completed");
  assert.equal(execution.lanes.aiWeb.status, "completed");
  assert.equal(execution.lanes.aiWeb.runId, ai.id);
  assert.equal(execution.lanes.aiWeb.summary.new, 2);
  await runtime.shutdownSourcingWorkers();
});

test("restart recovery preserves a failed AI-web child's conflicts and failed offers in the durable parent lane summary (CR-29 round 10)", async () => {
  // Simulates a crash between the AI-web worker settling as failed
  // (sourcingRunFail) and the in-process coordinator persisting its own
  // lane summary onto the durable search execution: the execution's aiWeb
  // lane is still "running" on disk even though the underlying sourcing run
  // already failed. Before this fix, sourcingRunFail always stored
  // `summary: null`, and workerLaneResult dropped a failed outcome's value
  // too, so reconcileOrphanedSourcingRuns's `{ run, value: run.summary }`
  // reconstruction had nothing to compact and the parent lane lost both the
  // conflict and the failed-offer detail permanently.
  const repoRoot = tempRepo();
  const manual = sourcingRunStart({
    repoRoot,
    env: {},
    purpose: "manual-search",
    inputFingerprint: "restart-failed-ai",
    metadata: { searchExecutionId: "search-restart-failed-ai" },
  }).run;
  const completedManual = sourcingRunComplete({
    repoRoot,
    env: {},
    id: manual.id,
    summary: { scanned: 2, presented: 1 },
  }).run;
  searchExecutionEnsure({
    repoRoot,
    env: {},
    id: "search-restart-failed-ai",
    deterministicRunId: completedManual.id,
  });
  searchExecutionSetLane({
    repoRoot,
    env: {},
    id: "search-restart-failed-ai",
    lane: "deterministic",
    status: "completed",
    runId: completedManual.id,
    summary: completedManual.summary,
  });

  const ai = sourcingRunStart({
    repoRoot,
    env: {},
    purpose: "ai-web-search",
    inputFingerprint: "restart-failed-ai",
    metadata: { searchExecutionId: "search-restart-failed-ai" },
  }).run;
  const failedIds = ["sourced-acme-restart-failed"];
  const failedOffers = [
    { id: "sourced-acme-restart-failed", url: "https://jobs.example.test/acme/restart-failed" },
  ];
  const conflictOffers = [
    {
      company: "Acme",
      title: "Bridge Role",
      url: "https://jobs.example.test/acme/restart-bridge",
    },
  ];
  // The worker manager settles the run as failed BEFORE the crash — the
  // durable write sourcingRunFail's `summary` argument now makes, mirroring
  // sourcing-worker-manager.mjs's settleSuccessfulExecution.
  sourcingRunFail({
    repoRoot,
    env: {},
    id: ai.id,
    error: {
      code: "AI_WEB_SEARCH_IDENTITY_CONFLICT",
      message: "Found 1 identity conflict(s) that could not be reconciled.",
      failedIds,
      failedOffers,
      conflicts: 1,
      conflictOffers,
    },
    summary: { failed: 1, failedIds, failedOffers, conflicts: 1, conflictOffers },
  });
  // The crash happens before this write, so the durable execution's aiWeb
  // lane is still "running" on disk even though the child already failed.
  searchExecutionSetLane({
    repoRoot,
    env: {},
    id: "search-restart-failed-ai",
    lane: "aiWeb",
    status: "running",
    runId: ai.id,
  });

  const runtime = createWorkspaceAgentRuntime({ repoRoot, env: {} });
  runtime.recoverOrphanedSourcingRuns();
  const execution = await runtime.waitForUnifiedSearch("search-restart-failed-ai");

  assert.equal(execution.lanes.aiWeb.status, "failed");
  assert.equal(execution.lanes.aiWeb.summary.failed, 1);
  assert.deepEqual(execution.lanes.aiWeb.summary.failedIds, failedIds);
  assert.deepEqual(execution.lanes.aiWeb.summary.failedOffers, failedOffers);
  assert.equal(execution.lanes.aiWeb.summary.conflicts, 1);
  assert.deepEqual(execution.lanes.aiWeb.summary.conflictOffers, conflictOffers);
  await runtime.shutdownSourcingWorkers();
});

test("restart recovery with 40 maximum-length failures and conflicts persists and reloads with counts intact (CR-29 round 14)", async () => {
  // Codex review of PR #304: compactSearchExecutionReceipt count-capped
  // failedOffers/conflictOffers at 50 each and bounded url length, but never
  // bounded `id` length, and duplicated the same bounded sample onto BOTH
  // the lane's `summary` and its raw `error` unmodified. 40 failures plus 40
  // conflicts, each with a maximum-length id/url, doubled their footprint
  // across summary+error and could exceed the search_executions row's hard
  // 65,536-byte DB constraint, throwing SEARCH_EXECUTION_TOO_LARGE and
  // terminalizing the parent lane with a null summary instead of merely a
  // truncated one.
  const repoRoot = tempRepo();
  const manual = sourcingRunStart({
    repoRoot,
    env: {},
    purpose: "manual-search",
    inputFingerprint: "restart-max-shape",
    metadata: { searchExecutionId: "search-restart-max-shape" },
  }).run;
  const completedManual = sourcingRunComplete({
    repoRoot,
    env: {},
    id: manual.id,
    summary: { scanned: 2, presented: 1 },
  }).run;
  searchExecutionEnsure({
    repoRoot,
    env: {},
    id: "search-restart-max-shape",
    deterministicRunId: completedManual.id,
  });
  searchExecutionSetLane({
    repoRoot,
    env: {},
    id: "search-restart-max-shape",
    lane: "deterministic",
    status: "completed",
    runId: completedManual.id,
    summary: completedManual.summary,
  });

  const ai = sourcingRunStart({
    repoRoot,
    env: {},
    purpose: "ai-web-search",
    inputFingerprint: "restart-max-shape",
    metadata: { searchExecutionId: "search-restart-max-shape" },
  }).run;
  const maxId = "sourced-max-length-id-".padEnd(300, "x");
  const maxUrl = `https://jobs.example.test/acme/${"y".repeat(300)}`;
  const failedIds = Array.from({ length: 40 }, (_, index) => `${maxId}-${index}`);
  const failedOffers = Array.from({ length: 40 }, (_, index) => ({
    id: `${maxId}-${index}`,
    url: `${maxUrl}-${index}`,
  }));
  const conflictOffers = Array.from({ length: 40 }, (_, index) => ({
    company: `Conflict Co ${index}`,
    title: `Conflict Role ${index}`,
    url: `${maxUrl}-conflict-${index}`,
  }));
  sourcingRunFail({
    repoRoot,
    env: {},
    id: ai.id,
    error: {
      code: "AI_WEB_SEARCH_IDENTITY_CONFLICT",
      message: "Found 40 identity conflict(s) that could not be reconciled.",
      failedIds,
      failedOffers,
      conflicts: 40,
      conflictOffers,
    },
    summary: { failed: 40, failedIds, failedOffers, conflicts: 40, conflictOffers },
  });
  searchExecutionSetLane({
    repoRoot,
    env: {},
    id: "search-restart-max-shape",
    lane: "aiWeb",
    status: "running",
    runId: ai.id,
  });

  const runtime = createWorkspaceAgentRuntime({ repoRoot, env: {} });
  runtime.recoverOrphanedSourcingRuns();
  const execution = await runtime.waitForUnifiedSearch("search-restart-max-shape");

  assert.equal(execution.lanes.aiWeb.status, "failed");
  assert.equal(execution.lanes.aiWeb.summary.failed, 40, "the failed COUNT must survive intact");
  assert.equal(
    execution.lanes.aiWeb.summary.conflicts,
    40,
    "the conflicts COUNT must survive intact"
  );
  assert.equal(execution.lanes.aiWeb.error.failed, 40);
  assert.equal(execution.lanes.aiWeb.error.conflicts, 40);
  assert.equal(execution.lanes.aiWeb.error.truncated, true);
  // Samples may have been shrunk to fit the budget, but every surviving
  // sample must still respect the per-field length bound.
  for (const id of execution.lanes.aiWeb.summary.failedIds || []) {
    assert.ok(id.length <= 256, "a surviving failedId must be bounded to 256 chars");
  }
  for (const failedOffer of execution.lanes.aiWeb.summary.failedOffers || []) {
    assert.ok((failedOffer.id || "").length <= 256);
    assert.ok((failedOffer.url || "").length <= 256);
  }

  const reloaded = searchExecutionGet({
    repoRoot,
    env: {},
    id: "search-restart-max-shape",
  }).execution;
  assert.equal(reloaded.lanes.aiWeb.summary.failed, 40);
  assert.equal(reloaded.lanes.aiWeb.summary.conflicts, 40);
  assert.ok(
    Buffer.byteLength(JSON.stringify(reloaded), "utf8") < 65_536,
    "the persisted execution must stay under the hard DB limit"
  );
  await runtime.shutdownSourcingWorkers();
});

test("unified execution persists a bounded receipt while the AI child keeps full detail", async () => {
  const repoRoot = tempRepo();
  const fullSummary = {
    searched: 120,
    found: 120,
    new: 100,
    offers: Array.from({ length: 120 }, (_, index) => ({
      company: `Company ${index}`,
      title: `Role ${index}`,
      url: `https://example.com/jobs/${index}`,
      bodyText: "Detailed job description. ".repeat(200),
    })),
    sources: Array.from({ length: 120 }, (_, index) => ({
      url: `https://source.example/${index}`,
      response: "Full source response. ".repeat(100),
    })),
    queryResults: Array.from({ length: 120 }, (_, index) => ({
      promptId: `prompt-${index}`,
      output: "Full provider response. ".repeat(100),
    })),
    // CR-29 round 9: conflicts/conflictOffers must be bounded the same way
    // failedIds/failedOffers already are, so a max-shape execution with a
    // large conflict sample still stays under the size bound below.
    conflicts: 60,
    conflictOffers: Array.from({ length: 120 }, (_, index) => ({
      company: `Conflict Co ${index}`,
      title: `Conflict Role ${index}`,
      url: `https://example.com/conflicts/${index}`,
    })),
  };
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
    runSearchInBackgroundImpl: async ({ runId }) => ({
      id: runId,
      purpose: "manual-search",
      status: "completed",
      summary: { scanned: 2, presented: 1 },
    }),
    companyDiscoveryCadenceImpl: () => ({ status: "current", due: false }),
  });
  let aiRunId;
  runtime.registerAiWebSearchStarter({
    isAvailable: () => true,
    start: async ({ searchExecutionId, onStarted }) => {
      const started = sourcingRunStart({
        repoRoot,
        env: {},
        purpose: "ai-web-search",
        inputFingerprint: searchExecutionId,
        metadata: { searchExecutionId },
      }).run;
      aiRunId = started.id;
      onStarted?.(started);
      const completed = sourcingRunComplete({
        repoRoot,
        env: {},
        id: started.id,
        summary: fullSummary,
      }).run;
      return { ok: true, run: completed, value: fullSummary };
    },
  });

  await runtime.executeIntent({
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: "workspace-main" },
      input: { purpose: "manual-search", searchExecutionId: "search-max-shape" },
    },
  });
  const execution = await runtime.waitForUnifiedSearch("search-max-shape");
  const child = sourcingRunGet({ repoRoot, env: {}, id: aiRunId }).run;

  assert.equal(execution.status, "completed");
  assert.equal(execution.lanes.aiWeb.status, "completed");
  assert.equal(execution.lanes.aiWeb.summary.offerCount, 120);
  assert.equal(execution.lanes.aiWeb.summary.sourceCount, 120);
  assert.equal(execution.lanes.aiWeb.summary.queryCount, 120);
  assert.equal(Object.hasOwn(execution.lanes.aiWeb.summary, "offers"), false);
  assert.equal(Object.hasOwn(execution.lanes.aiWeb.summary, "sources"), false);
  assert.equal(Object.hasOwn(execution.lanes.aiWeb.summary, "queryResults"), false);
  assert.equal(execution.lanes.aiWeb.summary.conflicts, 60);
  assert.equal(execution.lanes.aiWeb.summary.conflictOffers.length, 50);
  assert.ok(Buffer.byteLength(JSON.stringify(execution), "utf8") < 65_536);
  assert.equal(child.summary.offers.length, 120);
  assert.equal(child.summary.sources.length, 120);
  assert.equal(child.summary.queryResults.length, 120);
  await runtime.shutdownSourcingWorkers();
});

test("a failed AI-web child's failedIds/failedOffers survive compaction into the durable parent execution, reloaded from SQLite (CR-29 round 8)", async () => {
  // compactSearchExecutionReceipt (the parent's `summary` compaction) and
  // search-executions.mjs's own error normalization both used to drop
  // `failed`/`failedIds`/`failedOffers` on the floor, even though the
  // child's own sourcing-run record already kept them (sourcing-runs.mjs's
  // normalizeError). Reloading the parent execution after a failed AI-web
  // lane had no way to name which postings never made it into the DB.
  const repoRoot = tempRepo();
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
    runSearchInBackgroundImpl: async ({ runId }) => ({
      id: runId,
      purpose: "manual-search",
      status: "completed",
      summary: { scanned: 2, presented: 1 },
    }),
    companyDiscoveryCadenceImpl: () => ({ status: "current", due: false }),
  });

  const failedIds = ["sourced-acme-conflict-recovery"];
  const failedOffers = [
    { id: "sourced-acme-conflict-recovery", url: "https://jobs.example.test/acme/recovery" },
  ];
  runtime.registerAiWebSearchStarter({
    isAvailable: () => true,
    start: async ({ searchExecutionId, onStarted }) => {
      const started = sourcingRunStart({
        repoRoot,
        env: {},
        purpose: "ai-web-search",
        inputFingerprint: searchExecutionId,
        metadata: { searchExecutionId },
      }).run;
      onStarted?.(started);
      const error = {
        code: "AI_WEB_SEARCH_ARTIFACT_WRITE_FAILED",
        message: "Failed to persist 1 job description artifact(s).",
        failedIds,
        failedOffers,
      };
      const failed = sourcingRunFail({ repoRoot, env: {}, id: started.id, error }).run;
      return {
        ok: false,
        run: failed,
        error: failed.error,
        value: { failed: 1, failedIds, failedOffers },
      };
    },
  });

  await runtime.executeIntent({
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: "workspace-main" },
      input: { purpose: "manual-search", searchExecutionId: "search-failed-recovery" },
    },
  });
  await runtime.waitForUnifiedSearch("search-failed-recovery");

  // Reload straight from SQLite (not the in-memory coordination promise's
  // own return value) to prove the fields survive the actual DB round trip.
  const reloaded = searchExecutionGet({
    repoRoot,
    env: {},
    id: "search-failed-recovery",
  }).execution;

  assert.equal(reloaded.lanes.aiWeb.status, "failed");
  assert.equal(reloaded.lanes.aiWeb.summary.failed, 1);
  assert.deepEqual(reloaded.lanes.aiWeb.summary.failedIds, failedIds);
  assert.deepEqual(reloaded.lanes.aiWeb.summary.failedOffers, failedOffers);
  // CR-29 round 14: the failedIds/failedOffers SAMPLES now live on the
  // summary only — duplicating them onto `error` too is exactly what let
  // a large sample double its footprint and blow the execution's
  // 65,536-byte limit. `error` keeps the count and a truncated marker.
  assert.equal(reloaded.lanes.aiWeb.error.failed, 1);
  assert.equal(reloaded.lanes.aiWeb.error.truncated, true);
  assert.equal(Object.hasOwn(reloaded.lanes.aiWeb.error, "failedIds"), false);
  assert.equal(Object.hasOwn(reloaded.lanes.aiWeb.error, "failedOffers"), false);
  await runtime.shutdownSourcingWorkers();
});

test("a conflict-only AI-web child's conflicts/conflictOffers survive compaction into the durable parent execution, reloaded from SQLite (CR-29 round 9)", async () => {
  // Same gap as the failedIds/failedOffers regression above, but for
  // identity conflicts: compactSearchExecutionReceipt and
  // search-executions.mjs's own error normalization both dropped
  // `conflicts`/`conflictOffers` entirely, even though the child's own
  // sourcing-run record already kept them (sourcing-runs.mjs's
  // normalizeError, CR-29 round 8). Reloading the parent execution after a
  // conflict-only AI-web lane had no way to name the conflicting postings —
  // only the child runId, with nothing pointing at the conflict itself.
  const repoRoot = tempRepo();
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
    runSearchInBackgroundImpl: async ({ runId }) => ({
      id: runId,
      purpose: "manual-search",
      status: "completed",
      summary: { scanned: 2, presented: 1 },
    }),
    companyDiscoveryCadenceImpl: () => ({ status: "current", due: false }),
  });

  const conflictOffers = [
    { company: "Acme", title: "Bridge Role", url: "https://jobs.example.test/acme/bridge" },
  ];
  runtime.registerAiWebSearchStarter({
    isAvailable: () => true,
    start: async ({ searchExecutionId, onStarted }) => {
      const started = sourcingRunStart({
        repoRoot,
        env: {},
        purpose: "ai-web-search",
        inputFingerprint: searchExecutionId,
        metadata: { searchExecutionId },
      }).run;
      onStarted?.(started);
      const error = {
        code: "AI_WEB_SEARCH_IDENTITY_CONFLICT",
        message: "Found 1 identity conflict(s) that could not be reconciled.",
        conflicts: 1,
        conflictOffers,
      };
      const failed = sourcingRunFail({ repoRoot, env: {}, id: started.id, error }).run;
      return {
        ok: false,
        run: failed,
        error: failed.error,
        value: { failed: 0, conflicts: 1, conflictOffers },
      };
    },
  });

  await runtime.executeIntent({
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: "workspace-main" },
      input: { purpose: "manual-search", searchExecutionId: "search-conflict-recovery" },
    },
  });
  await runtime.waitForUnifiedSearch("search-conflict-recovery");

  // Reload straight from SQLite (not the in-memory coordination promise's
  // own return value) to prove the fields survive the actual DB round trip.
  const reloaded = searchExecutionGet({
    repoRoot,
    env: {},
    id: "search-conflict-recovery",
  }).execution;

  assert.equal(reloaded.lanes.aiWeb.status, "failed");
  assert.equal(reloaded.lanes.aiWeb.summary.conflicts, 1);
  assert.deepEqual(reloaded.lanes.aiWeb.summary.conflictOffers, conflictOffers);
  // CR-29 round 14: conflictOffers SAMPLES now live on the summary only.
  // `error` keeps the count and a truncated marker instead of a duplicate
  // copy of the same bounded sample.
  assert.equal(reloaded.lanes.aiWeb.error.conflicts, 1);
  assert.equal(reloaded.lanes.aiWeb.error.truncated, true);
  assert.equal(Object.hasOwn(reloaded.lanes.aiWeb.error, "conflictOffers"), false);
  // The execution-size bound (see the max-shape test above) must hold for a
  // conflict-only lane too, not just an artifact-write failure.
  assert.ok(Buffer.byteLength(JSON.stringify(reloaded), "utf8") < 65_536);
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
