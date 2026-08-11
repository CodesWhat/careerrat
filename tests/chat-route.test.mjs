// tests/chat-route.test.mjs
// node:test suite for the M2 chat HTTP surface (src/cli/chat-route.mjs +
// src/core/ai/chat-runtime.mjs), driven end-to-end over a real http server
// (mirrors tests/skill-run-route.test.mjs's bootRouteServer harness) with a
// hermetic fake STREAMING SDK (mirrors tests/chat-runtime.test.mjs's own
// fakeStreamingSdk) — no real @anthropic-ai/claude-agent-sdk devDependency
// touched.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mountChatRoute } from "../src/cli/chat-route.mjs";
import { createChatRuntime } from "../src/core/ai/chat-runtime.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tempRepoWithSkill(skillNames = "ingest-profile") {
  const names = Array.isArray(skillNames) ? skillNames : [skillNames];
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-chat-route-"));
  for (const skillName of names) {
    const skillDir = join(repoRoot, ".agents/skills", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\n---\n# ${skillName}\n`,
      "utf8"
    );
  }
  return repoRoot;
}

// Same "one pulled turn per generator loop" fake as tests/chat-runtime.test.mjs.
function fakeStreamingSdk(turns) {
  return {
    query: ({ prompt, options }) => {
      const { signal } = options.abortController;
      let turnIndex = 0;
      async function* gen() {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-1",
          skills: options.skills,
        };
        for await (const _turnInput of prompt) {
          if (signal.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
          const messages = turns[turnIndex] || [];
          turnIndex++;
          for (const m of messages) {
            if (signal.aborted) {
              const err = new Error("aborted");
              err.name = "AbortError";
              throw err;
            }
            yield m;
          }
        }
      }
      const it = gen();
      it.interrupt = async () => {};
      it.close = () => {};
      it.return = async () => ({ value: undefined, done: true });
      return it;
    },
  };
}

function turnMessages(n) {
  return [
    {
      type: "assistant",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: `Reply ${n}` }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 100 * n,
      num_turns: n,
      session_id: "sdk-session-1",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    },
  ];
}

// Mirrors skill-run-route.test.mjs's bootRouteServer(): a bare addRoute Map
// wrapped in http.createServer, no full tracker-dev.mjs dev server needed.
// Tracks every raw socket the server ever accepts (server.on("connection"))
// so closeServer() can force-destroy stragglers instead of waiting on them.
// Needed specifically because several tests in this suite deliberately abort
// a client request mid-SSE-stream (that's the point of the KEY REGRESSION
// test) — server.close() alone only stops accepting NEW connections and
// waits for existing ones to end on their own, which for an abruptly-aborted
// socket can take multiple real seconds to be reaped by the OS/runtime
// rather than being a signal our own code controls.
function bootServer(chatRuntime, repoRoot) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountChatRoute({ addRoute, repoRoot, chatRuntime, env: {} });

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    route(req, res);
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.__sockets = sockets;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    for (const socket of server.__sockets || []) {
      socket.destroy();
    }
  });
}

function waitForPredicate(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function poll() {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("timed out waiting for predicate"));
        return;
      }
      setTimeout(poll, intervalMs);
    })();
  });
}

