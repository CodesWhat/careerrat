import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";

import { mountSearchRoutes } from "../src/cli/search-route.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
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
}) {
  const routes = new Map();
  mountSearchRoutes({
    addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    repoRoot,
    env,
    runAiWebSearch,
    workspaceAgentRuntime,
  });
  return routes.get("POST /api/search/ai-web-search/run");
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
  globalThis.setInterval = (callback, ms) => {
    assert.equal(ms, 10000);
    callback();
    return 17;
  };
  globalThis.clearInterval = (token) => assert.equal(token, 17);
  try {
    const res = response();
    const handler = handlerFor({
      repoRoot,
      runAiWebSearch: async ({ onProgress }) => {
        onProgress({ type: "activity", message: "Searching saved prompt…" });
        return { searched: 1, found: 2, new: 1, duplicates: 1, errors: [] };
      },
    });
    await handler(request(), res);
    assert.equal(res.status, 200);
    assert.match(res.chunks.join(""), /: ping\n\n/);
    assert.deepEqual(sseFrames(res), [
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
    assert.match(durable.metadata.inputFingerprint, /^[a-f0-9]{64}$/);
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
  assert.deepEqual(sseFrames(res), [{ type: "activity", message: "started" }]);
});

test("AI web-search disconnect aborts the underlying run via an AbortSignal", async () => {
  const repoRoot = tempRepo();
  let sawAbort;
  const abortSeen = new Promise((resolve) => {
    sawAbort = resolve;
  });
  const handler = handlerFor({
    repoRoot,
    runAiWebSearch: ({ onProgress, signal }) =>
      new Promise((resolve) => {
        onProgress({ type: "activity", message: "started" });
        signal.addEventListener("abort", () => {
          sawAbort();
          resolve({ searched: 1, found: 0, new: 0, duplicates: 0, errors: [] });
        });
        // Never resolves on its own — only the abort listener settles it,
        // simulating a long-running search the client walks away from. See
        // skill-run-route.test.mjs's matching client-disconnect test for the
        // same pattern.
      }),
  });
  const res = response();
  const running = handler(request(), res);
  await new Promise((resolve) => setImmediate(resolve));
  res.emit("close");
  await abortSeen;
  await running;

  const durable = sourcingRunLatest({ repoRoot, purpose: "ai-web-search" }).run;
  assert.equal(durable.status, "failed");
  assert.equal(durable.summary, null);
  assert.equal(durable.error.code, "AI_WEB_SEARCH_ABORTED");
});
