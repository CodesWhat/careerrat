import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeAll } from "../src/core/db/connection.mjs";
import { candidateSetupInitialize, companyBoardResolutionGet } from "../src/core/db/verbs.mjs";
import {
  COMPANY_DISCOVERY_BATCH_MAX,
  isPrivateOrLocalHost,
  normalizeCompanyKey,
  REFRESH_REASONS,
  RESOLUTION_CACHE_TTL_DAYS,
  RESOLUTION_FAILURE_REFRESH_THRESHOLD,
  RESOLVER_FETCH_TIMEOUT_MS,
  RESOLVER_REDIRECT_CAP,
  resolutionNeedsRefresh,
  resolveCompanyBoard,
  ZERO_JOB_REFRESH_THRESHOLD,
} from "../src/core/discovery/company-board-resolver.mjs";

const cleanupRoots = [];
const NOW = new Date("2026-07-04T12:00:00.000Z");

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-company-board-resolver-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

function setupRepo() {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function lookupHostFor(addressesByHost = {}) {
  return async (host) => {
    const value = addressesByHost[host] || "203.0.113.10";
    return Array.isArray(value) ? value : [{ address: value }];
  };
}

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

function fetchFrom(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, options });
    const route = routes[href];
    if (!route) throw new Error(`unexpected fetch: ${href}`);
    return typeof route === "function" ? route(href, options) : route;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function rejectingFetch() {
  const fetchImpl = async (url) => {
    throw new Error(`fetch should not be called for ${url}`);
  };
  fetchImpl.calls = [];
  return fetchImpl;
}

function baseResolution(overrides = {}) {
  return {
    company_key: "acme-ai",
    company_name: "Acme AI",
    company_domain: "acme.example",
    careers_url: "https://acme.example/careers",
    job_board_url: "https://jobs.lever.co/acme",
    ats_provider: "lever",
    api_url: "https://api.lever.co/v0/postings/acme",
    confidence: "high",
    provenance: [{ source: "resolver-test", url: "https://acme.example" }],
    first_resolved_at: "2026-07-01T12:00:00.000Z",
    last_verified_at: "2026-07-01T12:00:00.000Z",
    last_scan_result: { status: "matching-roles-found", matching_role_count: 1 },
    failure_count: 0,
    zero_job_count: 0,
    next_refresh_reason: null,
    status: "supported_ats",
    ...overrides,
  };
}

test("exports the pinned company discovery resolver constants and refresh reasons", () => {
  assert.equal(COMPANY_DISCOVERY_BATCH_MAX, 12);
  assert.equal(RESOLUTION_CACHE_TTL_DAYS, 14);
  assert.equal(RESOLVER_FETCH_TIMEOUT_MS, 8000);
  assert.equal(RESOLVER_REDIRECT_CAP, 3);
  assert.equal(ZERO_JOB_REFRESH_THRESHOLD, 2);
  assert.equal(RESOLUTION_FAILURE_REFRESH_THRESHOLD, 2);
  assert.deepEqual(REFRESH_REASONS, {
    EXPLICIT_REFRESH: "explicit-refresh",
    STALE_TTL: "stale-ttl",
    HTTP_403: "http-403",
    HTTP_404: "http-404",
    REDIRECT_PROVIDER_CHANGE: "redirect-provider-change",
    PROVIDER_CHANGE: "provider-change",
    ZERO_JOBS_THRESHOLD: "zero-jobs-threshold",
    FAILED_EXTRACTION: "failed-extraction",
    RESOLVER_FAILURE_THRESHOLD: "resolver-failure-threshold",
    MANUAL_REVIEW: "manual-review",
  });
});

test("normalizes company keys and identifies local/private hosts before fetching", () => {
  assert.equal(normalizeCompanyKey(" Acme, Inc. AI "), "acme-inc-ai");

  for (const host of [
    "localhost",
    "jobs.localhost",
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.1.1",
    "::1",
    "[::1]",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
  ]) {
    assert.equal(isPrivateOrLocalHost(host), true, `${host} should be unsafe`);
  }

  assert.equal(isPrivateOrLocalHost("jobs.lever.co"), false);
  assert.equal(isPrivateOrLocalHost("203.0.113.10"), false);
});

