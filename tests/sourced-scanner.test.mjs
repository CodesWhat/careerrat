import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  buildLocationFilter,
  buildTitleFilter,
  extractCompBand,
  extractReqId,
  fetchProvider,
  filterAndDedupeOffers,
  fitFromScore,
  htmlToText,
  inferProvider,
  normalizeCompanyRoleKey,
  scoreSourcedOffer,
} from "../src/core/scoring/sourced-scanner.mjs";

// ---------------------------------------------------------------------------
// Demo persona fixture — mirrors Jane in candidate/example/
// ---------------------------------------------------------------------------
const JANE_TECH_CONFIG = {
  targeting: {
    role_buckets: [
      { name: "Primary", titles: ["Forward Deployed Engineer", "Applied AI Engineer"] },
      { name: "Secondary", titles: ["Solutions Engineer", "Solutions Architect"] },
    ],
    keep_signals: ["forward deployed", "applied ai", "solutions engineer"],
    cut_signals: ["devrel", "developer advocate", "core platform swe", "ml research"],
    excluded_companies: ["palantir", "tesla", "spacex", "xai", "neuralink"],
  },
  profile: {
    compensation: { minimum_base: 200000 },
    location: { home: "new york", relocation: [] },
  },
};

// ---------------------------------------------------------------------------
// Filter + infrastructure tests (unchanged)
// ---------------------------------------------------------------------------

test("title filter accepts target titles and rejects negative keywords", () => {
  const filter = buildTitleFilter({
    positive: [
      "Forward Deployed",
      "Applied AI",
      "Agent",
      "LLM",
      "Director of IT",
      "Head of Information Technology",
      "Workplace Technology",
    ],
    negative: ["Intern", "Developer Advocate"],
  });

  assert.equal(filter("Forward Deployed Engineer, AI"), true);
  assert.equal(filter("LLM Engineer"), true);
  assert.equal(filter("Director of IT Operations"), true);
  assert.equal(filter("Head of Information Technology"), true);
  assert.equal(filter("Director, Workplace Technology"), true);
  assert.equal(filter("Developer Advocate, AI Agents"), false);
  assert.equal(filter("Benefits Enrollment Specialist"), false);
  assert.equal(filter("Finance Manager"), false);
});

test("title filter recognizes bounded infrastructure-title equivalents without admitting adjacent functions", () => {
  const filter = buildTitleFilter({
    positive: [
      "Staff Platform Engineer",
      "Principal Infrastructure Engineer",
      "Staff Backend Engineer",
      "Senior Payments Infrastructure Engineer",
    ],
    negative: ["Intern"],
  });

  assert.equal(filter("Staff Software Engineer, Infrastructure Foundations"), true);
  assert.equal(filter("Senior Software Engineer, Compute (Temporal Cloud)"), true);
  assert.equal(filter("Senior Staff Engineer, Open Source Server"), true);
  assert.equal(filter("Staff Cloud Security Engineer"), false);
  assert.equal(filter("Staff Product Manager, Agent Platform"), false);
  assert.equal(filter("Principal Developer Advocate, AI"), false);
  assert.equal(filter("Account Executive, Platform"), false);
});

test("bounded title equivalence never crosses from staff IC to engineering management", () => {
  const filter = buildTitleFilter({ positive: ["Platform Engineering Manager"] });

  assert.equal(filter("Staff Platform Engineer"), false);
});

test("bounded title equivalence never crosses from engineering management to staff IC", () => {
  const filter = buildTitleFilter({ positive: ["Staff Platform Engineer"] });

  assert.equal(filter("Platform Engineering Manager"), false);
});

test("coarse scoring does not promote a GTM engineer from backend and platform evidence in the body", () => {
  const result = scoreSourcedOffer(
    {
      company: "Anthropic",
      title: "AI Engineer, GTM Claudification",
      location: "Remote - United States",
      comp: "$320,000 - $405,000 base",
      bodyText: `${"Build autonomous agents for go-to-market sellers. ".repeat(8)}Work closely with platform engineering partners.`,
    },
    {
      targeting: {
        role_buckets: [
          { name: "Platform", titles: ["Staff Platform Engineer", "Staff Backend Engineer"] },
        ],
        keep_signals: ["platform engineering"],
      },
      profile: {
        compensation: { minimum_base: 190000 },
        location: { home: "Brooklyn, NY", remote: true },
      },
    }
  );

  assert.equal(result.fit, "stretch");
  assert.equal(result.gate, "review");
  assert.ok(result.score < 65, `expected a sub-medium score, got ${result.score}`);
  assert.ok(result.ruleFlags.includes("title-target-mismatch"));
});

test("coarse scoring recognizes reordered non-engineering target titles", () => {
  const result = scoreSourcedOffer(
    {
      company: "Hospitality Corp",
      title: "Food and Beverage Operations Manager",
      location: "New York, NY",
      bodyText:
        "Lead beverage service, venue operations, training, and day-to-day hospitality workflows.",
    },
    {
      targeting: {
        role_buckets: [
          { name: "Hospitality operations", titles: ["Operations Manager, Food & Beverage"] },
        ],
        fit_bands: { high_min: 85, med_min: 65, fit_floor: 65 },
      },
      profile: {
        compensation: { minimum_base: 85000 },
        location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
      },
    }
  );

  assert.ok(
    result.score >= 65,
    `expected the reordered target to clear fit 65, got ${result.score}`
  );
  assert.match(result.ratingReason, /matches target title/i);
});

test("coarse scoring does not treat a generic staff engineer as a platform title match", () => {
  const result = scoreSourcedOffer(
    {
      company: "GenericCo",
      title: "Staff Engineer",
      location: "Remote - United States",
      comp: "$220,000 - $280,000 base",
      bodyText: `${"Lead high-impact projects across the engineering organization. ".repeat(7)}Partner with the platform engineering team.`,
    },
    {
      targeting: {
        role_buckets: [
          { name: "Platform", titles: ["Staff Platform Engineer", "Staff Backend Engineer"] },
        ],
        keep_signals: ["platform engineering"],
      },
      profile: {
        compensation: { minimum_base: 190000 },
        location: { home: "Brooklyn, NY", remote: true },
      },
    }
  );

  assert.equal(result.fit, "stretch");
  assert.ok(result.ruleFlags.includes("title-target-mismatch"));
});

