import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildSearchSources } from "../src/core/profile/generate-search-sources.mjs";
import { validate } from "../src/core/profile/schema-validator.mjs";
import { parseYaml, stringifyYaml } from "../src/core/profile/yaml.mjs";
import { buildLocationFilter } from "../src/core/scoring/sourced-scanner.mjs";

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

test("buildSearchSources: US home derives a country-aware filter that blocks foreign roles", () => {
  const result = buildSearchSources(targeting, profile);
  const filter = buildLocationFilter(result.location_filter);

  assert.ok(result.location_filter.always_allow.includes("Austin, TX"));
  assert.ok(result.location_filter.allow.includes("United States"));
  assert.ok(result.location_filter.block.includes("India"));
  assert.equal(result.location_filter.needs_location, false);
  assert.equal(filter("Austin, TX"), true);
  assert.equal(filter("United States"), true);
  assert.equal(filter("Indianapolis, Indiana, US"), true);
  assert.equal(filter("Bangalore, India"), false);
  assert.equal(filter("San Francisco, Chinatown, CA"), true);
});

test("buildLocationFilter preserves punctuation-led state and multi-word allow terms", () => {
  const filter = buildLocationFilter({
    always_allow: [],
    allow: [", NY", "United States", "North America"],
    block: [],
  });

  assert.equal(filter("Albany, NY"), true);
  assert.equal(filter("Remote — United States"), true);
  assert.equal(filter("Remote — North America"), true);
});

test("buildSearchSources: remote posture allows remote roles", () => {
  const result = buildSearchSources(targeting, {
    ...profile,
    location: { home: "", remote: true, relocation: [] },
  });

  assert.equal(result.location_filter.needs_location, false);
  assert.equal(buildLocationFilter(result.location_filter)("Remote"), true);
});

test("buildSearchSources: no home, relocation, or remote posture needs a location", () => {
  const result = buildSearchSources(targeting, {
    ...profile,
    location: { home: "", remote: false, relocation: [] },
  });

  assert.equal(result.location_filter.needs_location, true);
  assert.equal(buildLocationFilter(result.location_filter)("Remote"), false);
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
    // present-but-disabled for non-tech domains/titles so any domain can flip them
    // on later; every other generated entry stays enabled regardless.
    if (item.source_type !== "board") {
      assert.equal(item.enabled, true, `enabled must be true: ${JSON.stringify(item)}`);
    }
    // Every item must satisfy anyOf: query, url, or rssUrl.
    const hasSource = "query" in item || "url" in item || "rssUrl" in item;
    assert.ok(hasSource, `item missing query/url/rssUrl: ${JSON.stringify(item)}`);
  }
});

test("buildSearchSources: no RemoteVibeCodingJobs when domain and titles are both non-tech", () => {
  // Domain absent AND no title in any bucket looks tech-shaped — the
  // inferTechFromTargeting() fallback must stay false, same as the old
  // domain-only gate did for every non-tech candidate.
  const nonTechTargeting = {
    role_buckets: [
      { name: "Primary", priority: "primary", titles: ["Registered Nurse", "Nurse Practitioner"] },
    ],
  };
  const result = buildSearchSources(nonTechTargeting, profile);
  const rvEntries = result.searches.filter((s) => s.provider === "RemoteVibeCodingJobs");
  assert.equal(
    rvEntries.length,
    0,
    "RemoteVibeCodingJobs must not appear when domain is absent and titles aren't tech-shaped"
  );
});

test("buildSearchSources: RemoteVibeCodingJobs appears when domain is absent but a majority of titles look tech", () => {
  // The shared `targeting` fixture's titles ("Forward Deployed Engineer",
  // "Applied AI Engineer", "Solutions Engineer") all contain "Engineer" —
  // domain absent should now fall back to that title-inference signal
  // instead of defaulting to general-only aggregators.
  const result = buildSearchSources(targeting, profile);
  const rvEntries = result.searches.filter((s) => s.provider === "RemoteVibeCodingJobs");
  assert.equal(
    rvEntries.length,
    1,
    "RemoteVibeCodingJobs must appear when a majority of configured titles look tech"
  );
  assert.equal(rvEntries[0].rssUrl, "https://remotevibecodingjobs.com/feed.xml");
  assert.equal(
    result.searches
      .filter((source) => source.source_type === "board")
      .every((source) => source.enabled === true),
    true,
    "all seeded boards must be enabled when every configured title looks tech-shaped"
  );
});

