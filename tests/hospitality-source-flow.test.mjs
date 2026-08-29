import assert from "node:assert/strict";
import test from "node:test";

import { buildSearchSources } from "../src/core/profile/generate-search-sources.mjs";
import {
  buildLocationFilter,
  buildTitleFilter,
  filterAndDedupeOffers,
  scanBoards,
} from "../src/core/scoring/sourced-scanner.mjs";
import {
  detailHtmlByProvider,
  detailUrlByProvider,
  listHtmlByProvider,
} from "./fixtures/hospitality-public.mjs";

const targeting = {
  role_buckets: [
    {
      name: "Hospitality",
      priority: "primary",
      titles: ["Bartender", "Food and Beverage Supervisor", "Event Operations Manager"],
    },
  ],
  keep_signals: ["guest service", "bar operations", "venue operations"],
  cut_signals: ["software engineering"],
};

const profile = {
  candidate: { domain: "hospitality and food service" },
  location: {
    home: "New York, NY",
    remote: false,
    hybrid: true,
    onsite: true,
    commute_radius_miles: 30,
  },
  compensation: {},
  authorization: { work_authorized: true },
};

const PUBLIC_ADDRESS = [{ address: "93.184.216.34", family: 4 }];

test("hospitality source generation scans relevant local roles without making Arbeitnow the baseline", async () => {
  const config = buildSearchSources(targeting, profile);
  const hospitalitySources = config.searches.filter((source) =>
    ["culinaryagents", "oysterlink", "hcareers", "hospitalityonline", "ihirehospitality"].includes(
      source.provider
    )
  );

  assert.deepEqual([...new Set(hospitalitySources.map((source) => source.provider))].sort(), [
    "culinaryagents",
    "hcareers",
    "hospitalityonline",
    "ihirehospitality",
    "oysterlink",
  ]);
  assert.equal(
    config.searches.some((source) => source.provider === "arbeitnow"),
    false
  );
  assert.equal(
    hospitalitySources.every((source) => source.enabled),
    true
  );
  assert.equal(
    hospitalitySources.find((source) => source.provider === "ihirehospitality").url,
    "https://www.ihirehospitality.com/t-hospitality-s-new-york-jobs.html"
  );

  const byUrl = new Map();
  for (const source of hospitalitySources) {
    const detailUrl = detailUrlByProvider[source.provider];
    byUrl.set(source.url, listHtmlByProvider[source.provider]);
    byUrl.set(detailUrl, detailHtmlByProvider[source.provider]);
  }

  const techDetailUrl = "https://www.hcareers.com/jobs/9999999-platform-engineer-berlin";
  const outsideDetailUrl = "https://www.hcareers.com/jobs/9999998-bartender-berlin";
  const firstHcareers = hospitalitySources.find((source) => source.provider === "hcareers");
  byUrl.set(
    firstHcareers.url,
    listHtmlByProvider.hcareers.replace(
      "</body>",
      '<a href="/jobs/9999999-platform-engineer-berlin">Platform Engineer</a>' +
        '<a href="/jobs/9999998-bartender-berlin">Bartender in Berlin</a></body>'
    )
  );
  byUrl.set(
    techDetailUrl,
    detailHtmlByProvider.hcareers.replace("Rooftop Bartender", "Platform Engineer")
  );
  byUrl.set(
    outsideDetailUrl,
    detailHtmlByProvider.hcareers
      .replace('"addressLocality":"New York"', '"addressLocality":"Berlin"')
      .replace('"addressRegion":"NY"', '"addressRegion":"BE"')
      .replace('"addressCountry":"US"', '"addressCountry":"DE"')
  );

  const scanned = await scanBoards(
    { ...config, searches: hospitalitySources },
    {
      fetchImpl: async (url) => {
        const body = byUrl.get(url);
        if (!body) throw new Error(`unexpected request: ${url}`);
        return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
      },
      resolveHost: async () => PUBLIC_ADDRESS,
      dispatcherFactory: () => ({ close: async () => {} }),
    }
  );

  assert.deepEqual(scanned.errors, []);
  const filtered = filterAndDedupeOffers(scanned.offers, {
    titleFilter: buildTitleFilter(config.title_filter),
    locationFilter: buildLocationFilter(config.location_filter),
    config: { targeting, profile },
    now: Date.parse("2026-08-27T12:00:00Z"),
  });

  assert.ok(filtered.kept.some((offer) => /Bartender/.test(offer.title)));
  assert.equal(
    filtered.kept.some((offer) => /Platform Engineer/.test(offer.title)),
    false
  );
  assert.ok(filtered.filteredTitle.some((offer) => /Platform Engineer/.test(offer.title)));
  assert.ok(
    filtered.filteredLocation.some(
      (offer) => /Rooftop Bartender/.test(offer.title) && /Berlin/.test(offer.location)
    )
  );
  assert.equal(
    filtered.kept.every((offer) => /New York|Brooklyn/.test(offer.location)),
    true
  );
  assert.equal(
    filtered.kept.every((offer) => offer.bodyPartial === false),
    true
  );
});

test("hospitality boards are not seeded for unrelated software targets", () => {
  const config = buildSearchSources(
    {
      role_buckets: [{ name: "Engineering", priority: "primary", titles: ["Platform Engineer"] }],
    },
    {
      ...profile,
      candidate: { domain: "software engineering" },
    }
  );

  assert.equal(
    config.searches.some((source) =>
      [
        "culinaryagents",
        "oysterlink",
        "hcareers",
        "hospitalityonline",
        "ihirehospitality",
      ].includes(source.provider)
    ),
    false
  );
});

