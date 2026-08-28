import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";
import { buildHiringCafeUrl } from "../src/core/providers/hiringcafe.mjs";
import {
  addProviderSource,
  addSearchFromQuery,
  addSearchFromUrl,
  emptyConfig,
  markRun,
  parseConfig,
  recencyCutoff,
  serializeConfig,
  setEnabled,
  toCaptureSource,
  validateConfig,
} from "../src/core/providers/search-sources.mjs";
import { pendingSourceLoginRequests } from "../src/core/search/source-login-preflight.mjs";

// Load the real schema from disk
const schemaPath = new URL("../config/search-sources.schema.json", import.meta.url).pathname;
const SCHEMA = JSON.parse(readFileSync(schemaPath, "utf8"));

// ---------------------------------------------------------------------------
// emptyConfig
// ---------------------------------------------------------------------------

test("emptyConfig() validates against the real schema", () => {
  const cfg = emptyConfig();
  const result = validateConfig(cfg, SCHEMA);
  assert.ok(
    result.valid,
    `emptyConfig should be schema-valid; errors: ${JSON.stringify(result.errors)}`
  );
});

// ---------------------------------------------------------------------------
// addSearchFromQuery
// ---------------------------------------------------------------------------

test("addSearchFromQuery appends a valid entry with label defaulting to query", () => {
  const cfg = addSearchFromQuery(emptyConfig(), { query: "applied AI engineer" });
  assert.equal(cfg.searches.length, 1);
  const s = cfg.searches[0];
  assert.equal(s.label, "applied AI engineer");
  assert.equal(s.query, "applied AI engineer");
  assert.equal(s.recency.mode, "since-last-run");
  assert.equal(s.provider, "HiringCafe");
  assert.equal(s.enabled, true);
});

test("addSearchFromQuery result validates against real schema", () => {
  const cfg = addSearchFromQuery(emptyConfig(), { query: "applied AI engineer" });
  const result = validateConfig(cfg, SCHEMA);
  assert.ok(result.valid, `schema errors: ${JSON.stringify(result.errors)}`);
});

test("addSearchFromQuery deduplicates same provider+query", () => {
  const cfg1 = addSearchFromQuery(emptyConfig(), { query: "applied AI engineer" });
  const cfg2 = addSearchFromQuery(cfg1, { query: "applied AI engineer" });
  assert.equal(cfg2.searches.length, 1);
  assert.equal(cfg2, cfg1); // same object reference
});

test("addSearchFromQuery deduplicates case-insensitive provider match", () => {
  const cfg1 = addSearchFromQuery(emptyConfig(), {
    query: "applied AI engineer",
    provider: "HiringCafe",
  });
  const cfg2 = addSearchFromQuery(cfg1, {
    query: "applied AI engineer",
    provider: "hiringcafe",
  });
  assert.equal(cfg2.searches.length, 1);
});

test("addSearchFromQuery throws on missing query", () => {
  assert.throws(() => addSearchFromQuery(emptyConfig(), { label: "no query" }), /query/i);
});

test("addSearchFromQuery throws on empty query", () => {
  assert.throws(() => addSearchFromQuery(emptyConfig(), { query: "" }), /query/i);
});

// ---------------------------------------------------------------------------
// addProviderSource
// ---------------------------------------------------------------------------

test("addProviderSource creates a deterministic board source from a provider and query", () => {
  const cfg = addProviderSource(emptyConfig(), {
    provider: "RemoteOK",
    query: "staff platform engineer",
  });
  assert.deepEqual(cfg.searches, [
    {
      provider: "remoteok",
      source_type: "board",
      label: "RemoteOK",
      query: "staff platform engineer",
      enabled: true,
      recency: { mode: "since-last-run", safetyMinutes: 30 },
    },
  ]);
  assert.equal(validateConfig(cfg, SCHEMA).valid, true);
});

