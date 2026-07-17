import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createDesktopAuthStore, mountDesktopAuthRoutes } from "../src/cli/desktop-auth-route.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = "00000000-0000-4000-8000-000000000000";

function bootRouteServer() {
  const routes = new Map();
  const addRoute = (method, path, handler) => routes.set(`${method} ${path}`, handler);
  mountDesktopAuthRoutes({ addRoute, repoRoot: "/fake/repo", env: {} });
  return { routes };
}

function baseUrl() {
  return "http://127.0.0.1:7777";
}

async function closeServer() {}

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

function post(server, url, body) {
  return fetchRoute(server, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function start(server) {
  const response = await post(server, `${baseUrl()}/api/desktop-auth/start`, {});
  assert.equal(response.status, 200);
  return response.json();
}

test("store starts pending records and reports unknown nonces", () => {
  const store = createDesktopAuthStore();
  const { nonce, expiresAt } = store.start();

  assert.match(nonce, UUID_RE);
  assert.ok(expiresAt > Date.now());
  assert.equal(store.status(nonce), "pending");
  assert.equal(store.status(UNKNOWN_UUID), "unknown");
  assert.deepEqual(store.cancel(UNKNOWN_UUID), { ok: false, code: "UNKNOWN" });
  assert.deepEqual(store.fulfill(UNKNOWN_UUID, "jwt"), { ok: false, code: "UNKNOWN" });
  assert.deepEqual(store.claim(UNKNOWN_UUID), { ok: false, code: "UNKNOWN" });
});

test("store cancel transitions only pending records to failed", () => {
  const store = createDesktopAuthStore();
  const { nonce } = store.start();

  assert.deepEqual(store.cancel(nonce), { ok: true });
  assert.equal(store.status(nonce), "failed");
  assert.deepEqual(store.cancel(nonce), {
    ok: false,
    code: "NOT_PENDING",
    state: "failed",
  });
  assert.deepEqual(store.fulfill(nonce, "jwt"), {
    ok: false,
    code: "NOT_PENDING",
    state: "failed",
  });
  assert.deepEqual(store.claim(nonce), {
    ok: false,
    code: "NOT_FULFILLED",
    state: "failed",
  });
});

test("store fulfills only pending records and claims the jwt exactly once", () => {
  const store = createDesktopAuthStore();
  const { nonce } = store.start();

  assert.deepEqual(store.claim(nonce), {
    ok: false,
    code: "NOT_FULFILLED",
    state: "pending",
  });
  assert.deepEqual(store.fulfill(nonce, "secret.jwt"), { ok: true });
  assert.equal(store.status(nonce), "fulfilled");
  assert.deepEqual(store.fulfill(nonce, "replacement.jwt"), {
    ok: false,
    code: "NOT_PENDING",
    state: "fulfilled",
  });
  assert.deepEqual(store.cancel(nonce), {
    ok: false,
    code: "NOT_PENDING",
    state: "fulfilled",
  });
  assert.deepEqual(store.claim(nonce), { ok: true, jwt: "secret.jwt" });
  assert.equal(store.status(nonce), "claimed");
  assert.deepEqual(store.claim(nonce), {
    ok: false,
    code: "NOT_FULFILLED",
    state: "claimed",
  });
});

test("store lazily expires pending records before fulfillment", () => {
  const store = createDesktopAuthStore({ pendingTtlMs: 0 });
  const { nonce } = store.start();

  assert.equal(store.status(nonce), "expired");
  assert.deepEqual(store.fulfill(nonce, "jwt"), {
    ok: false,
    code: "NOT_PENDING",
    state: "expired",
  });
});

test("store lazily expires fulfilled records before claim", () => {
  const store = createDesktopAuthStore({ fulfilledTtlMs: 0 });
  const { nonce } = store.start();

  assert.deepEqual(store.fulfill(nonce, "jwt"), { ok: true });
  assert.equal(store.status(nonce), "expired");
  assert.deepEqual(store.claim(nonce), {
    ok: false,
    code: "NOT_FULFILLED",
    state: "expired",
  });
});

test("HTTP start returns an issued nonce, sign-in URL, and expiry", async () => {
  const server = await bootRouteServer();
  try {
    const result = await start(server);

    assert.equal(result.ok, true);
    assert.match(result.nonce, UUID_RE);
    assert.equal(result.signInUrl, `${baseUrl()}/app/desktop-sign-in?nonce=${result.nonce}`);
    assert.ok(result.expiresAt > Date.now());
  } finally {
    await closeServer(server);
  }
});

test("HTTP status requires a nonce and reports unissued nonces as unknown", async () => {
  const server = await bootRouteServer();
  try {
    const missing = await fetchRoute(server, `${baseUrl()}/api/desktop-auth/status`);
    assert.equal(missing.status, 400);

    const unknown = await fetchRoute(
      server,
      `${baseUrl()}/api/desktop-auth/status?nonce=${UNKNOWN_UUID}`
    );
    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), { ok: true, status: "unknown" });
  } finally {
    await closeServer(server);
  }
});

test("HTTP mutation routes validate required body fields", async () => {
  const server = await bootRouteServer();
  try {
    for (const [path, body] of [
      ["cancel", {}],
      ["complete", { nonce: UNKNOWN_UUID }],
      ["complete", { jwt: "jwt" }],
      ["claim", {}],
    ]) {
      const response = await post(server, `${baseUrl()}/api/desktop-auth/${path}`, body);
      assert.equal(response.status, 400, `${path} should reject ${JSON.stringify(body)}`);
    }
  } finally {
    await closeServer(server);
  }
});

