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
    ["oysterlink", "hcareers", "hospitalityonline", "ihirehospitality"].includes(source.provider)
  );

  assert.deepEqual([...new Set(hospitalitySources.map((source) => source.provider))].sort(), [
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
  const firstHcareers = hospitalitySources.find((source) => source.provider === "hcareers");
  byUrl.set(
    firstHcareers.url,
    listHtmlByProvider.hcareers.replace(
      "</body>",
      '<a href="/jobs/9999999-platform-engineer-berlin">Platform Engineer</a></body>'
    )
  );
  byUrl.set(
    techDetailUrl,
    detailHtmlByProvider.hcareers
      .replace("Rooftop Bartender", "Platform Engineer")
      .replace("New York", "Berlin")
      .replace('"NY"', '"Germany"')
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
  assert.equal(
    filtered.kept.every((offer) => /New York/.test(offer.location)),
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
      ["oysterlink", "hcareers", "hospitalityonline", "ihirehospitality"].includes(source.provider)
    ),
    false
  );
});

test("hospitality source generation uses OysterLink's canonical New York City slug", () => {
  const config = buildSearchSources(targeting, {
    ...profile,
    location: { ...profile.location, home: "New York City, NY" },
  });
  const oyster = config.searches.find((source) => source.provider === "oysterlink");

  assert.equal(oyster.url, "https://oysterlink.com/jobs/bartender/new-york-ny/");
});
