import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildSearchSources } from "../src/core/profile/generate-search-sources.mjs";
import { validate } from "../src/core/profile/schema-validator.mjs";
import { parseYaml, stringifyYaml } from "../src/core/profile/yaml.mjs";

// ---------------------------------------------------------------------------
// Load the real schema
// ---------------------------------------------------------------------------

const schemaPath = new URL("../config/search-sources.schema.json", import.meta.url).pathname;
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const targeting = {
  role_buckets: [
    {
      name: "Primary",
      priority: "primary",
      titles: ["Forward Deployed Engineer", "Applied AI Engineer"],
    },
    {
      name: "Secondary",
      priority: "secondary",
      titles: ["Solutions Engineer", "Forward Deployed Engineer"], // dup to test dedup
    },
  ],
  keep_signals: ["customer-facing", "AI/ML product"],
  cut_signals: ["core platform SWE", "infrastructure only"],
};

const profile = {
  candidate: {
    full_name: "Jane Candidate",
    preferred_name: "Jane",
    email: "jane@example.com",
  },
  compensation: {
    currency: "USD",
    current_base: 185000, // must NOT leak into search sources
    minimum_base: 210000,
    target_base: 240000,
    cash_over_equity: true,
  },
  location: {
    home: "Austin, TX",
    remote: true,
    relocation: ["New York, NY", "San Francisco, CA"],
  },
  authorization: {
    work_authorized: true,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("buildSearchSources: title_filter.positive includes all bucket titles (deduped)", () => {
  const result = buildSearchSources(targeting, profile);
  const positive = result.title_filter.positive;

  // All unique titles from all buckets should appear.
  assert.ok(positive.includes("Forward Deployed Engineer"), "missing Forward Deployed Engineer");
  assert.ok(positive.includes("Applied AI Engineer"), "missing Applied AI Engineer");
  assert.ok(positive.includes("Solutions Engineer"), "missing Solutions Engineer");

  // Duplicate "Forward Deployed Engineer" from secondary bucket must not repeat.
  const count = positive.filter((t) => t === "Forward Deployed Engineer").length;
  assert.equal(count, 1, "Forward Deployed Engineer should appear exactly once");
});

test("buildSearchSources: title_filter.negative contains conventional noise filters", () => {
  const result = buildSearchSources(targeting, profile);
  assert.ok(result.title_filter.negative.includes("Intern"), "missing Intern in negative");
  assert.ok(result.title_filter.negative.includes("Junior"), "missing Junior in negative");
});

test("buildSearchSources: location_filter.allow includes Remote, home, and relocation cities", () => {
  const result = buildSearchSources(targeting, profile);
  const allow = result.location_filter.allow;
  assert.ok(allow.includes("Remote"), "missing Remote");
  assert.ok(allow.includes("Austin, TX"), "missing home city");
  assert.ok(allow.includes("New York, NY"), "missing relocation city");
  assert.ok(allow.includes("San Francisco, CA"), "missing relocation city 2");
});

test("buildSearchSources: location_filter.always_allow and block are empty arrays", () => {
  const result = buildSearchSources(targeting, profile);
  assert.deepEqual(result.location_filter.always_allow, []);
  assert.deepEqual(result.location_filter.block, []);
});

test("buildSearchSources: every searches item has provider, label, and a query/url/rssUrl; non-board items are enabled by default", () => {
  const result = buildSearchSources(targeting, profile);
  for (const item of result.searches) {
    assert.ok(
      typeof item.provider === "string" && item.provider.length > 0,
      `missing provider: ${JSON.stringify(item)}`
    );
    assert.ok(
      typeof item.label === "string" && item.label.length > 0,
      `missing label: ${JSON.stringify(item)}`
    );
    // Board-wide aggregator entries (RemoteOK/Remotive/Working Nomads) are seeded
    // present-but-disabled for non-tech domains (this fixture has no candidate.domain)
    // so any domain can flip them on later; every other generated entry stays enabled.
    if (item.source_type !== "board") {
      assert.equal(item.enabled, true, `enabled must be true: ${JSON.stringify(item)}`);
    }
    // Every item must satisfy anyOf: query, url, or rssUrl.
    const hasSource = "query" in item || "url" in item || "rssUrl" in item;
    assert.ok(hasSource, `item missing query/url/rssUrl: ${JSON.stringify(item)}`);
  }
});

test("buildSearchSources: no RemoteVibeCodingJobs when domain is absent", () => {
  // The shared profile fixture has no candidate.domain — must not produce tech-only boards.
  const result = buildSearchSources(targeting, profile);
  const rvEntries = result.searches.filter((s) => s.provider === "RemoteVibeCodingJobs");
  assert.equal(rvEntries.length, 0, "RemoteVibeCodingJobs must not appear when domain is absent");
});

test("buildSearchSources: exactly one RemoteVibeCodingJobs entry with rssUrl when domain is tech", () => {
  const techProfile = {
    ...profile,
    candidate: { ...profile.candidate, domain: "software engineering" },
  };
  const result = buildSearchSources(targeting, techProfile);
  const rvEntries = result.searches.filter((s) => s.provider === "RemoteVibeCodingJobs");
  assert.equal(
    rvEntries.length,
    1,
    "expected exactly one RemoteVibeCodingJobs entry for tech domain"
  );
  assert.ok(
    typeof rvEntries[0].rssUrl === "string" && rvEntries[0].rssUrl.length > 0,
    "rssUrl must be a non-empty string"
  );
});

test("buildSearchSources: seeds exactly three enabled lowercase board providers for tech", () => {
  const result = buildSearchSources(targeting, {
    ...profile,
    candidate: { ...profile.candidate, domain: "software engineering" },
  });
  const boards = result.searches.filter((source) => source.source_type === "board");

  assert.deepEqual(
    boards.map(({ provider, source_type, enabled }) => ({ provider, source_type, enabled })),
    [
      { provider: "remoteok", source_type: "board", enabled: true },
      { provider: "remotive", source_type: "board", enabled: true },
      { provider: "workingnomads", source_type: "board", enabled: true },
    ]
  );
});

test("buildSearchSources: seeds the same three boards disabled for healthcare", () => {
  const result = buildSearchSources(targeting, {
    ...profile,
    candidate: { ...profile.candidate, domain: "nursing and healthcare" },
  });
  const boards = result.searches.filter((source) => source.source_type === "board");

  assert.deepEqual(
    boards.map(({ provider, source_type, enabled }) => ({ provider, source_type, enabled })),
    [
      { provider: "remoteok", source_type: "board", enabled: false },
      { provider: "remotive", source_type: "board", enabled: false },
      { provider: "workingnomads", source_type: "board", enabled: false },
    ]
  );
});

test("buildSearchSources: HiringCafe searches are deduped by title", () => {
  const result = buildSearchSources(targeting, profile);
  const hcEntries = result.searches.filter((s) => s.provider === "HiringCafe");
  const labels = hcEntries.map((s) => s.label);
  const uniqueLabels = new Set(labels);
  assert.equal(
    labels.length,
    uniqueLabels.size,
    "HiringCafe searches should not have duplicate labels"
  );
});

test("buildSearchSources: fixed posting-age preference becomes a generated recency window", () => {
  const result = buildSearchSources(
    {
      ...targeting,
      search_preferences: {
        posting_age: {
          mode: "fixed-days",
          days: 14,
        },
      },
    },
    profile
  );
  const hcEntries = result.searches.filter((s) => s.provider === "HiringCafe");

  assert.ok(hcEntries.length > 0, "expected generated HiringCafe searches");
  for (const entry of hcEntries) {
    assert.deepEqual(entry.recency, {
      mode: "fixed-hours",
      hours: 336,
      safetyMinutes: 30,
    });
  }
});

test("buildSearchSources: result validates against search-sources.schema.json", () => {
  const result = buildSearchSources(targeting, profile);
  const { valid, errors } = validate(result, schema);
  assert.equal(valid, true, `schema validation failed: ${JSON.stringify(errors, null, 2)}`);
});

test("buildSearchSources: YAML round-trip still validates against schema", () => {
  const result = buildSearchSources(targeting, profile);
  const yaml = stringifyYaml(result);
  const reparsed = parseYaml(yaml);
  const { valid, errors } = validate(reparsed, schema);
  assert.equal(
    valid,
    true,
    `YAML round-trip validation failed: ${JSON.stringify(errors, null, 2)}`
  );
});

test("buildSearchSources: tracked_companies is an empty array", () => {
  const result = buildSearchSources(targeting, profile);
  assert.deepEqual(result.tracked_companies, []);
});

test("buildSearchSources: source_catalog has aggregators, ats, remote_boards", () => {
  const result = buildSearchSources(targeting, profile);
  assert.ok(Array.isArray(result.source_catalog.aggregators), "aggregators must be an array");
  assert.ok(Array.isArray(result.source_catalog.ats), "ats must be an array");
  assert.ok(Array.isArray(result.source_catalog.remote_boards), "remote_boards must be an array");
  assert.ok(
    result.source_catalog.aggregators.includes("HiringCafe"),
    "HiringCafe missing from aggregators"
  );
  assert.ok(
    result.source_catalog.aggregators.includes("RemoteVibeCodingJobs"),
    "RemoteVibeCodingJobs missing from aggregators"
  );
});