// Reads an SSE fetch Response's body until `stopWhen(text)` matches (or the
// stream ends), returning the raw accumulated text — mirrors
// skill-run-route.test.mjs's own readSseBody(), extended with a deadline
// since (unlike that suite's one-shot streams) a chat session's SSE stream
// never ends on its own.
//
// IMPORTANT: a ReadableStreamDefaultReader only ever services ONE outstanding
// read() request at a time (extra concurrent calls just queue up as separate
// pending requests, each claiming exactly one future chunk). A naive "race
// read() against a short timeout, then loop and call read() again" pattern
// leaks a new pending read on every timeout tick — the chunk that arrives
// satisfies whichever pending read is OLDEST, not the one this iteration is
// awaiting, so real data silently goes to an abandoned promise and the loop
// only ever "sees" data when it happens to still be watching the right
// promise. Fix: keep exactly one in-flight read() promise alive across
// iterations and only replace it once it resolves; race THAT single promise
// against the overall deadline instead of manufacturing a fresh read() each
// tick.
async function readSseBody(res, { stopWhen, timeoutMs = 2000, leaveOpen = false } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  let pending = null;
  while (true) {
    if (stopWhen?.(text)) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (!pending) pending = reader.read();
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve({ timedOut: true }), Math.min(remaining, 50))
    );
    const outcome = await Promise.race([pending, timeoutPromise]);
    if (outcome.timedOut) continue;
    pending = null;
    const { value, done } = outcome;
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  // `leaveOpen` skips reader.cancel() — see openSse()'s header comment for
  // why: this suite discovered that canceling/destroying an SSE connection
  // and then IMMEDIATELY opening a new one carrying a `Last-Event-ID` header
  // makes this machine's local network stack sit on the second request for
  // ~15s before delivering it (reproduces identically via curl, so it is not
  // a Node/undici pooling issue — looks like local SSE-reconnect-aware
  // middleware/security tooling). Leaving the reader unconsumed-but-open and
  // tearing the connection down later via AbortController instead avoids the
  // trigger pattern entirely.
  if (!leaveOpen) {
    try {
      reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return text;
}

// Opens a chat SSE connection and hands back both the Response and an
// `abort()` you call whenever you're actually done with it — see
// readSseBody()'s `leaveOpen` comment for why callers sometimes need to
// defer teardown instead of using the fetchSse() convenience below.
async function openSse(url, { headers } = {}) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  return { res, abort: () => controller.abort() };
}

// Fetches a chat SSE stream, reads it via readSseBody(), then ABORTS the
// underlying request (not just cancels the reader) — for the common case
// where nothing else needs this specific connection to stay alive
// afterward. See readSseBody()'s `leaveOpen` comment for the one case
// (Last-Event-ID immediately following a torn-down connection) where this
// shortcut is NOT safe to use back-to-back.
async function fetchSse(url, { headers, stopWhen, timeoutMs = 2000 } = {}) {
  const { res, abort } = await openSse(url, { headers });
  const text = await readSseBody(res, { stopWhen, timeoutMs });
  abort();
  return { res, text };
}

function parseSseIds(text) {
  return Array.from(text.matchAll(/^id: (\d+)$/gm)).map((m) => Number(m[1]));
}

// ---------------------------------------------------------------------------
// POST /api/chat/start — status table
// ---------------------------------------------------------------------------