test("explicit software domains and ambiguous server or event words never enable hospitality boards", () => {
  for (const candidate of [
    {
      domain: "software engineering",
      titles: ["Server Engineer", "Event Operations Manager"],
    },
    { domain: "event-driven software systems", titles: ["Platform Engineer"] },
    { domain: "", titles: ["Server Engineer", "Event Coordinator"] },
  ]) {
    const config = buildSearchSources(
      {
        role_buckets: [{ name: "Engineering", priority: "primary", titles: candidate.titles }],
      },
      {
        ...profile,
        candidate: { domain: candidate.domain },
      }
    );

    assert.equal(
      config.searches.some((source) =>
        [
          "culinaryagents",
          "oysterlink",
          "hcareers",
          "hospitalityonline",
          "ihirehospitality",
        ].includes(source.provider)
      ),
      false,
      JSON.stringify(candidate)
    );
    assert.equal(
      config.searches.some((source) => source.provider === "arbeitnow"),
      true,
      JSON.stringify(candidate)
    );
  }
});

test("a strong hospitality operations title can infer the domain when the profile has none", () => {
  const config = buildSearchSources(
    {
      role_buckets: [
        { name: "Operations", priority: "primary", titles: ["Event Operations Manager"] },
      ],
    },
    {
      ...profile,
      candidate: { domain: "" },
    }
  );

  assert.equal(
    config.searches.some((source) => source.provider === "hcareers"),
    true
  );
});

test("hospitality source generation normalizes common New York location forms", () => {
  for (const home of ["NYC", "New York City", "New York City, NY", "New York, NY, United States"]) {
    const config = buildSearchSources(targeting, {
      ...profile,
      location: { ...profile.location, home },
    });
    const providers = config.searches
      .filter((source) => source.enabled !== false && source.source_type === "board")
      .map((source) => source.provider);
    const oyster = config.searches.find((source) => source.provider === "oysterlink");

    assert.equal(oyster.url, "https://oysterlink.com/jobs/bartender/new-york-ny/", home);
    assert.deepEqual(
      [...new Set(providers)].sort(),
      ["culinaryagents", "hcareers", "hospitalityonline", "ihirehospitality", "oysterlink"],
      home
    );
  }
});

test("hospitality source generation keeps a deterministic fallback when no local board URL is possible", () => {
  const config = buildSearchSources(targeting, {
    ...profile,
    location: { ...profile.location, home: "London, UK" },
  });

  assert.equal(
    config.searches.some((source) => source.provider === "arbeitnow" && source.enabled),
    true
  );
});

test("hospitality title-query boards cover a bounded deduplicated set of target titles", () => {
  const config = buildSearchSources(
    {
      ...targeting,
      role_buckets: [
        {
          name: "Hospitality",
          priority: "primary",
          titles: [
            "Bartender",
            " bartender ",
            "Event Operations Manager",
            "Food and Beverage Supervisor",
            "Hotel Operations Manager",
            "Banquet Manager",
            "Concierge",
          ],
        },
      ],
    },
    profile
  );
  const queryProviders = new Set(["culinaryagents", "oysterlink", "hcareers", "hospitalityonline"]);
  const queriesByProvider = Object.groupBy(
    config.searches.filter((source) => queryProviders.has(source.provider)),
    (source) => source.provider
  );

  for (const provider of queryProviders) {
    const sources = queriesByProvider[provider];
    assert.deepEqual(
      sources.map((source) => source.label.split(" · ").at(-1)),
      [
        "Bartender",
        "Event Operations Manager",
        "Food and Beverage Supervisor",
        "Hotel Operations Manager",
      ]
    );
    assert.equal(
      sources.every((source) => source.max_results === 8),
      true
    );
    if (provider === "culinaryagents") {
      for (const [index, source] of sources.entries()) {
        const url = new URL(source.url);
        assert.equal(url.hostname, "culinaryagents.com");
        assert.equal(url.pathname, "/search/jobs");
        assert.equal(url.searchParams.get("search[name]"), source.label.split(" · ").at(-1));
        assert.equal(url.searchParams.get("search[location]"), "New York, NY");
        assert.equal(url.searchParams.get("search[country]"), "US");
        assert.equal(index < 4, true);
      }
    }
  }
  assert.equal(
    config.searches.filter((source) => source.provider === "ihirehospitality").length,
    1
  );
});

test("hospitality title-query boards allocate the bounded title cap across role buckets", () => {
  const config = buildSearchSources(
    {
      ...targeting,
      role_buckets: [
        {
          name: "Bar leadership",
          priority: "primary",
          titles: ["Bar Manager", "Assistant Bar Manager", "Bar Operations Lead", "Lead Bartender"],
        },
        {
          name: "Hospitality operations",
          priority: "secondary",
          titles: ["Operations Manager, Food & Beverage", "Assistant General Manager"],
        },
        {
          name: "Event and venue operations",
          priority: "adjacent",
          titles: ["Event Operations Manager", "Venue Operations Manager"],
        },
      ],
    },
    profile
  );
  const queryProviders = new Set(["culinaryagents", "oysterlink", "hcareers", "hospitalityonline"]);
  const queriesByProvider = Object.groupBy(
    config.searches.filter((source) => queryProviders.has(source.provider)),
    (source) => source.provider
  );

  for (const provider of queryProviders) {
    assert.deepEqual(
      queriesByProvider[provider].map((source) => source.label.split(" · ").at(-1)),
      [
        "Bar Manager",
        "Operations Manager, Food & Beverage",
        "Event Operations Manager",
        "Assistant Bar Manager",
      ]
    );
  }
});