test("addProviderSource creates an explicit ATS source for a branded provider URL", () => {
  const url = "https://jobs.example.com/search";
  const cfg = addProviderSource(emptyConfig(), {
    provider: "phenom",
    label: "Example careers",
    url,
  });
  assert.deepEqual(cfg.searches, [
    {
      provider: "phenom",
      source_type: "ats",
      label: "Example careers",
      name: "Example careers",
      url,
      enabled: true,
      recency: { mode: "since-last-run", safetyMinutes: 30 },
    },
  ]);
  assert.equal(validateConfig(cfg, SCHEMA).valid, true);
});

test("addProviderSource deduplicates provider and target", () => {
  const cfg = addProviderSource(emptyConfig(), {
    provider: "remoteok",
    query: "staff engineer",
  });
  assert.equal(addProviderSource(cfg, { provider: "RemoteOK", query: "staff engineer" }), cfg);
});

test("addProviderSource rejects unsupported, unsafe, and incomplete sources", () => {
  assert.throws(
    () => addProviderSource(emptyConfig(), { provider: "not-real", query: "engineer" }),
    /unsupported/i
  );
  assert.throws(
    () => addProviderSource(emptyConfig(), { provider: "local-parser", query: "engineer" }),
    /unsupported/i
  );
  assert.throws(() => addProviderSource(emptyConfig(), { provider: "remoteok" }), /query or URL/i);
});

// ---------------------------------------------------------------------------
// addSearchFromUrl — HiringCafe
// ---------------------------------------------------------------------------

test("addSearchFromUrl with a hiring.cafe URL appends valid HiringCafe entry", () => {
  const { url: hcUrl } = buildHiringCafeUrl({ query: "applied AI engineer" });
  const cfg = addSearchFromUrl(emptyConfig(), hcUrl);
  assert.equal(cfg.searches.length, 1);

  const s = cfg.searches[0];
  assert.equal(s.provider, "HiringCafe");
  assert.ok(s.url, "entry should have url");
  assert.ok(s.searchState && typeof s.searchState === "object", "entry should have searchState");
  assert.equal(
    s.searchState.searchQuery,
    "applied AI engineer",
    "searchState.searchQuery should round-trip"
  );
  assert.equal(s.query, "applied AI engineer");
});

test("addSearchFromUrl with hiring.cafe URL validates against real schema", () => {
  const { url: hcUrl } = buildHiringCafeUrl({ query: "applied AI engineer" });
  const cfg = addSearchFromUrl(emptyConfig(), hcUrl);
  const result = validateConfig(cfg, SCHEMA);
  assert.ok(result.valid, `schema errors: ${JSON.stringify(result.errors)}`);
});

test("addSearchFromUrl deduplicates a HiringCafe URL against a generated query source", () => {
  const generated = addSearchFromQuery(emptyConfig(), { query: "Bartender" });
  const { url } = buildHiringCafeUrl({ query: "bartender" });

  const result = addSearchFromUrl(generated, url, {
    label: "HiringCafe bartender",
    sourceType: "url-query",
  });

  assert.equal(result, generated);
  assert.equal(result.searches.length, 1);
});

// ---------------------------------------------------------------------------
// addSearchFromUrl — generic (LinkedIn)
// ---------------------------------------------------------------------------

test("addSearchFromUrl with LinkedIn URL creates browser entry", () => {
  const linkedinUrl = "https://www.linkedin.com/jobs/search/?keywords=ai";
  const cfg = addSearchFromUrl(emptyConfig(), linkedinUrl);
  assert.equal(cfg.searches.length, 1);

  const s = cfg.searches[0];
  assert.equal(s.source_type, "browser");
  assert.equal(s.url, linkedinUrl);
});

test("addSearchFromUrl with LinkedIn URL validates against real schema", () => {
  const linkedinUrl = "https://www.linkedin.com/jobs/search/?keywords=ai";
  const cfg = addSearchFromUrl(emptyConfig(), linkedinUrl);
  const result = validateConfig(cfg, SCHEMA);
  assert.ok(result.valid, `schema errors: ${JSON.stringify(result.errors)}`);
});

