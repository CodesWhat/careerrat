// tests/ai-proxy.test.mjs
// node:test suite for the stateless metering proxy (src/cli/ai-proxy.mjs).
//
// A mock "real provider" upstream (plain node:http) stands in for Anthropic so
// these tests are hermetic: ephemeral ports both sides, temp dirs for the
// usage log, no network. createProxyServer() is the pure factory under test —
// it never binds a socket itself, so each test binds its own ephemeral port
// and tears it down.
//
// Every fetch() response body is consumed (.text()/.json()) even when the
// test doesn't need it: undici's connection pool can stall a later request to
// the same origin behind an undrained body, and this proxy's own metering
// logic runs synchronously right after res.end() — draining the body is both
// good client hygiene and what makes "did /meter update yet" deterministic.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProxyServer } from "../src/cli/ai-proxy.mjs";
import { reportingUserId } from "../src/cli/proxy-core.mjs";
import { computeCost, readUsageEvents, usageLogAbsPath } from "../src/core/ai/usage-log.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "careerrat-ai-proxy-"));
}

const NON_STREAM_BODY = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "hello RAW_MODEL_REPLY_02_07" }],
  model: "claude-sonnet-5",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 1000,
    output_tokens: 500,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 100,
  },
};

const ALLOWED_USAGE_KEYS = [
  "id",
  "at",
  "source",
  "feature",
  "skill",
  "action",
  "operation",
  "model",
  "upstream",
  "tokens_in",
  "tokens_out",
  "cache_read_tokens",
  "cache_creation_tokens",
  "web_searches",
  "shared_cache_hit",
  "cost_usd",
  "priced",
  "user",
  "userLabel",
];
const FORBIDDEN_USAGE_KEYS = [
  "prompt",
  "body",
  "requestBody",
  "responseBody",
  "raw",
  "rawText",
  "content",
  "messages",
  "outputSchema",
  "schema",
];
const FORBIDDEN_CONTENT = [
  "PROMPT_SECRET_02_07",
  "RAW_MODEL_REPLY_02_07",
  "RESUME_SECRET_02_07",
  "JD_SECRET_02_07",
  "CANDIDATE_FACT_SECRET_02_07",
  "PAGE_BODY_SECRET_02_07",
];

function assertUsageEventIsMetadataOnly(event) {
  assert.deepEqual(Object.keys(event).sort(), [...ALLOWED_USAGE_KEYS].sort());
  for (const key of FORBIDDEN_USAGE_KEYS) {
    assert.equal(Object.hasOwn(event, key), false, `usage row leaked key ${key}`);
  }
  const serialized = JSON.stringify(event);
  for (const secret of FORBIDDEN_CONTENT) {
    assert.equal(serialized.includes(secret), false, `usage row leaked ${secret}`);
  }
}

function sseFixture(model) {
  const events = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_2",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 2000,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "stream chunk" },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 750 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

// Stands in for the real provider: records every request it receives (method,
// url, headers, parsed body) so tests can assert on exactly what the proxy
// forwarded — and never sees the client's own bearer token or x-careerrat-*
// labels if the proxy is stripping correctly.
function startMockUpstream() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let parsed = {};
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        /* ignore (e.g. GET with no body) */
      }
      requests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: parsed,
      });

      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseFixture(parsed.model));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ...NON_STREAM_BODY, model: parsed.model || NON_STREAM_BODY.model })
        );
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, requests, url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

function startControlledUpstream() {
  const requests = [];
  const pending = [];
  let released = false;
  function respond(res, body) {
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...NON_STREAM_BODY, model: body.model }));
  }
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ req, res, body: parsed });
      if (released) respond(res, parsed);
      else pending.push({ req, res, body: parsed });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        requests,
        pending,
        url: `http://127.0.0.1:${port}`,
        respondAll() {
          released = true;
          while (pending.length) {
            const { res, body } = pending.shift();
            respond(res, body);
          }
        },
        close: () => server.close(),
      });
    });
  });
}

