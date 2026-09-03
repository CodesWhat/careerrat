import assert from "node:assert/strict";
import test from "node:test";
import {
  careerOpsProviderIds,
  fetchCareerOpsProvider,
  inferCareerOpsProvider,
  isCareerOpsProviderSupported,
  providerForId,
} from "../src/core/providers/career-ops-registry.mjs";
import {
  CAREER_OPS_DEFERRED_PROVIDER_IDS,
  CAREER_OPS_EXCLUDED_PROVIDER_IDS,
  CAREER_OPS_PROVIDER_IDS,
  CAREER_OPS_PROVIDER_PARITY,
  CAREER_OPS_UPSTREAM,
  CAREER_OPS_UPSTREAM_PROVIDER_IDS,
} from "../src/core/providers/provider-parity.mjs";

const EXPECTED_PROVIDER_IDS = [
  "4dayweek",
  "a16z-speedrun-talent",
  "agentic-jobs",
  "alibaba",
  "amazon",
  "arbeitnow",
  "arbeitsagentur",
  "ashby",
  "avature",
  "bamboohr",
  "beesite",
  "breezy",
  "careerviet",
  "comeet",
  "consider",
  "cryptocurrencyjobs",
  "csod",
  "dassault",
  "deutschebahn",
  "echojobs",
  "eightfold",
  "feishu-jobs",
  "flowxtra",
  "gem",
  "getonbrd",
  "getro",
  "glints",
  "greenhouse",
  "hackernews",
  "hecklerkoch",
  "higheredjobs",
  "himalayas",
  "ibm",
  "icims",
  "itviec",
  "jibeapply",
  "jobbankca",
  "jobicy",
  "jobspresso",
  "jobstreet",
  "jobvite",
  "join",
  "joinup",
  "justjoin",
  "landingjobs",
  "larajobs",
  "lever",
  "local-parser",
  "manfred",
  "meituan",
  "mokahr",
  "mycareersfuture",
  "nodesk",
  "nofluffjobs",
  "oraclecloud",
  "personio",
  "phenom",
  "pinpoint",
  "radancy",
  "recruitee",
  "remoteok",
  "remotive",
  "remotli",
  "rheinmetall",
  "rippling",
  "senjob",
  "smartrecruiters",
  "softgarden",
  "solidjobs",
  "successfactors",
  "teamtailor",
  "tencent",
  "thehub",
  "themuse",
  "tkms",
  "torre",
  "vdab",
  "weworkremotely",
  "workable",
  "workday",
  "workingnomads",
  "wttj",
  "yourator",
];

test("Career Ops provider parity is pinned to the audited upstream snapshot", () => {
  assert.deepEqual(CAREER_OPS_UPSTREAM, {
    repository: "https://github.com/career-ops-hq/career-ops",
    commit: "ffb49be1f394041840c31c23a5d3a3347854340e",
    providerCount: 83,
  });
  assert.deepEqual(CAREER_OPS_PROVIDER_IDS, EXPECTED_PROVIDER_IDS);
  assert.equal(new Set(CAREER_OPS_PROVIDER_IDS).size, 83);
  assert.equal(CAREER_OPS_PROVIDER_PARITY.length, 83);
});

