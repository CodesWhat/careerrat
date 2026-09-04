import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";

import { mountSearchRoutes } from "../src/cli/search-route.mjs";
import { createWorkspaceAgentRuntime } from "../src/core/agent/workspace-agent.mjs";
import { writeAIPreferences } from "../src/core/ai/ai-preferences.mjs";
import { writeInstalledRuntimeSelection } from "../src/core/ai/runtime-selection.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { candidateSetupInitialize, sourcingRunLatest } from "../src/core/db/verbs.mjs";
import { saveSearchPrompts } from "../src/core/search/search-prompts.mjs";
import {
  createVerifiedRuntimeExecutable,
  VERIFIED_RUNTIME_CAPABILITIES,
} from "./helpers/installed-runtime-fixture.mjs";

const roots = [];

function tempRepo({ prompts = 1 } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-ai-web-route-"));
  roots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  if (prompts) saveSearchPrompts({ repoRoot, prompts: [{ id: "p1", text: "Find AI roles" }] });
  return repoRoot;
}

function handlerFor({
  repoRoot,
  env = { ANTHROPIC_API_KEY: "test-key" },
  runAiWebSearch,
  generateSearchPrompts,
  workspaceAgentRuntime,
  setIntervalImpl,
  clearIntervalImpl,
}) {
  return mountedRoutesFor({
    repoRoot,
    env,
    runAiWebSearch,
    generateSearchPrompts,
    workspaceAgentRuntime,
    setIntervalImpl,
    clearIntervalImpl,
  }).handler;
}

function mountedRoutesFor({
  repoRoot,
  env = { ANTHROPIC_API_KEY: "test-key" },
  runAiWebSearch,
  generateSearchPrompts,
  workspaceAgentRuntime,
  setIntervalImpl,
  clearIntervalImpl,
}) {
  const routes = new Map();
  const lifecycle = mountSearchRoutes({
    addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    repoRoot,
    env,
    runAiWebSearch,
    ...(generateSearchPrompts ? { generateSearchPromptsImpl: generateSearchPrompts } : {}),
    workspaceAgentRuntime,
    ...(setIntervalImpl ? { setIntervalImpl } : {}),
    ...(clearIntervalImpl ? { clearIntervalImpl } : {}),
  });
  return {
    handler: routes.get("POST /api/search/ai-web-search/run"),
    lifecycle,
  };
}

function request(body = "{}") {
  const req = Readable.from([Buffer.from(body)]);
  req.url = "/api/search/ai-web-search/run";
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  return req;
}

function response() {
  const res = new EventEmitter();
  res.status = null;
  res.headers = null;
  res.chunks = [];
  res.ended = false;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
    return res;
  };
  res.write = (chunk) => {
    res.chunks.push(String(chunk));
    return true;
  };
  res.end = (chunk) => {
    if (chunk) res.chunks.push(String(chunk));
    res.ended = true;
    return res;
  };
  res.flushHeaders = () => {};
  return res;
}

function jsonBody(res) {
  return JSON.parse(res.chunks.join(""));
}

function sseFrames(res) {
  return res.chunks
    .join("")
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)));
}