test("stale generic source filters cannot admit an adjacent GTM title after targeting narrows", () => {
  const titleFilter = buildTitleFilter({ positive: ["Software Engineer"] });
  const config = {
    targeting: {
      role_buckets: [
        { name: "Platform", titles: ["Staff Platform Engineer", "Staff Backend Engineer"] },
      ],
      keep_signals: ["platform engineering"],
    },
    profile: {
      compensation: { minimum_base: 190000 },
      location: { home: "Brooklyn, NY", remote: true },
    },
  };
  const bodyText = `${"Build autonomous agents for go-to-market sellers. ".repeat(8)}Work closely with platform engineering partners.`;
  const result = filterAndDedupeOffers(
    [
      {
        company: "Anthropic",
        title: "AI Engineer, GTM Claudification",
        url: "https://jobs.example.test/gtm-ai-engineer",
        location: "Remote - United States",
        comp: "$320,000 - $405,000 base",
        bodyText,
      },
      {
        company: "PlatformCo",
        title: "Staff Software Engineer, Infrastructure Foundations",
        url: "https://jobs.example.test/infrastructure-foundations",
        location: "Remote - United States",
        comp: "$220,000 - $280,000 base",
        bodyText: `${"Build reliable distributed infrastructure services. ".repeat(8)}Own platform engineering foundations.`,
      },
    ],
    {
      titleFilter,
      locationFilter: () => true,
      config,
    }
  );

  assert.deepEqual(
    result.kept.map((offer) => offer.company),
    ["PlatformCo"]
  );
  assert.equal(result.filteredTitle.length, 1);
  assert.equal(result.filteredTitle[0].company, "Anthropic");
  assert.equal(result.filteredTitle[0].qualificationReason, "title-relevance-low");
});

test("stale exact source filters cannot admit a different title after targeting narrows", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "GTMCo",
        title: "AI Engineer",
        url: "https://jobs.example.test/ai-engineer",
        location: "Remote - United States",
        bodyText: "Partner with the platform engineering team. ".repeat(10),
      },
    ],
    {
      titleFilter: buildTitleFilter({ positive: ["AI Engineer"] }),
      locationFilter: () => true,
      config: {
        targeting: {
          role_buckets: [{ name: "Platform", titles: ["Staff Platform Engineer"] }],
          keep_signals: ["platform engineering"],
        },
        profile: { location: { home: "Brooklyn, NY", remote: true } },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredTitle.length, 1);
  assert.equal(result.filteredTitle[0].qualificationReason, "title-relevance-low");
});

test("management targets do not treat individual-contributor engineering titles as adjacent", () => {
  const result = scoreSourcedOffer(
    {
      company: "SystemsCo",
      title: "Senior Software Engineer",
      location: "Remote - United States",
      bodyText: "Build distributed systems and guide technical execution. ".repeat(10),
    },
    {
      targeting: {
        role_buckets: [{ name: "Management", titles: ["Engineering Manager"] }],
        keep_signals: ["distributed systems"],
      },
      profile: { location: { home: "Brooklyn, NY", remote: true } },
    }
  );

  assert.equal(result.fit, "stretch");
  assert.ok(result.score < 65);
  assert.ok(result.ruleFlags.includes("title-target-mismatch"));
});

test("location filter blocks foreign roles while allowing home, remote, and unknown-location roles", () => {
  const filter = buildLocationFilter({
    always_allow: ["New York"],
    allow: ["Remote", "New York", "United States", "US"],
    block: ["India", "London"],
  });

  assert.equal(filter("Remote - India or New York"), true);
  assert.equal(filter("Remote - India"), false);
  assert.equal(filter("New York, NY"), true);
  assert.equal(filter("Remote"), true);
  // Providers sometimes omit location entirely. Keep those roles available for
  // later body review rather than treating missing provider data as foreign.
  assert.equal(filter(""), true);
});

test("location filter does not fall through to allow-all when a policy has no allow entries", () => {
  const filter = buildLocationFilter({
    always_allow: ["United States"],
    allow: [],
    block: ["India"],
  });

  assert.equal(filter("United States"), true);
  assert.equal(filter("India"), false);
  assert.equal(filter("France"), false);

  const noPolicy = buildLocationFilter({ always_allow: [], allow: [], block: [] });
  assert.equal(noPolicy("France"), true);
});

test("dedupe filters existing tracker roles by URL and req id, but only flags company-role matches", () => {
  const offers = [
    {
      company: "Writer",
      title: "Software Engineer, Agents",
      url: "https://jobs.example.com/1",
      location: "New York",
    },
    {
      company: "NewCo",
      title: "Forward Deployed Engineer",
      url: "https://jobs.greenhouse.io/newco/jobs/12345",
      location: "Remote US",
    },
    {
      company: "OtherCo",
      title: "Forward Deployed Engineer",
      url: "https://seen.example.com/job",
      location: "Remote US",
    },
    {
      company: "ReqCo",
      title: "Applied AI Engineer",
      url: "https://jobs.greenhouse.io/reqco/jobs/777",
      location: "Remote US",
    },
  ];

  const result = filterAndDedupeOffers(offers, {
    seenUrls: new Set(["https://seen.example.com/job"]),
    seenReqIds: new Set(["greenhouse:777"]),
    seenCompanyRoles: new Set([normalizeCompanyRoleKey("Writer", "Software Engineer Agents")]),
    titleFilter: () => true,
    locationFilter: () => true,
  });

  assert.deepEqual(
    result.kept.map((offer) => offer.company),
    ["Writer", "NewCo"]
  );
  assert.equal(result.duplicates.length, 2);
  assert.equal(result.possibleDuplicates.length, 1);
  assert.equal(result.kept[0].possibleDuplicate, true);
});

test("dedupe presents one canonical role when different URLs carry the same requisition ID", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Twilio",
        title: "Senior Engineering Manager, Conversational Agents",
        url: "https://remote.example.test/twilio-agents",
        location: "Remote - US",
        reqId: "greenhouse:7926887",
      },
      {
        company: "Twilio",
        title: "Senior Engineering Manager Conversational Agents",
        url: "https://job-boards.example.test/twilio/jobs/7926887",
        location: "Remote - US",
        reqId: "greenhouse:7926887",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    }
  );

  assert.deepEqual(
    result.kept.map((offer) => offer.url),
    ["https://remote.example.test/twilio-agents"]
  );
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].duplicateReason, "req_id_batch");
  assert.equal(result.possibleDuplicates.length, 0);
});

test("same-run exact duplicates are removed before location rejection counting", () => {
  const repeated = {
    company: "Grafana Labs",
    title: "Staff Software Engineer - Databases",
    url: "https://jobs.example.test/grafana-databases",
    location: "Germany (Remote)",
  };
  const result = filterAndDedupeOffers([repeated, { ...repeated }], {
    seenUrls: new Set(),
    seenReqIds: new Set(),
    seenCompanyRoles: new Set(),
    titleFilter: () => true,
    locationFilter: buildLocationFilter({ allow: ["Remote", "United States"], block: ["Germany"] }),
  });

  assert.equal(result.filteredLocation.length, 1);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].duplicateReason, "url_batch");
});