test("every provider in the pinned upstream inventory has an explicit disposition", () => {
  // Regression guard for a self-referential test: deriving the expected
  // universe from CAREER_OPS_PROVIDER_IDS itself would pass even if a
  // provider upstream silently added at the pin was never adopted, deferred,
  // or excluded here. CAREER_OPS_UPSTREAM_PROVIDER_IDS is instead a
  // hard-coded copy of the real upstream inventory at the pinned commit
  // (fetched directly from career-ops-hq/career-ops), independent of what this
  // repo has actually adopted.
  //
  // local-parser is deliberately not double-counted: it is already present
  // in CAREER_OPS_PROVIDER_IDS (with an "unsupported" disposition in
  // CAREER_OPS_PROVIDER_PARITY), so CAREER_OPS_EXCLUDED_PROVIDER_IDS only
  // needs to explain its exclusion, not add it to the tally again.
  const adopted = new Set(CAREER_OPS_PROVIDER_IDS);
  const deferred = new Set(Object.keys(CAREER_OPS_DEFERRED_PROVIDER_IDS));
  const excluded = new Set(Object.keys(CAREER_OPS_EXCLUDED_PROVIDER_IDS));

  for (const id of excluded) {
    assert.ok(adopted.has(id), `excluded provider ${id} must also be an adopted id (local-parser)`);
  }
  for (const id of deferred) {
    assert.ok(!adopted.has(id), `deferred provider ${id} must not already be adopted`);
  }

  const accountedFor = new Set([...adopted, ...deferred]);
  const upstream = new Set(CAREER_OPS_UPSTREAM_PROVIDER_IDS);

  assert.deepEqual(
    [...accountedFor].sort(),
    [...upstream].sort(),
    "adopted + deferred must exactly equal the pinned upstream inventory"
  );
  assert.equal(CAREER_OPS_UPSTREAM_PROVIDER_IDS.length, 83);
});

test("every upstream provider has an explicit runtime disposition", () => {
  const byId = new Map(CAREER_OPS_PROVIDER_PARITY.map((entry) => [entry.id, entry]));
  assert.deepEqual([...byId.keys()], EXPECTED_PROVIDER_IDS);

  for (const id of EXPECTED_PROVIDER_IDS.filter((candidate) => candidate !== "local-parser")) {
    assert.equal(byId.get(id)?.status, "implemented", id);
    assert.equal(isCareerOpsProviderSupported(id), true, id);
  }

  assert.deepEqual(byId.get("local-parser"), {
    id: "local-parser",
    status: "unsupported",
    reason: "Executes user-configured local commands; it is not a public network source adapter.",
  });
  assert.equal(isCareerOpsProviderSupported("local-parser"), false);
  assert.equal(isCareerOpsProviderSupported("unknown"), false);
});

test("all implemented provider modules load and satisfy the provider contract", () => {
  assert.deepEqual(
    careerOpsProviderIds(),
    EXPECTED_PROVIDER_IDS.filter((id) => id !== "local-parser")
  );
  for (const id of careerOpsProviderIds()) {
    const provider = providerForId(id);
    assert.equal(provider.id, id);
    assert.equal(typeof provider.fetch, "function", id);
    assert.ok(provider.detect == null || typeof provider.detect === "function", id);
  }
  assert.equal(providerForId("local-parser"), null);
});

test("provider inference covers high-leverage ATS URLs and normalizes explicit ids", () => {
  const cases = [
    ["https://acme.bamboohr.com/careers", "bamboohr"],
    ["https://acme.breezy.hr", "breezy"],
    ["https://www.comeet.co/careers-api/2.0/company/acme/positions?token=public-token", "comeet"],
    ["https://jobs.gem.com/acme", "gem"],
    ["https://jobs.icims.com/jobs/search?ss=1", "icims"],
    ["https://jobs.jobvite.com/acme", "jobvite"],
    ["https://acme.jobs.personio.com", "personio"],
    ["https://acme.pinpointhq.com", "pinpoint"],
    ["https://ats.rippling.com/acme/jobs", "rippling"],
    ["https://acme.teamtailor.com/jobs", "teamtailor"],
    ["https://acme.successfactors.com/careers", "successfactors"],
    ["https://acme.avature.net/careers", "avature"],
    ["https://acme.eightfold.ai/careers", "eightfold"],
    [
      "https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs",
      "oraclecloud",
    ],
  ];
  for (const [careersUrl, expected] of cases) {
    assert.equal(inferCareerOpsProvider({ careers_url: careersUrl }), expected, careersUrl);
  }
  assert.equal(inferCareerOpsProvider({ provider: "PHENOM" }), "phenom");
  assert.equal(inferCareerOpsProvider({ provider: "radancy" }), "radancy");
  assert.equal(inferCareerOpsProvider({ provider: "local-parser" }), null);
  assert.equal(inferCareerOpsProvider({ careers_url: "https://example.com/jobs" }), null);
});

