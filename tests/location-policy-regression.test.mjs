import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSearchSources } from "../src/core/profile/generate-search-sources.mjs";
import { feedItemsToOffers } from "../src/core/providers/rss.mjs";
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

test("captured job text overrides a false remote label and enforces the office-day limit", () => {
  const profile = {
    candidate: { domain: "software engineering" },
    location: {
      home: "NYC",
      remote: true,
      hybrid: true,
      onsite: false,
      max_commute_days_per_week: 2,
      relocation: [],
    },
  };
  const mislabeled = offer("mislabeled-remote", "Mislabeled Corp", "New York, NY (Remote)");
  mislabeled.bodyText =
    "This software engineering role requires employees in the office 5 days per week in New York City.";
  const matchingHybrid = offer("matching-hybrid", "Matching Corp", "New York, NY (Hybrid)");
  matchingHybrid.bodyText = "This team is expected in the New York office 2 days per week.";
  const result = qualifyByLocation(profile, [mislabeled, matchingHybrid]);

  assert.deepEqual(
    result.kept.map((row) => row.company),
    ["Matching Corp"]
  );
  assert.equal(result.filteredLocation.length, 1);
  assert.equal(result.filteredLocation[0].company, "Mislabeled Corp");
  assert.equal(result.filteredLocation[0].qualificationReason, "office-days-exceed-preference");
});

test("an unset office-day limit does not reject a required hybrid schedule", () => {
  const profile = {
    candidate: { domain: "software engineering" },
    location: {
      home: "NYC",
      remote: true,
      hybrid: true,
      onsite: false,
      max_commute_days_per_week: null,
      relocation: [],
    },
  };
  const hybrid = offer("unlimited-hybrid", "Unlimited Hybrid Corp", "New York, NY (Hybrid)");
  hybrid.bodyText = "Employees are required in the New York office 2 days per week.";

  const result = qualifyByLocation(profile, [hybrid]);

  assert.deepEqual(
    result.kept.map((row) => row.company),
    ["Unlimited Hybrid Corp"]
  );
  assert.equal(result.filteredLocation.length, 0);
});

test("optional office access stays remote while required office schedules are enforced", () => {
  const profile = {
    candidate: { domain: "software engineering" },
    location: {
      home: "NYC",
      remote: true,
      hybrid: false,
      onsite: false,
      max_commute_days_per_week: null,
      relocation: [],
    },
  };
  const optional = offer("optional-office", "Optional Office Corp", "Remote - United States");
  optional.bodyText =
    "This is a fully remote role. Employees may use the New York office 2 days per week if they prefer.";
  const required = offer("required-office", "Required Office Corp", "Remote - United States");
  required.bodyText = "Employees are required in the New York office 2 days per week.";
  const must = offer("must-office", "Must Office Corp", "Remote - United States");
  must.bodyText = "Employees must work in the New York office 2 days per week.";
  const expected = offer("expected-office", "Expected Office Corp", "Remote - United States");
  expected.bodyText = "Employees are expected in the New York office 2 days per week.";

  const result = qualifyByLocation(profile, [optional, required, must, expected]);

  assert.deepEqual(
    result.kept.map((row) => row.company),
    ["Optional Office Corp"]
  );
  assert.deepEqual(
    result.filteredLocation.map((row) => [row.company, row.qualificationReason]),
    [
      ["Required Office Corp", "hybrid-not-allowed"],
      ["Must Office Corp", "hybrid-not-allowed"],
      ["Expected Office Corp", "hybrid-not-allowed"],
    ]
  );
});

