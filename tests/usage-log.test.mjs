// tests/usage-log.test.mjs
// node:test suite for the P0-6 metering substrate (usage-log.mjs).
//
// This ledger backs monetization, so the load-bearing behaviors are: the
// append/read JSONL round-trip, computeCost's exact + prefix model matching
// and cache multipliers, the "never fabricate a price" fallback for an unknown
// model, and the ROLESTER_PRICING_JSON override.

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as UsageLog from "../src/core/ai/usage-log.mjs";
import {
  appendUsageEvent,
  canonicalizeUsageEvent,
  computeCost,
  pruneUsageEvents,
  readUsageEvents,
  USAGE_LOG_SUBPATH,
  usageLogAbsPath,
} from "../src/core/ai/usage-log.mjs";

const NOW = new Date("2026-07-01T12:00:00Z");

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "careerrat-usage-"));
}

// ---------------------------------------------------------------------------
// computeCost — exact + prefix matching, cache multipliers, unknown model
// ---------------------------------------------------------------------------

test("computeCost: exact model match, input+output only", () => {
  const { cost_usd, priced } = computeCost("claude-sonnet-5", {
    tokens_in: 1_000_000,
    tokens_out: 1_000_000,
  });
  assert.equal(priced, true);
  assert.equal(cost_usd, 3 + 15); // $3 in + $15 out per MTok
});

test("computeCost: claude-opus-4-8 and claude-haiku-4-5 rates", () => {
  assert.equal(computeCost("claude-opus-4-8", { tokens_in: 1_000_000, tokens_out: 0 }).cost_usd, 5);
  assert.equal(
    computeCost("claude-haiku-4-5", { tokens_in: 0, tokens_out: 1_000_000 }).cost_usd,
    5
  );
});

test("computeCost: prefix-matches a dated snapshot id to its family rate", () => {
  const dated = computeCost("claude-haiku-4-5-20251001", { tokens_in: 1_000_000, tokens_out: 0 });
  const family = computeCost("claude-haiku-4-5", { tokens_in: 1_000_000, tokens_out: 0 });
  assert.equal(dated.priced, true);
  assert.equal(dated.cost_usd, family.cost_usd);
});

test("computeCost: cache_read at 0.1x and cache_creation at 1.25x the input rate", () => {
  const rate = 3; // claude-sonnet-5 input rate
  const { cost_usd } = computeCost("claude-sonnet-5", {
    tokens_in: 0,
    tokens_out: 0,
    cache_read_tokens: 1_000_000,
    cache_creation_tokens: 1_000_000,
  });
  assert.equal(cost_usd, rate * 0.1 + rate * 1.25);
});

test("computeCost: unknown model never fabricates a price", () => {
  const { cost_usd, priced } = computeCost("some-other-vendor-model", {
    tokens_in: 1000,
    tokens_out: 1000,
  });
  assert.equal(priced, false);
  assert.equal(cost_usd, null);
});

test("computeCost: ROLESTER_PRICING_JSON overrides/extends the default table", () => {
  const prior = process.env.ROLESTER_PRICING_JSON;
  process.env.ROLESTER_PRICING_JSON = JSON.stringify({
    "claude-sonnet-5": { in: 1, out: 1 }, // override an existing entry
    "custom-model-x": { in: 2, out: 4 }, // add a new one
  });
  try {
    const overridden = computeCost("claude-sonnet-5", {
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
    });
    assert.equal(overridden.cost_usd, 2); // 1 + 1, not the default 3 + 15

    const added = computeCost("custom-model-x", { tokens_in: 1_000_000, tokens_out: 1_000_000 });
    assert.equal(added.priced, true);
    assert.equal(added.cost_usd, 6); // 2 + 4

    // Untouched entries in the default table still resolve.
    const unaffected = computeCost("claude-haiku-4-5", { tokens_in: 1_000_000, tokens_out: 0 });
    assert.equal(unaffected.cost_usd, 1);
  } finally {
    if (prior === undefined) delete process.env.ROLESTER_PRICING_JSON;
    else process.env.ROLESTER_PRICING_JSON = prior;
  }
});

test("computeCost: malformed ROLESTER_PRICING_JSON falls back to defaults, never throws", () => {
  const prior = process.env.ROLESTER_PRICING_JSON;
  process.env.ROLESTER_PRICING_JSON = "{not valid json";
  try {
    const { cost_usd, priced } = computeCost("claude-sonnet-5", {
      tokens_in: 1_000_000,
      tokens_out: 0,
    });
    assert.equal(priced, true);
    assert.equal(cost_usd, 3);
  } finally {
    if (prior === undefined) delete process.env.ROLESTER_PRICING_JSON;
    else process.env.ROLESTER_PRICING_JSON = prior;
  }
});