test("Career Ops fetch normalizes provider output for CareerRat and marks missing bodies partial", async () => {
  const calls = [];
  const offers = await fetchCareerOpsProvider(
    "bamboohr",
    { name: "Acme", careers_url: "https://acme.bamboohr.com/careers" },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            result: [
              {
                id: "42",
                jobOpeningName: "Staff Platform Engineer",
                location: { city: "Denver", state: "CO" },
                isRemote: true,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
      // The SSRF guard resolves the host before ever calling fetchImpl; mock
      // it to a real public address so this stays a pure unit test with no
      // network access, same pattern as public-http-fetch.test.mjs.
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatcherFactory: () => ({ close: async () => {} }),
      sleep: async () => {},
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://acme.bamboohr.com/careers/list");
  assert.equal(calls[0].init.redirect, "error");
  assert.match(calls[0].init.headers["user-agent"], /CareerRat/);
  assert.deepEqual(offers, [
    {
      title: "Staff Platform Engineer",
      url: "https://acme.bamboohr.com/careers/42",
      company: "Acme",
      location: "Denver, CO, Remote",
      comp: "",
      bodyText: "",
      bodyPartial: true,
      provider: "bamboohr",
    },
  ]);
});

test("Career Ops fetch preserves free list-payload descriptions and normalizes epoch dates", async () => {
  const offers = await fetchCareerOpsProvider(
    "lever",
    { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              text: "Staff Engineer",
              hostedUrl: "https://jobs.lever.co/acme/abc",
              categories: { location: "Remote" },
              descriptionPlain: "Build reliable systems.",
              createdAt: 1_786_665_600_000,
            },
          ]),
          { status: 200 }
        ),
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatcherFactory: () => ({ close: async () => {} }),
    }
  );

  assert.equal(offers[0].bodyText, "Build reliable systems.");
  assert.equal(offers[0].bodyPartial, false);
  assert.equal(offers[0].postedAt, "2026-08-14T00:00:00.000Z");
  assert.equal(offers[0].provider, "lever");
});

test("CareerRat injects candidate query keywords into keyword-required providers", async () => {
  let requestBody = null;
  const offers = await fetchCareerOpsProvider(
    "vdab",
    { name: "VDAB", query: "Data Engineer" },
    {
      maxPages: 1,
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ resultaten: [] }), { status: 200 });
      },
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatcherFactory: () => ({ close: async () => {} }),
    }
  );

  assert.deepEqual(offers, []);
  assert.equal(requestBody.criteria.trefwoord, "Data Engineer");
});

test("CareerRat injects candidate query keywords into jobbankca", async () => {
  let requestedUrl = null;
  const offers = await fetchCareerOpsProvider(
    "jobbankca",
    { name: "Job Bank", query: "Data Engineer" },
    {
      sleep: async () => {},
      fetchImpl: async (url) => {
        requestedUrl = url;
        return new Response('<?xml version="1.0"?><feed></feed>', { status: 200 });
      },
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatcherFactory: () => ({ close: async () => {} }),
    }
  );

  assert.deepEqual(offers, []);
  assert.equal(new URL(requestedUrl).searchParams.get("searchstring"), "Data Engineer");
});

test("CareerRat injects candidate query keywords into mycareersfuture", async () => {
  let requestBody = null;
  const offers = await fetchCareerOpsProvider(
    "mycareersfuture",
    { name: "MyCareersFuture", query: "Data Engineer" },
    {
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      },
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatcherFactory: () => ({ close: async () => {} }),
    }
  );

  assert.deepEqual(offers, []);
  assert.equal(requestBody.search, "Data Engineer");
});
