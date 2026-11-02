import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SEARCH_HEALTH_DEGRADED_SHARE,
  SEARCH_HEALTH_FAILED_SHARE,
  SEARCH_SKIP_BROWSER_REASON,
  searchRunHealth,
  summarizeSearchHealth,
} from "../src/core/search/search-health.mjs";

const fail = (reason, n = 1) =>
  Array.from({ length: n }, (_, i) => ({ company: `c${i}`, error: reason }));
const skip = (n) =>
  Array.from({ length: n }, (_, i) => ({
    company: `b${i}`,
    error: SEARCH_SKIP_BROWSER_REASON,
    skipped: true,
  }));

test("thresholds are ordered and health follows the failed share", () => {
  assert.ok(SEARCH_HEALTH_DEGRADED_SHARE < SEARCH_HEALTH_FAILED_SHARE);
  assert.equal(summarizeSearchHealth({ attemptedSources: 20, errors: [] }).status, "ok");
  assert.equal(
    summarizeSearchHealth({ attemptedSources: 20, errors: fail("boom", 2) }).status,
    "degraded"
  );
  assert.equal(
    summarizeSearchHealth({ attemptedSources: 20, errors: fail("boom", 10) }).status,
    "failed"
  );
  assert.equal(
    summarizeSearchHealth({ attemptedSources: 20, errors: fail("boom", 1) }).status,
    "ok"
  );
});

test("browser skips are counted apart from errors and don't dilute the share", () => {
  const health = summarizeSearchHealth({
    attemptedSources: 10,
    errors: [...skip(4), ...fail("boom", 1)],
  });
  assert.equal(health.skipped, 4);
  assert.equal(health.failed, 1);
  assert.equal(health.readable, 6);
  assert.equal(health.status, "degraded");
  assert.deepEqual(health.skippedReasons, [{ reason: SEARCH_SKIP_BROWSER_REASON, count: 4 }]);
  assert.deepEqual(health.errorReasons, [{ reason: "boom", count: 1 }]);
});

test("reasons are grouped by count with URLs stripped", () => {
  const health = summarizeSearchHealth({
    attemptedSources: 6,
    errors: [
      { error: "https://a.example/x returned HTTP 404" },
      { error: "https://b.example/y returned HTTP 404" },
      { error: "https://c.example/z returned HTTP 404" },
      { error: "fetch failed: timeout" },
    ],
  });
  assert.deepEqual(health.errorReasons, [
    { reason: "returned HTTP 404", count: 3 },
    { reason: "fetch failed: timeout", count: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(health), /example/);
});

test("nothing readable is failed, and an empty scan is not", () => {
  assert.equal(summarizeSearchHealth({ attemptedSources: 3, errors: skip(3) }).status, "failed");
  assert.equal(summarizeSearchHealth({ attemptedSources: 0, errors: [] }).status, "ok");
});

test("searchRunHealth computes health for runs saved before the field existed", () => {
  assert.equal(searchRunHealth({ summary: null }), null);
  const health = searchRunHealth({ summary: { attemptedSources: 4, errors: fail("boom", 4) } });
  assert.equal(health.status, "failed");
});

test("provider warnings make an otherwise clean run degraded", () => {
  const clean = summarizeSearchHealth({ attemptedSources: 5, errors: [] });
  assert.equal(clean.status, "ok");
  const warned = summarizeSearchHealth({
    attemptedSources: 5,
    errors: [],
    warnings: [{ company: "Acme", warning: "workday: Acme truncated at 10 pages" }],
  });
  assert.equal(warned.status, "degraded");
  assert.equal(warned.warningCount, 1);
  assert.match(warned.message, /incomplete/);
  assert.equal(warned.warningReasons[0].reason, "workday: Acme truncated at 10 pages");
});
