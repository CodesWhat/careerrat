import assert from "node:assert/strict";
import test from "node:test";

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

test("infers ATS provider from common careers URLs", () => {
  assert.equal(inferProvider({ careers_url: "https://jobs.ashbyhq.com/openai" }), "ashby");
  assert.equal(
    inferProvider({ careers_url: "https://job-boards.greenhouse.io/anthropic" }),
    "greenhouse"
  );
  assert.equal(inferProvider({ careers_url: "https://jobs.lever.co/acme" }), "lever");
});

test("includes Lever salary descriptions in fetched sourced comp text", async () => {
  const offers = await fetchProvider(
    "lever",
    { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    async () =>
      new Response(
        JSON.stringify([
          {
            text: "Director of IT",
            hostedUrl: "https://jobs.lever.co/acme/abc",
            categories: { location: "Remote" },
            descriptionBodyPlain: "Own corporate IT, identity, endpoint, and automation.",
            descriptionPlain: "Stale marketing role text.",
            salaryDescriptionPlain:
              "The base salary range for this position is expected to be between $224,000 - $260,000 per year.",
            lists: [],
          },
        ]),
        { status: 200 }
      )
  );

  assert.equal(
    offers[0].comp,
    "The base salary range for this position is expected to be between $224,000 - $260,000 per year."
  );
  assert.deepEqual(extractCompBand(`${offers[0].comp}\n${offers[0].bodyText}`), {
    min: 224000,
    max: 260000,
  });
  assert.match(offers[0].bodyText, /Own corporate IT/);
  assert.doesNotMatch(offers[0].bodyText, /Stale marketing role text/);
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
    extractReqId("https://hiring.cafe/job/swfwvwmaq6basefz").id,
    "hiringcafe:swfwvwmaq6basefz"
  );
  assert.equal(
    extractReqId("https://www.linkedin.com/jobs/view/444555666/").id,
    "linkedin:444555666"
  );
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

test("maps score bands to tracker fit buckets", () => {
  assert.equal(fitFromScore(90), "high");
  assert.equal(fitFromScore(70), "med");
  assert.equal(fitFromScore(55), "stretch");
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