test("rejects unsafe scheme and local/private host hints before cache promotion", async () => {
  const repoRoot = setupRepo();
  const unsafeHints = [
    "file:///etc/passwd",
    "ftp://example.com/careers",
    "javascript:alert(1)",
    "http://localhost/careers",
    "http://127.0.0.1/careers",
    "http://10.0.0.2/careers",
    "http://172.16.0.2/careers",
    "http://192.168.0.2/careers",
    "http://[::1]/careers",
    "http://[fd00::1]/careers",
  ];

  for (const [index, domain_hint] of unsafeHints.entries()) {
    const name = `Unsafe ${index}`;
    await assert.rejects(
      () =>
        resolveCompanyBoard({
          repoRoot,
          seed: { name, domain_hint },
          fetchImpl: rejectingFetch(),
          lookupHost: lookupHostFor(),
          now: NOW,
        }),
      (err) => err.code === "UNSAFE_COMPANY_BOARD_URL"
    );
    assert.equal(
      companyBoardResolutionGet({ repoRoot, companyKey: normalizeCompanyKey(name) }).resolution,
      null
    );
  }
});

test("rejects redirect targets that become local or private", async () => {
  const repoRoot = setupRepo();
  const fetchImpl = fetchFrom({
    "https://acme.example/": response("", {
      status: 302,
      headers: { location: "http://127.0.0.1/admin" },
    }),
  });

  await assert.rejects(
    () =>
      resolveCompanyBoard({
        repoRoot,
        seed: { name: "Acme AI", domain_hint: "https://acme.example" },
        fetchImpl,
        lookupHost: lookupHostFor({ "acme.example": "203.0.113.20" }),
        now: NOW,
      }),
    (err) => err.code === "UNSAFE_COMPANY_BOARD_URL"
  );
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(companyBoardResolutionGet({ repoRoot, companyKey: "acme-ai" }).resolution, null);
});

test("resolves a supported ATS hint through provider inference and persists cache metadata", async () => {
  const repoRoot = setupRepo();
  const result = await resolveCompanyBoard({
    repoRoot,
    seed: { name: "Acme AI", domain_hint: "https://jobs.lever.co/acme" },
    fetchImpl: rejectingFetch(),
    lookupHost: lookupHostFor({ "jobs.lever.co": "54.211.1.10" }),
    now: NOW,
  });

  assert.equal(result.status, "supported_ats");
  assert.equal(result.companyKey, "acme-ai");
  assert.equal(result.companyName, "Acme AI");
  assert.equal(result.companyDomain, "jobs.lever.co");
  assert.equal(result.jobBoardUrl, "https://jobs.lever.co/acme");
  assert.equal(result.atsProvider, "lever");
  assert.equal(result.apiUrl, "https://api.lever.co/v0/postings/acme");
  assert.equal(result.proposedAction, "approve-supported-ats");
  assert.equal(result.promotable, true);
  assert.ok(result.provenance.some((entry) => entry.source === "supported-ats-hint"));

  const cached = companyBoardResolutionGet({ repoRoot, companyKey: "acme-ai" }).resolution;
  assert.equal(cached.status, "supported_ats");
  assert.equal(cached.ats_provider, "lever");
  assert.equal(cached.job_board_url, "https://jobs.lever.co/acme");
  assert.equal(cached.api_url, "https://api.lever.co/v0/postings/acme");
  assert.equal(cached.confidence, "high");
  assert.equal(cached.last_verified_at, NOW.toISOString());
  assert.ok(cached.provenance.some((entry) => entry.source === "supported-ats-hint"));
});