test("POST /api/chat/start: 201 on success, then 409 duplicate with chatId on the same skill", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const chatRuntime = createChatRuntime({
    repoRoot,
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    loadSdk: async () => fakeStreamingSdk([turnMessages(1)]),
  });
  const server = await bootServer(chatRuntime, repoRoot);
  try {
    const first = await fetch(`${baseUrl(server)}/api/chat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "ingest-profile" }),
    });
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.skill, "ingest-profile");
    assert.equal(firstBody.state, "running");
    assert.ok(firstBody.chatId);

    const second = await fetch(`${baseUrl(server)}/api/chat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "ingest-profile" }),
    });
    assert.equal(second.status, 409);
    const secondBody = await second.json();
    assert.equal(secondBody.chatId, firstBody.chatId);
  } finally {
    chatRuntime.shutdown();
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("POST /api/chat/start: 400 for an empty skill and for a not-allowed skill", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const chatRuntime = createChatRuntime({ repoRoot, env: { ANTHROPIC_API_KEY: "sk-ant-test" } });
  const server = await bootServer(chatRuntime, repoRoot);
  try {
    const empty = await fetch(`${baseUrl(server)}/api/chat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    await empty.json();

    const disallowed = await fetch(`${baseUrl(server)}/api/chat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "evaluate-job" }),
    });
    assert.equal(disallowed.status, 400);
    await disallowed.json();
  } finally {
    chatRuntime.shutdown();
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("POST /api/chat/start: 429 once maxSessions is reached", async () => {
  const repoRoot = tempRepoWithSkill(["a", "b"]);
  const chatRuntime = createChatRuntime({
    repoRoot,
    env: { ANTHROPIC_API_KEY: "sk-ant-test", ROLESTER_CHAT_SKILLS: "a,b" },
    maxSessions: 1,
    loadSdk: async () => fakeStreamingSdk([[]]),
  });
  const server = await bootServer(chatRuntime, repoRoot);
  try {
    const ok = await fetch(`${baseUrl(server)}/api/chat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "a" }),
    });
    assert.equal(ok.status, 201);
    await ok.json();

    const blocked = await fetch(`${baseUrl(server)}/api/chat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "b" }),
    });
    assert.equal(blocked.status, 429);
    await blocked.json();
  } finally {
    chatRuntime.shutdown();
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("POST /api/chat/start: 501 when the SDK devDependency isn't installed", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const chatRuntime = createChatRuntime({
    repoRoot,
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    loadSdk: async () => {
      const err = new Error("@anthropic-ai/claude-agent-sdk is not installed");
      err.code = "SDK_NOT_INSTALLED";
      throw err;
    },
  });
  const server = await bootServer(chatRuntime, repoRoot);
  try {
    const res = await fetch(`${baseUrl(server)}/api/chat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "ingest-profile" }),
    });
    assert.equal(res.status, 501);
    await res.json();
  } finally {
    chatRuntime.shutdown();
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// GET /api/chat/events — SSE id: lines, Last-Event-ID replay, 404
// ---------------------------------------------------------------------------

test("GET /api/chat/events: 404 for an unknown chatId", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const chatRuntime = createChatRuntime({ repoRoot, env: { ANTHROPIC_API_KEY: "sk-ant-test" } });
  const server = await bootServer(chatRuntime, repoRoot);
  try {
    const res = await fetch(`${baseUrl(server)}/api/chat/events?id=nope`);
    assert.equal(res.status, 404);
    await res.json();
  } finally {
    chatRuntime.shutdown();
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("GET /api/chat/events: frames carry id: lines, and Last-Event-ID replays only the tail", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const chatRuntime = createChatRuntime({
    repoRoot,
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    loadSdk: async () => fakeStreamingSdk([turnMessages(1)]),
  });
  const server = await bootServer(chatRuntime, repoRoot);
  try {
    const startRes = await fetch(`${baseUrl(server)}/api/chat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "ingest-profile" }),
    });
    const { chatId } = await startRes.json();

    await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "idle");

    // Deliberately kept open (leaveOpen + manual abort below, not fetchSse's
    // auto-abort) — see readSseBody()'s header comment: tearing this
    // connection down before opening the Last-Event-ID one right after it
    // would trigger a ~15s local-network stall unrelated to our server code.
    const { res: fullRes, abort: abortFull } = await openSse(
      `${baseUrl(server)}/api/chat/events?id=${chatId}`
    );
    assert.equal(fullRes.status, 200);
    assert.match(fullRes.headers.get("content-type") || "", /text\/event-stream/);
    const fullText = await readSseBody(fullRes, {
      stopWhen: (t) => /event: result/.test(t),
      leaveOpen: true,
    });
    const fullIds = parseSseIds(fullText);
    assert.ok(fullIds.length >= 3, `expected at least 3 events, got ids: ${fullIds.join(",")}`);
    assert.match(fullText, /^id: \d+$/m);

    const lastId = Math.max(...fullIds);
    const { res: tailRes, abort: abortTail } = await openSse(
      `${baseUrl(server)}/api/chat/events?id=${chatId}`,
      {
        headers: { "Last-Event-ID": String(lastId) },
      }
    );
    const tailText = await readSseBody(tailRes, { timeoutMs: 300 });
    const tailIds = parseSseIds(tailText);
    // Nothing new happened since lastId (session is idle, no further pushes) —
    // the replay-only-after-lastId contract means this connection gets no
    // backlog at all, just (possibly) live heartbeats/future events.
    assert.ok(
      tailIds.every((id) => id > lastId),
      `expected only ids > ${lastId}, got: ${tailIds.join(",")}`
    );

    abortFull();
    abortTail();
  } finally {
    chatRuntime.shutdown();
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// KEY REGRESSION: destroying an events response mid-running must not abort
// the session — a second connection afterward gets the full backlog plus
// whatever happened live in between.
test("GET /api/chat/events: destroying the response mid-running does not abort the session", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const chatRuntime = createChatRuntime({
    repoRoot,
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    loadSdk: async () => fakeStreamingSdk([turnMessages(1)]),
  });
  const server = await bootServer(chatRuntime, repoRoot);
  try {
    const startRes = await fetch(`${baseUrl(server)}/api/chat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "ingest-profile" }),
    });
    const { chatId } = await startRes.json();

    // Connect, read the first frame (proving we're mid-stream), then abort
    // the client request — this destroys the server-side response.
    const controller = new AbortController();
    const firstRes = await fetch(`${baseUrl(server)}/api/chat/events?id=${chatId}`, {
      signal: controller.signal,
    });
    const reader = firstRes.body.getReader();
    await reader.read();
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }

    // Give the server a beat to process the socket teardown, then wait for
    // the turn to complete on its own — proving the session survived.
    await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "idle", {
      timeoutMs: 2000,
    });
    assert.equal(chatRuntime.getSession(chatId).state, "idle");

    const { res: secondRes, text: secondText } = await fetchSse(
      `${baseUrl(server)}/api/chat/events?id=${chatId}`,
      {
        stopWhen: (t) => /event: result/.test(t),
      }
    );
    assert.equal(secondRes.status, 200);
    assert.match(secondText, /event: result/);
    assert.match(secondText, /event: system/); // the init frame from the very start of the session
  } finally {
    chatRuntime.shutdown();
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat/message — 202 / 400 / 404 / 410
// ---------------------------------------------------------------------------

test("POST /api/chat/message: 202 on success, 400 empty text, 404 unknown, 410 closed", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const chatRuntime = createChatRuntime({
    repoRoot,
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    loadSdk: async () => fakeStreamingSdk([turnMessages(1), turnMessages(2)]),
  });
  const server = await bootServer(chatRuntime, repoRoot);
  try {
    const startRes = await fetch(`${baseUrl(server)}/api/chat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "ingest-profile" }),
    });
    const { chatId } = await startRes.json();
    await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "idle");

    const ok = await fetch(`${baseUrl(server)}/api/chat/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId, text: "hello" }),
    });
    assert.equal(ok.status, 202);
    assert.deepEqual(await ok.json(), { accepted: true });

    const empty = await fetch(`${baseUrl(server)}/api/chat/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId, text: "   " }),
    });
    assert.equal(empty.status, 400);
    await empty.json();

    const unknown = await fetch(`${baseUrl(server)}/api/chat/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: "nope", text: "hi" }),
    });
    assert.equal(unknown.status, 404);
    await unknown.json();

    await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "idle");
    chatRuntime.closeSession(chatId);
    const closed = await fetch(`${baseUrl(server)}/api/chat/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId, text: "hi" }),
    });
    assert.equal(closed.status, 410);
    await closed.json();
  } finally {
    chatRuntime.shutdown();
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat/interrupt — 202 / 404 / 409
// ---------------------------------------------------------------------------

test("POST /api/chat/interrupt: 202 while running, 409 once idle, 404 unknown", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const chatRuntime = createChatRuntime({
    repoRoot,
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    loadSdk: async () => fakeStreamingSdk([turnMessages(1)]),
  });
  const server = await bootServer(chatRuntime, repoRoot);
  try {
    const startRes = await fetch(`${baseUrl(server)}/api/chat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "ingest-profile" }),
    });
    const { chatId } = await startRes.json();

    // Still running (kickoff hasn't resolved to idle yet in the general
    // case) — but our fake resolves almost instantly, so race-tolerantly
    // assert on whichever real state comes back rather than assuming timing.
    const whileMaybeRunning = await fetch(`${baseUrl(server)}/api/chat/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId }),
    });
    assert.ok([202, 409].includes(whileMaybeRunning.status));
    await whileMaybeRunning.json();

    await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "idle");
    const onceIdle = await fetch(`${baseUrl(server)}/api/chat/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId }),
    });
    assert.equal(onceIdle.status, 409);
    await onceIdle.json();

    const unknown = await fetch(`${baseUrl(server)}/api/chat/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: "nope" }),
    });
    assert.equal(unknown.status, 404);
    await unknown.json();
  } finally {
    chatRuntime.shutdown();
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat/close — 204 / 404
// ---------------------------------------------------------------------------

test("POST /api/chat/close: 204 on success, 404 for an unknown chatId", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const chatRuntime = createChatRuntime({
    repoRoot,
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    loadSdk: async () => fakeStreamingSdk([turnMessages(1)]),
  });
  const server = await bootServer(chatRuntime, repoRoot);
  try {
    const startRes = await fetch(`${baseUrl(server)}/api/chat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "ingest-profile" }),
    });
    const { chatId } = await startRes.json();

    const ok = await fetch(`${baseUrl(server)}/api/chat/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId }),
    });
    assert.equal(ok.status, 204);
    assert.equal(chatRuntime.getSession(chatId).state, "closed");

    const unknown = await fetch(`${baseUrl(server)}/api/chat/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: "nope" }),
    });
    assert.equal(unknown.status, 404);
    await unknown.json();
  } finally {
    chatRuntime.shutdown();
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// GET /api/chat/by-skill and GET /api/chat/list
// ---------------------------------------------------------------------------

test("GET /api/chat/by-skill: 200 with {chatId, state} for a live session, 404 otherwise", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const chatRuntime = createChatRuntime({
    repoRoot,
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    loadSdk: async () => fakeStreamingSdk([turnMessages(1)]),
  });
  const server = await bootServer(chatRuntime, repoRoot);
  try {
    const missing = await fetch(`${baseUrl(server)}/api/chat/by-skill?skill=ingest-profile`);
    assert.equal(missing.status, 404);
    await missing.json();

    const startRes = await fetch(`${baseUrl(server)}/api/chat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "ingest-profile" }),
    });
    const { chatId } = await startRes.json();

    const found = await fetch(`${baseUrl(server)}/api/chat/by-skill?skill=ingest-profile`);
    assert.equal(found.status, 200);
    const body = await found.json();
    assert.equal(body.chatId, chatId);
    assert.equal(body.skill, "ingest-profile");
    assert.ok(["running", "idle"].includes(body.state));
  } finally {
    chatRuntime.shutdown();
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("GET /api/chat/list: 200 with every tracked session", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const chatRuntime = createChatRuntime({
    repoRoot,
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    loadSdk: async () => fakeStreamingSdk([turnMessages(1)]),
  });
  const server = await bootServer(chatRuntime, repoRoot);
  try {
    const empty = await fetch(`${baseUrl(server)}/api/chat/list`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), []);

    const startRes = await fetch(`${baseUrl(server)}/api/chat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "ingest-profile" }),
    });
    const { chatId } = await startRes.json();

    const listRes = await fetch(`${baseUrl(server)}/api/chat/list`);
    const list = await listRes.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].chatId, chatId);
    assert.ok("createdAt" in list[0] && "lastActivityAt" in list[0]);
  } finally {
    chatRuntime.shutdown();
    await closeServer(server);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
