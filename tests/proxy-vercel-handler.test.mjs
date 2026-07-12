import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import handler from "../apps/proxy-vercel/api/v1/[...path].mjs";

const TOKEN = "fake-proxy-token";
const KEY = "fake-upstream-key";
const FORBIDDEN_CONTENT = ["PROMPT_SECRET_VERCEL", "RAW_REPLY_SECRET_VERCEL"];
const JSON_BODY = JSON.stringify({
  id: "msg_fake",
  type: "message",
  model: "claude-test-json",
  content: [{ type: "text", text: FORBIDDEN_CONTENT[1] }],
  usage: {
    input_tokens: 100,
    output_tokens: 25,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 2,
  },
});
const SSE_BODY = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-test-sse", usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: FORBIDDEN_CONTENT[1] } })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 12 } })}\n\n`,
].join("");

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))
  );
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function harness({ spent = 0 } = {}) {
  const upstreamRequests = [];
  const upstream = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      upstreamRequests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body,
      });
      if (req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
        res.end('{"data":[]}');
      } else if (JSON.parse(body).stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(SSE_BODY.slice(0, 73));
        res.end(SSE_BODY.slice(73));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON_BODY);
      }
    });
  });
  const dbRequests = [];
  const db = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      dbRequests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json" });
      res.end(
        req.method === "POST" ? "" : JSON.stringify([{ user_id: "ignored", sum: String(spent) }])
      );
    });
  });
  const upstreamUrl = await listen(upstream);
  const dbUrl = await listen(db);
  return {
    upstream,
    db,
    upstreamUrl,
    dbUrl,
    upstreamRequests,
    dbRequests,
    async stop() {
      await Promise.all([close(upstream), close(db)]);
    },
  };
}

function setEnv(h, extra = {}) {
  Object.assign(process.env, {
    ROLESTER_PROXY_TOKEN: TOKEN,
    ROLESTER_UPSTREAM_KEY: KEY,
    ROLESTER_UPSTREAM_URL: h.upstreamUrl,
    ROLESTER_METER_DB_URL: h.dbUrl,
    ROLESTER_METER_DB_KEY: "fake-db-key",
    ROLESTER_METER_DB_TABLE: "usage_events",
    ROLESTER_PROXY_USER_CAP_USD: "",
    ROLESTER_PROXY_USER_CAPS: "",
    ...extra,
  });
}
function request(path, { token = TOKEN, method = "POST", stream = false } = {}) {
  const headers = {
    "content-type": "application/json",
    "x-rolester-skill": "evaluate-job",
    "x-rolester-action": "gate",
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(`http://proxy.test${path}`, {
    method,
    headers,
    body:
      method === "GET"
        ? undefined
        : JSON.stringify({
            model: "claude-test",
            stream,
            messages: [{ role: "user", content: FORBIDDEN_CONTENT[0] }],
          }),
  });
}
function assertMetadataOnly(row) {
  assert.equal(Object.hasOwn(row, "user_id"), true);
  assert.equal(Object.hasOwn(row, "user_label"), true);
  for (const key of ["prompt", "body", "content", "messages", "user", "userLabel"])
    assert.equal(Object.hasOwn(row, key), false);
  for (const secret of FORBIDDEN_CONTENT) assert.equal(JSON.stringify(row).includes(secret), false);
}

test("handler returns 401 for absent/wrong tokens without upstream or DB traffic", async () => {
  const h = await harness();
  setEnv(h);
  try {
    for (const token of [null, "wrong"]) {
      const res = await handler(request("/v1/messages", { token }), {});
      assert.equal(res.status, 401);
      await res.text();
    }
    assert.equal(h.upstreamRequests.length, 0);
    assert.equal(h.dbRequests.length, 0);
  } finally {
    await h.stop();
  }
});

test("under-cap non-stream POST is byte-identical and meters through context.waitUntil", async () => {
  const h = await harness({ spent: 0.25 });
  setEnv(h, { ROLESTER_PROXY_USER_CAP_USD: "10" });
  const pending = [];
  const context = {
    waitUntil(promise) {
      pending.push(promise);
    },
  };
  try {
    const res = await handler(request("/v1/messages"), context);
    assert.equal(await res.text(), JSON_BODY);
    assert.equal(pending.length, 1);
    await Promise.all(pending);
    assert.equal(h.upstreamRequests.length, 1);
    assert.equal(h.upstreamRequests[0].headers.authorization, undefined);
    assert.equal(h.upstreamRequests[0].headers["x-api-key"], KEY);
    assert.equal(h.upstreamRequests[0].headers["x-rolester-skill"], undefined);
    const post = h.dbRequests.find((entry) => entry.method === "POST");
    const row = JSON.parse(post.body);
    assertMetadataOnly(row);
    assert.equal(row.tokens_in, 100);
    assert.equal(row.tokens_out, 25);
    assert.equal(row.cache_read_tokens, 5);
    assert.equal(row.cache_creation_tokens, 2);
  } finally {
    await h.stop();
  }
});

test("SSE response passes byte-for-byte and meters fixture usage", async () => {
  const h = await harness();
  setEnv(h);
  try {
    const res = await handler(request("/v1/messages", { stream: true }), {});
    assert.equal(await res.text(), SSE_BODY);
    const row = JSON.parse(h.dbRequests.find((entry) => entry.method === "POST").body);
    assertMetadataOnly(row);
    assert.equal(row.model, "claude-test-sse");
    assert.equal(row.tokens_in, 40);
    assert.equal(row.tokens_out, 12);
    assert.equal(row.cache_read_tokens, 3);
    assert.equal(row.cache_creation_tokens, 4);
  } finally {
    await h.stop();
  }
});

test("over-cap request returns 402 before touching upstream", async () => {
  const h = await harness({ spent: 2 });
  setEnv(h, { ROLESTER_PROXY_USER_CAP_USD: "2" });
  try {
    const res = await handler(request("/v1/messages"), {});
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error.type, "cap_exceeded");
    assert.equal(h.upstreamRequests.length, 0);
    assert.equal(h.dbRequests.filter((entry) => entry.method === "POST").length, 0);
  } finally {
    await h.stop();
  }
});

test("without waitUntil the handler awaits metering before the body completes", async () => {
  const h = await harness();
  setEnv(h);
  try {
    const res = await handler(request("/v1/messages"), {});
    await res.arrayBuffer();
    assert.equal(h.dbRequests.filter((entry) => entry.method === "POST").length, 1);
  } finally {
    await h.stop();
  }
});

test("GET /v1/models is a direct passthrough and is not metered", async () => {
  const h = await harness();
  setEnv(h);
  try {
    const res = await handler(request("/v1/models?limit=1", { method: "GET" }), {});
    assert.equal(await res.text(), '{"data":[]}');
    assert.equal(res.headers.get("x-upstream"), "yes");
    assert.equal(h.upstreamRequests[0].url, "/v1/models?limit=1");
    assert.equal(h.dbRequests.length, 0);
  } finally {
    await h.stop();
  }
});

test("missing serverless meter DB credentials returns request-time 500", async () => {
  const h = await harness();
  setEnv(h);
  const priorError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  try {
    delete process.env.ROLESTER_METER_DB_URL;
    delete process.env.ROLESTER_METER_DB_KEY;
    const res = await handler(request("/v1/models", { method: "GET" }), {});
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "proxy_misconfigured" });
    assert.equal(h.upstreamRequests.length, 0);
    assert.match(errors[0], /required in serverless mode/);
  } finally {
    console.error = priorError;
    await h.stop();
  }
});
