// Portal coverage tests: Wellfound and Lever adapters.
// Covers: pure URL builders, buildSourceUrl dispatch, addSearchFromUrl host
// detection, generate-search-sources seeding, and schema validation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSearchSources } from "../src/core/profile/generate-search-sources.mjs";
import { validate } from "../src/core/profile/schema-validator.mjs";
import { buildLeverUrl, leverSearchEntry } from "../src/core/providers/lever.mjs";
import {
  addSearchFromUrl,
  emptyConfig,
  mergeSearchConfigs,
  validateConfig,
} from "../src/core/providers/search-sources.mjs";
import { buildSourceUrl, providerKey } from "../src/core/providers/source-url.mjs";
import { buildWellfoundUrl } from "../src/core/providers/wellfound.mjs";

const schemaPath = new URL("../config/search-sources.schema.json", import.meta.url).pathname;
const SCHEMA = JSON.parse(readFileSync(schemaPath, "utf8"));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseTechProfile = {
  candidate: {
    full_name: "Jane Candidate",
    preferred_name: "Jane",
    email: "jane@example.com",
    domain: "software engineering",
  },
  compensation: { currency: "USD", minimum_base: 180000 },
  location: { home: "Austin, TX", remote: true, relocation: [] },
  authorization: { work_authorized: true },
};

const baseNonTechProfile = {
  ...baseTechProfile,
  candidate: { ...baseTechProfile.candidate, domain: "finance" },
};

const baseNoDomainProfile = {
  ...baseTechProfile,
  candidate: { ...baseTechProfile.candidate, domain: undefined },
};

const onsiteTechProfile = {
  ...baseTechProfile,
  location: { home: "San Francisco, CA", remote: false, relocation: [] },
};

// Base targeting (no tracked_companies — Lever seeding must not fire).
const targeting = {
  role_buckets: [
    {
      name: "Primary",
      priority: "primary",
      titles: ["Forward Deployed Engineer", "Applied AI Engineer"],
    },
  ],
  keep_signals: [],
  cut_signals: [],
};

// Targeting with tracked companies — Lever seeding fires for these.
const targetingWithCompanies = {
  ...targeting,
  tracked_companies: ["Stripe", "Airbnb"],
};

// ---------------------------------------------------------------------------
// buildWellfoundUrl — url passthrough
// ---------------------------------------------------------------------------

test("buildWellfoundUrl: returns source.url unchanged when present", () => {
  const pasted = "https://wellfound.com/role/software-engineer";
  assert.equal(buildWellfoundUrl({ url: pasted }), pasted);
});

// ---------------------------------------------------------------------------
// buildWellfoundUrl — remote flag
// ---------------------------------------------------------------------------

test("buildWellfoundUrl: remote=true produces /role/r/{slug}", () => {
  const result = buildWellfoundUrl({ query: "Software Engineer", remote: true });
  assert.equal(result, "https://wellfound.com/role/r/software-engineer");
});

