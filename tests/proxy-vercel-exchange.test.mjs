import assert from "node:assert/strict";
import { test } from "node:test";
import handler from "../apps/proxy-vercel/api/auth/exchange.mjs";
import { hashProxyToken, looksLikeMintedToken } from "../src/cli/proxy-core.mjs";

const RAW_JWT = "raw.jwt.secret";
const ENV_KEYS = [
  "CLERK_JWT_KEY",
  "ROLESTER_METER_DB_URL",
  "ROLESTER_METER_DB_KEY",
  "ROLESTER_EXCHANGE_ALLOWED_ORIGINS",
  "ROLESTER_PUBLIC_PROXY_URL",
];

function request({ method = "POST", authorization = `Bearer ${RAW_JWT}`, body } = {}) {
  const headers = {};
  if (authorization !== null) headers.authorization = authorization;
  return new Request("https://proxy.test/auth/exchange", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
}

async function invoke({
  req = request(),
  env = {},
  verify = async () => ({ sub: "user_123", azp: "http://localhost:7777" }),
  storeFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (init.method === "POST") {
      return Response.json([{ last_issued_at: "2026-07-18T12:00:00Z" }], { status: 201 });
    }
    assert.equal(parsed.pathname, "/rest/v1/proxy_tokens");
    return Response.json([]);
  },
} = {}) {
  const priorEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const priorFetch = globalThis.fetch;
  const priorLog = console.log;
  const priorError = console.error;
  const logs = [];
  Object.assign(process.env, {
    CLERK_JWT_KEY: "fake-clerk-public-key",
    ROLESTER_METER_DB_URL: "https://fake-project.supabase.co",
    ROLESTER_METER_DB_KEY: "fake-service-role-key",
  });
  for (const key of ENV_KEYS.slice(3)) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = storeFetch;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const response = await handler(req, { verifyToken: verify });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(logs.join("\n").includes(RAW_JWT), false, "console output leaked the raw JWT");
    return { response, logs };
  } finally {
    globalThis.fetch = priorFetch;
    console.log = priorLog;
    console.error = priorError;
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("exchange rejects non-POST methods with 405 and no-store", async () => {
  const { response } = await invoke({ req: request({ method: "GET" }), env: {} });
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: "method_not_allowed" });
});

test("exchange returns 503 when Clerk or meter DB configuration is missing", async () => {
  for (const key of ["CLERK_JWT_KEY", "ROLESTER_METER_DB_URL", "ROLESTER_METER_DB_KEY"]) {
    const { response } = await invoke({ env: { [key]: undefined } });
    assert.equal(response.status, 503, key);
    assert.deepEqual(await response.json(), { error: "proxy_misconfigured" });
  }
});

test("exchange rejects request bodies over 16KB with 413", async () => {
  const { response } = await invoke({ req: request({ body: "x".repeat(16 * 1024 + 1) }) });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "payload_too_large" });
});

test("exchange rejects missing and invalid Bearer JWTs with 401", async () => {
  const missing = await invoke({ req: request({ authorization: null }) });
  assert.equal(missing.response.status, 401);
  assert.deepEqual(await missing.response.json(), { error: "unauthorized" });

  const invalid = await invoke({
    verify: async () => {
      throw new Error(`invalid ${RAW_JWT}`);
    },
  });
  assert.equal(invalid.response.status, 401);
  assert.deepEqual(await invalid.response.json(), { error: "unauthorized" });
});

test("exchange rejects verified JWT claims without a subject", async () => {
  const { response } = await invoke({ verify: async () => ({ sub: "" }) });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});

test("exchange rejects a non-loopback azp absent from allowed origins", async () => {
  const { response } = await invoke({
    verify: async () => ({ sub: "user_123", azp: "https://desktop.example" }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});

test("exchange allows loopback azp and stores only the minted-token hash", async () => {
  const calls = [];
  const { response, logs } = await invoke({
    verify: async (jwt, options) => {
      assert.equal(jwt, RAW_JWT);
      assert.deepEqual(options, { jwtKey: "fake-clerk-public-key" });
      return { sub: "user_loopback", azp: "https://127.0.0.1:54321" };
    },
    storeFetch: async (url, init = {}) => {
      calls.push({ url: new URL(url), init });
      return init.method === "POST"
        ? Response.json([{ last_issued_at: "2026-07-18T12:00:00Z" }], { status: 201 })
        : Response.json([]);
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body).sort(), ["ok", "proxyUrl", "token"]);
  assert.equal(looksLikeMintedToken(body.token), true);
  assert.equal(body.proxyUrl, "https://rolester-proxy.vercel.app");
  const upsert = calls.find((call) => call.init.method === "POST");
  const stored = JSON.parse(upsert.init.body);
  assert.equal(stored.clerk_user_id, "user_loopback");
  assert.equal(stored.label, "beta");
  assert.equal(stored.token_hash, hashProxyToken(body.token));
  assert.equal(JSON.stringify(stored).includes(body.token), false);
  assert.equal(logs.join("\n").includes(body.token), false, "console output leaked minted token");
});

test("exchange allows azp listed in ROLESTER_EXCHANGE_ALLOWED_ORIGINS", async () => {
  const { response, logs } = await invoke({
    env: {
      ROLESTER_EXCHANGE_ALLOWED_ORIGINS: JSON.stringify([
        "https://desktop.example",
        "rolester://desktop",
      ]),
      ROLESTER_PUBLIC_PROXY_URL: "https://managed.example",
    },
    verify: async () => ({ sub: "user_allowed", azp: "rolester://desktop" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(looksLikeMintedToken(body.token), true);
  assert.equal(body.proxyUrl, "https://managed.example");
  assert.equal(logs.join("\n").includes(body.token), false, "console output leaked minted token");
});

test("exchange rate limit returns 429 with exact Retry-After arithmetic", async () => {
  const priorNow = Date.now;
  Date.now = () => Date.parse("2026-07-18T12:00:29.001Z");
  try {
    const { response } = await invoke({
      storeFetch: async (_url, init = {}) => {
        assert.equal(init.method, undefined);
        return Response.json([{ last_issued_at: "2026-07-18T12:00:00Z" }]);
      },
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.deepEqual(await response.json(), { error: "rate_limited" });
  } finally {
    Date.now = priorNow;
  }
});

test("exchange returns 503 when the token-store write rejects", async () => {
  const { response } = await invoke({
    storeFetch: async (_url, init = {}) => {
      if (init.method === "POST") throw new Error("store rejected write");
      return Response.json([]);
    },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "proxy_misconfigured" });
});