test("same-run canonical dedupe selects the richer copy independent of source order", () => {
  const weak = {
    company: "Acme",
    title: "Staff Platform Engineer",
    url: "https://aggregator.example.test/acme-platform",
    location: "Remote - US",
    bodyText: "Short preview.",
    bodyPartial: true,
    reqId: "greenhouse:acme-platform",
  };
  const rich = {
    ...weak,
    url: "https://jobs.example.test/acme-platform",
    bodyText: "Own a distributed platform and mentor engineers. ".repeat(20),
    bodyPartial: false,
    comp: "$210,000 - $250,000 base",
  };
  const run = (offers) =>
    filterAndDedupeOffers(offers, {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    });

  for (const offers of [
    [weak, rich],
    [rich, weak],
  ]) {
    const result = run(offers);
    assert.deepEqual(
      result.kept.map((offer) => offer.url),
      [rich.url]
    );
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.duplicates[0].duplicateReason, "req_id_batch");
  }
});

test("adjacent engineering titles need strong candidate evidence while blockers stay blocked", () => {
  const titleFilter = buildTitleFilter({
    positive: ["Staff Frontend Engineer"],
    negative: ["Security", "Sales"],
  });
  const config = {
    targeting: {
      role_buckets: [{ titles: ["Staff Frontend Engineer"] }],
      keep_signals: ["accessibility systems"],
    },
    profile: { location: { home: "New York, NY", remote: true } },
  };
  const makeOffer = (id, title) => ({
    company: "Acme",
    title,
    url: `https://jobs.example.test/${id}`,
    location: "Remote - United States",
    bodyText: "Build accessibility systems for a mature product platform. ".repeat(12),
  });
  const result = filterAndDedupeOffers(
    [
      makeOffer("design-systems", "Staff Software Engineer, Design Systems"),
      makeOffer("security", "Staff Security Engineer"),
      makeOffer("marketing", "Product Marketing Manager"),
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter,
      locationFilter: () => true,
      config,
    }
  );

  assert.deepEqual(
    result.kept.map((offer) => [offer.title, offer.titleRelevance]),
    [["Staff Software Engineer, Design Systems", "adjacent-signal"]]
  );
  assert.deepEqual(
    result.filteredTitle.map((offer) => offer.qualificationReason),
    ["title-negative-blocker", "title-relevance-low"]
  );
});

test("frontend targeting does not admit a backend role as an adjacent engineering title", () => {
  const config = {
    targeting: {
      role_buckets: [{ titles: ["Staff Frontend Engineer"] }],
      keep_signals: ["accessibility systems"],
    },
    profile: { location: { home: "New York, NY", remote: true } },
  };
  const result = filterAndDedupeOffers(
    [
      {
        company: "Acme",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.test/backend",
        location: "Remote - United States",
        bodyText: "Build accessibility systems for a mature product platform. ".repeat(12),
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: buildTitleFilter({ positive: ["Staff Frontend Engineer"] }),
      locationFilter: () => true,
      config,
    }
  );

  assert.deepEqual(result.kept, []);
  assert.equal(result.filteredTitle[0]?.qualificationReason, "title-relevance-low");
});

test("specialized engineering targets reject adjacent roles missing that specialization", () => {
  const config = {
    targeting: {
      role_buckets: [{ titles: ["Staff Security Engineer"] }],
      keep_signals: ["security infrastructure"],
    },
    profile: { location: { home: "New York, NY", remote: true } },
  };
  const result = filterAndDedupeOffers(
    [
      {
        company: "Acme",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.test/backend-for-security-target",
        location: "Remote - United States",
        bodyText: "Build security infrastructure for a mature product platform. ".repeat(12),
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: buildTitleFilter({ positive: ["Staff Security Engineer"] }),
      locationFilter: () => true,
      config,
    }
  );

  assert.deepEqual(result.kept, []);
  assert.equal(result.filteredTitle[0]?.qualificationReason, "title-relevance-low");
});

test("specialization variants do not admit unrelated adjacent engineering roles", () => {
  for (const targetTitle of ["Staff Solution Engineer", "Staff Cybersecurity Engineer"]) {
    const result = filterAndDedupeOffers(
      [
        {
          company: "Acme",
          title: "Staff Backend Engineer",
          url: `https://jobs.example.test/backend-for-${targetTitle.toLowerCase().replaceAll(" ", "-")}`,
          location: "Remote - United States",
          bodyText: "Build customer and security systems for a mature product platform. ".repeat(
            12
          ),
        },
      ],
      {
        seenUrls: new Set(),
        seenReqIds: new Set(),
        seenCompanyRoles: new Set(),
        titleFilter: buildTitleFilter({ positive: [targetTitle] }),
        locationFilter: () => true,
        config: {
          targeting: {
            role_buckets: [{ titles: [targetTitle] }],
            keep_signals: ["customer and security systems"],
          },
          profile: { location: { home: "New York, NY", remote: true } },
        },
      }
    );

    assert.deepEqual(result.kept, [], targetTitle);
    assert.equal(result.filteredTitle[0]?.qualificationReason, "title-relevance-low", targetTitle);
  }
});

test("dedupe keeps unrelated generic /jobs/<id> URLs from distinct domains", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Alpha",
        title: "Platform Engineer",
        url: "https://careers.alpha.example/jobs/123",
        location: "Remote - US",
      },
      {
        company: "Beta",
        title: "Product Designer",
        url: "https://careers.beta.example/jobs/123",
        location: "New York, NY",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    }
  );

  assert.deepEqual(
    result.kept.map((offer) => offer.company),
    ["Alpha", "Beta"]
  );
  assert.equal(result.duplicates.length, 0);
});

test("dedupe keeps UUID-shaped paths on unrelated hosts as distinct requisitions", () => {
  const sharedUuid = "17330e14-aaaa-bbbb-cccc-123456789000";
  const result = filterAndDedupeOffers(
    [
      {
        company: "Alpha",
        title: "Platform Engineer",
        url: `https://careers.alpha.example/openings/${sharedUuid}`,
        location: "Remote - US",
      },
      {
        company: "Beta",
        title: "Product Designer",
        url: `https://careers.beta.example/roles/${sharedUuid}`,
        location: "New York, NY",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    }
  );

  assert.deepEqual(
    result.kept.map((offer) => offer.company),
    ["Alpha", "Beta"]
  );
  assert.equal(result.duplicates.length, 0);
});

test("dedupe still recognizes one Greenhouse requisition across official URL forms", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Acme",
        title: "Platform Engineer",
        url: "https://boards.greenhouse.io/acme/jobs/123456",
        location: "Remote - US",
      },
      {
        company: "Acme",
        title: "Platform Engineer",
        url: "https://job-boards.eu.greenhouse.io/acme/jobs/123456",
        location: "Remote - US",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    }
  );

  assert.equal(result.kept.length, 1);
  assert.equal(result.duplicates.length, 1);
});

