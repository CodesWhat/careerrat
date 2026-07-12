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
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProxyServer } from "../src/cli/ai-proxy.mjs";
import { computeCost, readUsageEvents } from "../src/core/ai/usage-log.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "rolester-ai-proxy-"));
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
// forwarded — and never sees the client's own bearer token or x-rolester-*
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

async function startProxy(opts) {
  const { server, counters, meterRoot } = createProxyServer(opts);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    server,
    counters,
    meterRoot,
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  };
}

// ---------------------------------------------------------------------------
// Boot validation
// ---------------------------------------------------------------------------

test("createProxyServer: refuses to boot without a proxy token or an upstream key", () => {
  assert.throws(() => createProxyServer({ upstreamKey: "sk-real" }), /ROLESTER_PROXY_TOKEN/);
  assert.throws(() => createProxyServer({ proxyToken: "devtok" }), /ROLESTER_UPSTREAM_KEY/);
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
        "x-rolester-feature": "application-tailoring",
        "x-rolester-skill": "apply-job",
        "x-rolester-action": "tailor",
        "x-rolester-operation": "packet.generate",
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
    assert.equal(upReq.headers["x-rolester-feature"], undefined);
    assert.equal(upReq.headers["x-rolester-skill"], undefined);
    assert.equal(upReq.headers["x-rolester-action"], undefined);
    assert.equal(upReq.headers["x-rolester-operation"], undefined);

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
        "x-rolester-feature": "company-discovery",
        "x-rolester-skill": "discover-companies",
        "x-rolester-action": "seed-generate",
        "x-rolester-operation": "company-seeds",
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
// Opt-in Vercel AI Gateway attribution headers (ROLESTER_UPSTREAM_REPORTING)
// ---------------------------------------------------------------------------

test("proxy: ROLESTER_UPSTREAM_REPORTING=1 injects ai-reporting-user/-tags, never the raw token", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    env: { ROLESTER_UPSTREAM_REPORTING: "1" },
  });
  try {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer devtok",
        "content-type": "application/json",
        "x-rolester-feature": "job-evaluation",
        "x-rolester-skill": "evaluate-job",
        "x-rolester-action": "gate",
        "x-rolester-operation": "job.gate",
      },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(upstream.requests.length, 1);
    const [upReq] = upstream.requests;
    const expectedUserId = createHash("sha256").update("devtok", "utf8").digest("hex").slice(0, 12);
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

test("proxy: reporting headers are absent when ROLESTER_UPSTREAM_REPORTING is unset (default off)", async () => {
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
        "x-rolester-skill": "evaluate-job",
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

test("proxy: ai-reporting-tags omitted when no x-rolester-skill/-action headers are sent", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real-upstream",
    upstreamUrl: upstream.url,
    meterRoot: root,
    env: { ROLESTER_UPSTREAM_REPORTING: "1" },
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
// (ROLESTER_UPSTREAM_HEADERS carrying its own "authorization") rides through
// the trailing Object.assign in buildUpstreamHeaders(), and x-api-key still
// carries the upstream key set earlier in the same function — the two can
// coexist for a gateway that wants both.
test("proxy: ROLESTER_UPSTREAM_HEADERS carrying authorization rides through Object.assign; x-api-key still the upstream key", async () => {
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
// Generic /v1/* passthrough (no metering outside /v1/messages)
// ---------------------------------------------------------------------------

test("proxy: generic passthrough for other /v1/* paths, no usage_event written", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  const proxy = await startProxy({
    proxyToken: "devtok",
    upstreamKey: "sk-real",
    upstreamUrl: upstream.url,
    meterRoot: root,
  });
  try {
    const res = await fetch(`${proxy.url}/v1/models`, {
      headers: { authorization: "Bearer devtok" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { data: [] });
    assert.equal(readUsageEvents({ root }).length, 0);
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