test("HTTP mutation routes distinguish unknown nonces from wrong states", async () => {
  const server = await bootRouteServer();
  try {
    const unknownRequests = [
      ["cancel", { nonce: UNKNOWN_UUID }],
      ["complete", { nonce: UNKNOWN_UUID, jwt: "jwt" }],
      ["claim", { nonce: UNKNOWN_UUID }],
    ];
    for (const [path, body] of unknownRequests) {
      const response = await post(server, `${baseUrl()}/api/desktop-auth/${path}`, body);
      assert.equal(response.status, 404, `${path} should reject an unknown nonce`);
    }

    const pending = await start(server);
    const prematureClaim = await post(server, `${baseUrl()}/api/desktop-auth/claim`, {
      nonce: pending.nonce,
    });
    assert.equal(prematureClaim.status, 410);

    const cancelled = await start(server);
    assert.equal(
      (await post(server, `${baseUrl()}/api/desktop-auth/cancel`, { nonce: cancelled.nonce }))
        .status,
      200
    );
    assert.equal(
      (
        await post(server, `${baseUrl()}/api/desktop-auth/complete`, {
          nonce: cancelled.nonce,
          jwt: "jwt",
        })
      ).status,
      410
    );
    assert.equal(
      (await post(server, `${baseUrl()}/api/desktop-auth/cancel`, { nonce: cancelled.nonce }))
        .status,
      410
    );
  } finally {
    await closeServer(server);
  }
});

test("handoff rejects unsafe, missing, and unissued nonces without reflecting them", async () => {
  const server = await bootRouteServer();
  try {
    const malicious = "</script><script>alert(1)</script>";
    for (const url of [
      `${baseUrl()}/api/desktop-auth/handoff`,
      `${baseUrl()}/api/desktop-auth/handoff?nonce=${encodeURIComponent(malicious)}`,
      `${baseUrl()}/api/desktop-auth/handoff?nonce=${UNKNOWN_UUID}`,
    ]) {
      const response = await fetchRoute(server, url);
      const html = await response.text();
      assert.equal(response.status, 410);
      assert.match(response.headers.get("content-type") || "", /^text\/html\b/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
      assert.doesNotMatch(html, new RegExp(UNKNOWN_UUID));
      assert.ok(!html.includes(malicious));
    }
  } finally {
    await closeServer(server);
  }
});

test("handoff without a jwt returns the cookie fallback only for an issued pending nonce", async () => {
  const server = await bootRouteServer();
  try {
    const { nonce } = await start(server);
    const response = await fetchRoute(
      server,
      `${baseUrl()}/api/desktop-auth/handoff?nonce=${nonce}`
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /^text\/html\b/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(html, /fetch\("\/api\/desktop-auth\/complete"/);
    assert.ok(html.includes(`nonce: ${JSON.stringify(nonce)}`));
  } finally {
    await closeServer(server);
  }
});

test("handoff with a jwt fulfills once and never leaks the jwt through status", async () => {
  const server = await bootRouteServer();
  try {
    const { nonce } = await start(server);
    const jwt = "header.payload/signature secret";
    const handoff = await fetchRoute(
      server,
      `${baseUrl()}/api/desktop-auth/handoff?nonce=${nonce}&__clerk_db_jwt=${encodeURIComponent(jwt)}`
    );
    const html = await handoff.text();
    assert.equal(handoff.status, 200);
    assert.equal(handoff.headers.get("cache-control"), "no-store");
    assert.match(handoff.headers.get("content-type") || "", /^text\/html\b/);
    assert.match(html, /Signed in/);

    const status = await fetchRoute(server, `${baseUrl()}/api/desktop-auth/status?nonce=${nonce}`);
    const statusText = await status.text();
    assert.deepEqual(JSON.parse(statusText), { ok: true, status: "fulfilled" });
    assert.ok(!statusText.includes(jwt));

    const repeated = await fetchRoute(
      server,
      `${baseUrl()}/api/desktop-auth/handoff?nonce=${nonce}&__clerk_db_jwt=other`
    );
    assert.equal(repeated.status, 410);
  } finally {
    await closeServer(server);
  }
});

test("HTTP happy path fulfills, claims exactly once, and ends claimed", async () => {
  const server = await bootRouteServer();
  try {
    const { nonce } = await start(server);
    const jwt = "one-time.jwt";
    const handoff = await fetchRoute(
      server,
      `${baseUrl()}/api/desktop-auth/handoff?nonce=${nonce}&__clerk_db_jwt=${encodeURIComponent(jwt)}`
    );
    assert.equal(handoff.status, 200);

    const fulfilled = await fetchRoute(
      server,
      `${baseUrl()}/api/desktop-auth/status?nonce=${nonce}`
    );
    const fulfilledText = await fulfilled.text();
    assert.deepEqual(JSON.parse(fulfilledText), { ok: true, status: "fulfilled" });
    assert.ok(!fulfilledText.includes(jwt));

    const claim = await post(server, `${baseUrl()}/api/desktop-auth/claim`, { nonce });
    assert.equal(claim.status, 200);
    assert.deepEqual(await claim.json(), { ok: true, jwt });

    const claimed = await fetchRoute(server, `${baseUrl()}/api/desktop-auth/status?nonce=${nonce}`);
    const claimedText = await claimed.text();
    assert.deepEqual(JSON.parse(claimedText), { ok: true, status: "claimed" });
    assert.ok(!claimedText.includes(jwt));

    const secondClaim = await post(server, `${baseUrl()}/api/desktop-auth/claim`, { nonce });
    assert.equal(secondClaim.status, 410);
    assert.deepEqual(await secondClaim.json(), {
      ok: false,
      code: "NOT_FULFILLED",
      state: "claimed",
    });
  } finally {
    await closeServer(server);
  }
});