test("dedupe recognizes one Ashby requisition across official URL variants", () => {
  const reqId = "17330e14-aaaa-bbbb-cccc-123456789000";
  const result = filterAndDedupeOffers(
    [
      {
        company: "Acme",
        title: "Platform Engineer",
        url: `https://jobs.ashbyhq.com/acme/${reqId}`,
        location: "Remote - US",
      },
      {
        company: "Acme",
        title: "Platform Engineer",
        url: `https://jobs.ashbyhq.com/acme/${reqId}/application?source=careerrat`,
        location: "Remote - US",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    }
  );

  assert.equal(result.kept.length, 1);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].duplicateReason, "req_id_batch");
});

test("adjacent non-engineering titles require a shared occupation and strong candidate evidence", () => {
  const titleFilter = buildTitleFilter({
    positive: ["Registered Nurse, ICU"],
    negative: ["Travel Nurse"],
  });
  const config = {
    targeting: {
      role_buckets: [{ titles: ["Registered Nurse, ICU"] }],
      keep_signals: ["bedside care"],
    },
    profile: { location: { home: "Columbus, OH", remote: true } },
  };
  const makeOffer = (id, title) => ({
    company: "Regional Health",
    title,
    url: `https://jobs.example.test/${id}`,
    location: "Remote - United States",
    bodyText: "Coordinate bedside care and mentor clinical teams. ".repeat(12),
  });
  const result = filterAndDedupeOffers(
    [
      makeOffer("clinical-nurse", "Clinical Nurse Specialist"),
      makeOffer("finance", "Hospital Finance Manager"),
      makeOffer("travel", "Travel Nurse"),
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter,
      locationFilter: () => true,
      config,
    }
  );

  assert.deepEqual(
    result.kept.map((offer) => [offer.title, offer.titleRelevance]),
    [["Clinical Nurse Specialist", "adjacent-signal"]]
  );
  assert.deepEqual(
    result.filteredTitle.map((offer) => offer.qualificationReason),
    ["title-relevance-low", "title-negative-blocker"]
  );
});

test("infers ATS provider from common careers URLs", () => {
  assert.equal(inferProvider({ careers_url: "https://jobs.ashbyhq.com/openai" }), "ashby");
  assert.equal(
    inferProvider({ careers_url: "https://job-boards.greenhouse.io/anthropic" }),
    "greenhouse"
  );
  assert.equal(inferProvider({ careers_url: "https://jobs.lever.co/acme" }), "lever");
});

// fetchProvider("lever", ...) now routes through fetchCareerOpsProvider (the
// SSRF-guarded Career Ops registry) instead of this module's own unguarded
// legacy fetcher — see the comment above fetchProvider's definition. The
// vendored lever.mjs adapter maps `descriptionPlain` (not the legacy
// fetcher's descriptionBodyPlain/additionalPlain/salaryDescriptionPlain/lists
// concatenation) into bodyText and does not surface a comp string at all, so
// this is a real, disclosed behavior change from the pre-fix scanner: comp is
// no longer populated for Lever specifically. bodyText and location (via
// resolveLocation's allLocations dedupe, asserted separately below) still
// carry through correctly.
test("fetchCareerOpsProvider-routed Lever fetch maps descriptionPlain into bodyText", async () => {
  const offers = await fetchProvider(
    "lever",
    { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              text: "Director of IT",
              hostedUrl: "https://jobs.lever.co/acme/abc",
              categories: { location: "Remote" },
              descriptionPlain: "Own corporate IT, identity, endpoint, and automation.",
            },
          ]),
          { status: 200 }
        ),
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatcherFactory: () => ({ close: async () => {} }),
    }
  );

  assert.match(offers[0].bodyText, /Own corporate IT/);
  assert.equal(offers[0].comp, "");
});

// #1 review: production scanner bypass. Every provider fetchProvider() knows
// about — including the seven that used to have their own unguarded fetchers
// here — must go through the shared SSRF guard before fetchImpl is ever
// called. A source entry pointing its api/careers_url at a private-resolving
// hostname must be rejected here, on the actual production dispatch path,
// not just in the registry's own unit tests.
test("fetchProvider rejects a greenhouse source whose host resolves to a private address, before ever calling fetchImpl", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () =>
      fetchProvider(
        "greenhouse",
        { name: "Acme", careers_url: "https://job-boards.greenhouse.io/acme" },
        {
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("must not reach fetchImpl");
          },
          resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
        }
      ),
    (error) => {
      assert.match(error.message, /Career Ops request blocked/);
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
});

test("fetchProvider rejects a lever source whose host resolves to a private address, before ever calling fetchImpl", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () =>
      fetchProvider(
        "lever",
        { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
        {
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("must not reach fetchImpl");
          },
          resolveHost: async () => [{ address: "169.254.169.254", family: 4 }],
        }
      ),
    (error) => {
      assert.match(error.message, /Career Ops request blocked/);
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
});

// #1 review: Lever's allLocations dedupe (resolveLocation() in
// vendor/lever.mjs) is inert on the legacy path because the old fetchLever
// only ever read categories.location. Routing through the guard also routes
// through the real vendored mapping, so a multi-location posting's full
// location set now reaches the offer.
test("fetchProvider dedupes Lever's primary location with allLocations through the guarded path", async () => {
  const offers = await fetchProvider(
    "lever",
    { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              text: "Staff Engineer",
              hostedUrl: "https://jobs.lever.co/acme/abc",
              categories: { location: "Barcelona", allLocations: ["Barcelona", "Montevideo"] },
              descriptionPlain: "Build reliable systems.",
            },
          ]),
          { status: 200 }
        ),
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatcherFactory: () => ({ close: async () => {} }),
    }
  );

  assert.equal(offers[0].location, "Barcelona; Montevideo");
  assert.equal(offers[0].company, "Acme");
});

// #1 review: fetchRss (source_type:"rss") took a user-configured URL straight
// to fetchImpl with no host validation at all — same threat model as the ATS
// providers above. It must go through guardedFetch too.
test("fetchProvider rejects an rss source whose host resolves to a private address, before ever calling fetchImpl", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () =>
      fetchProvider(
        "rss",
        { rssUrl: "https://feeds.example.test/jobs.xml" },
        {
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("must not reach fetchImpl");
          },
          resolveHost: async () => [{ address: "10.0.0.5", family: 4 }],
        }
      ),
    (error) => {
      assert.match(error.message, /RSS request blocked/);
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
});