// ---------------------------------------------------------------------------
// canonicalizeUsageEvent — defaults, shared_cache_hit derivation
// ---------------------------------------------------------------------------

test("canonicalizeUsageEvent fills defaults and derives shared_cache_hit", () => {
  const event = canonicalizeUsageEvent(
    { model: "claude-sonnet-5", tokens_in: 100, tokens_out: 50, cache_read_tokens: 10 },
    { now: NOW }
  );
  assert.equal(event.at, "2026-07-01T12:00:00.000Z");
  assert.equal(event.source, "byok"); // default when not proxy/byok
  assert.equal(event.skill, null);
  assert.equal(event.action, null);
  assert.equal(event.web_searches, 0);
  assert.equal(event.shared_cache_hit, true);
  assert.ok(event.id.startsWith("use_"));
  assert.equal(event.priced, true);
});

test("canonicalizeUsageEvent: shared_cache_hit is false with no cache reads", () => {
  const event = canonicalizeUsageEvent(
    { model: "claude-sonnet-5", tokens_in: 10, tokens_out: 10 },
    { now: NOW }
  );
  assert.equal(event.shared_cache_hit, false);
});

test("canonicalizeUsageEvent: unknown model is unpriced, cost_usd null", () => {
  const event = canonicalizeUsageEvent(
    { model: "unknown-model", tokens_in: 10, tokens_out: 10 },
    { now: NOW }
  );
  assert.equal(event.priced, false);
  assert.equal(event.cost_usd, null);
});

test("canonicalizeUsageEvent: carries the upstream host, defaults to null when absent", () => {
  const withUpstream = canonicalizeUsageEvent(
    { model: "claude-sonnet-5", tokens_in: 1, tokens_out: 1, upstream: "ai-gateway.vercel.sh" },
    { now: NOW }
  );
  assert.equal(withUpstream.upstream, "ai-gateway.vercel.sh");

  const withoutUpstream = canonicalizeUsageEvent(
    { model: "claude-sonnet-5", tokens_in: 1, tokens_out: 1 },
    { now: NOW }
  );
  assert.equal(withoutUpstream.upstream, null);
});

test("canonicalizeUsageEvent: derives feature and keeps operation for product cost attribution", () => {
  const event = canonicalizeUsageEvent(
    {
      source: "byok",
      skill: "resume-extract",
      action: "resume-ai",
      operation: "onboard.resume-ai",
      model: "claude-sonnet-5",
      tokens_in: 100,
      tokens_out: 50,
    },
    { now: NOW }
  );

  assert.equal(event.feature, "onboarding.resume-ingestion");
  assert.equal(event.operation, "onboard.resume-ai");
});

test("canonicalizeUsageEvent: explicit feature label wins over inferred labels", () => {
  const event = canonicalizeUsageEvent(
    {
      feature: "pricing-lab.custom-experiment",
      skill: "discover-companies",
      action: "seed-generate",
      operation: "company-seeds",
      model: "claude-sonnet-5",
    },
    { now: NOW }
  );

  assert.equal(event.feature, "pricing-lab.custom-experiment");
});

test("summarizeUsageEvents: rolls spend up by product feature and preserves detail rows", () => {
  const events = [
    canonicalizeUsageEvent(
      {
        source: "byok",
        skill: "resume-extract",
        action: "resume-ai",
        operation: "onboard.resume-ai",
        model: "claude-sonnet-5",
        tokens_in: 1000,
        tokens_out: 200,
      },
      { now: NOW }
    ),
    canonicalizeUsageEvent(
      {
        source: "proxy",
        skill: "discover-companies",
        action: "seed-generate",
        operation: "company-seeds",
        model: "claude-sonnet-5",
        tokens_in: 2000,
        tokens_out: 300,
      },
      { now: NOW }
    ),
    canonicalizeUsageEvent(
      {
        source: "proxy",
        feature: "company-discovery",
        skill: "discover-companies",
        action: "scanner-cascade",
        operation: "public-scanner",
        model: "claude-sonnet-5",
        tokens_in: 500,
        tokens_out: 100,
      },
      { now: NOW }
    ),
    canonicalizeUsageEvent(
      {
        source: "byok",
        skill: "mystery",
        action: "experiment",
        model: "unknown-model",
        tokens_in: 300,
        tokens_out: 30,
      },
      { now: NOW }
    ),
  ];

  const summary = UsageLog.summarizeUsageEvents(events);

  assert.equal(summary.totals.requests, 4);
  assert.equal(summary.totals.tokens_in, 3800);
  assert.equal(summary.totals.tokens_out, 630);
  assert.equal(summary.totals.total_tokens, 4430);
  assert.equal(summary.totals.unpriced_requests, 1);
  assert.equal(summary.byFeature[0].feature, "company-discovery");
  assert.equal(summary.byFeature[0].requests, 2);
  assert.equal(summary.byFeature[0].tokens_in, 2500);
  assert.equal(summary.byFeature[0].tokens_out, 400);
  assert.equal(summary.byFeature[0].total_tokens, 2900);
  assert.equal(summary.byFeature[1].feature, "onboarding.resume-ingestion");
  assert.equal(summary.byFeature[2].feature, "skill.mystery");
  assert.deepEqual(summary.byFeature[0].breakdown[0], {
    skill: "discover-companies",
    action: "seed-generate",
    operation: "company-seeds",
    requests: 1,
    tokens_in: 2000,
    tokens_out: 300,
    total_tokens: 2300,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    web_searches: 0,
    cost_usd: computeCost("claude-sonnet-5", { tokens_in: 2000, tokens_out: 300 }).cost_usd,
    unpriced_requests: 0,
  });
});