test("addSearchFromUrl turns a supported Career Ops URL into a deterministic ATS source", () => {
  const url = "https://acme.bamboohr.com/careers";
  const cfg = addSearchFromUrl(emptyConfig(), url, { label: "Acme careers" });
  assert.deepEqual(cfg.searches, [
    {
      provider: "bamboohr",
      source_type: "ats",
      label: "Acme careers",
      name: "Acme careers",
      url,
      enabled: true,
    },
  ]);
  assert.equal(validateConfig(cfg, SCHEMA).valid, true);
});

test("addSearchFromUrl throws on unparseable URL", () => {
  assert.throws(() => addSearchFromUrl(emptyConfig(), "not-a-url"), /unparseable/i);
});

test("browser source add and login preflight reject a known site label on another hostname", () => {
  assert.throws(
    () =>
      addSearchFromUrl(emptyConfig(), "https://jobs.example.com/search", {
        label: "LinkedIn saved search",
        sourceType: "browser",
      }),
    /does not match.*hostname/i
  );

  assert.deepEqual(
    pendingSourceLoginRequests({
      searches: [
        {
          provider: "jobs.example.com",
          platform: "linkedin",
          source_type: "browser",
          auth: true,
          label: "LinkedIn saved search",
          url: "https://jobs.example.com/search",
          enabled: false,
        },
      ],
    }),
    []
  );
});

test("login preflight keeps a durable No quiet on later searches", () => {
  assert.deepEqual(
    pendingSourceLoginRequests({
      searches: [
        {
          provider: "indeed.com",
          platform: "indeed",
          source_type: "browser",
          auth: true,
          label: "Indeed saved search",
          url: "https://www.indeed.com/jobs?q=operations",
          enabled: false,
          login_skipped: true,
        },
      ],
    }),
    []
  );
});

// ---------------------------------------------------------------------------
// setEnabled — immutability and selector types
// ---------------------------------------------------------------------------

test("setEnabled toggles by index", () => {
  const cfg = addSearchFromQuery(emptyConfig(), { query: "ai engineer", enabled: true });
  const updated = setEnabled(cfg, 0, false);
  assert.equal(updated.searches[0].enabled, false);
});

test("setEnabled toggles by label (case-insensitive)", () => {
  const cfg = addSearchFromQuery(emptyConfig(), { query: "ai engineer", label: "AI Engineer" });
  const updated = setEnabled(cfg, "ai engineer", false);
  assert.equal(updated.searches[0].enabled, false);
});

test("setEnabled is immutable — original config unchanged", () => {
  const cfg = addSearchFromQuery(emptyConfig(), { query: "ai engineer", enabled: true });
  const original = cfg.searches[0].enabled;
  setEnabled(cfg, 0, false);
  assert.equal(cfg.searches[0].enabled, original, "original should not mutate");
});

test("setEnabled throws on unknown index", () => {
  const cfg = emptyConfig();
  assert.throws(() => setEnabled(cfg, 99, true), /index/i);
});

test("setEnabled throws on unknown label", () => {
  const cfg = emptyConfig();
  assert.throws(() => setEnabled(cfg, "nonexistent label", true), /label/i);
});

// ---------------------------------------------------------------------------
// markRun + recencyCutoff
// ---------------------------------------------------------------------------

test("markRun sets ISO recency.lastRunAt", () => {
  const cfg = addSearchFromQuery(emptyConfig(), { query: "ai engineer" });
  const now = new Date("2025-06-01T12:00:00.000Z");
  const updated = markRun(cfg, 0, now);
  assert.equal(updated.searches[0].recency.lastRunAt, now.toISOString());
});

