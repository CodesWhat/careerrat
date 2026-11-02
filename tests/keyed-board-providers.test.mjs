import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildSearchSources } from "../src/core/profile/generate-search-sources.mjs";
import { fetchAdzuna, parseAdzunaResponse } from "../src/core/providers/adzuna.mjs";
import {
  hasCredentials,
  MissingCredentialsError,
  requireCredentials,
} from "../src/core/providers/keyed-credentials.mjs";
import { addProviderSource, addSearchFromUrl } from "../src/core/providers/search-sources.mjs";
import { fetchUsaJobs, parseUsaJobsResponse } from "../src/core/providers/usajobs.mjs";
import { isBoardProviderSupported, scanBoards } from "../src/core/scoring/sourced-scanner.mjs";
import { summarizeDeadSources } from "../src/core/search/search-health.mjs";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/search-sources/${name}`, import.meta.url), "utf8"));

const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 };
const net = {
  resolveHost: async () => [PUBLIC_ADDRESS],
  dispatcherFactory: () => ({ close: async () => {} }),
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const USA_ENV = { USAJOBS_API_KEY: "key-123", USAJOBS_USER_AGENT: "me@example.test" };
const ADZUNA_ENV = { ADZUNA_APP_ID: "app-1", ADZUNA_APP_KEY: "key-1" };

test("requireCredentials names every missing variable and the signup page", () => {
  assert.throws(
    () => requireCredentials("usajobs", { USAJOBS_API_KEY: "  " }),
    (error) => {
      assert.ok(error instanceof MissingCredentialsError);
      assert.equal(error.code, "MISSING_CREDENTIALS");
      assert.deepEqual(error.missing, ["USAJOBS_API_KEY", "USAJOBS_USER_AGENT"]);
      assert.match(error.message, /developer\.usajobs\.gov/);
      return true;
    }
  );
  assert.equal(hasCredentials("adzuna", ADZUNA_ENV), true);
  assert.equal(hasCredentials("adzuna", { ADZUNA_APP_ID: "x" }), false);
});

test("parseUsaJobsResponse maps postings and drops rows without a link", () => {
  const offers = parseUsaJobsResponse(fixture("usajobs-search.json"));
  assert.equal(offers.length, 2);
  assert.deepEqual(
    { ...offers[0], bodyText: undefined },
    {
      title: "Program Analyst",
      url: "https://www.usajobs.gov/job/800000001",
      company: "Example Bureau",
      location: "Washington, District of Columbia",
      comp: "USD 88621-115208 per year",
      postedAt: "2026-10-20T00:00:00.000Z",
      bodyText: undefined,
      bodyPartial: false,
    }
  );
  assert.match(offers[0].bodyText, /Analyze program performance/);
  assert.equal(offers[1].company, "Example Department");
  assert.equal(offers[1].comp, "");
  assert.equal(offers[1].bodyPartial, true);
});

test("parseUsaJobsResponse rejects an unexpected shape instead of returning nothing", () => {
  assert.throws(() => parseUsaJobsResponse({ error: "x" }), /unexpected API response/);
});

test("fetchUsaJobs sends the key and user-agent headers and the query", async () => {
  const seen = [];
  const offers = await fetchUsaJobs(
    { query: "program analyst", location: "Washington, DC" },
    {
      env: USA_ENV,
      ...net,
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), headers: new Headers(init.headers) });
        return json(fixture("usajobs-search.json"));
      },
    }
  );
  assert.equal(offers.length, 2);
  assert.equal(seen.length, 1);
  const url = new URL(seen[0].url);
  assert.equal(url.origin + url.pathname, "https://data.usajobs.gov/api/search");
  assert.equal(url.searchParams.get("Keyword"), "program analyst");
  assert.equal(url.searchParams.get("LocationName"), "Washington, DC");
  assert.equal(seen[0].headers.get("authorization-key"), "key-123");
  assert.equal(seen[0].headers.get("user-agent"), "me@example.test");
});

test("fetchUsaJobs without a key fails loudly and never calls the network", async () => {
  let called = false;
  await assert.rejects(
    () =>
      fetchUsaJobs(
        { query: "analyst" },
        {
          env: {},
          ...net,
          fetchImpl: async () => {
            called = true;
            return json({});
          },
        }
      ),
    /usajobs: missing USAJOBS_API_KEY and USAJOBS_USER_AGENT/
  );
  assert.equal(called, false);
});

test("parseAdzunaResponse keeps stated pay, drops estimates and rows without a link", () => {
  const offers = parseAdzunaResponse(fixture("adzuna-search.json"), {}, "us");
  assert.equal(offers.length, 2);
  assert.equal(offers[0].company, "Example Logistics");
  assert.equal(offers[0].comp, "USD 52000-61000");
  assert.equal(offers[0].postedAt, "2026-10-28T09:15:00.000Z");
  assert.equal(offers[0].bodyPartial, true);
  assert.equal(offers[1].comp, "");
});

test("fetchAdzuna builds the country search URL with the app id and key", async () => {
  const seen = [];
  const offers = await fetchAdzuna(
    { query: "operations coordinator", country: "us", location: "Chicago" },
    {
      env: ADZUNA_ENV,
      ...net,
      fetchImpl: async (url) => {
        seen.push(new URL(String(url)));
        return json(fixture("adzuna-search.json"));
      },
    }
  );
  assert.equal(offers.length, 2);
  assert.equal(seen[0].origin + seen[0].pathname, "https://api.adzuna.com/v1/api/jobs/us/search/1");
  assert.equal(seen[0].searchParams.get("app_id"), "app-1");
  assert.equal(seen[0].searchParams.get("app_key"), "key-1");
  assert.equal(seen[0].searchParams.get("what"), "operations coordinator");
  assert.equal(seen[0].searchParams.get("where"), "Chicago");
});

test("fetchAdzuna refuses a missing key and an unsupported country by name", async () => {
  const deps = { ...net, fetchImpl: async () => json({ results: [] }) };
  await assert.rejects(
    () => fetchAdzuna({ query: "x", country: "us" }, { env: {}, ...deps }),
    /adzuna: missing ADZUNA_APP_ID and ADZUNA_APP_KEY/
  );
  await assert.rejects(
    () => fetchAdzuna({ query: "x", country: "zz" }, { env: ADZUNA_ENV, ...deps }),
    /adzuna: set country to one of/
  );
  await assert.rejects(
    () => fetchAdzuna({ query: "x" }, { env: ADZUNA_ENV, ...deps }),
    /adzuna: set country/
  );
});

test("a 404 from a keyed API surfaces as an HTTP 404 error", async () => {
  await assert.rejects(
    () =>
      fetchAdzuna(
        { query: "x", country: "us" },
        { env: ADZUNA_ENV, ...net, fetchImpl: async () => new Response("nope", { status: 404 }) }
      ),
    /HTTP 404/
  );
});

test("the scanner knows the keyed providers and reports missing keys as an error row", async () => {
  assert.equal(isBoardProviderSupported("usajobs"), true);
  assert.equal(isBoardProviderSupported("adzuna"), true);
  const saved = { ...process.env };
  for (const name of [...Object.keys(USA_ENV), ...Object.keys(ADZUNA_ENV)])
    delete process.env[name];
  try {
    const result = await scanBoards(
      {
        searches: [
          {
            provider: "usajobs",
            source_type: "board",
            label: "USAJobs",
            query: "analyst",
            enabled: true,
          },
        ],
      },
      { fetchImpl: async () => json({}), ...net }
    );
    assert.equal(result.offers.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /USAJOBS_API_KEY/);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("addProviderSource adds the keyed providers as keyword boards", () => {
  const config = addProviderSource(
    { searches: [] },
    { provider: "adzuna", query: "Operations Coordinator", country: "GB", location: "Leeds" }
  );
  assert.deepEqual(
    { ...config.searches[0], recency: undefined },
    {
      provider: "adzuna",
      source_type: "board",
      label: "adzuna",
      query: "Operations Coordinator",
      country: "gb",
      location: "Leeds",
      enabled: true,
      recency: undefined,
    }
  );
  assert.throws(
    () => addProviderSource({ searches: [] }, { provider: "adzuna", query: "x" }),
    /needs a --country/
  );
  assert.throws(
    () => addProviderSource({ searches: [] }, { provider: "usajobs", url: "https://x.test/" }),
    /needs a --query/
  );
  const usa = addProviderSource({ searches: [] }, { provider: "usajobs", query: "analyst" });
  assert.equal(usa.searches[0].source_type, "board");
  assert.equal(usa.searches[0].url, undefined);
});

const targeting = {
  role_buckets: [{ name: "Primary", priority: "primary", titles: ["Operations Manager"] }],
};
const usProfile = {
  candidate: { domain: "operations" },
  location: { home: "Austin, TX", remote: false },
};

test("buildSearchSources seeds keyed sources only when their keys are set", () => {
  const without = buildSearchSources(targeting, usProfile, { env: {} });
  assert.equal(
    without.searches.some((s) => s.provider === "usajobs"),
    false
  );
  assert.equal(
    without.searches.some((s) => s.provider === "adzuna"),
    false
  );

  const withKeys = buildSearchSources(targeting, usProfile, {
    env: { ...USA_ENV, ...ADZUNA_ENV },
  });
  const usajobs = withKeys.searches.find((s) => s.provider === "usajobs");
  const adzuna = withKeys.searches.find((s) => s.provider === "adzuna");
  assert.equal(usajobs.query, "Operations Manager");
  assert.equal(adzuna.country, "us");
  assert.equal(adzuna.query, "Operations Manager");
});

test("buildSearchSources skips Adzuna for a home outside its markets and USAJobs outside the US", () => {
  const result = buildSearchSources(
    targeting,
    { candidate: { domain: "operations" }, location: { home: "Lagos, Nigeria", remote: false } },
    { env: { ...USA_ENV, ...ADZUNA_ENV } }
  );
  assert.equal(
    result.searches.some((s) => s.provider === "adzuna"),
    false
  );
  assert.equal(
    result.searches.some((s) => s.provider === "usajobs"),
    false
  );
});

test("buildSearchSources seeds the no-key remote boards for every domain and Hacker News for tech only", () => {
  const general = buildSearchSources(targeting, usProfile);
  const providers = general.searches.map((s) => s.provider);
  for (const id of ["himalayas", "jobicy", "remotive", "remoteok", "workingnomads"]) {
    assert.ok(providers.includes(id), `missing ${id}`);
  }
  assert.equal(providers.includes("hackernews"), false);

  const tech = buildSearchSources(
    { role_buckets: [{ name: "Primary", priority: "primary", titles: ["Software Engineer"] }] },
    {
      candidate: { domain: "software engineering" },
      location: { home: "Austin, TX", remote: true },
    }
  );
  assert.ok(tech.searches.some((s) => s.provider === "hackernews"));
});

test("a company board on a supported ATS beats a browser source for the same URL", () => {
  for (const sourceType of ["browser", "url-query"]) {
    const config = addSearchFromUrl({ searches: [] }, "https://boards.greenhouse.io/examplecorp", {
      label: "Example Corp",
      sourceType,
    });
    assert.equal(config.searches[0].source_type, "ats");
    assert.equal(config.searches[0].provider, "greenhouse");
  }
  const unknown = addSearchFromUrl({ searches: [] }, "https://careers.example.test/jobs", {
    label: "Example",
    sourceType: "browser",
  });
  assert.equal(unknown.searches[0].source_type, "browser");
});

test("summarizeDeadSources lists 404 sources with their URL and a next action", () => {
  const dead = summarizeDeadSources([
    {
      kind: "company",
      label: "Gone Co",
      url: "https://boards.greenhouse.io/goneco",
      errors: [{ company: "Gone Co", error: "HTTP 404 Not Found" }],
    },
    {
      kind: "source",
      label: "Flaky Board",
      url: "https://flaky.example.test/api",
      errors: [{ company: "Flaky Board", error: "HTTP 503" }],
    },
    {
      kind: "source",
      label: "Missing Tenant",
      url: "https://ats.example.test/acme",
      errors: [{ company: "Missing Tenant", error: "The board does not exist" }],
    },
    { kind: "source", label: "Fine", url: "https://fine.example.test", errors: [] },
  ]);
  assert.equal(dead.count, 2);
  assert.deepEqual(
    dead.sources.map((s) => [s.label, s.url, s.action]),
    [
      ["Gone Co", "https://boards.greenhouse.io/goneco", "Remove it or re-resolve it."],
      ["Missing Tenant", "https://ats.example.test/acme", "Remove it or re-resolve it."],
    ]
  );
});

test("the scan summary lists dead sources with their URL and next action", async () => {
  const { printSummary } = await import("../scripts/scan-sourced.mjs");
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    printSummary(
      {
        coldFamilies: [],
        scanned: 0,
        new: 0,
        filteredTitle: 0,
        filteredLocation: 0,
        duplicates: 0,
        errors: [{ company: "Gone Co", error: "HTTP 404 Not Found" }],
        deadSources: summarizeDeadSources([
          {
            kind: "company",
            label: "Gone Co",
            url: "https://boards.greenhouse.io/goneco",
            errors: [{ error: "HTTP 404 Not Found" }],
          },
        ]),
      },
      [],
      {},
      5
    );
  } finally {
    console.log = original;
  }
  const out = lines.join("\n");
  assert.match(out, /Dead sources \(1\):/);
  assert.match(
    out,
    /- Gone Co \(https:\/\/boards\.greenhouse\.io\/goneco\): not found \(404\)\. Remove it or re-resolve it\./
  );
  assert.match(out, /Errors:\n- Gone Co: HTTP 404/);
});