test("buildSearchSources: empty-domain title inference requires a strict tech-title majority", () => {
  const cases = [
    {
      label: "majority non-tech",
      titles: ["Software Engineer", "Registered Nurse", "Clinical Manager"],
    },
    { label: "exact 50/50", titles: ["Software Engineer", "Registered Nurse"] },
    { label: "zero titles", titles: [] },
  ];

  for (const { label, titles } of cases) {
    const result = buildSearchSources(
      { role_buckets: [{ name: "Primary", priority: "primary", titles }] },
      profile
    );

    assert.equal(
      result.searches.some((source) => source.provider === "RemoteVibeCodingJobs"),
      false,
      `${label} must not enable the tech RSS source`
    );
    assert.equal(
      result.searches
        .filter((source) => source.enabled_reason === "domain-gate")
        .every((source) => source.enabled === false),
      true,
      `${label} must keep every tech-gated board disabled`
    );
    assert.equal(
      result.searches.some((source) => source.provider === "arbeitnow" && source.enabled === true),
      titles.length > 0,
      `${label} must enable the broad fallback only after a target title exists`
    );
  }
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

test("buildSearchSources: no hardcoded tech literal — explicit tech domain with no titles configured yet omits the tech aggregators entirely", () => {
  // domain-neutral rule: no personal/tech default hardcoded. An explicit tech
  // domain with an empty role_buckets can't derive a real query, so the
  // RemoteVibeCodingJobs/Wellfound aggregators must be skipped rather than
  // falling back to a hardcoded "AI engineer" literal that would misrepresent
  // any non-AI tech candidate (e.g. embedded, mobile, SRE).
  const techProfileNoTitles = {
    ...profile,
    candidate: { ...profile.candidate, domain: "software engineering" },
  };
  const result = buildSearchSources({ role_buckets: [] }, techProfileNoTitles);

  assert.equal(
    result.searches.some((s) => s.provider === "RemoteVibeCodingJobs"),
    false,
    "RemoteVibeCodingJobs must not appear when no title can be derived"
  );
  assert.equal(
    result.searches.some((s) => s.provider === "Wellfound"),
    false,
    "Wellfound must not appear when no title can be derived"
  );
  assert.ok(
    !result.searches.some(
      (s) => s.query === "AI engineer" || (s.url && s.url.includes("ai-engineer"))
    ),
    "no search entry may fall back to the hardcoded 'AI engineer' literal"
  );
});

test("buildSearchSources: seeds broad public fallback plus tech boards for tech", () => {
  const result = buildSearchSources(targeting, {
    ...profile,
    candidate: { ...profile.candidate, domain: "software engineering" },
  });
  const boards = result.searches.filter((source) => source.source_type === "board");

  assert.deepEqual(
    boards.map(({ provider, source_type, enabled, enabled_reason }) => ({
      provider,
      source_type,
      enabled,
      enabled_reason,
    })),
    [
      {
        provider: "remoteok",
        source_type: "board",
        enabled: true,
        enabled_reason: "domain-gate",
      },
      {
        provider: "remotive",
        source_type: "board",
        enabled: true,
        enabled_reason: "domain-gate",
      },
      {
        provider: "workingnomads",
        source_type: "board",
        enabled: true,
        enabled_reason: "domain-gate",
      },
      {
        provider: "arbeitnow",
        source_type: "board",
        enabled: true,
        enabled_reason: "baseline",
      },
    ]
  );
});

test("buildSearchSources: keeps tech boards disabled but runs a broad public fallback for healthcare", () => {
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
      { provider: "arbeitnow", source_type: "board", enabled: true },
    ]
  );
  assert.equal(boards.at(-1).max_pages, 1);
  assert.equal(
    result.searches.some((source) => source.provider === "RemoteVibeCodingJobs"),
    false,
    "an explicit non-tech domain must override all-tech title inference"
  );
});

test("buildSearchSources: explicit tech domain enables tech sources despite non-tech titles", () => {
  const result = buildSearchSources(
    {
      role_buckets: [
        { name: "Primary", priority: "primary", titles: ["Registered Nurse", "Clinical Manager"] },
      ],
    },
    {
      ...profile,
      candidate: { ...profile.candidate, domain: "software engineering" },
    }
  );

  assert.equal(
    result.searches.some((source) => source.provider === "RemoteVibeCodingJobs"),
    true
  );
  assert.equal(
    result.searches
      .filter((source) => source.source_type === "board")
      .every((source) => source.enabled === true),
    true
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

test("buildSearchSources: source_catalog exposes all public Career Ops providers", () => {
  const result = buildSearchSources(targeting, profile);
  assert.equal(result.source_catalog.deterministic_providers.length, 77);
  assert.ok(result.source_catalog.deterministic_providers.includes("bamboohr"));
  assert.ok(result.source_catalog.deterministic_providers.includes("workday"));
  assert.equal(result.source_catalog.deterministic_providers.includes("local-parser"), false);
});