function sendRawRequest(url, { headers, chunks, end = true }) {
  const target = new URL(url);
  let req;
  const response = new Promise((resolve, reject) => {
    req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers,
      },
      (res) => {
        const responseChunks = [];
        res.on("data", (chunk) => responseChunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(responseChunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    if (end) req.end();
  });
  return { req, response };
}

async function startProxy(opts) {
  const { server, counters, meterRoot, dbHydration } = createProxyServer(opts);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    server,
    counters,
    meterRoot,
    dbHydration,
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  };
}

function startMockMeterDb({ aggregateRows = [], postStatus = 201 } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, bodyText });
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(aggregateRows));
        return;
      }
      res.writeHead(postStatus, { "content-type": "application/json" });
      res.end(
        postStatus >= 200 && postStatus < 300 ? "" : JSON.stringify({ error: "fake failure" })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, requests, url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

// ---------------------------------------------------------------------------
// Boot validation
// ---------------------------------------------------------------------------

test("createProxyServer: refuses to boot without a proxy token or an upstream key", () => {
  assert.throws(() => createProxyServer({ upstreamKey: "sk-real" }), /CAREERRAT_PROXY_TOKEN/);
  assert.throws(() => createProxyServer({ proxyToken: "devtok" }), /CAREERRAT_UPSTREAM_KEY/);
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test("proxy: 401 with no token and with the wrong token; never reaches upstream", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real",
    upstreamUrl: upstream.url,
    meterRoot: root,
  });
  try {
    const noAuth = await fetch(`${proxy.url}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(noAuth.status, 401);
    await noAuth.json();

    const wrongAuth = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: "{}",
    });
    assert.equal(wrongAuth.status, 401);
    await wrongAuth.json();

    const meterNoAuth = await fetch(`${proxy.url}/meter`);
    assert.equal(meterNoAuth.status, 401);
    await meterNoAuth.json();

    assert.equal(upstream.requests.length, 0);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// x-api-key is how the real Anthropic SDK client authenticates when
// ANTHROPIC_API_KEY is set (verified against the installed
// @anthropic-ai/claude-agent-sdk bundle) — this is how the embedded skill
// runtime (P0-4) routes the Agent SDK's own traffic through this proxy, with
// no Authorization header at all.
test("proxy: accepts the proxy token via a bare x-api-key header (no Authorization)", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
  });
  try {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "devtok", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(upstream.requests.length, 1);
    // The client's OWN x-api-key (the proxy token) must never reach upstream —
    // the proxy overwrites it with the real upstream key, same as the
    // Authorization-header path strips the client's bearer token.
    assert.equal(upstream.requests[0].headers["x-api-key"], "sk-real-upstream");

    const meterRes = await fetch(`${proxy.url}/meter`, { headers: { "x-api-key": "devtok" } });
    assert.equal(meterRes.status, 200);
    const meter = await meterRes.json();
    assert.equal(meter.requests, 1);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: 401 when x-api-key carries the wrong token; never reaches upstream", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real",
    upstreamUrl: upstream.url,
    meterRoot: root,
  });
  try {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "wrong-token", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 401);
    await res.json();
    assert.equal(upstream.requests.length, 0);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Non-stream: forwarding, header injection/stripping, byte fidelity, metering
// ---------------------------------------------------------------------------

test("proxy (non-stream): injects upstream headers, strips client auth/labels, forwards bytes verbatim, meters", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real-upstream",
    upstreamUrl: upstream.url,
    upstreamHeaders: { "x-portkey-config": "cfg-1" },
    meterRoot: root,
  });
  try {
    const reqBody = JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    });
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer devtok",
        "content-type": "application/json",
        "x-careerrat-feature": "application-tailoring",
        "x-careerrat-skill": "apply-job",
        "x-careerrat-action": "tailor",
        "x-careerrat-operation": "packet.generate",
      },
      body: reqBody,
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, JSON.stringify({ ...NON_STREAM_BODY, model: "claude-sonnet-5" }));

    assert.equal(upstream.requests.length, 1);
    const [upReq] = upstream.requests;
    assert.equal(upReq.headers["x-api-key"], "sk-real-upstream");
    assert.equal(upReq.headers["anthropic-version"], "2023-06-01");
    assert.equal(upReq.headers["x-portkey-config"], "cfg-1");
    assert.equal(upReq.headers.authorization, undefined);
    assert.equal(upReq.headers["x-careerrat-feature"], undefined);
    assert.equal(upReq.headers["x-careerrat-skill"], undefined);
    assert.equal(upReq.headers["x-careerrat-action"], undefined);
    assert.equal(upReq.headers["x-careerrat-operation"], undefined);
    assert.equal(upReq.headers["ai-reporting-user"], undefined);
    assert.equal(upReq.headers["ai-reporting-tags"], undefined);

    const expected = computeCost("claude-sonnet-5", {
      tokens_in: 1000,
      tokens_out: 500,
      cache_read_tokens: 100,
      cache_creation_tokens: 200,
    });
    const events = readUsageEvents({ root });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "proxy");
    assert.equal(events[0].feature, "application-tailoring");
    assert.equal(events[0].skill, "apply-job");
    assert.equal(events[0].action, "tailor");
    assert.equal(events[0].operation, "packet.generate");
    assert.equal(events[0].model, "claude-sonnet-5");
    assert.equal(events[0].tokens_in, 1000);
    assert.equal(events[0].tokens_out, 500);
    assert.equal(events[0].cache_read_tokens, 100);
    assert.equal(events[0].cache_creation_tokens, 200);
    assert.equal(events[0].priced, true);
    assert.equal(events[0].cost_usd, expected.cost_usd);
    assert.equal(events[0].upstream, new URL(upstream.url).host); // cost-drift visibility
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: multi-token map and legacy token form one auth union; wrong tokens 401", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "fake-legacy-token",
    proxyTokens: { alpha: "fake-alpha-token", beta: "fake-beta-token" },
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
  });
  try {
    for (const token of ["fake-alpha-token", "fake-beta-token", "fake-legacy-token"]) {
      const res = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
      });
      assert.equal(res.status, 200);
      await res.text();
    }
    const wrong = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer fake-wrong-token", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(wrong.status, 401);
    await wrong.json();
    assert.equal(upstream.requests.length, 3);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: usage attributes distinct token hashes and labels without persisting raw tokens", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const tokens = {
    alpha: "fake-private-alpha-token",
    beta: "fake-private-beta-token",
    default: "fake-private-default-token",
  };
  const proxy = await startProxy({
    proxyToken: tokens.default,
    proxyTokens: { alpha: tokens.alpha, beta: tokens.beta },
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
  });
  try {
    for (const token of [tokens.alpha, tokens.beta, tokens.default]) {
      const res = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
      });
      assert.equal(res.status, 200);
      await res.text();
    }

    const events = readUsageEvents({ root });
    assert.deepEqual(
      events.map((event) => event.userLabel),
      ["alpha", "beta", "default"]
    );
    assert.deepEqual(
      events.map((event) => event.user),
      [tokens.alpha, tokens.beta, tokens.default].map(reportingUserId)
    );
    assert.equal(new Set(events.map((event) => event.user)).size, 3);

    const meterFile = readFileSync(usageLogAbsPath(root), "utf8");
    for (const token of Object.values(tokens)) assert.equal(meterFile.includes(token), false);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: forwards while under cap, then 402s the next request without upstream or identity leakage", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const token = "fake-capped-token";
  const perRequestCost = computeCost("claude-sonnet-5", {
    tokens_in: 1000,
    tokens_out: 500,
    cache_read_tokens: 100,
    cache_creation_tokens: 200,
  }).cost_usd;
  const proxy = await startProxy({
    proxyTokens: { cappedTester: token },
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    userCapUsd: perRequestCost,
  });
  try {
    const request = () =>
      fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-careerrat-skill": "fake-skill",
        },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
      });
    const underCap = await request();
    assert.equal(underCap.status, 200);
    await underCap.text();
    assert.equal(upstream.requests.length, 1);

    const capped = await request();
    assert.equal(capped.status, 402);
    const body = await capped.json();
    assert.equal(body.error.type, "cap_exceeded");
    assert.equal(JSON.stringify(body).includes(token), false);
    assert.equal(JSON.stringify(body).includes("cappedTester"), false);
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0].headers["x-careerrat-skill"], undefined);
    assert.equal(upstream.requests[0].headers["ai-reporting-user"], undefined);
    assert.equal(upstream.requests[0].headers["ai-reporting-tags"], undefined);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: serializes capped requests per user so concurrent calls cannot all spend the same balance", async () => {
  const upstream = await startControlledUpstream();
  const root = tempRoot();
  const perRequestCost = computeCost("claude-sonnet-5", {
    tokens_in: 1000,
    tokens_out: 500,
    cache_read_tokens: 100,
    cache_creation_tokens: 200,
  }).cost_usd;
  const proxy = await startProxy({
    proxyTokens: { cappedTester: "fake-concurrent-token" },
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    userCapUsd: perRequestCost,
  });
  const send = () =>
    fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer fake-concurrent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
  try {
    const responses = [send(), send()];
    await waitFor(
      () => upstream.requests.length >= 1,
      "first capped request did not reach upstream"
    );
    upstream.respondAll();
    const settled = await Promise.all(responses);
    assert.deepEqual(settled.map((response) => response.status).sort(), [200, 402]);
    await Promise.all(settled.map((response) => response.text()));
    assert.equal(upstream.requests.length, 1);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: capped admission remains concurrent across different users", async () => {
  const upstream = await startControlledUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyTokens: { alpha: "fake-alpha-concurrent", beta: "fake-beta-concurrent" },
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    userCapUsd: 1,
  });
  const send = (token) =>
    fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
  try {
    const responses = [send("fake-alpha-concurrent"), send("fake-beta-concurrent")];
    await waitFor(
      () => upstream.requests.length === 2,
      "different capped users were serialized behind one another"
    );
    upstream.respondAll();
    const settled = await Promise.all(responses);
    assert.deepEqual(
      settled.map((response) => response.status),
      [200, 200]
    );
    await Promise.all(settled.map((response) => response.text()));
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: aborting a capped request releases that user's admission slot", async () => {
  const upstream = await startControlledUpstream();
  const root = tempRoot();
  const token = "fake-abort-token";
  const proxy = await startProxy({
    proxyTokens: { abortTester: token },
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    userCapUsd: 1,
  });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const body = JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] });
  try {
    const first = sendRawRequest(`${proxy.url}/v1/messages`, { headers, chunks: [body] });
    first.response.catch(() => {});
    await waitFor(() => upstream.requests.length === 1, "aborted request did not reach upstream");
    first.req.destroy();

    const second = fetch(`${proxy.url}/v1/messages`, { method: "POST", headers, body });
    await waitFor(
      () => upstream.requests.length === 2,
      "aborted request kept the user's admission slot"
    );
    upstream.respondAll();
    const response = await second;
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: aborting while a capped body is still arriving releases admission", async () => {
  const upstream = await startControlledUpstream();
  const root = tempRoot();
  const token = "fake-partial-abort-token";
  const proxy = await startProxy({
    proxyTokens: { partialAbortTester: token },
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    userCapUsd: 1,
  });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    const first = sendRawRequest(`${proxy.url}/v1/messages`, {
      headers,
      chunks: ['{"model":"claude-sonnet-5",'],
      end: false,
    });
    first.response.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 25));
    first.req.destroy();

    const second = fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    await waitFor(
      () => upstream.requests.length === 1,
      "partial-body abort kept the user's admission slot"
    );
    upstream.respondAll();
    const response = await second;
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: a documented gateway model is priced and advances a capped user's spend", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const model = "anthropic/claude-sonnet-4.6";
  const perRequestCost = computeCost("claude-sonnet-4-6", {
    tokens_in: 1000,
    tokens_out: 500,
    cache_read_tokens: 100,
    cache_creation_tokens: 200,
  }).cost_usd;
  const proxy = await startProxy({
    proxyToken: "fake-gateway-token",
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    userCapUsd: perRequestCost,
  });
  const send = () =>
    fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer fake-gateway-token", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 16, messages: [] }),
    });
  try {
    const first = await send();
    assert.equal(first.status, 200);
    await first.text();
    const second = await send();
    assert.equal(second.status, 402);
    await second.text();
    const [event] = readUsageEvents({ root });
    assert.equal(event.model, model);
    assert.equal(event.priced, true);
    assert.equal(event.cost_usd, perRequestCost);
    assert.equal(upstream.requests.length, 1);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: capped users cannot dispatch a model with unknown pricing", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "fake-unpriced-capped-token",
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    userCapUsd: 1,
  });
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer fake-unpriced-capped-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "unknown-priced-model", max_tokens: 16, messages: [] }),
    });
    assert.equal(response.status, 402);
    const body = await response.json();
    assert.equal(body.error.type, "cap_exceeded");
    assert.match(body.error.message, /model is unavailable/i);
    assert.equal(upstream.requests.length, 0);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: per-label caps override global cap, including zero for unlimited", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const perRequestCost = computeCost("claude-sonnet-5", {
    tokens_in: 1000,
    tokens_out: 500,
    cache_read_tokens: 100,
    cache_creation_tokens: 200,
  }).cost_usd;
  const proxy = await startProxy({
    proxyTokens: { strict: "fake-strict-token", unlimited: "fake-unlimited-token" },
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    userCapUsd: perRequestCost * 10,
    userCaps: { strict: perRequestCost, unlimited: 0 },
  });
  const send = (token) =>
    fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
  try {
    for (const expectedStatus of [200, 402]) {
      const res = await send("fake-strict-token");
      assert.equal(res.status, expectedStatus);
      await res.text();
    }
    for (let i = 0; i < 2; i++) {
      const res = await send("fake-unlimited-token");
      assert.equal(res.status, 200);
      await res.text();
    }
    assert.equal(upstream.requests.length, 3);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: absent and zero global caps are unlimited", async () => {
  const upstream = await startMockUpstream();
  const roots = [tempRoot(), tempRoot()];
  const proxies = [];
  try {
    for (const [index, userCapUsd] of [undefined, 0].entries()) {
      const proxy = await startProxy({
        proxyToken: `fake-unlimited-${index}`,
        upstreamKey: "sk-fake-upstream",
        upstreamUrl: upstream.url,
        meterRoot: roots[index],
        userCapUsd,
      });
      proxies.push(proxy);
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${proxy.url}/v1/messages`, {
          method: "POST",
          headers: {
            authorization: `Bearer fake-unlimited-${index}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
        });
        assert.equal(res.status, 200);
        await res.text();
      }
    }
    assert.equal(upstream.requests.length, 4);
  } finally {
    for (const proxy of proxies) proxy.close();
    upstream.close();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("createProxyServer: rehydrates per-user spend so caps survive restart", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const token = "fake-restart-token";
  const perRequestCost = computeCost("claude-sonnet-5", {
    tokens_in: 1000,
    tokens_out: 500,
    cache_read_tokens: 100,
    cache_creation_tokens: 200,
  }).cost_usd;
  const options = {
    proxyTokens: { restartTester: token },
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    userCapUsd: perRequestCost,
  };
  let first;
  let second;
  try {
    first = await startProxy(options);
    const initial = await fetch(`${first.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    assert.equal(initial.status, 200);
    await initial.text();
    first.close();

    second = await startProxy(options);
    const afterRestart = await fetch(`${second.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    assert.equal(afterRestart.status, 402);
    await afterRestart.json();
    assert.equal(upstream.requests.length, 1);
  } finally {
    first?.close();
    second?.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy (non-stream): metered bounded calls write labels and allowed usage keys only", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
  });
  try {
    const reqBody = JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content:
            "PROMPT_SECRET_02_07 RESUME_SECRET_02_07 JD_SECRET_02_07 " +
            "CANDIDATE_FACT_SECRET_02_07 PAGE_BODY_SECRET_02_07",
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          name: "company_seed_response",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { seeds: { type: "array" } },
            required: ["seeds"],
          },
        },
      },
    });
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer devtok",
        "content-type": "application/json",
        "x-careerrat-feature": "company-discovery",
        "x-careerrat-skill": "discover-companies",
        "x-careerrat-action": "seed-generate",
        "x-careerrat-operation": "company-seeds",
      },
      body: reqBody,
    });
    assert.equal(res.status, 200);
    await res.text();

    const events = readUsageEvents({ root });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "proxy");
    assert.equal(events[0].feature, "company-discovery");
    assert.equal(events[0].skill, "discover-companies");
    assert.equal(events[0].action, "seed-generate");
    assert.equal(events[0].operation, "company-seeds");
    assert.equal(events[0].model, "claude-sonnet-5");
    assertUsageEventIsMetadataOnly(events[0]);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Optional PostgREST meter sink
// ---------------------------------------------------------------------------

test("proxy: healthy meter DB receives metadata-only snake_case event and JSONL stays empty", async () => {
  const upstream = await startMockUpstream();
  const meterDb = await startMockMeterDb();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyTokens: { fakeTester: "fake-db-token" },
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    meterDbUrl: meterDb.url,
    meterDbKey: "fake-service-role-key",
  });
  try {
    await proxy.dbHydration;
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer fake-db-token",
        "content-type": "application/json",
        "x-careerrat-feature": "company-discovery",
        "x-careerrat-skill": "discover-companies",
        "x-careerrat-action": "seed-generate",
        "x-careerrat-operation": "company-seeds",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 16,
        messages: [{ role: "user", content: FORBIDDEN_CONTENT.join(" ") }],
      }),
    });
    assert.equal(res.status, 200);
    await res.text();

    await waitFor(
      () => meterDb.requests.some((request) => request.method === "POST"),
      "meter DB did not receive usage event"
    );
    const post = meterDb.requests.find((request) => request.method === "POST");
    const row = JSON.parse(post.bodyText);
    assert.equal(row.user_id, reportingUserId("fake-db-token"));
    assert.equal(row.user_label, "fakeTester");
    assert.equal(Object.hasOwn(row, "user"), false);
    assert.equal(Object.hasOwn(row, "userLabel"), false);
    const { user_id, user_label, ...canonicalFields } = row;
    assertUsageEventIsMetadataOnly({ ...canonicalFields, user: user_id, userLabel: user_label });
    assert.equal(post.headers.apikey, "fake-service-role-key");
    assert.equal(post.headers.authorization, "Bearer fake-service-role-key");
    assert.equal(post.headers.prefer, "return=minimal");
    assert.equal(readUsageEvents({ root }).length, 0);
  } finally {
    proxy.close();
    meterDb.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: meter DB failure preserves 200 response and writes exactly one JSONL fallback row", async () => {
  const upstream = await startMockUpstream();
  const meterDb = await startMockMeterDb({ postStatus: 503 });
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "fake-fallback-token",
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    meterDbUrl: meterDb.url,
    meterDbKey: "fake-service-role-key",
  });
  try {
    await proxy.dbHydration;
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer fake-fallback-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();
    await waitFor(() => readUsageEvents({ root }).length === 1, "JSONL fallback was not written");
    assert.equal(readUsageEvents({ root }).length, 1);
    assert.equal(meterDb.requests.filter((request) => request.method === "POST").length, 1);
  } finally {
    proxy.close();
    meterDb.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: DB hydration restores prior user spend and rejects the first over-cap request", async () => {
  const upstream = await startMockUpstream();
  const token = "fake-hydrated-token";
  const userId = reportingUserId(token);
  const meterDb = await startMockMeterDb({ aggregateRows: [{ user_id: userId, sum: "1.50" }] });
  const root = tempRoot();
  const proxy = await startProxy({
    proxyTokens: { hydratedTester: token },
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    userCapUsd: 1,
    meterDbUrl: meterDb.url,
    meterDbKey: "fake-service-role-key",
  });
  try {
    await proxy.dbHydration;
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error.type, "cap_exceeded");
    assert.equal(upstream.requests.length, 0);
    assert.equal(meterDb.requests.filter((request) => request.method === "POST").length, 0);
  } finally {
    proxy.close();
    meterDb.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: meter DB unset makes no DB fetch calls and retains JSONL behavior", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const dbFetchCalls = [];
  const proxy = await startProxy({
    proxyToken: "fake-jsonl-token",
    upstreamKey: "sk-fake-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    fetchImpl: async (...args) => {
      dbFetchCalls.push(args);
      throw new Error("DB fetch must remain disabled");
    },
  });
  try {
    await proxy.dbHydration;
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer fake-jsonl-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(dbFetchCalls.length, 0);
    assert.equal(readUsageEvents({ root }).length, 1);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Opt-in Vercel AI Gateway attribution headers (CAREERRAT_UPSTREAM_REPORTING)
// ---------------------------------------------------------------------------

test("proxy: CAREERRAT_UPSTREAM_REPORTING=1 injects ai-reporting-user/-tags, never the raw token", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    env: { CAREERRAT_UPSTREAM_REPORTING: "1" },
  });
  try {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer devtok",
        "content-type": "application/json",
        "x-careerrat-feature": "job-evaluation",
        "x-careerrat-skill": "evaluate-job",
        "x-careerrat-action": "gate",
        "x-careerrat-operation": "job.gate",
      },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(upstream.requests.length, 1);
    const [upReq] = upstream.requests;
    const expectedUserId = reportingUserId("devtok");
    assert.equal(upReq.headers["ai-reporting-user"], expectedUserId);
    assert.equal(
      upReq.headers["ai-reporting-tags"],
      "feature:job-evaluation,skill:evaluate-job,action:gate,operation:job.gate"
    );

    // The raw proxy token must never appear as any outbound header value.
    for (const value of Object.values(upReq.headers)) {
      assert.notEqual(String(value), "devtok");
    }
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: reporting headers are absent when CAREERRAT_UPSTREAM_REPORTING is unset (default off)", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
  });
  try {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer devtok",
        "content-type": "application/json",
        "x-careerrat-skill": "evaluate-job",
      },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();

    const [upReq] = upstream.requests;
    assert.equal(upReq.headers["ai-reporting-user"], undefined);
    assert.equal(upReq.headers["ai-reporting-tags"], undefined);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: ai-reporting-tags omitted when no x-careerrat-skill/-action headers are sent", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    env: { CAREERRAT_UPSTREAM_REPORTING: "1" },
  });
  try {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer devtok", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();

    const [upReq] = upstream.requests;
    assert.notEqual(upReq.headers["ai-reporting-user"], undefined); // still attributed
    assert.equal(upReq.headers["ai-reporting-tags"], undefined); // nothing to tag
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// Documents CURRENT precedence, not new behavior: a bearer-auth-style upstream
// (CAREERRAT_UPSTREAM_HEADERS carrying its own "authorization") rides through
// the trailing Object.assign in buildUpstreamHeaders(), and x-api-key still
// carries the upstream key set earlier in the same function — the two can
// coexist for a gateway that wants both.
test("proxy: CAREERRAT_UPSTREAM_HEADERS carrying authorization rides through Object.assign; x-api-key still the upstream key", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real-upstream",
    upstreamUrl: upstream.url,
    upstreamHeaders: { authorization: "Bearer gateway-side-token" },
    meterRoot: root,
  });
  try {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer devtok", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();

    const [upReq] = upstream.requests;
    assert.equal(upReq.headers.authorization, "Bearer gateway-side-token");
    assert.equal(upReq.headers["x-api-key"], "sk-real-upstream");
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Stream: byte fidelity + incremental usage parsing
// ---------------------------------------------------------------------------

test("proxy (stream): forwards SSE bytes verbatim and meters from message_start + final message_delta", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real",
    upstreamUrl: upstream.url,
    meterRoot: root,
  });
  try {
    const reqBody = JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 32,
      stream: true,
      messages: [],
    });
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer devtok", "content-type": "application/json" },
      body: reqBody,
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, sseFixture("claude-sonnet-5"));

    const events = readUsageEvents({ root });
    assert.equal(events.length, 1);
    assert.equal(events[0].model, "claude-sonnet-5");
    assert.equal(events[0].tokens_in, 2000);
    // final message_delta usage.output_tokens (750), not message_start's placeholder (1)
    assert.equal(events[0].tokens_out, 750);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unknown model — never fabricate a price
// ---------------------------------------------------------------------------

test("proxy: unknown model is metered as unpriced with cost_usd:null", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real",
    upstreamUrl: upstream.url,
    meterRoot: root,
  });
  try {
    const reqBody = JSON.stringify({
      model: "some-unreleased-model",
      max_tokens: 16,
      messages: [],
    });
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer devtok", "content-type": "application/json" },
      body: reqBody,
    });
    assert.equal(res.status, 200);
    await res.text();

    const events = readUsageEvents({ root });
    assert.equal(events.length, 1);
    assert.equal(events[0].model, "some-unreleased-model");
    assert.equal(events[0].priced, false);
    assert.equal(events[0].cost_usd, null);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Exact managed-proxy surface
// ---------------------------------------------------------------------------

test("proxy: rejects every authenticated method/path except POST /v1/messages", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real",
    upstreamUrl: upstream.url,
    meterRoot: root,
  });
  try {
    const attempts = [
      fetch(`${proxy.url}/v1/messages/batches`, {
        method: "POST",
        headers: { authorization: "Bearer devtok", "content-type": "application/json" },
        body: "{}",
      }),
      fetch(`${proxy.url}/v1/messages`, { headers: { authorization: "Bearer devtok" } }),
      fetch(`${proxy.url}/v1/models`, { headers: { authorization: "Bearer devtok" } }),
    ];
    const responses = await Promise.all(attempts);
    assert.deepEqual(
      responses.map((response) => response.status),
      [404, 404, 404]
    );
    await Promise.all(responses.map((response) => response.json()));
    assert.equal(upstream.requests.length, 0);
    assert.equal(readUsageEvents({ root }).length, 0);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: rejects a declared oversized body with 413 before upstream", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real",
    upstreamUrl: upstream.url,
    meterRoot: root,
    maxRequestBytes: 32,
  });
  const body = JSON.stringify({ model: "claude-sonnet-5", messages: [] });
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer devtok",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.type, "request_too_large");
    assert.equal(upstream.requests.length, 0);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: bounds chunked bodies and returns 413 without an upstream request", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real",
    upstreamUrl: upstream.url,
    meterRoot: root,
    maxRequestBytes: 32,
  });
  try {
    const { response } = sendRawRequest(`${proxy.url}/v1/messages`, {
      headers: { authorization: "Bearer devtok", "content-type": "application/json" },
      chunks: ['{"model":"claude-', 'sonnet-5","messages":[]}'],
    });
    const result = await response;
    assert.equal(result.status, 413);
    assert.equal(JSON.parse(result.body).error.type, "request_too_large");
    assert.equal(upstream.requests.length, 0);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: unknown (non-/v1/*, non-/meter) path returns 404", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real",
    upstreamUrl: upstream.url,
    meterRoot: root,
  });
  try {
    const res = await fetch(`${proxy.url}/nope`, { headers: { authorization: "Bearer devtok" } });
    assert.equal(res.status, 404);
    await res.json();
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// /meter aggregation
// ---------------------------------------------------------------------------

test("GET /meter: aggregates requests/tokens/cost across requests, and requires auth", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real",
    upstreamUrl: upstream.url,
    meterRoot: root,
  });
  try {
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { authorization: "Bearer devtok", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
      });
      await res.text(); // drain before issuing the next request on the same origin
    }

    const meterRes = await fetch(`${proxy.url}/meter`, {
      headers: { authorization: "Bearer devtok" },
    });
    assert.equal(meterRes.status, 200);
    const meter = await meterRes.json();
    assert.equal(meter.requests, 2);
    assert.equal(meter.tokens_in, 2000);
    assert.equal(meter.tokens_out, 1000);
    assert.equal(meter.unpriced_requests, 0);

    const perRequestCost = computeCost("claude-sonnet-5", {
      tokens_in: 1000,
      tokens_out: 500,
      cache_read_tokens: 100,
      cache_creation_tokens: 200,
    }).cost_usd;
    assert.ok(Math.abs(meter.cost_usd - perRequestCost * 2) < 1e-9);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("createProxyServer: seeds /meter counters from prior proxy-sourced rows in the usage log", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  // Pre-seed the log as if a prior proxy process already recorded a request.
  const { appendUsageEvent } = await import("../src/core/ai/usage-log.mjs");
  appendUsageEvent(
    { source: "proxy", model: "claude-sonnet-5", tokens_in: 500, tokens_out: 250 },
    { root }
  );
  // A byok-sourced row must NOT be folded into the proxy's own counters.
  appendUsageEvent(
    { source: "byok", model: "claude-sonnet-5", tokens_in: 999, tokens_out: 999 },
    { root }
  );

  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real",
    upstreamUrl: upstream.url,
    meterRoot: root,
  });
  try {
    const meterRes = await fetch(`${proxy.url}/meter`, {
      headers: { authorization: "Bearer devtok" },
    });
    const meter = await meterRes.json();
    assert.equal(meter.requests, 1);
    assert.equal(meter.tokens_in, 500);
    assert.equal(meter.tokens_out, 250);
  } finally {
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});