test("caches API URLs for Recruitee and Workday supported ATS hints", async () => {
  const cases = [
    {
      name: "Acme Recruitee",
      domainHint: "https://acme.recruitee.com",
      host: "acme.recruitee.com",
      provider: "recruitee",
      apiUrl: "https://acme.recruitee.com/api/offers/",
    },
    {
      name: "Acme Workday",
      domainHint: "https://acme.wd5.myworkdayjobs.com/careers",
      host: "acme.wd5.myworkdayjobs.com",
      provider: "workday",
      apiUrl: "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/careers/jobs",
    },
  ];

  for (const fixture of cases) {
    const repoRoot = setupRepo();
    const result = await resolveCompanyBoard({
      repoRoot,
      seed: { name: fixture.name, domain_hint: fixture.domainHint },
      fetchImpl: rejectingFetch(),
      lookupHost: lookupHostFor({ [fixture.host]: "203.0.113.30" }),
      now: NOW,
    });

    assert.equal(result.status, "supported_ats", fixture.name);
    assert.equal(result.atsProvider, fixture.provider, fixture.name);
    assert.equal(result.apiUrl, fixture.apiUrl, fixture.name);

    const cached = companyBoardResolutionGet({
      repoRoot,
      companyKey: normalizeCompanyKey(fixture.name),
    }).resolution;
    assert.equal(cached.ats_provider, fixture.provider, fixture.name);
    assert.equal(cached.api_url, fixture.apiUrl, fixture.name);
  }
});

test("resolves newly supported Career Ops ATS hints without requiring a hand-built API URL", async () => {
  const repoRoot = setupRepo();
  const result = await resolveCompanyBoard({
    repoRoot,
    seed: { name: "Acme Bamboo", domain_hint: "https://acme.bamboohr.com/careers" },
    fetchImpl: rejectingFetch(),
    lookupHost: lookupHostFor({ "acme.bamboohr.com": "203.0.113.31" }),
    now: NOW,
  });

  assert.equal(result.status, "supported_ats");
  assert.equal(result.atsProvider, "bamboohr");
  assert.equal(result.jobBoardUrl, "https://acme.bamboohr.com/careers");
  assert.equal(result.apiUrl, "");
  assert.equal(result.promotable, true);

  const cached = companyBoardResolutionGet({ repoRoot, companyKey: "acme-bamboo" }).resolution;
  assert.equal(cached.ats_provider, "bamboohr");
  assert.equal(cached.job_board_url, "https://acme.bamboohr.com/careers");
});

test("discovers a supported ATS board from public homepage and careers links within the redirect cap", async () => {
  const repoRoot = setupRepo();
  const fetchImpl = fetchFrom({
    "https://acme.example/": response("", {
      status: 301,
      headers: { location: "/careers" },
    }),
    "https://acme.example/careers": response('<html><a href="/jobs">Open jobs</a></html>', {
      headers: { "content-type": "text/html" },
    }),
    "https://acme.example/jobs": response(
      '<html><a href="https://jobs.lever.co/acme">Lever board</a></html>',
      {
        headers: { "content-type": "text/html" },
      }
    ),
  });

  const result = await resolveCompanyBoard({
    repoRoot,
    seed: { name: "Acme AI", domain_hint: "https://acme.example" },
    fetchImpl,
    lookupHost: lookupHostFor({
      "acme.example": "203.0.113.20",
      "jobs.lever.co": "54.211.1.10",
    }),
    now: NOW,
  });

  assert.equal(result.status, "supported_ats");
  assert.equal(result.jobBoardUrl, "https://jobs.lever.co/acme");
  assert.equal(result.atsProvider, "lever");
  assert.ok(fetchImpl.calls.length <= RESOLVER_REDIRECT_CAP);
  assert.ok(
    fetchImpl.calls.every((call) => call.options.redirect === "manual"),
    "resolver must inspect redirects before following them"
  );
  assert.equal(
    fetchImpl.calls.every((call) => call.options.signal instanceof AbortSignal),
    true
  );

  const cached = companyBoardResolutionGet({ repoRoot, companyKey: "acme-ai" }).resolution;
  assert.equal(cached.status, "supported_ats");
  assert.equal(cached.job_board_url, "https://jobs.lever.co/acme");
});