// #3 review: fetchRss cleared its abort timer in a `finally` immediately after
// guardedFetch resolved, so once headers arrived the deadline stopped covering
// the body read: a host that returns headers and then stalls the body hung
// `guarded.response.text()` forever. The fix keeps the timer live across the
// body read too, clearing it only once text() settles. This fetchImpl mirrors
// a real fetch by wiring the response body's stream to the same abort signal
// guardedFetch passed it, so aborting on deadline actually errors the pending
// read instead of leaving it stuck with nothing listening.
test("fetchProvider('rss', …) aborts a body that stalls after headers, within the RSS deadline", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const fetchImpl = async (_url, init) => {
      const { signal } = init;
      const stream = new ReadableStream({
        start(streamController) {
          if (signal.aborted) {
            streamController.error(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => streamController.error(signal.reason), {
            once: true,
          });
        },
      });
      return new Response(stream, { status: 200 });
    };

    const promise = fetchProvider(
      "rss",
      { rssUrl: "https://feeds.example.test/jobs.xml" },
      {
        fetchImpl,
        resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
        dispatcherFactory: () => ({ close: async () => {} }),
      }
    );

    // Flush the guardedFetch chain's own microtasks (DNS resolve, response
    // construction) so the stalled `.text()` read is actually pending before
    // the mocked clock advances past the RSS deadline.
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(15_000);

    await assert.rejects(promise, (error) => {
      assert.match(String(error?.message || error), /abort/i);
      return true;
    });
  } finally {
    mock.timers.reset();
  }
});

test("extracts canonical req ids from common ATS URLs", () => {
  assert.equal(
    extractReqId("https://job-boards.greenhouse.io/acme/jobs/123456").id,
    "greenhouse:123456"
  );
  assert.equal(
    extractReqId("https://jobs.ashbyhq.com/acme/17330e14-aaaa-bbbb-cccc-123456789000").id,
    "ashby:17330e14-aaaa-bbbb-cccc-123456789000"
  );
  assert.equal(
    extractReqId("https://careers.example.com/openings/17330e14-aaaa-bbbb-cccc-123456789000").id,
    null
  );
  assert.equal(
    extractReqId("https://hiring.cafe/job/swfwvwmaq6basefz").id,
    "hiringcafe:swfwvwmaq6basefz"
  );
  assert.equal(
    extractReqId("https://www.linkedin.com/jobs/view/444555666/").id,
    "linkedin:444555666"
  );
  assert.equal(extractReqId("https://careers.example.com/jobs/123456").id, null);
});

// ---------------------------------------------------------------------------
// Config-driven scoring — Jane tech persona tests
// (replaces former legacy assertions; now pass JANE_TECH_CONFIG explicitly)
// ---------------------------------------------------------------------------

test("FDE title with JANE config scores in keep territory (high or med fit, likely-keep gate)", () => {
  const result = scoreSourcedOffer(
    {
      company: "Acme",
      title: "Forward Deployed Engineer",
      location: "New York City",
      comp: "USD 205000-265000",
      bodyText:
        "Build working prototypes with customers using LLM APIs, RAG, agents, MCP connectors, and production integrations. Drive adoption with enterprise teams.",
    },
    JANE_TECH_CONFIG
  );

  assert.ok(
    result.fit === "high" || result.fit === "med",
    `expected high or med fit, got ${result.fit} (score ${result.score})`
  );
  assert.equal(result.gate, "likely-keep");
});

