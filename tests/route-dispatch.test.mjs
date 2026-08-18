// tests/route-dispatch.test.mjs
// node:test suite for dispatchHttpRoute (src/core/tracker/route-dispatch.mjs)
// — the shared boundary every addRoute()-mounted handler runs through.
//
// Regression coverage for the P0 crash: a route handler that throws (sync,
// or as a rejected promise from an async handler) used to escape as an
// uncaught exception / unhandled rejection and kill the whole tracker:dev
// process for every in-flight request, not just the one that failed. See
// CRASH-evidence-constructor-logo*.log — src/core/tracker/demo-logos.mjs
// threw inside an async src/cli/logo-route.mjs handler with no `await`
// before the throw, so the rejection was never observed anywhere upstream.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { dispatchHttpRoute } from "../src/core/tracker/route-dispatch.mjs";

function bootServer(handler) {
  const server = createServer((req, res) => {
    const matched = dispatchHttpRoute(handler, req, res);
    if (!matched) {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("dispatchHttpRoute: a synchronous throw in the handler yields a 500, not a crash", async () => {
  const server = await bootServer((_req, _res) => {
    throw new Error("boom (sync)");
  });
  try {
    const res = await fetch(baseUrl(server));
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { error: "internal_error" });
    // The server must still be alive for the next request.
    const again = await fetch(baseUrl(server));
    assert.equal(again.status, 500);
  } finally {
    await closeServer(server);
  }
});

test("dispatchHttpRoute: a rejecting bare thenable (then but no catch) still yields a 500, and a resolving one is left alone", async () => {
  // A handler returning a then-only thenable must not blow up the boundary
  // itself: Promise.resolve normalizes it before rejection handling attaches.
  const server = await bootServer((_req, _res) => ({
    // biome-ignore lint/suspicious/noThenProperty: a bare thenable is exactly what this test exercises
    then(_onFulfilled, onRejected) {
      onRejected(new Error("boom (bare thenable)"));
      return this;
    },
  }));
  try {
    const res = await fetch(baseUrl(server));
    assert.equal(res.status, 500);
  } finally {
    await closeServer(server);
  }

  const okServer = await bootServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return {
      // biome-ignore lint/suspicious/noThenProperty: a bare thenable is exactly what this test exercises
      then(onFulfilled) {
        onFulfilled("done");
        return this;
      },
    };
  });
  try {
    const res = await fetch(baseUrl(okServer));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  } finally {
    await closeServer(okServer);
  }
});

test("dispatchHttpRoute: a rejected promise from an async handler (no await before the throw) yields a 500, not a crash", async () => {
  // Mirrors the exact shape of the real bug: an async handler that throws
  // synchronously in its body before hitting any `await` still returns a
  // *rejected promise* to the caller, never a synchronous throw.
  const server = await bootServer(async (_req, _res) => {
    throw new Error("boom (async, pre-await)");
  });
  try {
    const res = await fetch(baseUrl(server));
    assert.equal(res.status, 500);
    const again = await fetch(baseUrl(server));
    assert.equal(again.status, 500);
  } finally {
    await closeServer(server);
  }
});

test("dispatchHttpRoute: a rejection after an await also yields a 500, not a crash", async () => {
  const server = await bootServer(async (_req, _res) => {
    await Promise.resolve();
    throw new Error("boom (async, post-await)");
  });
  try {
    const res = await fetch(baseUrl(server));
    assert.equal(res.status, 500);
  } finally {
    await closeServer(server);
  }
});

test("dispatchHttpRoute: a well-behaved handler is unaffected", async () => {
  const server = await bootServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const res = await fetch(baseUrl(server));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await closeServer(server);
  }
});
