import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSearchSources } from "../src/core/profile/generate-search-sources.mjs";
import {
  buildLocationFilter,
  filterAndDedupeOffers,
} from "../src/core/scoring/sourced-scanner.mjs";

const targeting = {
  role_buckets: [{ priority: "primary", titles: ["Platform Engineer"] }],
  keep_signals: [],
  cut_signals: [],
};

function qualifyByLocation(profile, offers, { generatedFilter = true } = {}) {
  const generated = buildSearchSources(targeting, profile);
  return filterAndDedupeOffers(offers, {
    seenUrls: new Set(),
    seenReqIds: new Set(),
    seenCompanyRoles: new Set(),
    titleFilter: () => true,
    locationFilter: buildLocationFilter(generatedFilter ? generated.location_filter : null),
    config: { targeting, profile },
  });
}

function offer(id, company, location) {
  return {
    title: "Platform Engineer",
    company,
    location,
    url: `https://jobs.example.test/${id}`,
    bodyText: "Platform engineering role with enough detail for a deterministic test fixture.",
  };
}

test("remote-or-NYC posture accepts US remote and New York metro roles without leaking other regions", () => {
  const profile = {
    candidate: { domain: "software engineering" },
    location: {
      home: "NYC",
      remote: true,
      hybrid: true,
      onsite: false,
      relocation: [],
    },
  };
  const result = qualifyByLocation(profile, [
    offer("remote-us", "Remote US Corp", "Remote - United States"),
    offer("nyc-hybrid", "NYC Hybrid Corp", "New York, NY (Hybrid)"),
    offer("nyc-metro", "NYC Metro Corp", "New York Metropolitan Area (Hybrid)"),
    offer("ny-metro", "NY Metro Corp", "NY Metro (Hybrid)"),
    offer("boston", "Boston Corp", "Boston, MA (Hybrid)"),
    offer("remote-emea", "Remote EMEA Corp", "Remote - EMEA"),
  ]);

  assert.deepEqual(result.kept.map((row) => row.company).sort(), [
    "NY Metro Corp",
    "NYC Hybrid Corp",
    "NYC Metro Corp",
    "Remote US Corp",
  ]);
  assert.deepEqual(result.filteredLocation.map((row) => row.company).sort(), [
    "Boston Corp",
    "Remote EMEA Corp",
  ]);
});

test("the scanner recognizes NYC as US even without a generated source filter", () => {
  const profile = {
    candidate: { domain: "software engineering" },
    location: {
      home: "NYC",
      remote: true,
      hybrid: true,
      onsite: false,
      relocation: [],
    },
  };
  const result = qualifyByLocation(
    profile,
    [
      offer("remote-us-direct", "Remote US Direct", "Remote - United States"),
      offer("remote-emea-direct", "Remote EMEA Direct", "Remote - EMEA"),
    ],
    { generatedFilter: false }
  );

  assert.deepEqual(
    result.kept.map((row) => row.company),
    ["Remote US Direct"]
  );
  assert.deepEqual(
    result.filteredLocation.map((row) => row.company),
    ["Remote EMEA Direct"]
  );
});

test("US-only remote scope rejects foreign, global, and region-unknown remote roles", () => {
  const profile = {
    candidate: { domain: "software engineering" },
    location: {
      home: "NYC",
      remote: true,
      hybrid: true,
      onsite: false,
      relocation: [],
    },
  };
  const result = qualifyByLocation(
    profile,
    [
      offer("remote-us-strict", "Remote US Strict", "Remote - United States"),
      offer("remote-de", "Remote DE Corp", "Remote DE; Aachen; Munich"),
      offer("remote-germany", "Remote Germany Corp", "Remote - Germany"),
      offer("remote-emea-strict", "Remote EMEA Strict", "Remote - EMEA"),
      offer("remote-global", "Remote Global Corp", "Remote - Worldwide"),
      offer("remote-anywhere", "Remote Anywhere Corp", "Remote - Anywhere"),
      offer("remote-unknown", "Remote Unknown Corp", "Remote"),
    ],
    { generatedFilter: false }
  );

  assert.deepEqual(
    result.kept.map((row) => row.company),
    ["Remote US Strict"]
  );
  assert.deepEqual(
    result.filteredLocation.map((row) => [row.company, row.qualificationReason]),
    [
      ["Remote DE Corp", "remote-region-mismatch"],
      ["Remote Germany Corp", "remote-region-mismatch"],
      ["Remote EMEA Strict", "remote-region-mismatch"],
      ["Remote Global Corp", "remote-region-unverified"],
      ["Remote Anywhere Corp", "remote-region-unverified"],
      ["Remote Unknown Corp", "remote-region-unverified"],
    ]
  );
});

test("NYC-only local scope accepts the metro and rejects other US cities", () => {
  const profile = {
    candidate: { domain: "software engineering" },
    location: {
      home: "NYC",
      remote: true,
      hybrid: true,
      onsite: false,
      relocation: [],
    },
  };
  const result = qualifyByLocation(
    profile,
    [
      offer("nyc-local", "NYC Local Corp", "New York, NY (Hybrid)"),
      offer("brooklyn-local", "Brooklyn Local Corp", "Brooklyn, NY (Hybrid)"),
      offer("boston-local", "Boston Local Corp", "Boston, MA (Hybrid)"),
      offer("austin-local", "Austin Local Corp", "Austin, TX (Hybrid)"),
    ],
    { generatedFilter: false }
  );

  assert.deepEqual(result.kept.map((row) => row.company).sort(), [
    "Brooklyn Local Corp",
    "NYC Local Corp",
  ]);
  assert.deepEqual(result.filteredLocation.map((row) => row.company).sort(), [
    "Austin Local Corp",
    "Boston Local Corp",
  ]);
});