test("excluded company (palantir) with JANE config gets excluded-company flag and likely-cut gate", () => {
  const result = scoreSourcedOffer(
    {
      company: "Palantir",
      title: "Forward Deployed Engineer",
      location: "Remote - US",
      comp: "$220K-$280K",
      bodyText: "Work with customers on AI workflows.",
    },
    JANE_TECH_CONFIG
  );

  assert.ok(
    result.ruleFlags.includes("excluded-company"),
    `expected excluded-company flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

test("devrel title with JANE config gets a cut-risk flag and likely-cut gate", () => {
  const result = scoreSourcedOffer(
    {
      company: "Acme",
      title: "Developer Advocate, AI Platform",
      location: "Remote - US",
      comp: "$180K-$220K",
      bodyText:
        "Evangelize the platform. Run hackathons, write blog posts, give talks, and build sample apps for community.",
    },
    JANE_TECH_CONFIG
  );

  assert.ok(
    result.ruleFlags.some((f) => f.startsWith("cut-risk")),
    `expected a cut-risk flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

test("comp posted below $200K floor with JANE config gets comp-below-floor flag and likely-cut gate", () => {
  const result = scoreSourcedOffer(
    {
      company: "Acme",
      title: "Applied AI Engineer",
      location: "Remote - US",
      comp: "$130,000 - $170,000",
      bodyText: "Build AI-powered solutions for enterprise customers using LLM APIs and agents.",
    },
    JANE_TECH_CONFIG
  );

  assert.ok(
    result.ruleFlags.includes("comp-below-floor"),
    `expected comp-below-floor flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

test("Solutions Engineer title with JANE config scores as keep (high or med fit)", () => {
  const result = scoreSourcedOffer(
    {
      company: "Acme",
      title: "Solutions Engineer",
      location: "New York, NY",
      comp: "$210,000 - $250,000",
      bodyText:
        "Partner with enterprise customers to deploy integrations and prototype workflows using APIs and LLMs.",
    },
    JANE_TECH_CONFIG
  );

  assert.ok(
    result.fit === "high" || result.fit === "med",
    `expected high or med fit, got ${result.fit} (score ${result.score})`
  );
  assert.notEqual(result.gate, "likely-cut");
});

test("excluded company (tesla) with JANE config gets excluded-company flag", () => {
  const result = scoreSourcedOffer(
    {
      company: "Tesla",
      title: "Applied AI Engineer",
      location: "Austin, TX",
      comp: "$230K-$290K",
      bodyText: "Build AI-powered tools for manufacturing operations.",
    },
    JANE_TECH_CONFIG
  );

  assert.ok(
    result.ruleFlags.includes("excluded-company"),
    `expected excluded-company flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

test("ml research cut signal with JANE config gets cut-risk flag", () => {
  const result = scoreSourcedOffer(
    {
      company: "Acme",
      title: "ML Research Engineer",
      location: "Remote - US",
      comp: "$210,000 - $260,000",
      bodyText:
        "Conduct ML research, fine-tune foundation models, publish papers, run experiments on distributed training clusters.",
    },
    JANE_TECH_CONFIG
  );

  assert.ok(
    result.ruleFlags.some((f) => f.startsWith("cut-risk")),
    `expected a cut-risk flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

// ---------------------------------------------------------------------------
// Bias-gone proof: same FDE offer without config is neutral (no keep boost)
// ---------------------------------------------------------------------------

test("FDE title WITHOUT config scores neutral — no keep boost from baked-in preferences", () => {
  const result = scoreSourcedOffer({
    company: "Acme",
    title: "Forward Deployed Engineer",
    location: "Remote - US",
    comp: "$220K-$280K",
    bodyText:
      "Work with enterprise customers to deploy AI-powered integrations and build prototypes.",
  });

  // Without config there are no keep_signals, so the title cannot set a high base
  // The score should NOT reach high (82+), landing at stretch or med at most
  assert.ok(
    result.fit !== "high",
    `expected no high fit without config, got fit=${result.fit} score=${result.score}`
  );
  // No keep gate without config-driven keep signals
  assert.notEqual(
    result.gate,
    "likely-keep",
    `expected no likely-keep gate without config, got gate=${result.gate}`
  );
});

test("confirmed keep and cut role signals adjust score and report ids outside human rule flags", () => {
  const offer = {
    company: "ExampleCo",
    title: "Applied AI Engineer",
    location: "",
    comp: "",
    bodyText: "Build customer prototypes with agent workflow tooling.",
  };
  const baseConfig = {
    targeting: {
      role_families: [{ name: "Applied AI", patterns: ["applied ai engineer"] }],
      keep_signals: [],
      cut_signals: [],
    },
    profile: {},
  };
  const baseline = scoreSourcedOffer(offer, baseConfig);
  const keep = scoreSourcedOffer(offer, {
    ...baseConfig,
    roleSignals: [
      {
        id: "signal-keep-agent-workflow",
        roleFamily: "applied-ai",
        signalType: "keep",
        text: "agent workflow",
      },
    ],
  });
  const cut = scoreSourcedOffer(offer, {
    ...baseConfig,
    roleSignals: [
      {
        id: "signal-cut-customer-prototypes",
        roleFamily: "Applied AI",
        signalType: "cut",
        text: "customer prototypes",
      },
    ],
  });

  assert.ok(keep.score > baseline.score, `${keep.score} should exceed ${baseline.score}`);
  assert.ok(cut.score < baseline.score, `${cut.score} should be below ${baseline.score}`);
  assert.deepEqual(keep.roleSignalIds, ["signal-keep-agent-workflow"]);
  assert.deepEqual(cut.roleSignalIds, ["signal-cut-customer-prototypes"]);
  assert.equal(keep.ruleFlags.includes("signal-keep-agent-workflow"), false);
  assert.equal(cut.ruleFlags.includes("signal-cut-customer-prototypes"), false);
  assert.ok(cut.ruleFlags.some((flag) => flag.startsWith("cut-risk-")));
});

test("no roleSignals argument is byte-identical to the pre-promotion scanner result", () => {
  const result = scoreSourcedOffer(
    { company: "ExampleCo", title: "Applied AI Engineer" },
    {
      targeting: {
        role_families: [{ name: "Applied AI", patterns: ["applied ai engineer"] }],
        keep_signals: [],
        cut_signals: [],
      },
      profile: {},
    }
  );

  assert.deepEqual(result, {
    fit: "stretch",
    score: 52,
    gate: "review",
    ratingReason: "",
    ruleFlags: ["comp-unposted"],
  });
});

// ---------------------------------------------------------------------------
// Structural (domain-neutral) signals still fire without config
// ---------------------------------------------------------------------------

test("remote/US location adds a bonus without config (neutral structural signal)", () => {
  const remote = scoreSourcedOffer({ title: "Analyst", location: "Remote - United States" });
  const onsite = scoreSourcedOffer({
    title: "Analyst",
    location: "On-site only, in-office 5 days/week",
  });

  assert.ok(
    remote.score > onsite.score,
    `expected remote (${remote.score}) > onsite (${onsite.score})`
  );
});

test("foreign remote locations do not receive the US location bonus", () => {
  const result = scoreSourcedOffer({
    title: "Analyst",
    location: "Remote DE; Aachen; Munich",
  });

  assert.equal(result.ratingReason.includes("remote/US location"), false);
});

test("office-burden flag fires without config (neutral structural signal)", () => {
  const result = scoreSourcedOffer({
    title: "Analyst",
    location: "Chicago",
    bodyText: "This is a fully onsite in-office role, 5 days/week at our headquarters.",
  });

  assert.ok(
    result.ruleFlags.includes("office-burden"),
    `expected office-burden flag, got ${JSON.stringify(result.ruleFlags)}`
  );
});

test("heavy travel flag fires without config (neutral structural signal)", () => {
  const result = scoreSourcedOffer({
    title: "Field Consultant",
    location: "Remote",
    bodyText: "This role requires heavy travel, up to 50%+ travel to customer sites.",
  });

  assert.ok(
    result.ruleFlags.includes("travel"),
    `expected travel flag, got ${JSON.stringify(result.ruleFlags)}`
  );
});

// ---------------------------------------------------------------------------
// Comp extraction and HTML utilities
// ---------------------------------------------------------------------------

test("extracts compensation ranges and strips ATS HTML bodies", () => {
  assert.deepEqual(extractCompBand("The salary range for this role is $200,000 - $300,000 base."), {
    min: 200000,
    max: 300000,
  });
  assert.deepEqual(extractCompBand("USD 180000-230000"), { min: 180000, max: 230000 });
  assert.deepEqual(extractCompBand("$153K – $325K • Offers Equity"), { min: 153000, max: 325000 });
  assert.deepEqual(extractCompBand("$221.7K - $266K • Offers Equity"), {
    min: 221700,
    max: 266000,
  });
  assert.equal(htmlToText("&lt;p&gt;Build &amp; ship&lt;/p&gt;"), "Build & ship");
  assert.deepEqual(
    extractCompBand(
      htmlToText(
        "&lt;span&gt;$258,000&lt;/span&gt;&lt;span&gt;&amp;mdash;&lt;/span&gt;&lt;span&gt;$348,000 USD&lt;/span&gt;"
      )
    ),
    { min: 258000, max: 348000 }
  );
  assert.deepEqual(
    extractCompBand(
      "Bar Manager\nFull Time • Salary ($70k)\nRole details\nOther jobs you might be interested in\nBar Director\nSalary ($120k - $140k)"
    ),
    { min: 70000, max: 70000 }
  );
});

test("dedupe attaches fit ratings to kept offers", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "OpenAI",
        title: "AI Deployment Engineer- Codex",
        url: "https://jobs.ashbyhq.com/openai/example",
        location: "Remote - US",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
    }
  );

  assert.equal(Number.isFinite(result.kept[0].score), true);
  assert.ok(["high", "med", "stretch"].includes(result.kept[0].fit));
});

test("qualification gate rejects management seniority drift before scoring", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Figma",
        title: "Manager, Software Engineering - Billing",
        url: "https://jobs.example.com/manager",
        location: "New York, NY",
        bodyText: "Lead a backend platform team building reliable distributed systems.",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: {
          role_buckets: [
            { name: "Platform", titles: ["Staff Backend Engineer", "Principal Platform Engineer"] },
          ],
          cut_signals: ["pure people management"],
        },
        profile: {
          location: { home: "Brooklyn, NY", remote: true, hybrid: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredSeniority.length, 1);
  assert.equal(result.filteredSeniority[0].qualificationReason, "management-track-mismatch");
});

test("qualification gate enforces remote eligibility and a configured commute radius", () => {
  const offers = [
    {
      company: "Temporal",
      title: "Staff Backend Engineer",
      url: "https://jobs.example.com/nyc",
      location: "Hybrid - New York, NY",
    },
    {
      company: "Temporal",
      title: "Principal Platform Engineer",
      url: "https://jobs.example.com/albany",
      location: "Hybrid - Albany, NY",
    },
    {
      company: "Temporal",
      title: "Staff Software Engineer",
      url: "https://jobs.example.com/remote-us",
      location: "Remote - United States",
    },
    {
      company: "Temporal",
      title: "Staff Software Engineer",
      url: "https://jobs.example.com/remote-ie",
      location: "Remote - Ireland",
    },
    {
      company: "Temporal",
      title: "Staff Software Engineer",
      url: "https://jobs.example.com/unknown",
      location: "",
    },
  ];
  const result = filterAndDedupeOffers(offers, {
    seenUrls: new Set(),
    seenReqIds: new Set(),
    seenCompanyRoles: new Set(),
    titleFilter: () => true,
    locationFilter: () => true,
    config: {
      targeting: {
        role_buckets: [{ name: "Platform", titles: ["Staff Backend Engineer"] }],
      },
      profile: {
        location: {
          home: "Brooklyn, NY",
          remote: true,
          hybrid: true,
          onsite: false,
          commute_radius_miles: 25,
          relocation: [],
        },
      },
    },
  });

  assert.deepEqual(
    result.kept.map((offer) => offer.url),
    [
      "https://jobs.example.com/nyc",
      "https://jobs.example.com/remote-us",
      "https://jobs.example.com/unknown",
    ]
  );
  assert.equal(result.filteredLocation.length, 2);
  assert.equal(result.kept[2].qualificationUnknowns.includes("location"), true);
});

test("qualification gate recognizes NYC inside a detailed neighborhood label", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Midtown Hospitality",
        title: "General Manager",
        url: "https://jobs.example.com/midtown-general-manager",
        location: "New York, NY (Midtown/Koreatown NYC)",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: {
          role_buckets: [{ name: "Hospitality", titles: ["General Manager"] }],
        },
        profile: {
          location: {
            home: "New York, NY",
            remote: true,
            hybrid: true,
            onsite: true,
            relocation: [],
          },
        },
      },
    }
  );

  assert.equal(result.kept.length, 1);
  assert.equal(result.filteredLocation.length, 0);
});

test("qualification gate filters stale, below-floor, and explicit sponsorship-conflict roles", () => {
  const now = Date.parse("2026-08-09T12:00:00Z");
  const result = filterAndDedupeOffers(
    [
      {
        company: "OldCo",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.com/old",
        location: "Remote - US",
        postedAt: "2026-06-01T00:00:00Z",
      },
      {
        company: "CheapCo",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.com/cheap",
        location: "Remote - US",
        postedAt: "2026-08-08T00:00:00Z",
        comp: "$140,000 - $180,000 base",
      },
      {
        company: "NoVisaCo",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.com/no-visa",
        location: "Remote - US",
        postedAt: "2026-08-08T00:00:00Z",
        bodyText: "Candidates must already be authorized. We do not offer visa sponsorship.",
      },
      {
        company: "UnknownCo",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.com/unknowns",
        location: "",
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
      now,
      config: {
        targeting: {
          role_buckets: [{ name: "Platform", titles: ["Staff Backend Engineer"] }],
          search_preferences: { posting_age: { mode: "fixed-days", days: 30 } },
        },
        profile: {
          compensation: { minimum_base: 200000 },
          location: { home: "Brooklyn, NY", remote: true, hybrid: true },
          authorization: { work_authorized: false, requires_sponsorship: true },
        },
      },
    }
  );

  assert.equal(result.filteredAge.length, 1);
  assert.equal(result.filteredSalary.length, 1);
  assert.equal(result.filteredEligibility.length, 1);
  assert.equal(result.kept.length, 1);
  assert.deepEqual(result.kept[0].qualificationUnknowns.sort(), [
    "compensation",
    "location",
    "postedAt",
  ]);
});

test("partial offers enforce location, compensation, and content policy by default", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Partial Location Corp",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.com/partial-location",
        location: "Remote - United States",
        bodyText: "Location: San Francisco Bay Area, CA (in-person).",
        bodyPartial: true,
      },
      {
        company: "Partial Comp Corp",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.com/partial-comp",
        location: "Remote - United States",
        bodyText: "Salary Range: $100,000 - $120,000 annually.",
        bodyPartial: true,
      },
      {
        company: "Partial Eligibility Corp",
        title: "Staff Backend Engineer",
        url: "https://jobs.example.com/partial-eligibility",
        location: "Remote - United States",
        bodyText: "Visa sponsorship is not available for this position.",
        bodyPartial: true,
      },
    ],
    {
      seenUrls: new Set(),
      seenReqIds: new Set(),
      seenCompanyRoles: new Set(),
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Staff Backend Engineer"] }] },
        profile: {
          compensation: { minimum_base: 180000 },
          authorization: { requires_sponsorship: true },
          location: {
            home: "Brooklyn, NY",
            remote: true,
            remote_scope: "home-country",
            hybrid: true,
            onsite: false,
          },
        },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredLocation.length, 1);
  assert.equal(result.filteredSalary.length, 1);
  assert.equal(result.filteredEligibility.length, 1);
});

test("qualification gate caps one company and reconciles every fetched offer", () => {
  const offers = Array.from({ length: 4 }, (_, index) => ({
    company: "FloodCo",
    title: `Staff Backend Engineer ${index + 1}`,
    url: `https://jobs.example.com/flood-${index + 1}`,
    location: "Remote - US",
    postedAt: `2026-08-0${index + 1}T00:00:00Z`,
  }));
  const result = filterAndDedupeOffers(offers, {
    seenUrls: new Set(),
    seenReqIds: new Set(),
    seenCompanyRoles: new Set(),
    companyPresentationCounts: new Map(),
    perCompanyCap: 2,
    titleFilter: () => true,
    locationFilter: () => true,
    config: {
      targeting: { role_buckets: [{ titles: ["Staff Backend Engineer"] }] },
      profile: { location: { home: "Brooklyn, NY", remote: true } },
    },
  });

  assert.equal(result.kept.length, 2);
  assert.equal(result.overflow.length, 2);
  const reconciled = [
    result.kept,
    result.filteredTitle,
    result.filteredSeniority,
    result.filteredLocation,
    result.filteredAge,
    result.filteredSalary,
    result.filteredEligibility,
    result.duplicates,
    result.invalid,
    result.overflow,
  ].reduce((sum, rows) => sum + rows.length, 0);
  assert.equal(reconciled, offers.length);
});

test("maps score bands to tracker fit buckets", () => {
  assert.equal(fitFromScore(90), "high");
  assert.equal(fitFromScore(84), "med");
  assert.equal(fitFromScore(70), "med");
  assert.equal(fitFromScore(55), "stretch");
});

test("maps score bands through the candidate's saved thresholds", () => {
  assert.equal(fitFromScore(84, { high_min: 85, med_min: 65 }), "med");
  assert.equal(fitFromScore(64, { high_min: 85, med_min: 65 }), "stretch");
  assert.equal(fitFromScore(84, { high_min: "not-a-number", med_min: 70 }), "med");
  assert.equal(fitFromScore(84, { high_min: null, med_min: null }), "med");
});

test("qualification recognizes an annual salary sentence below the saved floor", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Credence",
        title: "AI Software Engineer",
        url: "https://jobs.example.test/credence-ai-software-engineer",
        location: "Tysons Corner, VA (Remote)",
        bodyText: "Salary Range: $120,000 - $150,000 annually.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Software Engineer"] }] },
        profile: {
          compensation: { minimum_base: 180000 },
          location: { home: "Brooklyn, NY", remote: true, hybrid: true, onsite: false },
        },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredSalary[0]?.qualificationReason, "comp-below-floor");
});