test("persists unrecognized public careers pages as promotable generic browser sources", async () => {
  const repoRoot = setupRepo();
  const fetchImpl = fetchFrom({
    "https://plain.example/careers": response(
      "<html><h1>Careers</h1><p>Email jobs@plain.example.</p></html>",
      {
        headers: { "content-type": "text/html" },
      }
    ),
  });

  const result = await resolveCompanyBoard({
    repoRoot,
    seed: { name: "Plain Co", domain_hint: "https://plain.example/careers" },
    fetchImpl,
    lookupHost: lookupHostFor({ "plain.example": "203.0.113.50" }),
    now: NOW,
  });

  assert.equal(result.status, "generic_public");
  assert.equal(result.proposedAction, "approve-public-source");
  assert.equal(result.promotable, true);
  assert.equal(result.atsProvider, null);
  assert.equal(result.jobBoardUrl, "https://plain.example/careers");
  assert.ok(result.provenance.some((entry) => entry.source === "public-page-fetch"));

  const cached = companyBoardResolutionGet({ repoRoot, companyKey: "plain-co" }).resolution;
  assert.equal(cached.status, "generic_public");
  assert.equal(cached.ats_provider, null);
  assert.equal(cached.proposed_action, "approve-public-source");
  assert.equal(cached.job_board_url, "https://plain.example/careers");
});

test("resolutionNeedsRefresh covers explicit, stale, scan, threshold, and stored enum reasons", () => {
  assert.deepEqual(resolutionNeedsRefresh(baseResolution(), { now: NOW }), {
    needed: false,
    reason: null,
  });

  const cases = [
    [
      "force refresh",
      baseResolution(),
      { forceRefresh: true, now: NOW },
      REFRESH_REASONS.EXPLICIT_REFRESH,
    ],
    [
      "stale TTL",
      baseResolution({ last_verified_at: "2026-06-19T11:59:59.000Z" }),
      { now: NOW },
      REFRESH_REASONS.STALE_TTL,
    ],
    [
      "403 scan",
      baseResolution({ last_scan_result: { status: "http-403" } }),
      { now: NOW },
      REFRESH_REASONS.HTTP_403,
    ],
    [
      "404 scan",
      baseResolution({ last_scan_result: { status: "http-404" } }),
      { now: NOW },
      REFRESH_REASONS.HTTP_404,
    ],
    [
      "redirect provider change",
      baseResolution({ last_scan_result: { status: "redirect-provider-change" } }),
      { now: NOW },
      REFRESH_REASONS.REDIRECT_PROVIDER_CHANGE,
    ],
    [
      "provider change",
      baseResolution({ last_scan_result: { status: "provider-change" } }),
      { now: NOW },
      REFRESH_REASONS.PROVIDER_CHANGE,
    ],
    [
      "zero job threshold",
      baseResolution({ zero_job_count: 2 }),
      { now: NOW },
      REFRESH_REASONS.ZERO_JOBS_THRESHOLD,
    ],
    [
      "failed extraction",
      baseResolution({ last_scan_result: { status: "failed-extraction" } }),
      { now: NOW },
      REFRESH_REASONS.FAILED_EXTRACTION,
    ],
    [
      "failure threshold",
      baseResolution({ failure_count: 2 }),
      { now: NOW },
      REFRESH_REASONS.RESOLVER_FAILURE_THRESHOLD,
    ],
    [
      "stored reason",
      baseResolution({ next_refresh_reason: REFRESH_REASONS.MANUAL_REVIEW }),
      { now: NOW },
      REFRESH_REASONS.MANUAL_REVIEW,
    ],
  ];

  for (const [label, resolution, options, reason] of cases) {
    assert.deepEqual(resolutionNeedsRefresh(resolution, options), { needed: true, reason }, label);
  }
});