after(() => {
  closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("AI web-search route returns 501/422/400/413 before opening SSE", async () => {
  const noAi = response();
  await handlerFor({ repoRoot: tempRepo(), env: {}, runAiWebSearch: async () => ({}) })(
    request(),
    noAi
  );
  assert.equal(noAi.status, 501);

  const noPrompts = response();
  await handlerFor({ repoRoot: tempRepo({ prompts: 0 }), runAiWebSearch: async () => ({}) })(
    request('{"promptIds":["missing"]}'),
    noPrompts
  );
  assert.equal(noPrompts.status, 422);

  const badJson = response();
  await handlerFor({ repoRoot: tempRepo(), runAiWebSearch: async () => ({}) })(
    request("{"),
    badJson
  );
  assert.equal(badJson.status, 400);

  const tooLarge = response();
  await handlerFor({ repoRoot: tempRepo(), runAiWebSearch: async () => ({}) })(
    request(`{"padding":"${"x".repeat(1024 * 1024)}"}`),
    tooLarge
  );
  assert.equal(tooLarge.status, 413);
});

test("mounting the AI route registers a durable unified-search starter", async () => {
  const repoRoot = tempRepo();
  let workerDefinition;
  let starterDefinition;
  let searchInput;
  const events = [];
  const workspaceAgentRuntime = {
    registerSourcingWorker(definition) {
      workerDefinition = definition;
    },
    registerAiWebSearchStarter(definition) {
      starterDefinition = definition;
    },
    startSourcingWorker({ run, context }) {
      return {
        run,
        promise: Promise.resolve(
          workerDefinition.execute({
            run,
            context,
            signal: new AbortController().signal,
            reportProgress() {},
          })
        ).then((result) => ({ run: { ...run, status: "completed" }, value: result.value })),
      };
    },
    async recordSearchStart() {},
  };

  mountedRoutesFor({
    repoRoot,
    workspaceAgentRuntime,
    runAiWebSearch: async (input) => {
      searchInput = input;
      const { onProgress } = input;
      onProgress({ type: "activity", message: "Searching the open web" });
      return { searched: 1, found: 1, new: 1, errors: [] };
    },
  });

  assert.equal(starterDefinition.isAvailable(), true);
  const deterministic = {
    status: "succeeded",
    result: {
      ok: true,
      run: { summary: { scanned: 3, presented: 1 } },
      value: {
        scanned: 3,
        presented: 1,
        sourceCoverage: [
          {
            kind: "configured",
            label: "Existing source",
            host: "existing.example",
            status: "success",
            found: 1,
          },
        ],
        offers: [
          {
            company: "Existing Company",
            title: "Existing Role",
            url: "https://existing.example/jobs/existing-role",
          },
        ],
      },
    },
  };
  const result = await starterDefinition.start({
    searchExecutionId: "search-unified-route",
    deterministic,
    onProgress: (event) => events.push(event),
  });
  const stored = sourcingRunLatest({ repoRoot, env: {}, purpose: "ai-web-search" }).run;
  const expectedCoverage = {
    status: "succeeded",
    sources: [
      {
        kind: "configured",
        label: "Existing source",
        host: "existing.example",
        status: "success",
        found: 1,
      },
    ],
    offers: [
      {
        company: "Existing Company",
        title: "Existing Role",
        url: "https://existing.example/jobs/existing-role",
      },
    ],
  };

  assert.equal(result.ok, true);
  assert.equal(stored.metadata.searchExecutionId, "search-unified-route");
  assert.deepEqual(stored.metadata.deterministic, expectedCoverage);
  assert.deepEqual(searchInput.deterministic, expectedCoverage);
  assert.deepEqual(events, [{ type: "activity", message: "Searching the open web" }]);
});

test("unified AI starter reports app shutdown as resumable instead of completed", async () => {
  const repoRoot = tempRepo();
  let starterDefinition;
  const workspaceAgentRuntime = {
    registerSourcingWorker() {},
    registerAiWebSearchStarter(definition) {
      starterDefinition = definition;
    },
    startSourcingWorker({ run }) {
      return {
        run,
        promise: Promise.resolve({ run: null, value: null, resumable: true }),
      };
    },
    async recordSearchStart() {},
  };

  mountedRoutesFor({
    repoRoot,
    workspaceAgentRuntime,
    runAiWebSearch: async () => assert.fail("resumable fixture must not run the provider"),
  });

  const result = await starterDefinition.start({ searchExecutionId: "search-paused" });
  const stored = sourcingRunLatest({ repoRoot, env: {}, purpose: "ai-web-search" }).run;

  assert.equal(result.ok, false);
  assert.equal(result.resumable, true);
  assert.equal(result.run.id, stored.id);
  assert.equal(stored.status, "running");
});

test("AI web-search generates candidate prompts automatically when none are saved", async () => {
  const repoRoot = tempRepo({ prompts: 0 });
  let searches = 0;
  const res = response();
  await handlerFor({
    repoRoot,
    generateSearchPrompts: async () => ({
      status: 200,
      body: {
        ok: true,
        data: { prompts: [{ text: "Find current operations roles in New York" }] },
      },
    }),
    runAiWebSearch: async ({ promptIds }) => {
      searches += 1;
      assert.equal(promptIds.length, 1);
      return { searched: 1, found: 0, new: 0, duplicates: 0, errors: [] };
    },
  })(request(), res);

  assert.equal(res.status, 200);
  assert.equal(searches, 1);
  assert.equal(sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run.status, "completed");
});

test("AI web-search route streams activity before done and emits heartbeat comments", async () => {
  const repoRoot = tempRepo();
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const scheduled = [];
  const cleared = [];
  globalThis.setInterval = (callback, ms) => {
    scheduled.push(ms);
    if (ms === 10000) callback();
    return ms;
  };
  globalThis.clearInterval = (id) => cleared.push(id);
  try {
    const res = response();
    let receivedExecutionPlan;
    const handler = handlerFor({
      repoRoot,
      runAiWebSearch: async ({ onProgress, writeGuard, executionPlan }) => {
        receivedExecutionPlan = executionPlan;
        assert.equal(typeof writeGuard, "function");
        assert.doesNotThrow(() => writeGuard(openDb({ repoRoot })));
        onProgress({ type: "activity", message: "Searching saved prompt…" });
        return { searched: 1, found: 2, new: 1, duplicates: 1, errors: [] };
      },
    });
    await handler(request('{"searchExecutionId":"search-execution-ai"}'), res);
    assert.equal(res.status, 200);
    assert.match(res.chunks.join(""), /: ping\n\n/);
    const frames = sseFrames(res);
    assert.equal(frames[0].type, "started");
    assert.equal(frames[0].run.purpose, "ai-web-search");
    assert.equal(frames[0].run.status, "running");
    assert.deepEqual(frames.slice(1), [
      { type: "activity", message: "Searching saved prompt…" },
      {
        type: "done",
        data: { searched: 1, found: 2, new: 1, duplicates: 1, errors: [] },
      },
    ]);
    const durable = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run;
    assert.equal(durable.status, "completed");
    assert.equal(durable.summary.new, 1);
    assert.deepEqual(durable.metadata.promptIds, ["p1"]);
    assert.equal(durable.metadata.searchExecutionId, "search-execution-ai");
    assert.equal(durable.metadata.aiExecutionPlan.operation, "research.web");
    assert.equal(durable.metadata.aiExecutionPlan.runtimeId, "anthropic-api");
    assert.equal(durable.metadata.aiExecutionPlan.resolved.quality, "balanced");
    assert.equal(durable.metadata.aiExecutionPlan.resolved.effort, "medium");
    assert.deepEqual(receivedExecutionPlan, durable.metadata.aiExecutionPlan);
    assert.match(durable.metadata.inputFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(scheduled, [10000, 30000]);
    assert.deepEqual(
      cleared.sort((a, b) => a - b),
      [10000, 30000]
    );
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("AI web search starts and completes in the same workspace-main history", async () => {
  const repoRoot = tempRepo();
  const started = [];
  const completed = [];
  const workspaceAgentRuntime = {
    async recordSearchStart(input) {
      started.push(input);
    },
    async recordSearchCompletion(input) {
      completed.push(input);
    },
  };
  const res = response();
  await handlerFor({
    repoRoot,
    workspaceAgentRuntime,
    runAiWebSearch: async () => ({
      searched: 1,
      found: 3,
      new: 2,
      duplicates: 1,
      errors: [],
      failedPromptIds: [],
      queryResults: [{ promptId: "p1", status: "completed", queries: ["AI roles"] }],
      sources: [{ url: "https://jobs.example.test", status: "completed" }],
    }),
  })(request(), res);

  assert.equal(started.length, 1);
  assert.equal(started[0].run.purpose, "ai-web-search");
  assert.equal(started[0].run.status, "running");
  assert.deepEqual(started[0].input, {
    purpose: "ai-web-search",
    promptIds: ["p1"],
  });
  assert.deepEqual(started[0].sources, { promptCount: 1 });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].run.id, started[0].run.id);
  assert.equal(completed[0].run.status, "completed");
  assert.equal(completed[0].run.summary.new, 2);
});

test("AI web-search route persists exact failed prompts and accepts retry prompt ids", async () => {
  const repoRoot = tempRepo();
  let receivedPromptIds;
  const res = response();
  await handlerFor({
    repoRoot,
    runAiWebSearch: async ({ promptIds }) => {
      receivedPromptIds = promptIds;
      return {
        searched: 1,
        found: 0,
        new: 0,
        duplicates: 0,
        errors: ["search timed out"],
        failedPromptIds: ["p1"],
        queryResults: [
          {
            promptId: "p1",
            prompt: "Find AI roles",
            status: "failed",
            queries: [{ query: "AI jobs", status: "failed", error: "search timed out" }],
            error: "search timed out",
          },
        ],
        sources: [{ url: "https://jobs.example.test", status: "failed", error: "timeout" }],
      };
    },
  })(request('{"promptIds":["p1"]}'), res);

  assert.deepEqual(receivedPromptIds, ["p1"]);
  const durable = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run;
  assert.equal(durable.status, "failed");
  assert.deepEqual(durable.error.failedPromptIds, ["p1"]);
  assert.equal(durable.error.queryResults[0].queries[0].query, "AI jobs");
  assert.equal(durable.error.sources[0].url, "https://jobs.example.test");
});

test("AI web-search route durably warns when only an auxiliary top-up query failed", async () => {
  const repoRoot = tempRepo();
  const res = response();
  const warning = "The additional search query timed out.";
  await handlerFor({
    repoRoot,
    runAiWebSearch: async () => ({
      searched: 1,
      found: 1,
      new: 1,
      presented: 1,
      duplicates: 0,
      errors: [],
      warnings: [warning],
      failedPromptIds: [],
      queryResults: [
        {
          promptId: "p1",
          prompt: "Find AI roles",
          status: "completed",
          queries: [
            { query: "AI roles", status: "completed", error: null },
            {
              query: "Find AI roles",
              status: "failed",
              error: warning,
            },
          ],
        },
      ],
      sources: [{ url: "https://jobs.example.test/role", status: "completed" }],
    }),
  })(request(), res);

  assert.equal(sseFrames(res).at(-1).type, "done");
  const durable = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run;
  assert.equal(durable.status, "completed");
  assert.equal(durable.summary.new, 1);
  assert.deepEqual(durable.summary.failedPromptIds, []);
  assert.deepEqual(durable.summary.errors, []);
  assert.deepEqual(durable.summary.warnings, [warning]);
  assert.equal(durable.summary.queryResults[0].queries[1].error, warning);
});

test("AI web-search route marks the run failed when a successful prompt still lost its posting to a JD artifact-write failure (CR-29 round 6)", async () => {
  // A successful prompt followed by a JD staging failure used to settle as
  // a completed run: the worker only checked whether EVERY selected prompt
  // failed, ignoring runAiWebSearch's own ok/failed/failedIds. That
  // suppressed retry despite the lost posting.
  const repoRoot = tempRepo();
  const res = response();
  await handlerFor({
    repoRoot,
    runAiWebSearch: async () => ({
      searched: 1,
      found: 1,
      new: 0,
      presented: 0,
      duplicates: 0,
      errors: [],
      failedPromptIds: [],
      ok: false,
      failed: 1,
      failedIds: ["sourced-acme-example-1"],
      queryResults: [
        {
          promptId: "p1",
          prompt: "Find AI roles",
          status: "completed",
          queries: [{ query: "AI roles", status: "completed", error: null }],
        },
      ],
      sources: [{ url: "https://jobs.example.test/role", status: "completed" }],
    }),
  })(request(), res);

  const durable = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run;
  assert.equal(durable.status, "failed");
  assert.equal(durable.error.code, "AI_WEB_SEARCH_ARTIFACT_WRITE_FAILED");
  assert.deepEqual(durable.error.failedIds, ["sourced-acme-example-1"]);
  assert.deepEqual(durable.error.failedPromptIds, []);
});

test("AI web-search route preserves candidate-safe provider-cap guidance", async () => {
  const repoRoot = tempRepo();
  const message =
    "The selected AI provider has reached its usage limit. It resets at 4pm (America/New_York). Try again after the reset.";
  const res = response();
  await handlerFor({
    repoRoot,
    runAiWebSearch: async () => ({
      searched: 1,
      found: 0,
      new: 0,
      duplicates: 0,
      errors: [message],
      failedPromptIds: ["p1"],
      queryResults: [
        {
          promptId: "p1",
          prompt: "Find AI roles",
          status: "failed",
          queries: [{ query: "Find AI roles", status: "failed", error: message }],
          error: message,
        },
      ],
      sources: [],
    }),
  })(request(), res);

  const frames = sseFrames(res);
  assert.equal(frames.at(-1).type, "done");
  assert.deepEqual(frames.at(-1).data.errors, [message]);
  const durable = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run;
  assert.equal(durable.status, "failed");
  assert.equal(durable.error.message, message);
  assert.doesNotMatch(JSON.stringify(durable.error), /CLI|schema|RUNTIME_/i);
});

test("AI web-search route freezes the saved provider-neutral preferences at run start", async () => {
  const repoRoot = tempRepo();
  writeAIPreferences({ repoRoot, env: {}, quality: "best", reasoning: "high" });
  let receivedExecutionPlan;
  const res = response();
  await handlerFor({
    repoRoot,
    runAiWebSearch: async ({ executionPlan }) => {
      receivedExecutionPlan = executionPlan;
      return { searched: 1, found: 1, new: 1, duplicates: 0, errors: [] };
    },
  })(request(), res);

  assert.equal(res.status, 200);
  assert.equal(receivedExecutionPlan.requested.quality, "best");
  assert.equal(receivedExecutionPlan.requested.reasoning, "high");
  assert.equal(receivedExecutionPlan.resolved.quality, "best");
  assert.equal(receivedExecutionPlan.resolved.effort, "high");
  const durable = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run;
  assert.deepEqual(durable.metadata.aiExecutionPlan, receivedExecutionPlan);
});

test("AI web-search route freezes verified installed-runtime evidence for durable execution", async () => {
  for (const runtimeId of ["claude", "codex"]) {
    const repoRoot = tempRepo();
    const executable = createVerifiedRuntimeExecutable({ root: repoRoot, runtimeId });
    const env = { PATH: join(repoRoot, "bin"), CAREERRAT_DESKTOP_SHELL: "1" };
    writeInstalledRuntimeSelection({
      repoRoot,
      env,
      runtimeId,
      verification: {
        ...executable.evidence,
        capabilities: VERIFIED_RUNTIME_CAPABILITIES,
        checkedAt: "2026-08-27T16:00:00.000Z",
      },
    });
    let receivedExecutionPlan;
    const res = response();
    await handlerFor({
      repoRoot,
      env,
      runAiWebSearch: async ({ executionPlan }) => {
        receivedExecutionPlan = executionPlan;
        return { searched: 1, found: 1, new: 1, duplicates: 0, errors: [] };
      },
    })(request(), res);

    assert.equal(res.status, 200, runtimeId);
    assert.deepEqual(receivedExecutionPlan.installedRuntime, executable.evidence);
    assert.deepEqual(
      sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run.metadata.aiExecutionPlan,
      receivedExecutionPlan
    );
  }
});

test("AI web-search route rejects a concurrent run with 409", async () => {
  const repoRoot = tempRepo();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const handler = handlerFor({
    repoRoot,
    runAiWebSearch: async () => {
      await blocked;
      return { searched: 1, found: 0, new: 0, duplicates: 0, errors: [] };
    },
  });
  const firstRes = response();
  const first = handler(request(), firstRes);
  await new Promise((resolve) => setImmediate(resolve));
  const secondRes = response();
  await handler(request(), secondRes);
  assert.equal(secondRes.status, 409);
  assert.match(jsonBody(secondRes).error.message, /already running/i);
  release();
  await first;
});

test("AI web-search route stops writing frames after the response closes", async () => {
  const repoRoot = tempRepo();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const handler = handlerFor({
    repoRoot,
    runAiWebSearch: async ({ onProgress }) => {
      onProgress({ type: "activity", message: "started" });
      await blocked;
      return { searched: 1, found: 0, new: 0, duplicates: 0, errors: [] };
    },
  });
  const res = response();
  const running = handler(request(), res);
  await new Promise((resolve) => setImmediate(resolve));
  res.emit("close");
  release();
  await running;
  const frames = sseFrames(res);
  assert.equal(frames[0].type, "started");
  assert.deepEqual(frames.slice(1), [{ type: "activity", message: "started" }]);
});

test("AI web-search disconnect leaves the durable worker running to completion", async () => {
  const repoRoot = tempRepo();
  let release;
  let providerSignal;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const handler = handlerFor({
    repoRoot,
    runAiWebSearch: async ({ onProgress, signal }) => {
      providerSignal = signal;
      onProgress({ type: "activity", message: "started" });
      await blocked;
      return { searched: 1, found: 0, new: 0, duplicates: 0, errors: [] };
    },
  });
  const res = response();
  const running = handler(request(), res);
  await new Promise((resolve) => setImmediate(resolve));
  res.emit("close");

  assert.equal(providerSignal.aborted, false);
  assert.equal(sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run.status, "running");

  release();
  await running;

  const durable = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run;
  assert.equal(durable.status, "completed");
  assert.equal(durable.error, null);
});

test("the workspace search worker owns AI web-search execution", async () => {
  const repoRoot = tempRepo();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const workspaceAgentRuntime = createWorkspaceAgentRuntime({ repoRoot, env: {} });
  const { handler } = mountedRoutesFor({
    repoRoot,
    workspaceAgentRuntime,
    runAiWebSearch: async () => {
      await blocked;
      return { searched: 1, found: 0, new: 0, duplicates: 0, errors: [] };
    },
  });
  const res = response();
  const running = handler(request(), res);
  await new Promise((resolve) => setImmediate(resolve));

  const durable = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run;
  assert.equal(durable.status, "running");
  assert.equal(workspaceAgentRuntime.ownsSourcingRun(durable.id), true);

  release();
  await running;
  await workspaceAgentRuntime.shutdownSourcingWorkers();
});

test("AI web-search refreshes its durable lease while the provider is quiet", async () => {
  const repoRoot = tempRepo();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const scheduled = new Map();
  let nextId = 0;
  const handler = handlerFor({
    repoRoot,
    setIntervalImpl(callback, ms) {
      nextId += 1;
      scheduled.set(ms, { id: nextId, callback });
      return nextId;
    },
    clearIntervalImpl(id) {
      for (const [ms, entry] of scheduled) {
        if (entry.id === id) scheduled.delete(ms);
      }
    },
    runAiWebSearch: async () => {
      await blocked;
      return { searched: 1, found: 0, new: 0, duplicates: 0, errors: [] };
    },
  });
  const res = response();
  const running = handler(request(), res);
  await new Promise((resolve) => setImmediate(resolve));

  const before = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run;
  assert.equal(typeof scheduled.get(30000)?.callback, "function");
  scheduled.get(30000).callback();
  const refreshed = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run;
  assert.ok(Date.parse(refreshed.updatedAt) > Date.parse(before.updatedAt));
  assert.equal(refreshed.progress.workerStatus, "running");

  release();
  await running;
});

test("AI web-search lifecycle leaves the durable worker resumable on app shutdown", async () => {
  const repoRoot = tempRepo();
  let providerSignal;
  const { handler, lifecycle } = mountedRoutesFor({
    repoRoot,
    runAiWebSearch: ({ signal }) =>
      new Promise((_resolve, reject) => {
        providerSignal = signal;
        signal.addEventListener(
          "abort",
          () => reject(signal.reason || new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      }),
  });
  const res = response();
  const running = handler(request(), res);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(providerSignal.aborted, false);
  await lifecycle.shutdownAiWebSearch();
  await running;

  assert.equal(providerSignal.aborted, true);
  const durable = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run;
  assert.equal(durable.status, "running");
  assert.equal(durable.error, null);
});

test("a replacement workspace owner resumes the same AI web-search run", async () => {
  const repoRoot = tempRepo();
  let firstSignal;
  const firstRuntime = createWorkspaceAgentRuntime({ repoRoot, env: {} });
  const firstMounted = mountedRoutesFor({
    repoRoot,
    workspaceAgentRuntime: firstRuntime,
    runAiWebSearch: ({ signal }) =>
      new Promise((_resolve, reject) => {
        firstSignal = signal;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  const firstResponse = response();
  const firstRequest = firstMounted.handler(request(), firstResponse);
  await new Promise((resolve) => setImmediate(resolve));
  const original = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run;

  await firstRuntime.shutdownSourcingWorkers();
  await firstRequest;
  assert.equal(firstSignal.aborted, true);
  assert.equal(sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run.status, "running");

  let resumedInput;
  const replacementRuntime = createWorkspaceAgentRuntime({ repoRoot, env: {} });
  mountedRoutesFor({
    repoRoot,
    workspaceAgentRuntime: replacementRuntime,
    runAiWebSearch: async (input) => {
      resumedInput = input;
      return { searched: 1, found: 1, new: 1, duplicates: 0, errors: [] };
    },
  });
  replacementRuntime.recoverOrphanedSourcingRuns();
  for (
    let attempt = 0;
    attempt < 50 && replacementRuntime.ownsSourcingRun(original.id);
    attempt += 1
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const completed = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run;
  assert.equal(completed.id, original.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.metadata.recoveryCount, 1);
  assert.deepEqual(resumedInput.promptIds, ["p1"]);
  assert.deepEqual(resumedInput.executionPlan, original.metadata.aiExecutionPlan);
  await replacementRuntime.shutdownSourcingWorkers();
});