test("qualification recognizes a single annual salary below the saved floor", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Single Salary Hospitality",
        title: "Bar Manager",
        url: "https://jobs.example.test/single-salary-hospitality",
        location: "New York, NY",
        bodyText: "Salary: $60,000 per year. Lead a high-volume beverage program in Manhattan.",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_base: 85000 },
          location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredSalary[0]?.qualificationReason, "comp-below-floor");
  assert.deepEqual(result.filteredSalary[0]?.compBand, { min: 60000, max: 60000 });
});

test("qualification trusts the role compensation before unrelated recommendation salaries", () => {
  const result = filterAndDedupeOffers(
    [
      {
        company: "Hospitality Group",
        title: "Bar Manager",
        url: "https://jobs.example.test/bar-manager-with-recommendations",
        location: "New York, NY",
        comp: "Full Time • Salary ($70k)",
        bodyText:
          "Bar Manager\nFull Time • Salary ($70k)\nLead this beverage program.\nSimilar jobs\nRestaurant Manager\nSalary ($75k - $120k)",
      },
    ],
    {
      titleFilter: () => true,
      locationFilter: () => true,
      config: {
        targeting: { role_buckets: [{ titles: ["Bar Manager"] }] },
        profile: {
          compensation: { minimum_base: 85000 },
          location: { home: "New York, NY", remote: true, hybrid: true, onsite: true },
        },
      },
    }
  );

  assert.equal(result.kept.length, 0);
  assert.equal(result.filteredSalary[0]?.qualificationReason, "comp-below-floor");
  assert.deepEqual(result.filteredSalary[0]?.compBand, { min: 70000, max: 70000 });
});