test("markRun creates recency if absent", () => {
  // Build a search with no recency field
  const cfg = {
    ...emptyConfig(),
    searches: [{ provider: "Test", label: "test", query: "test", enabled: true }],
  };
  const now = new Date("2025-06-01T12:00:00.000Z");
  const updated = markRun(cfg, 0, now);
  assert.ok(updated.searches[0].recency, "recency should be created");
  assert.equal(updated.searches[0].recency.lastRunAt, now.toISOString());
});

test("recencyCutoff returns postFilterAfter earlier than now and fetchHours >= hours", () => {
  const lastRunAt = new Date("2025-06-01T06:00:00.000Z").toISOString();
  const now = new Date("2025-06-01T12:00:00.000Z");
  const search = {
    recency: { mode: "since-last-run", safetyMinutes: 30, lastRunAt },
  };
  const result = recencyCutoff(search, now);
  assert.ok(result.postFilterAfter, "postFilterAfter should be set");
  assert.ok(new Date(result.postFilterAfter) < now, "postFilterAfter should be before now");
  assert.ok(result.fetchHours >= result.hours, "fetchHours should be >= hours");
});

// ---------------------------------------------------------------------------
// toCaptureSource
// ---------------------------------------------------------------------------

test("toCaptureSource maps query→term and lowercases provider", () => {
  const search = {
    provider: "HiringCafe",
    label: "Applied AI Engineer",
    query: "applied AI engineer",
    url: "https://hiring.cafe/?searchState={}",
    searchState: { sortBy: "date" },
    enabled: true,
  };
  const result = toCaptureSource(search);
  assert.equal(result.term, "applied AI engineer");
  assert.equal(result.provider, "hiringcafe");
  assert.equal(result.label, "Applied AI Engineer");
  assert.equal(result.enabled, true);
  assert.ok(typeof result.id === "string" && result.id.length > 0);
});

test("toCaptureSource id is a slug", () => {
  const search = {
    provider: "HiringCafe",
    label: "Applied AI Engineer!",
    query: "ai",
    enabled: true,
  };
  const result = toCaptureSource(search);
  assert.match(result.id, /^[a-z0-9-]+$/, "id should be slug-safe");
  assert.doesNotMatch(result.id, /^-|-$/, "id should not start or end with dash");
});

// ---------------------------------------------------------------------------
// parseConfig / serializeConfig round-trip
// ---------------------------------------------------------------------------

test("serializeConfig → parseConfig round-trip preserves searches and validates", () => {
  let cfg = emptyConfig();
  cfg = addSearchFromQuery(cfg, { query: "forward deployed engineer", label: "FDE" });
  cfg = addSearchFromQuery(cfg, { query: "applied AI engineer", provider: "HiringCafe" });

  const yaml = serializeConfig(cfg);
  assert.ok(typeof yaml === "string" && yaml.length > 0, "serialized YAML should be non-empty");

  const reparsed = parseConfig(yaml);
  assert.equal(reparsed.searches.length, cfg.searches.length, "searches count should round-trip");
  assert.equal(reparsed.searches[0].query, "forward deployed engineer");
  assert.equal(reparsed.searches[1].query, "applied AI engineer");

  const result = validateConfig(reparsed, SCHEMA);
  assert.ok(
    result.valid,
    `reparsed config should validate; errors: ${JSON.stringify(result.errors)}`
  );
});

// ---------------------------------------------------------------------------
// mergeSearchConfigs
// ---------------------------------------------------------------------------

import { mergeSearchConfigs } from "../src/core/providers/search-sources.mjs";

function baselineConfig() {
  return {
    title_filter: { positive: ["Forward Deployed"], negative: ["Intern"] },
    location_filter: { always_allow: [], allow: ["Remote"], block: [] },
    salary_filter: { min: 200000, max: 0, currency: "USD" },
    searches: [
      {
        provider: "HiringCafe",
        source_type: "url-query",
        label: "Forward Deployed",
        query: "Forward Deployed",
        enabled: true,
        recency: { mode: "since-last-run", safetyMinutes: 30 },
        searchState: { sortBy: "date" },
      },
      {
        provider: "RemoteVibeCodingJobs",
        source_type: "url-query",
        label: "Remote Vibe Coding Jobs",
        query: "AI engineer",
        rssUrl: "https://remotevibecodingjobs.com/feed.xml",
        enabled: true,
      },
    ],
    tracked_companies: [],
    source_catalog: {},
  };
}

