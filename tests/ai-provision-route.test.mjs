import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import { mountAiProvisionRoutes } from "../src/cli/ai-provision-route.mjs";

const tempRoots = new Set();

function buildTempRoot() {
  const root = mkdtempSync(join(tmpdir(), "rolester-ai-provision-route-"));
  tempRoots.add(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function bootRouteServer({
  repoRoot = buildTempRoot(),
  env = {},
  fetchImpl = async () => {},
} = {}) {
  const routes = new Map();
  const addRoute = (method, path, handler) => routes.set(`${method} ${path}`, handler);
  mountAiProvisionRoutes({ addRoute, repoRoot, env, fetchImpl });
  return { routes, repoRoot };
}

async function fetchRoute(server, input, options = {}) {
  const url = new URL(input);
  const method = options.method || "GET";
  const route = server.routes.get(`${method} ${url.pathname}`);
  assert.ok(route, `missing route: ${method} ${url.pathname}`);

  const req = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]);
  req.method = method;
  req.url = `${url.pathname}${url.search}`;
  req.headers = { host: url.host, ...(options.headers || {}) };

  let resolveEnded;
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const result = { status: null, headers: new Headers(), body: "" };
  const res = {
    writeHead(status, headers = {}) {
      result.status = status;
      result.headers = new Headers(headers);
      return this;
    },
    end(chunk = "") {
      result.body += chunk;
      resolveEnded();
      return this;
    },
  };
  await route(req, res);
  if (result.status === null) await ended;

  return {
    status: result.status,
    headers: result.headers,
    text: async () => result.body,
    json: async () => JSON.parse(result.body),
  };
}

function post(server, body) {
  return fetchRoute(server, "http://127.0.0.1:7777/api/settings/ai-managed/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function upstream(status, body, headers = {}) {
  return {
    status,
    headers: new Headers(headers),
    json: async () => body,
  };
}

test("connect rejects a missing jwt", async () => {
  const server = bootRouteServer();
  const response = await post(server, {});

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, error: "body.jwt is required" });
});

test("connect rejects a request body over 16KB", async () => {
  const server = bootRouteServer();
  const response = await fetchRoute(
    server,
    "http://127.0.0.1:7777/api/settings/ai-managed/connect",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jwt: "x".repeat(16 * 1024) }),
    }
  );

  assert.equal(response.status, 413);
});

test("connect maps upstream 401 to unauthorized", async () => {
  const server = bootRouteServer({ fetchImpl: async () => upstream(401, {}) });
  const response = await post(server, { jwt: "fake-jwt" });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
});

test("connect maps upstream 429 and passes through Retry-After", async () => {
  const server = bootRouteServer({
    fetchImpl: async () => upstream(429, {}, { "retry-after": "17" }),
  });
  const response = await post(server, { jwt: "fake-jwt" });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "17");
  assert.deepEqual(await response.json(), { ok: false, error: "rate_limited" });
});

test("connect maps other upstream failures to exchange_failed", async () => {
  const server = bootRouteServer({ fetchImpl: async () => upstream(500, {}) });
  const response = await post(server, { jwt: "fake-jwt" });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: "exchange_failed" });
});

test("connect maps fetch exceptions to exchange_failed", async () => {
  const server = bootRouteServer({
    fetchImpl: async () => {
      throw new Error("simulated network failure");
    },
  });
  const response = await post(server, { jwt: "fake-jwt" });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: "exchange_failed" });
});

test("connect rejects malformed upstream JSON", async () => {
  const server = bootRouteServer({
    fetchImpl: async () => ({
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw new SyntaxError("malformed JSON");
      },
    }),
  });
  const response = await post(server, { jwt: "fake-jwt" });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: "exchange_invalid" });
});

test("connect rejects an upstream token with the wrong shape", async () => {
  const server = bootRouteServer({
    fetchImpl: async () =>
      upstream(200, { ok: true, token: "rlp_obviously-invalid", proxyUrl: "https://proxy.test" }),
  });
  const response = await post(server, { jwt: "fake-jwt" });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: "exchange_invalid" });
});

test("connect rejects a non-URL upstream proxyUrl", async () => {
  const server = bootRouteServer({
    fetchImpl: async () =>
      upstream(200, { ok: true, token: `rlp_${"e".repeat(64)}`, proxyUrl: "not a URL" }),
  });
  const response = await post(server, { jwt: "fake-jwt" });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: "exchange_invalid" });
});

test("connect exchanges the jwt, persists credentials, and never returns the minted token", async () => {
  const calls = [];
  const token = `rlp_${"f".repeat(64)}`;
  const env = { ROLESTER_MANAGED_EXCHANGE_URL: "https://exchange.example.test/base/" };
  const repoRoot = buildTempRoot();
  mkdirSync(join(repoRoot, ".internal"));
  const server = bootRouteServer({
    repoRoot,
    env,
    fetchImpl: async (...args) => {
      calls.push(args);
      return upstream(200, {
        ok: true,
        token,
        proxyUrl: "https://managed-proxy.example.test",
      });
    },
  });

  const response = await post(server, { jwt: "obviously-fake-jwt" });
  const responseText = await response.text();

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(responseText), { ok: true, route: "proxy" });
  assert.doesNotMatch(responseText, /rlp_/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://exchange.example.test/base/auth/exchange");
  assert.equal(calls[0][1].headers.authorization, "Bearer obviously-fake-jwt");

  const envPath = join(server.repoRoot, ".internal", "ai.env");
  assert.equal(
    readFileSync(envPath, "utf8"),
    `ROLESTER_AI_PROXY_URL=https://managed-proxy.example.test\nROLESTER_AI_PROXY_TOKEN=${token}\n`
  );
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
  assert.equal(env.ROLESTER_AI_PROXY_URL, "https://managed-proxy.example.test");
  assert.equal(env.ROLESTER_AI_PROXY_TOKEN, token);
});