// ---------------------------------------------------------------------------
// Config-driven scoring — domain generality tests (unchanged)
// ---------------------------------------------------------------------------

const nursingConfig = {
  targeting: {
    keep_signals: ["bedside", "registered nurse", "rn"],
    cut_signals: ["travel nursing"],
    excluded_companies: ["BadHealth Staffing"],
  },
  profile: {
    compensation: { minimum_base: 90000 },
    location: { home: "Columbus", relocation: [] },
  },
};

test("config-driven scorer: bedside RN offer scores in keep territory (high or med)", () => {
  const result = scoreSourcedOffer(
    {
      company: "Columbus Regional Hospital",
      title: "Bedside RN - ICU",
      location: "Columbus, OH",
      comp: "$95,000 - $115,000",
      bodyText:
        "Registered nurse bedside care in the ICU unit. Provide direct patient care, medication administration, and coordinate with multidisciplinary teams.",
    },
    nursingConfig
  );

  assert.ok(
    result.fit === "high" || result.fit === "med",
    `expected high or med fit, got ${result.fit} (score ${result.score})`
  );
  assert.notEqual(result.gate, "likely-cut");
});

test("config-driven scorer: travel nursing offer gets cut penalty and cut-risk flag", () => {
  const result = scoreSourcedOffer(
    {
      company: "TravelHealth Inc",
      title: "Travel Nursing Recruiter",
      location: "Remote",
      comp: "$60,000 - $75,000",
      bodyText:
        "Recruit registered nurses for travel nursing assignments across the country. Manage placements for travel nursing contracts at hospitals nationwide.",
    },
    nursingConfig
  );

  assert.ok(
    result.ruleFlags.some((f) => f.startsWith("cut-risk")),
    `expected a cut-risk flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

test("config-driven scorer: excluded company gets excluded-company flag and penalty", () => {
  const result = scoreSourcedOffer(
    {
      company: "BadHealth Staffing",
      title: "RN Staff Nurse",
      location: "Columbus, OH",
      comp: "$100,000 - $120,000",
      bodyText:
        "Registered nurse position at BadHealth Staffing. Provide bedside care and patient support.",
    },
    nursingConfig
  );

  assert.ok(
    result.ruleFlags.includes("excluded-company"),
    `expected excluded-company flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

test("config-driven scorer: offer with posted comp below floor gets comp-below-floor", () => {
  const result = scoreSourcedOffer(
    {
      company: "SmallClinic",
      title: "Registered Nurse",
      location: "Columbus, OH",
      comp: "$60,000 - $80,000",
      bodyText:
        "RN position providing bedside registered nurse care in outpatient clinic setting. Full time nursing role.",
    },
    nursingConfig
  );

  assert.ok(
    result.ruleFlags.includes("comp-below-floor"),
    `expected comp-below-floor flag, got ${JSON.stringify(result.ruleFlags)}`
  );
  assert.equal(result.gate, "likely-cut");
});

test("config-driven scorer: nursing offer with config scores differently than without config", () => {
  const offer = {
    company: "Columbus Regional Hospital",
    title: "Bedside RN - ICU",
    location: "Columbus, OH",
    comp: "$95,000 - $115,000",
    bodyText:
      "Registered nurse bedside care in the ICU unit. Provide direct patient care, medication administration, and coordinate with multidisciplinary teams.",
  };
  const withConfig = scoreSourcedOffer(offer, nursingConfig);
  const withoutConfig = scoreSourcedOffer(offer);

  // Config keeps signals (bedside/rn) boost the score; without config, no such boost
  assert.notDeepEqual(
    { score: withConfig.score, ratingReason: withConfig.ratingReason },
    { score: withoutConfig.score, ratingReason: withoutConfig.ratingReason },
    "expected config path and no-config path to produce different scores/reasons for a nursing offer"
  );
});
