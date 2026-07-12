// tests/meter-db.test.mjs
// Unit coverage for the optional PostgREST usage-meter sink.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createDbMeter } from "../src/cli/meter-db.mjs";
import { canonicalizeUsageEvent } from "../src/core/ai/usage-log.mjs";

const BASE_URL = "https://fake-project.supabase.co";
const KEY = "fake-service-role-key";

function canonicalEvent() {
  return canonicalizeUsageEvent(
    {
      source: "proxy",
      feature: "job-evaluation",
      skill: "evaluate-job",
      action: "gate",
      operation: "job.gate",
      model: "claude-sonnet-5",
      upstream: "fake-upstream.test",
      user: "abc123def456",
      userLabel: "fake-tester",
      tokens_in: 1000,
      tokens_out: 500,
      cache_read_tokens: 100,
      cache_creation_tokens: 200,
    },
    { now: new Date("2026-07-12T12:00:00Z") }
  );
}

test("append: POSTs the exact snake_case row and required PostgREST headers", async () => {
  const calls = [];
  const meter = createDbMeter({
    url: `${BASE_URL}/`,
    serviceKey: KEY,
    table: "fake_usage_events",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 201 });
    },
  });

  assert.deepEqual(await meter.append(canonicalEvent()), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE_URL}/rest/v1/fake_usage_events`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, {
    apikey: KEY,
    authorization: `Bearer ${KEY}`,
    "content-type": "application/json",
    prefer: "return=minimal",
  });

  const row = JSON.parse(calls[0].init.body);
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      "action",
      "at",
      "cache_creation_tokens",
      "cache_read_tokens",
      "cost_usd",
      "feature",
      "id",
      "model",
      "operation",
      "priced",
      "shared_cache_hit",
      "skill",
      "source",
      "tokens_in",
      "tokens_out",
      "upstream",
      "user_id",
      "user_label",
      "web_searches",
    ].sort()
  );
  assert.equal(row.user_id, "abc123def456");
  assert.equal(row.user_label, "fake-tester");
  assert.equal(Object.hasOwn(row, "user"), false);
  assert.equal(Object.hasOwn(row, "userLabel"), false);
});

test("append: non-2xx and network failures resolve ok:false without throwing", async () => {
  const httpMeter = createDbMeter({
    url: BASE_URL,
    serviceKey: KEY,
    fetchImpl: async () => new Response("rejected row", { status: 409 }),
  });
  assert.deepEqual(await httpMeter.append(canonicalEvent()), { ok: false, error: "http_409" });

  const networkMeter = createDbMeter({
    url: BASE_URL,
    serviceKey: KEY,
    fetchImpl: async () => {
      throw new Error("fake network down");
    },
  });
  assert.deepEqual(await networkMeter.append(canonicalEvent()), {
    ok: false,
    error: "fake network down",
  });
});

test("hydrateUserCosts: parses PostgREST aggregate sums", async () => {
  const calls = [];
  const meter = createDbMeter({
    url: BASE_URL,
    serviceKey: KEY,
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return Response.json([
        { user_id: "user-a", sum: "1.25" },
        { user_id: "user-b", sum: 2.5 },
      ]);
    },
  });

  assert.deepEqual(
    await meter.hydrateUserCosts(),
    new Map([
      ["user-a", 1.25],
      ["user-b", 2.5],
    ])
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get("select"), "user_id,cost_usd.sum()");
  assert.equal(calls[0].url.searchParams.get("user_id"), "not.is.null");
  assert.equal(calls[0].init.headers.apikey, KEY);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
});

test("hydrateUserCosts: aggregate 4xx falls back to multiple raw-row pages and sums", async () => {
  const ranges = [];
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({
    user_id: index % 2 ? "user-a" : "user-b",
    cost_usd: "0.01",
  }));
  let call = 0;
  const meter = createDbMeter({
    url: BASE_URL,
    serviceKey: KEY,
    fetchImpl: async (_url, init) => {
      call += 1;
      if (call === 1) return new Response("aggregates disabled", { status: 400 });
      ranges.push(init.headers.range);
      if (call === 2) return Response.json(firstPage);
      return Response.json([
        { user_id: "user-a", cost_usd: 2 },
        { user_id: "user-b", cost_usd: 3 },
      ]);
    },
  });

  const costs = await meter.hydrateUserCosts();
  assert.ok(Math.abs(costs.get("user-a") - 7) < 1e-12);
  assert.ok(Math.abs(costs.get("user-b") - 8) < 1e-12);
  assert.deepEqual(ranges, ["0-999", "1000-1999"]);
});

test("hydrateUserCosts: total aggregate and paging failure returns an empty Map", async () => {
  let call = 0;
  const meter = createDbMeter({
    url: BASE_URL,
    serviceKey: KEY,
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return new Response("no aggregates", { status: 503 });
      throw new Error("fake paging failure");
    },
  });
  assert.deepEqual(await meter.hydrateUserCosts(), new Map());
});

test("meter DB schema columns exactly mirror canonical usage-event fields", () => {
  const sql = readFileSync(new URL("../scripts/meter-db-schema.sql", import.meta.url), "utf8");
  const tableBody = /create table if not exists usage_events\s*\(([\s\S]*?)\n\);/i.exec(sql)?.[1];
  assert.ok(tableBody, "usage_events table definition not found");
  const columns = [...tableBody.matchAll(/^\s{2}([a-z][a-z0-9_]*)\s+/gm)].map((match) => match[1]);

  const expected = Object.keys(canonicalEvent()).map((key) => {
    if (key === "user") return "user_id";
    if (key === "userLabel") return "user_label";
    return key;
  });
  assert.deepEqual(columns.sort(), expected.sort());
});