test("mergeSearchConfigs returns the baseline when there is no existing config", () => {
  const baseline = baselineConfig();
  assert.equal(mergeSearchConfigs(null, baseline), baseline);
  assert.equal(mergeSearchConfigs({}, baseline), baseline);
});

test("mergeSearchConfigs preserves manual searches and tracked_companies", () => {
  const existing = addSearchFromUrl(
    { ...emptyConfig(), tracked_companies: ["Anthropic"] },
    "https://www.linkedin.com/jobs/search/?keywords=ai",
    { label: "LinkedIn AI" }
  );
  const merged = mergeSearchConfigs(existing, baselineConfig());
  // Manual LinkedIn search survives.
  assert.ok(merged.searches.some((s) => s.label === "LinkedIn AI"));
  // Manual tracked company survives (not clobbered by baseline []).
  assert.deepEqual(merged.tracked_companies, ["Anthropic"]);
  // Derived filters come from the baseline.
  assert.equal(merged.salary_filter.min, 200000);
  assert.ok(validateConfig(merged, SCHEMA).valid);
});

test("mergeSearchConfigs appends new generated searches not already present", () => {
  const existing = emptyConfig(); // no searches yet
  const merged = mergeSearchConfigs(existing, baselineConfig());
  assert.equal(merged.searches.length, 2);
  assert.ok(merged.searches.some((s) => s.query === "Forward Deployed"));
});

test("mergeSearchConfigs is idempotent — re-merging the baseline adds nothing", () => {
  const once = mergeSearchConfigs(emptyConfig(), baselineConfig());
  const twice = mergeSearchConfigs(once, baselineConfig());
  assert.equal(twice.searches.length, once.searches.length);
});

test("mergeSearchConfigs dedupes the aggregator by provider + rssUrl", () => {
  // Existing RVCJ entry with a DIFFERENT query but the same rssUrl must not duplicate.
  const existing = {
    ...emptyConfig(),
    searches: [
      {
        provider: "RemoteVibeCodingJobs",
        source_type: "url-query",
        label: "RVCJ custom",
        query: "vibe coding",
        rssUrl: "https://remotevibecodingjobs.com/feed.xml",
        enabled: true,
      },
    ],
  };
  const merged = mergeSearchConfigs(existing, baselineConfig());
  const rvcj = merged.searches.filter((s) => s.provider === "RemoteVibeCodingJobs");
  assert.equal(rvcj.length, 1, "should not add a second RVCJ aggregator");
});

test("mergeSearchConfigs refreshes generated search recency from the baseline", () => {
  const existing = {
    ...emptyConfig(),
    searches: [
      {
        provider: "HiringCafe",
        source_type: "url-query",
        label: "Forward Deployed",
        query: "Forward Deployed",
        enabled: true,
        recency: {
          mode: "since-last-run",
          safetyMinutes: 30,
          lastRunAt: "2026-06-20T00:00:00.000Z",
        },
        searchState: { sortBy: "date" },
      },
    ],
  };
  const baseline = baselineConfig();
  baseline.searches[0] = {
    ...baseline.searches[0],
    recency: { mode: "fixed-hours", hours: 336, safetyMinutes: 30 },
  };

  const merged = mergeSearchConfigs(existing, baseline);

  assert.deepEqual(merged.searches[0].recency, {
    mode: "fixed-hours",
    hours: 336,
    safetyMinutes: 30,
    lastRunAt: "2026-06-20T00:00:00.000Z",
  });
  assert.equal(merged.searches.length, 2);
});
