import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { mountOnboardRoutes } from "../src/cli/onboard-route.mjs";
import { AI_ENV_RELPATH, writeLocalAiKey } from "../src/core/ai/ai-env.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-onboard-ai-key-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

function bootServer(repoRoot, { env = {}, fetchImpl } = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountOnboardRoutes({ addRoute, repoRoot, env, fetchImpl });
  return { routes, env };
}

async function invokeJson(server, method, path, payload) {
  const route = server.routes.get(`${method} ${path}`);
  assert.ok(route, `missing route: ${method} ${path}`);
  let resolveEnded;
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]);
  req.method = method;
  req.url = path;
  const res = {
    status: null,
    headers: null,
    rawBody: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(chunk = "") {
      this.rawBody += chunk;
      resolveEnded();
      return this;
    },
  };
  await route(req, res);
  if (res.status === null) await ended;
  return { status: res.status, body: res.rawBody ? JSON.parse(res.rawBody) : {} };
}

function postJson(server, path, payload) {
  return invokeJson(server, "POST", path, payload);
}

after(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/settings/ai-key/validate validates with Anthropic before storing", async () => {
  const repoRoot = tempRepo();
  const calls = [];
  const server = bootServer(repoRoot, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  });

  const key = "sk-ant-valid-looking-key-123456";
  const { status, body } = await postJson(server, "/api/settings/ai-key/validate", {
    provider: "anthropic",
    apiKey: key,
  });

  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, route: "byok", provider: "anthropic" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["x-api-key"], key);
  assert.equal(server.env.ANTHROPIC_API_KEY, key);
  const aiEnv = readFileSync(userPath({ repoRoot }, AI_ENV_RELPATH), "utf8");
  assert.match(aiEnv, /ANTHROPIC_API_KEY=sk-ant-valid-looking-key-123456/);
  assert.equal(JSON.stringify(body).includes(key), false);
});

test("POST /api/settings/ai-key/validate does not store rejected keys", async () => {
  const repoRoot = tempRepo();
  const env = {};
  const server = bootServer(repoRoot, {
    env,
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { type: "authentication_error" } }), { status: 401 }),
  });

  const key = "sk-ant-invalid-looking-key-123456";
  const { status, body } = await postJson(server, "/api/settings/ai-key/validate", {
    provider: "anthropic",
    apiKey: key,
  });

  assert.equal(status, 401);
  assert.equal(body.ok, false);
  assert.equal(body.code, "authentication_error");
  assert.equal(JSON.stringify(body).includes(key), false);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(existsSync(userPath({ repoRoot }, AI_ENV_RELPATH)), false);
});

test("POST /api/settings/ai-key/check validates the configured BYOK route", async () => {
  const repoRoot = tempRepo();
  const env = {};
  writeLocalAiKey({
    repoRoot,
    apiKey: "sk-ant-configured-looking-key-123456",
    env,
  });
  const calls = [];
  const server = bootServer(repoRoot, {
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  });

  const { status, body } = await postJson(server, "/api/settings/ai-key/check", {
    provider: "anthropic",
  });

  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, route: "byok", provider: "anthropic" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["x-api-key"], "sk-ant-configured-looking-key-123456");
});