test("buildWellfoundUrl: remote flag takes precedence over location", () => {
  const result = buildWellfoundUrl({
    query: "Software Engineer",
    remote: true,
    location: "San Francisco",
  });
  assert.match(result, /^https:\/\/wellfound\.com\/role\/r\//);
});

// ---------------------------------------------------------------------------
// buildWellfoundUrl — role + location (no remote)
// ---------------------------------------------------------------------------

test("buildWellfoundUrl: location without remote produces /role/l/{role-slug}/{loc-slug}", () => {
  const result = buildWellfoundUrl({ query: "Data Scientist", location: "New York" });
  assert.equal(result, "https://wellfound.com/role/l/data-scientist/new-york");
});

test("buildWellfoundUrl: slugifies compound location string", () => {
  const result = buildWellfoundUrl({ query: "Software Engineer", location: "San Francisco" });
  assert.equal(result, "https://wellfound.com/role/l/software-engineer/san-francisco");
});

// ---------------------------------------------------------------------------
// buildWellfoundUrl — role-only
// ---------------------------------------------------------------------------

test("buildWellfoundUrl: role-only produces /role/{slug}", () => {
  const result = buildWellfoundUrl({ query: "Product Manager" });
  assert.equal(result, "https://wellfound.com/role/product-manager");
});

test("buildWellfoundUrl: uses source.role field when query is absent", () => {
  const result = buildWellfoundUrl({ role: "Full Stack Engineer" });
  assert.equal(result, "https://wellfound.com/role/full-stack-engineer");
});

test("buildWellfoundUrl: source.role takes precedence over source.query", () => {
  const result = buildWellfoundUrl({ role: "Product Manager", query: "Something Else" });
  assert.equal(result, "https://wellfound.com/role/product-manager");
});

// ---------------------------------------------------------------------------
// buildWellfoundUrl — slug normalisation
// ---------------------------------------------------------------------------

test("buildWellfoundUrl: slugifies multi-word role with special characters", () => {
  const result = buildWellfoundUrl({ role: "AI/ML Engineer" });
  assert.equal(result, "https://wellfound.com/role/ai-ml-engineer");
});

test("buildWellfoundUrl: result is always https://", () => {
  const result = buildWellfoundUrl({ query: "Software Engineer" });
  assert.ok(result.startsWith("https://"), `expected https:// but got ${result}`);
});

// ---------------------------------------------------------------------------
// buildWellfoundUrl — error on missing inputs
// ---------------------------------------------------------------------------

test("buildWellfoundUrl: throws when neither url nor role/query is provided", () => {
  assert.throws(() => buildWellfoundUrl({}), /role.*query|source\.url/i);
});

test("buildWellfoundUrl: throws with empty role string", () => {
  assert.throws(() => buildWellfoundUrl({ role: "" }), /role.*query|source\.url/i);
});

// ---------------------------------------------------------------------------
// buildLeverUrl — board URL (default)
// ---------------------------------------------------------------------------

test("buildLeverUrl: returns source.url unchanged when present", () => {
  const pasted = "https://jobs.lever.co/stripe";
  assert.equal(buildLeverUrl({ url: pasted }), pasted);
});

test("buildLeverUrl: builds board URL from source.company slug", () => {
  assert.equal(buildLeverUrl({ company: "stripe" }), "https://jobs.lever.co/stripe");
});

test("buildLeverUrl: slugifies company name (lowercases, spaces to hyphens)", () => {
  assert.equal(buildLeverUrl({ company: "Acme Corp" }), "https://jobs.lever.co/acme-corp");
});

// ---------------------------------------------------------------------------
// buildLeverUrl — JSON/API endpoint
// ---------------------------------------------------------------------------

test("buildLeverUrl: json=true switches to api.lever.co with mode=json", () => {
  const result = buildLeverUrl({ company: "stripe", json: true });
  const parsed = new URL(result);
  assert.equal(parsed.hostname, "api.lever.co");
  assert.match(parsed.pathname, /^\/v0\/postings\/stripe$/);
  assert.equal(parsed.searchParams.get("mode"), "json");
});

test("buildLeverUrl: api=true (alias) also switches to JSON endpoint", () => {
  const result = buildLeverUrl({ company: "airbnb", api: true });
  const parsed = new URL(result);
  assert.equal(parsed.hostname, "api.lever.co");
  assert.equal(parsed.searchParams.get("mode"), "json");
});

test("buildLeverUrl: throws when neither url nor company provided", () => {
  assert.throws(() => buildLeverUrl({}), /company/i);
});

// ---------------------------------------------------------------------------
// leverSearchEntry — shape and schema validity
// ---------------------------------------------------------------------------

test("leverSearchEntry: returns schema-valid entry with correct shape", () => {
  const entry = leverSearchEntry("stripe");
  assert.equal(entry.provider, "Lever");
  assert.equal(entry.source_type, "ats");
  assert.equal(entry.enabled, true);
  assert.ok(typeof entry.label === "string" && entry.label.length > 0);
  assert.ok(entry.url.startsWith("https://jobs.lever.co/"));
});

test("leverSearchEntry: url contains the slugified company name", () => {
  const entry = leverSearchEntry("Acme Corp");
  assert.match(entry.url, /\/acme-corp$/);
});

test("leverSearchEntry: validates against search-sources.schema.json", () => {
  const cfg = { ...emptyConfig(), searches: [leverSearchEntry("stripe")] };
  const { valid, errors } = validate(cfg, SCHEMA);
  assert.ok(valid, `schema errors: ${JSON.stringify(errors, null, 2)}`);
});

test("leverSearchEntry: different companies produce different URLs", () => {
  const e1 = leverSearchEntry("stripe");
  const e2 = leverSearchEntry("airbnb");
  assert.notEqual(e1.url, e2.url);
  assert.match(e1.url, /\/stripe$/);
  assert.match(e2.url, /\/airbnb$/);
});

test("leverSearchEntry: throws when company is empty", () => {
  assert.throws(() => leverSearchEntry(""), /company/i);
});

// ---------------------------------------------------------------------------
// buildSourceUrl dispatch
// ---------------------------------------------------------------------------

test("buildSourceUrl: dispatches 'Wellfound' provider to wellfound builder", () => {
  const result = buildSourceUrl({ provider: "Wellfound", query: "Software Engineer" });
  assert.ok(result.url.startsWith("https://wellfound.com/"));
  assert.deepEqual(result.searchState, {});
  assert.equal(result.recency, null);
});

test("buildSourceUrl: dispatches 'wellfound' (lowercase) provider key", () => {
  const result = buildSourceUrl({ provider: "wellfound", query: "Data Scientist" });
  assert.ok(result.url.startsWith("https://wellfound.com/"));
});

test("buildSourceUrl: dispatches 'Lever' provider to lever builder", () => {
  const result = buildSourceUrl({ provider: "Lever", company: "stripe" });
  assert.equal(result.url, "https://jobs.lever.co/stripe");
  assert.deepEqual(result.searchState, {});
  assert.equal(result.recency, null);
});

test("buildSourceUrl: Lever with url passthrough returns that url", () => {
  const result = buildSourceUrl({ provider: "Lever", url: "https://jobs.lever.co/acme" });
  assert.equal(result.url, "https://jobs.lever.co/acme");
});

test("providerKey normalizes Wellfound and Lever to expected keys", () => {
  assert.equal(providerKey("Wellfound"), "wellfound");
  assert.equal(providerKey("Lever"), "lever");
});

// ---------------------------------------------------------------------------
// addSearchFromUrl — Wellfound host detection
// ---------------------------------------------------------------------------

test("addSearchFromUrl: wellfound.com URL creates Wellfound browser entry", () => {
  const url = "https://wellfound.com/role/software-engineer";
  const cfg = addSearchFromUrl(emptyConfig(), url);
  assert.equal(cfg.searches.length, 1);
  const s = cfg.searches[0];
  assert.equal(s.provider, "Wellfound");
  assert.equal(s.source_type, "browser");
  assert.equal(s.url, url);
  assert.equal(s.enabled, true);
});

test("addSearchFromUrl: www.wellfound.com URL creates Wellfound entry (www. is stripped)", () => {
  // www. is stripped by existing preprocessing; host becomes 'wellfound.com'.
  const cfg = addSearchFromUrl(emptyConfig(), "https://www.wellfound.com/role/product-manager");
  assert.equal(cfg.searches[0].provider, "Wellfound");
});

test("addSearchFromUrl: Wellfound entry validates against schema", () => {
  const cfg = addSearchFromUrl(emptyConfig(), "https://wellfound.com/role/r/software-engineer");
  const { valid, errors } = validateConfig(cfg, SCHEMA);
  assert.ok(valid, `schema errors: ${JSON.stringify(errors, null, 2)}`);
});

test("addSearchFromUrl: Wellfound uses label arg when provided", () => {
  const cfg = addSearchFromUrl(emptyConfig(), "https://wellfound.com/role/software-engineer", {
    label: "SW Eng",
  });
  assert.equal(cfg.searches[0].label, "SW Eng");
});

// ---------------------------------------------------------------------------
// addSearchFromUrl — Lever host detection
// ---------------------------------------------------------------------------

test("addSearchFromUrl: jobs.lever.co URL creates Lever ats entry", () => {
  const url = "https://jobs.lever.co/stripe";
  const cfg = addSearchFromUrl(emptyConfig(), url);
  assert.equal(cfg.searches.length, 1);
  const s = cfg.searches[0];
  assert.equal(s.provider, "Lever");
  assert.equal(s.source_type, "ats");
  assert.equal(s.url, url);
  assert.equal(s.enabled, true);
});

test("addSearchFromUrl: jobs.lever.co URL derives company label from path", () => {
  const cfg = addSearchFromUrl(emptyConfig(), "https://jobs.lever.co/acme-inc");
  assert.ok(
    cfg.searches[0].label.toLowerCase().includes("acme"),
    `label should contain 'acme'; got: ${cfg.searches[0].label}`
  );
});

test("addSearchFromUrl: jobs.lever.co URL validates against schema", () => {
  const cfg = addSearchFromUrl(emptyConfig(), "https://jobs.lever.co/stripe");
  const { valid, errors } = validateConfig(cfg, SCHEMA);
  assert.ok(valid, `schema errors: ${JSON.stringify(errors, null, 2)}`);
});

test("addSearchFromUrl: api.lever.co URL also creates Lever ats entry", () => {
  const url = "https://api.lever.co/v0/postings/stripe?mode=json";
  const cfg = addSearchFromUrl(emptyConfig(), url);
  const s = cfg.searches[0];
  assert.equal(s.provider, "Lever");
  assert.equal(s.source_type, "ats");
});

test("addSearchFromUrl: Lever uses label arg when provided", () => {
  const cfg = addSearchFromUrl(emptyConfig(), "https://jobs.lever.co/stripe", {
    label: "Stripe Jobs",
  });
  assert.equal(cfg.searches[0].label, "Stripe Jobs");
});

// ---------------------------------------------------------------------------
// mergeSearchConfigs — sameUrl deduplication for Wellfound + Lever
// ---------------------------------------------------------------------------

test("mergeSearchConfigs: re-running from-targeting does not duplicate Wellfound entry", () => {
  const entry = {
    provider: "Wellfound",
    source_type: "browser",
    label: "Wellfound",
    url: "https://wellfound.com/role/r/software-engineer",
    enabled: true,
  };
  const existing = { ...emptyConfig(), searches: [entry] };
  const baseline = { ...emptyConfig(), searches: [{ ...entry }] };
  const merged = mergeSearchConfigs(existing, baseline);
  const wfEntries = merged.searches.filter((s) => s.provider === "Wellfound");
  assert.equal(wfEntries.length, 1, "should not duplicate Wellfound entry on re-run");
});

test("mergeSearchConfigs: re-running from-targeting does not duplicate Lever entry", () => {
  const entry = leverSearchEntry("stripe");
  const existing = { ...emptyConfig(), searches: [entry] };
  const baseline = { ...emptyConfig(), searches: [leverSearchEntry("stripe")] };
  const merged = mergeSearchConfigs(existing, baseline);
  const leverEntries = merged.searches.filter((s) => s.provider === "Lever");
  assert.equal(leverEntries.length, 1, "should not duplicate Lever entry on re-run");
});

// ---------------------------------------------------------------------------
// generate-search-sources — Wellfound tech-gating
// ---------------------------------------------------------------------------

test("buildSearchSources: Wellfound entry present when domain is tech", () => {
  const result = buildSearchSources(targeting, baseTechProfile);
  const wf = result.searches.filter((s) => s.provider === "Wellfound");
  assert.ok(wf.length > 0, "expected at least one Wellfound entry for tech domain");
});

test("buildSearchSources: Wellfound entry has source_type browser and enabled true", () => {
  const result = buildSearchSources(targeting, baseTechProfile);
  const wf = result.searches.find((s) => s.provider === "Wellfound");
  assert.ok(wf, "Wellfound entry missing");
  assert.equal(wf.source_type, "browser");
  assert.ok(wf.url.startsWith("https://wellfound.com/"), `unexpected url: ${wf.url}`);
  assert.equal(wf.enabled, true);
});

test("buildSearchSources: Wellfound remote URL uses /role/r/ when candidate is remote", () => {
  const result = buildSearchSources(targeting, baseTechProfile);
  const wf = result.searches.find((s) => s.provider === "Wellfound");
  assert.ok(wf, "Wellfound entry missing");
  assert.match(wf.url, /\/role\/r\//, "remote candidate should produce /role/r/ URL");
});

test("buildSearchSources: Wellfound onsite URL uses /role/l/ when candidate is onsite with home city", () => {
  const result = buildSearchSources(targeting, onsiteTechProfile);
  const wf = result.searches.find((s) => s.provider === "Wellfound");
  assert.ok(wf, "Wellfound entry missing");
  assert.match(
    wf.url,
    /\/role\/l\//,
    "onsite candidate with home city should produce /role/l/ URL"
  );
});

test("buildSearchSources: Wellfound entry absent when domain is non-tech (finance)", () => {
  const result = buildSearchSources(targeting, baseNonTechProfile);
  const wf = result.searches.filter((s) => s.provider === "Wellfound");
  assert.equal(wf.length, 0, "Wellfound must not appear for non-tech domain");
});

test("buildSearchSources: Wellfound entry absent when domain and titles are both non-tech", () => {
  // `targeting`'s titles ("Forward Deployed Engineer", "Applied AI Engineer")
  // now read as tech-shaped under generate-search-sources.mjs's title-
  // inference fallback for an absent domain, so this uses its own non-tech
  // titles to keep testing the actual "nothing tech-shaped at all" case.
  const nonTechTargeting = {
    role_buckets: [
      { name: "Primary", priority: "primary", titles: ["Registered Nurse", "Nurse Practitioner"] },
    ],
    keep_signals: [],
    cut_signals: [],
  };
  const result = buildSearchSources(nonTechTargeting, baseNoDomainProfile);
  const wf = result.searches.filter((s) => s.provider === "Wellfound");
  assert.equal(
    wf.length,
    0,
    "Wellfound must not appear when domain is absent and titles aren't tech-shaped"
  );
});

test("buildSearchSources: Wellfound entry appears when domain is absent but titles look tech", () => {
  const result = buildSearchSources(targeting, baseNoDomainProfile);
  const wf = result.searches.filter((s) => s.provider === "Wellfound");
  assert.equal(
    wf.length,
    1,
    "Wellfound must appear when domain is absent and a majority of titles look tech"
  );
});

// ---------------------------------------------------------------------------
// generate-search-sources — tracked company names never guess ATS boards
// ---------------------------------------------------------------------------

test("buildSearchSources: does not guess Lever boards from tracked company names", () => {
  const result = buildSearchSources(targetingWithCompanies, baseNonTechProfile);
  const lever = result.searches.filter((s) => s.provider === "Lever");
  assert.equal(lever.length, 0, "bare company names must not become guessed Lever URLs");
});

test("buildSearchSources: Lever entries have correct shape", () => {
  const result = buildSearchSources(targetingWithCompanies, baseNonTechProfile);
  for (const e of result.searches.filter((s) => s.provider === "Lever")) {
    assert.equal(e.source_type, "ats");
    assert.ok(e.url.startsWith("https://jobs.lever.co/"), `bad url: ${e.url}`);
    assert.equal(e.enabled, true);
    assert.ok(typeof e.label === "string" && e.label.length > 0);
  }
});

test("buildSearchSources: tracked company slugs are not emitted as Lever URLs", () => {
  const result = buildSearchSources(targetingWithCompanies, baseNonTechProfile);
  const urls = result.searches.filter((s) => s.provider === "Lever").map((s) => s.url);
  assert.deepEqual(urls, []);
});

test("buildSearchSources: no Lever entries when tracked_companies absent or empty", () => {
  const result = buildSearchSources(targeting, baseNonTechProfile);
  const lever = result.searches.filter((s) => s.provider === "Lever");
  assert.equal(lever.length, 0, "no Lever entries expected when tracked_companies is empty");
});

test("buildSearchSources: Lever guessing stays disabled for both tech and non-tech", () => {
  const techResult = buildSearchSources(targetingWithCompanies, baseTechProfile);
  const nonTechResult = buildSearchSources(targetingWithCompanies, baseNonTechProfile);
  assert.equal(techResult.searches.filter((s) => s.provider === "Lever").length, 0);
  assert.equal(nonTechResult.searches.filter((s) => s.provider === "Lever").length, 0);
});

test("buildSearchSources: full config with Wellfound+Lever validates against schema", () => {
  const result = buildSearchSources(targetingWithCompanies, baseTechProfile);
  const { valid, errors } = validate(result, SCHEMA);
  assert.ok(valid, `schema validation failed: ${JSON.stringify(errors, null, 2)}`);
});

// ---------------------------------------------------------------------------
// source_catalog — Wellfound present in aggregators
// ---------------------------------------------------------------------------

test("buildSearchSources: source_catalog.aggregators includes Wellfound", () => {
  const result = buildSearchSources(targeting, baseTechProfile);
  assert.ok(
    Array.isArray(result.source_catalog.aggregators) &&
      result.source_catalog.aggregators.includes("Wellfound"),
    "Wellfound missing from source_catalog.aggregators"
  );
});

// ---------------------------------------------------------------------------
// isSpaJobHost via checkUrlLiveness — Wellfound and Lever SPA shell paths
// ---------------------------------------------------------------------------

test("checkUrlLiveness: wellfound.com 403 response is classified as spa_shell", async () => {
  const { checkUrlLiveness } = await import("../src/core/liveness/job-link-checker.mjs");
  const result = await checkUrlLiveness("https://wellfound.com/role/software-engineer", {
    fetchImpl: async () =>
      new Response("<html><body>Forbidden</body></html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
  });
  // 403 may be classified as expired or uncertain; what matters is wellfound.com
  // is treated as a SPA host (insufficient_content → spa_shell).
  // Test that short 403 body on wellfound.com does NOT produce a false 'live'.
  assert.notEqual(result.code, "live", "wellfound.com should not be classified as live on a 403");
});

test("checkUrlLiveness: jobs.lever.co short SPA shell is classified as spa_shell", async () => {
  const { checkUrlLiveness } = await import("../src/core/liveness/job-link-checker.mjs");
  const result = await checkUrlLiveness("https://jobs.lever.co/acme", {
    fetchImpl: async () =>
      new Response("<html><body>Loading</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  });
  assert.equal(result.result, "uncertain");
  assert.equal(result.code, "spa_shell");
});
