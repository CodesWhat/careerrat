import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";

import { mountSearchRoutes } from "../src/cli/search-route.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { candidateSetupInitialize, sourcingRunLatest } from "../src/core/db/verbs.mjs";
import { saveSearchPrompts } from "../src/core/search/search-prompts.mjs";

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
  workspaceAgentRuntime,
  setIntervalImpl,
  clearIntervalImpl,
}) {
  return mountedRoutesFor({
    repoRoot,
    env,
    runAiWebSearch,
    workspaceAgentRuntime,
    setIntervalImpl,
    clearIntervalImpl,
  }).handler;
}

function mountedRoutesFor({
  repoRoot,
  env = { ANTHROPIC_API_KEY: "test-key" },
  runAiWebSearch,
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
    request(),
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
    const handler = handlerFor({
      repoRoot,
      runAiWebSearch: async ({ onProgress, writeGuard }) => {
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

test("AI web-search lifecycle aborts and settles the durable worker on app shutdown", async () => {
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
  assert.equal(durable.status, "failed");
  assert.equal(durable.error.code, "AI_WEB_SEARCH_SERVER_STOPPED");
  assert.match(durable.error.message, /stopped while this search was running/i);
});
