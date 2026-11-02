import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createHostThrottle, parseRetryAfter } from "../src/core/net/host-throttle.mjs";

// A fake origin that records concurrency and request times, and answers 429
// when two requests start closer together than `minGapMs`.
async function fakeServer({ minGapMs = 0, delayMs = 0, handler } = {}) {
  const state = { active: 0, maxActive: 0, starts: [], count: 0 };
  const server = createServer((req, res) => {
    state.count += 1;
    const at = Date.now();
    const previous = state.starts.at(-1);
    state.starts.push(at);
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    const finish = (status, headers = {}, body = "ok") => {
      setTimeout(() => {
        state.active -= 1;
        res.writeHead(status, headers);
        res.end(body);
      }, delayMs);
    };
    if (handler) return handler(state, req, finish);
    if (previous != null && at - previous < minGapMs) return finish(429, { "retry-after": "0" });
    return finish(200);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  return { state, url, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("parseRetryAfter reads seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(
    parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", Date.parse("2026-01-01T00:00:00Z")),
    10000
  );
  assert.equal(parseRetryAfter("nonsense"), null);
  assert.equal(parseRetryAfter(null), null);
});

test("per-host concurrency never exceeds the cap", async () => {
  const server = await fakeServer({ delayMs: 20 });
  try {
    const throttle = createHostThrottle(fetch, { maxConcurrent: 2, minSpacingMs: 0 });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => throttle.fetch(server.url))
    );
    assert.ok(responses.every((r) => r.status === 200));
    assert.equal(server.state.maxActive, 2);
  } finally {
    await server.close();
  }
});

test("minimum spacing keeps a rate-limiting host from ever answering 429", async () => {
  const server = await fakeServer({ minGapMs: 20 });
  try {
    const throttle = createHostThrottle(fetch, { maxConcurrent: 4, minSpacingMs: 60 });
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => throttle.fetch(server.url))
    );
    assert.ok(responses.every((r) => r.status === 200));
    const stats = throttle.stats();
    assert.equal(stats.attempts, 12);
    assert.equal(stats.rateLimited, 0);
    assert.equal(stats.rateLimitedPct, 0);
  } finally {
    await server.close();
  }
});

test("without throttling the same host does rate limit (control)", async () => {
  const server = await fakeServer({ minGapMs: 30 });
  try {
    const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(server.url)));
    assert.ok(responses.some((r) => r.status === 429));
  } finally {
    await server.close();
  }
});

test("Retry-After on a 429 is honored, then the request succeeds", async () => {
  let calls = 0;
  const server = await fakeServer({
    handler: (_state, _req, finish) => {
      calls += 1;
      if (calls === 1) return finish(429, { "retry-after": "1" });
      return finish(200);
    },
  });
  try {
    const slept = [];
    const throttle = createHostThrottle(fetch, {
      minSpacingMs: 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const response = await throttle.fetch(server.url);
    assert.equal(response.status, 200);
    assert.deepEqual(slept, [1000]);
    const stats = throttle.stats();
    assert.equal(stats.rateLimited, 1);
    assert.equal(stats.retried, 1);
  } finally {
    await server.close();
  }
});

test("a Retry-After pauses the whole host, not just the failed request", async () => {
  let calls = 0;
  const server = await fakeServer({
    handler: (_state, _req, finish) => {
      calls += 1;
      return calls === 1 ? finish(503, { "retry-after": "0.3" }) : finish(200);
    },
  });
  try {
    const throttle = createHostThrottle(fetch, { minSpacingMs: 0, maxConcurrent: 4 });
    const started = Date.now();
    const responses = await Promise.all([throttle.fetch(server.url), throttle.fetch(server.url)]);
    assert.ok(responses.every((r) => r.status === 200));
    assert.ok(Date.now() - started >= 250, "both waited for the host pause");
    assert.equal(server.state.count, 3);
  } finally {
    await server.close();
  }
});

test("503 without Retry-After backs off exponentially and gives up after maxRetries", async () => {
  const server = await fakeServer({ handler: (_s, _r, finish) => finish(503) });
  try {
    const slept = [];
    const throttle = createHostThrottle(fetch, {
      minSpacingMs: 0,
      maxRetries: 2,
      baseBackoffMs: 100,
      random: () => 1,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const response = await throttle.fetch(server.url);
    assert.equal(response.status, 503);
    assert.deepEqual(slept, [100, 200]);
    assert.equal(server.state.count, 3);
    assert.equal(throttle.stats().gaveUp, 1);
  } finally {
    await server.close();
  }
});

test("a Retry-After beyond maxWaitMs is returned, not slept", async () => {
  const server = await fakeServer({
    handler: (_s, _r, finish) => finish(429, { "retry-after": "3600" }),
  });
  try {
    const slept = [];
    const throttle = createHostThrottle(fetch, {
      minSpacingMs: 0,
      maxWaitMs: 5000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const response = await throttle.fetch(server.url);
    assert.equal(response.status, 429);
    assert.deepEqual(slept, []);
    assert.equal(server.state.count, 1);
  } finally {
    await server.close();
  }
});

test("a 503 on a POST is not retried", async () => {
  const server = await fakeServer({ handler: (_s, _r, finish) => finish(503) });
  try {
    const throttle = createHostThrottle(fetch, { minSpacingMs: 0, sleep: async () => {} });
    const response = await throttle.fetch(server.url, { method: "POST", body: "{}" });
    assert.equal(response.status, 503);
    assert.equal(server.state.count, 1);
  } finally {
    await server.close();
  }
});

test("different hosts do not queue behind each other", async () => {
  const a = await fakeServer({ delayMs: 50 });
  const b = await fakeServer({ delayMs: 50 });
  try {
    const throttle = createHostThrottle(fetch, { maxConcurrent: 1, minSpacingMs: 0 });
    const started = Date.now();
    await Promise.all([throttle.fetch(a.url), throttle.fetch(b.url)]);
    assert.ok(Date.now() - started < 95);
    assert.equal(Object.keys(throttle.stats().hosts).length, 2);
  } finally {
    await a.close();
    await b.close();
  }
});

test("aborting while queued rejects with the abort reason", async () => {
  const server = await fakeServer({ delayMs: 100 });
  try {
    const throttle = createHostThrottle(fetch, { maxConcurrent: 1, minSpacingMs: 0 });
    const controller = new AbortController();
    const first = throttle.fetch(server.url);
    const second = throttle.fetch(server.url, { signal: controller.signal });
    controller.abort(new Error("stop"));
    await assert.rejects(second, /stop/);
    assert.equal((await first).status, 200);
  } finally {
    await server.close();
  }
});