// ---------------------------------------------------------------------------
// append/read round-trip
// ---------------------------------------------------------------------------

test("appendUsageEvent + readUsageEvents: round-trips exact fields", () => {
  const root = tempRoot();
  try {
    appendUsageEvent(
      {
        source: "proxy",
        skill: "apply-job",
        action: "tailor",
        model: "claude-sonnet-5",
        tokens_in: 200,
        tokens_out: 100,
      },
      { root, now: NOW }
    );
    const events = readUsageEvents({ root });
    assert.equal(events.length, 1);
    const [row] = events;
    assert.equal(row.source, "proxy");
    assert.equal(row.skill, "apply-job");
    assert.equal(row.action, "tailor");
    assert.equal(row.model, "claude-sonnet-5");
    assert.equal(row.tokens_in, 200);
    assert.equal(row.tokens_out, 100);
    assert.equal(row.priced, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendUsageEvent + readUsageEvents: upstream field round-trips", () => {
  const root = tempRoot();
  try {
    appendUsageEvent(
      {
        source: "proxy",
        model: "claude-sonnet-5",
        tokens_in: 1,
        tokens_out: 1,
        upstream: "api.anthropic.com",
      },
      { root, now: NOW }
    );
    const [row] = readUsageEvents({ root });
    assert.equal(row.upstream, "api.anthropic.com");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readUsageEvents: an old row written without an `upstream` key reads back fine", () => {
  const root = tempRoot();
  try {
    const path = usageLogAbsPath(root);
    mkdirSync(dirname(path), { recursive: true });
    // Hand-written line shaped like a pre-upstream-field row — no `upstream` key at all.
    appendFileSync(
      path,
      `${JSON.stringify({
        id: "use_legacy",
        at: NOW.toISOString(),
        source: "byok",
        model: "claude-sonnet-5",
        tokens_in: 5,
        tokens_out: 5,
        priced: true,
        cost_usd: 0.000075,
      })}\n`,
      "utf8"
    );
    const events = readUsageEvents({ root });
    assert.equal(events.length, 1);
    assert.equal(events[0].id, "use_legacy");
    assert.equal(events[0].upstream, undefined); // absent, not backfilled — never throws
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readUsageEvents: skips a malformed trailing line rather than throwing", () => {
  const root = tempRoot();
  try {
    appendUsageEvent({ model: "claude-sonnet-5", tokens_in: 1, tokens_out: 1 }, { root, now: NOW });
    const path = usageLogAbsPath(root);
    appendFileSync(path, "{not valid json\n", "utf8");
    const events = readUsageEvents({ root });
    assert.equal(events.length, 1); // the malformed line is skipped, not thrown
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendUsageEvent writes at the documented workspace subpath", () => {
  const root = tempRoot();
  try {
    const { path, relPath } = appendUsageEvent(
      { model: "claude-sonnet-5", tokens_in: 1, tokens_out: 1 },
      { root, now: NOW }
    );
    assert.equal(relPath, USAGE_LOG_SUBPATH);
    assert.equal(path, usageLogAbsPath(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

test("pruneUsageEvents: keeps the newest `max` rows and backs up the rest", () => {
  const root = tempRoot();
  try {
    for (let i = 0; i < 10; i++) {
      appendUsageEvent(
        { model: "claude-sonnet-5", tokens_in: i, tokens_out: 0 },
        { root, now: NOW, autoPrune: false }
      );
    }
    const result = pruneUsageEvents({ root, max: 3 });
    assert.equal(result.kept, 3);
    assert.equal(result.dropped, 7);
    const remaining = readUsageEvents({ root });
    assert.equal(remaining.length, 3);
    assert.deepEqual(
      remaining.map((e) => e.tokens_in),
      [7, 8, 9]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