test("captured job text rejects an on-site role even when the board calls it remote", () => {
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
  const mislabeled = offer("onsite-labeled-remote", "Onsite Corp", "New York, NY (Remote)");
  mislabeled.bodyText = "This is a fully on-site role at our New York City office.";
  const result = qualifyByLocation(profile, [mislabeled]);

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredLocation.length, 1);
  assert.equal(result.filteredLocation[0].qualificationReason, "onsite-not-allowed");
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

test("worldwide remote scope keeps remote roles globally while local work stays NYC-only", () => {
  const profile = {
    candidate: { domain: "software engineering" },
    location: {
      home: "NYC",
      remote: true,
      remote_scope: "worldwide",
      hybrid: true,
      onsite: true,
      relocation: [],
    },
  };
  const result = qualifyByLocation(profile, [
    offer("remote-us-worldwide", "Remote US Worldwide", "Remote - United States"),
    offer("remote-emea-worldwide", "Remote EMEA Worldwide", "Remote - EMEA"),
    offer("remote-anywhere-worldwide", "Remote Anywhere Worldwide", "Remote - Anywhere"),
    offer("nyc-hybrid-worldwide", "NYC Hybrid Worldwide", "New York, NY (Hybrid)"),
    offer("nyc-onsite-worldwide", "NYC Onsite Worldwide", "New York, NY (On-site)"),
    offer("boston-hybrid-worldwide", "Boston Hybrid Worldwide", "Boston, MA (Hybrid)"),
    offer(
      "london-remote-friendly-hybrid-worldwide",
      "London Remote-Friendly Hybrid Worldwide",
      "London, UK (Remote-friendly hybrid)"
    ),
    offer("berlin-onsite-worldwide", "Berlin Onsite Worldwide", "Berlin, Germany (On-site)"),
  ]);

  assert.deepEqual(result.kept.map((row) => row.company).sort(), [
    "NYC Hybrid Worldwide",
    "NYC Onsite Worldwide",
    "Remote Anywhere Worldwide",
    "Remote EMEA Worldwide",
    "Remote US Worldwide",
  ]);
  assert.deepEqual(result.filteredLocation.map((row) => row.company).sort(), [
    "Berlin Onsite Worldwide",
    "Boston Hybrid Worldwide",
    "London Remote-Friendly Hybrid Worldwide",
  ]);
});

test("NYC plus US-remote policy handles office labels and multisite postings without widening local work", () => {
  const profile = {
    candidate: { domain: "software engineering" },
    location: {
      home: "New York, NY",
      remote: true,
      remote_scope: "home-country",
      hybrid: true,
      onsite: false,
      relocation: [],
    },
  };
  const result = qualifyByLocation(
    profile,
    [
      offer("nyc-office", "Plaid Backend", "New York City Office"),
      offer("nyc-direct", "Addition Wealth", "New York, NY"),
      offer("nyc-hybrid", "NYC Hybrid", "New York, NY (Hybrid)"),
      offer("remote-us", "Remote US", "Remote · United States"),
      offer(
        "remote-nyc-multisite",
        "Remote NYC Multisite",
        "Remote · United States · New York City Office · New York"
      ),
      offer(
        "nyc-multisite",
        "NYC Multisite",
        "San Francisco HQ · New York City Office · New York · United States"
      ),
      offer("sf-local", "San Francisco Only", "San Francisco, CA (Hybrid)"),
      offer("seattle-local", "Seattle Only", "Seattle Office"),
      offer("west-coast-multisite", "West Coast Multisite", "San Francisco HQ · Seattle Office"),
    ],
    { generatedFilter: false }
  );

  assert.deepEqual(result.kept.map((row) => row.company).sort(), [
    "Addition Wealth",
    "NYC Hybrid",
    "NYC Multisite",
    "Plaid Backend",
    "Remote NYC Multisite",
    "Remote US",
  ]);
  assert.deepEqual(result.filteredLocation.map((row) => row.company).sort(), [
    "San Francisco Only",
    "Seattle Only",
    "West Coast Multisite",
  ]);
});

test("remote-only RSS provenance keeps a USA-scoped role eligible", () => {
  const profile = {
    candidate: { domain: "software engineering" },
    location: {
      home: "New York, NY",
      remote: true,
      remote_scope: "home-country",
      hybrid: true,
      onsite: false,
      relocation: [],
    },
  };
  const offers = feedItemsToOffers(
    [
      {
        title: "Senior Software Engineer, Platform at Qventus",
        link: "https://remotevibecodingjobs.com/jobs/qventus-platform",
        guid: null,
        isoDate: null,
        description: "Company: Qventus\nLocation: USA\nType: Full-time",
        categories: [],
      },
      {
        title: "Senior Software Engineer, Backend at Affirm",
        link: "https://remotevibecodingjobs.com/jobs/affirm-backend",
        guid: null,
        isoDate: null,
        description: "Company: Affirm\nLocation: Las Vegas, NV\nType: Full-time",
        categories: [],
      },
    ],
    {
      source: {
        provider: "RemoteVibeCodingJobs",
        label: "Remote Vibe Coding Jobs",
        rssUrl: "https://remotevibecodingjobs.com/feed.xml",
      },
    }
  );
  const result = qualifyByLocation(profile, offers, { generatedFilter: false });

  assert.deepEqual(
    result.kept.map((row) => row.company),
    ["Qventus", "Affirm"]
  );
  assert.equal(result.filteredLocation.length, 0);
});
