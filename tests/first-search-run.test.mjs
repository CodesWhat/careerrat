import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  candidateArtifactPut,
  candidateConfigPatch,
  candidateSetupInitialize,
  companyBoardResolutionUpsert,
  sourceConfigGet,
  sourceConfigPut,
  sourcingRunComplete,
  sourcingRunLatest,
  sourcingRunStart,
} from "../src/core/db/verbs.mjs";
import {
  countDeterministicSources,
  latestSourcingRunForUi,
  prepareFirstSearchSources,
  runFirstSearchInBackground,
  startFirstSearchRun,
} from "../src/core/onboarding/first-search-run.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { buildWellfoundUrl } from "../src/core/providers/wellfound.mjs";
import { saveSearchPrompts } from "../src/core/search/search-prompts.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-first-search-run-"));
  cleanupRoots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function leverResponse({ title, url }) {
  return new Response(
    JSON.stringify([
      {
        text: title,
        hostedUrl: url,
        categories: { location: "Remote" },
        descriptionBodyPlain: "Build AI and identity automation systems.",
      },
    ]),
    { status: 200 }
  );
}

function markSearchReady(repoRoot, { domain = "software engineering" } = {}) {
  candidateArtifactPut({
    repoRoot,
    id: "source-resume",
    kind: "source-resume",
    data: {
      format: "text",
      text: "AI engineer with identity automation and agent workflow experience.",
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "AI builder", titles: ["AI Engineer"] }],
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: { domain },
      location: {
        home: "New York, NY",
        remote: true,
        hybrid: true,
        onsite: false,
      },
    },
  });
}

function setTrackedCompanies(repoRoot, trackedCompanies) {
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: { tracked_companies: trackedCompanies },
  });
}

function aiRouteEnv() {
  return { ANTHROPIC_API_KEY: "test-key" };
}

function domainHintResponse(companies) {
  return {
    content: [{ type: "text", text: JSON.stringify({ companies }) }],
    model: "domain-hint-test",
  };
}

function cachedSupportedBoard(name, slug) {
  const now = new Date().toISOString();
  return {
    company_key: name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
    company_name: name,
    company_domain: "jobs.lever.co",
    careers_url: `https://jobs.lever.co/${slug}`,
    job_board_url: `https://jobs.lever.co/${slug}`,
    ats_provider: "lever",
    api_url: `https://api.lever.co/v0/postings/${slug}`,
    confidence: "high",
    provenance: [],
    first_resolved_at: now,
    last_verified_at: now,
    last_scan_result: { status: "resolved" },
    failure_count: 0,
    zero_job_count: 0,
    next_refresh_reason: null,
    status: "supported_ats",
    proposed_action: "approve-supported-ats",
    promotable: true,
  };
}

function seedNoDeterministicSources(repoRoot) {
  sourceConfigPut({
    repoRoot,
    name: "sourced-scan",
    data: { title_filter: {}, location_filter: null, tracked_companies: [] },
  });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      title_filter: {},
      location_filter: null,
      searches: [
        {
          label: "Browser-only board",
          source_type: "browser",
          url: "https://example.test/search?q=ai",
          enabled: true,
        },
        {
          provider: "arbeitnow",
          label: "Arbeitnow",
          source_type: "board",
          url: "https://www.arbeitnow.com/api/job-board-api",
          enabled: false,
        },
      ],
      tracked_companies: [],
      source_catalog: {},
    },
  });
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareFirstSearchSources writes merged SQLite search-sources without compatibility YAML", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      title_filter: { positive: ["Existing"], negative: [] },
      location_filter: { always_allow: [], allow: ["Remote"], block: [] },
      searches: [
        {
          provider: "Custom RSS",
          label: "Existing RSS",
          source_type: "rss",
          rssUrl: "https://example.test/existing.xml",
          enabled: true,
        },
      ],
      tracked_companies: [],
      source_catalog: {},
    },
  });

  const result = await prepareFirstSearchSources({ repoRoot, env: {} });

  assert.equal(result.ok, true);
  assert.equal(result.sources.stored, true);
  assert.equal(result.deterministicSources.rss >= 2, true);
  assert.equal(existsSync(userPath({ repoRoot }, "config/search-sources.yml")), false);

  const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
  assert.equal(
    stored.searches.some((source) => source.label === "Existing RSS"),
    true,
    "existing DB source entries must be preserved"
  );
  assert.equal(
    stored.searches.some((source) => source.provider === "RemoteVibeCodingJobs"),
    true,
    "generated DB source entries must be merged in"
  );
  assert.deepEqual(
    result.sourcedScan.location_filter,
    result.searchSources.location_filter,
    "the scanner-consumed config must receive the generated location policy"
  );
  assert.equal(result.sourcedScan.location_filter.block.includes("India"), true);
});

test("prepareFirstSearchSources replaces stale country blocks when remote scope becomes worldwide", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);

  const homeCountry = await prepareFirstSearchSources({ repoRoot, env: {} });
  assert.equal(homeCountry.searchSources.location_filter.block.includes("India"), true);

  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: { location: { remote: true, remote_scope: "worldwide" } },
  });
  const worldwide = await prepareFirstSearchSources({ repoRoot, env: {} });

  assert.deepEqual(worldwide.searchSources.location_filter.block, []);
  assert.deepEqual(worldwide.sourcedScan.location_filter.block, []);
});

test("first search parks with an actionable location error before creating a live run", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: { location: "" },
      location: {
        home: "",
        remote: false,
        hybrid: false,
        onsite: false,
        relocation: [],
      },
    },
  });

  const result = await startFirstSearchRun({ repoRoot, env: {} });

  assert.equal(result.ok, true);
  assert.equal(result.parked, true);
  assert.equal(result.run.status, "not_started");
  assert.equal(result.run.error.code, "SEARCH_LOCATION_REQUIRED");
  assert.match(result.run.error.message, /add your location|remote/i);
  assert.equal(sourcingRunLatest({ repoRoot, purpose: "first-search" }).run, null);
});

test("prepareFirstSearchSources only re-syncs stored entries owned by the domain gate", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  const storedRemoteOk = {
    provider: "remoteok",
    label: "Stored RemoteOK label",
    source_type: "board",
    url: "https://remoteok.com/api",
    enabled: false,
    enabled_reason: "domain-gate",
    stored_only: "preserve me",
  };
  const storedUserOwned = {
    provider: "remotive",
    label: "Stored Remotive label",
    source_type: "board",
    url: "https://remotive.com/api/remote-jobs",
    enabled: false,
    stored_only: "user choice",
  };
  const orphanedMarker = {
    provider: "custom",
    label: "Retired domain-gated board",
    source_type: "board",
    url: "https://boards.example.test/retired",
    enabled: false,
    enabled_reason: "domain-gate",
    stored_only: "no generated counterpart",
  };
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      title_filter: {},
      location_filter: null,
      searches: [storedRemoteOk, storedUserOwned, orphanedMarker],
      tracked_companies: [],
      source_catalog: {},
    },
  });

  await prepareFirstSearchSources({ repoRoot, env: {} });

  const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data.searches;
  assert.deepEqual(
    stored.find((source) => source.url === storedRemoteOk.url),
    { ...storedRemoteOk, enabled: true },
    "the generated tech gate may update enabled but must preserve every other stored field"
  );
  assert.deepEqual(
    stored.find((source) => source.url === storedUserOwned.url),
    storedUserOwned,
    "an unmarked entry is user-owned and must stay disabled"
  );
  assert.deepEqual(
    stored.find((source) => source.url === orphanedMarker.url),
    orphanedMarker,
    "a marked entry without a generated counterpart must stay untouched"
  );
});

test('prepareFirstSearchSources reconciles a legacy machine-generated "AI engineer" RemoteVibeCodingJobs/Wellfound entry instead of keeping it forever', async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  // Override targeting with a title that produces a distinct slug/URL from the
  // stale "AI engineer" literal below, so a survived legacy entry is
  // distinguishable from a freshly regenerated one rather than coincidentally
  // slugifying to the same URL.
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Platform",
          priority: "primary",
          titles: ["Platform Reliability Engineer"],
        },
      ],
    },
  });

  const legacyRemoteVibeCodingJobs = {
    provider: "RemoteVibeCodingJobs",
    source_type: "url-query",
    label: "Remote Vibe Coding Jobs",
    query: "AI engineer",
    rssUrl: "https://remotevibecodingjobs.com/feed.xml",
    enabled: true,
  };
  const legacyWellfoundUrl = buildWellfoundUrl({
    role: "AI engineer",
    remote: true,
  });
  const legacyWellfound = {
    provider: "Wellfound",
    source_type: "browser",
    label: "Wellfound",
    url: legacyWellfoundUrl,
    enabled: true,
  };
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      title_filter: {},
      location_filter: null,
      searches: [legacyRemoteVibeCodingJobs, legacyWellfound],
      tracked_companies: [],
      source_catalog: {},
    },
  });

  const result = await prepareFirstSearchSources({ repoRoot, env: {} });

  const stored = result.searchSources.searches;
  assert.equal(
    stored.some(
      (source) => source.provider === "RemoteVibeCodingJobs" && source.query === "AI engineer"
    ),
    false,
    "the legacy hardcoded RemoteVibeCodingJobs query must not survive the merge"
  );
  assert.equal(
    stored.some((source) => source.provider === "Wellfound" && source.url === legacyWellfoundUrl),
    false,
    "the legacy hardcoded Wellfound URL must not survive the merge"
  );
  assert.equal(
    stored.some(
      (source) =>
        source.provider === "RemoteVibeCodingJobs" &&
        source.query === "Platform Reliability Engineer"
    ),
    true,
    "the freshly generated title-derived RemoteVibeCodingJobs entry must take its place"
  );
  assert.equal(
    stored.some(
      (source) =>
        source.provider === "Wellfound" &&
        source.url ===
          buildWellfoundUrl({
            role: "Platform Reliability Engineer",
            remote: true,
          })
    ),
    true,
    "the freshly generated title-derived Wellfound entry must take its place"
  );
});

test("prepareFirstSearchSources uses AI domain hints to promote a bare tracked company", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  setTrackedCompanies(repoRoot, ["Neutral Labs"]);
  const calls = [];
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(url);
    return new Response(
      '<html><a href="https://203.0.113.11/jobs.lever.co/neutral-labs">Jobs</a></html>'
    );
  };

  const result = await prepareFirstSearchSources({
    repoRoot,
    env: aiRouteEnv(),
    fetchImpl,
    call: async (options) => {
      calls.push(options);
      return domainHintResponse([
        { name: "Neutral Labs", domain_hint: "https://203.0.113.10/careers" },
      ]);
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(fetchCalls, ["https://203.0.113.10/careers"]);
  assert.deepEqual(result.companyBoardResolution.aiHintFill, {
    requested: 1,
    hinted: 1,
    resolved: 1,
  });
  assert.equal(result.companyBoardResolution.promoted, 1);
  assert.deepEqual(result.sourcedScan.tracked_companies, [
    {
      name: "Neutral Labs",
      careers_url: "https://203.0.113.11/jobs.lever.co/neutral-labs",
    },
  ]);
  assert.deepEqual(
    sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies,
    result.sourcedScan.tracked_companies
  );
});

test("prepareFirstSearchSources skips AI rescue after a cache-hinted company attempt", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  setTrackedCompanies(repoRoot, ["Cached Board Co", "Bare Name Co"]);
  companyBoardResolutionUpsert({
    repoRoot,
    resolution: cachedSupportedBoard("Cached Board Co", "cached-board-co"),
  });
  let aiCalled = false;

  const result = await prepareFirstSearchSources({
    repoRoot,
    env: aiRouteEnv(),
    fetchImpl: async () => {
      throw new Error("fresh cached board must not fetch");
    },
    call: async () => {
      aiCalled = true;
      return domainHintResponse([]);
    },
  });

  assert.equal(aiCalled, false);
  assert.equal(result.companyBoardResolution.attempted, 1);
  assert.equal(result.companyBoardResolution.aiHintFill, undefined);
});

test("prepareFirstSearchSources skips AI rescue when no companies are tracked", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  let aiCalled = false;

  const result = await prepareFirstSearchSources({
    repoRoot,
    env: aiRouteEnv(),
    call: async () => {
      aiCalled = true;
      return domainHintResponse([]);
    },
  });

  assert.equal(aiCalled, false);
  assert.deepEqual(result.companyBoardResolution, {
    attempted: 0,
    resolved: 0,
    promoted: 0,
  });
});

test("prepareFirstSearchSources degrades gracefully when AI domain-hint fill fails", async () => {
  for (const [label, response] of [
    ["throws", new Error("provider unavailable")],
    ["returns garbage", "not-json"],
  ]) {
    const repoRoot = tempRepo();
    markSearchReady(repoRoot);
    setTrackedCompanies(repoRoot, [`${label} Co`]);

    const result = await prepareFirstSearchSources({
      repoRoot,
      env: aiRouteEnv(),
      fetchImpl: async () => {
        throw new Error("no hinted company should reach the resolver");
      },
      call: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
    });

    assert.deepEqual(result.companyBoardResolution.aiHintFill, {
      requested: 1,
      hinted: 0,
      resolved: 0,
    });
    assert.equal(result.companyBoardResolution.promoted, 0);
    assert.deepEqual(result.sourcedScan.tracked_companies, []);
  }
});

test("prepareFirstSearchSources caps the AI rescue prompt at 20 bare company names", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  setTrackedCompanies(
    repoRoot,
    Array.from({ length: 25 }, (_, index) => `Candidate Company ${index + 1}`)
  );
  const calls = [];

  const result = await prepareFirstSearchSources({
    repoRoot,
    env: aiRouteEnv(),
    call: async (options) => {
      calls.push(options);
      return domainHintResponse([]);
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(result.companyBoardResolution.aiHintFill.requested, 20);
  const prompt = calls[0].messages[0].content;
  const promptInput = JSON.parse(prompt.slice(prompt.indexOf("{")));
  assert.equal(promptInput.companies.length, 20);
  assert.equal(promptInput.companies.at(-1), "Candidate Company 20");
  assert.equal(promptInput.companies.includes("Candidate Company 21"), false);
});

test("countDeterministicSources counts RSS, supported boards, and ATS while skipping other enabled searches", () => {
  const counts = countDeterministicSources({
    searchSources: {
      searches: [
        {
          source_type: "rss",
          rssUrl: "https://example.test/jobs.xml",
          enabled: true,
        },
        {
          source_type: "browser",
          url: "https://hiring.cafe/search?q=ai",
          enabled: true,
        },
        {
          source_type: "auth",
          url: "https://www.linkedin.com/jobs/search",
          enabled: true,
        },
        { url: "https://example.test/jobs?query=ai", enabled: true },
        { source_type: "board", provider: "RemoteOK", enabled: true },
        {
          source_type: "ats",
          provider: "bamboohr",
          url: "https://acme.bamboohr.com/careers",
          enabled: true,
        },
        { source_type: "board", provider: "remotive", enabled: false },
        { source_type: "board", provider: "unknown", enabled: true },
        {
          source_type: "rss",
          rssUrl: "https://example.test/off.xml",
          enabled: false,
        },
      ],
    },
    sourcedScan: {
      tracked_companies: [
        { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
        { name: "Beta", careers_url: "https://job-boards.greenhouse.io/beta" },
        {
          name: "Custom command",
          provider: "manual-provider",
          careers_url: "https://example.test/jobs",
        },
      ],
    },
  });

  assert.deepEqual(counts, {
    attempted: 5,
    rss: 1,
    boards: 2,
    supportedAtsCompanies: 2,
    skipped: 4,
  });
});

test("countDeterministicSources accepts sources as the search list key", () => {
  const counts = countDeterministicSources({
    searchSources: {
      sources: [
        { source_type: "board", provider: "workingnomads", enabled: true },
        {
          source_type: "rss",
          rssUrl: "https://example.test/jobs.xml",
          enabled: true,
        },
      ],
    },
  });

  assert.deepEqual(counts, {
    attempted: 2,
    rss: 1,
    boards: 1,
    supportedAtsCompanies: 0,
    skipped: 0,
  });
});

test("failed first-search can retry as fresh work after deterministic source setup is fixed", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot, { domain: "operations" });
  seedNoDeterministicSources(repoRoot);

  const failed = await startFirstSearchRun({ repoRoot, env: {} });
  assert.equal(failed.reused, false);
  assert.equal(failed.run.status, "failed");
  assert.equal(failed.run.error.code, "NO_DETERMINISTIC_SOURCES");

  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      title_filter: {},
      location_filter: null,
      searches: [
        {
          label: "Fixed RSS",
          source_type: "rss",
          rssUrl: "https://example.test/jobs.xml",
          enabled: true,
        },
      ],
      tracked_companies: [],
      source_catalog: {},
    },
  });

  const retry = await startFirstSearchRun({
    repoRoot,
    env: {},
    retryFailed: true,
  });
  assert.equal(retry.reused, false);
  assert.equal(retry.run.status, "running");
  assert.notEqual(retry.run.id, failed.run.id);
  assert.equal(retry.run.metadata.retryOf, failed.run.id);
});

test("first-search completion is reused only while targeting and source inputs are unchanged", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      title_filter: {},
      location_filter: null,
      searches: [
        {
          label: "Stable RSS",
          source_type: "rss",
          rssUrl: "https://example.test/jobs.xml",
          enabled: true,
        },
      ],
      tracked_companies: [],
      source_catalog: {},
    },
  });

  const first = await startFirstSearchRun({ repoRoot, env: {} });
  const afterFirstPreparation = {
    searchSources: sourceConfigGet({ repoRoot, name: "search-sources" }).data,
    sourcedScan: sourceConfigGet({ repoRoot, name: "sourced-scan" }).data,
  };
  sourcingRunComplete({
    repoRoot,
    id: first.run.id,
    summary: { scanned: 1, new: 0, errors: [], offers: [] },
  });

  const unchanged = await startFirstSearchRun({ repoRoot, env: {} });
  assert.deepEqual(
    {
      searchSources: sourceConfigGet({ repoRoot, name: "search-sources" }).data,
      sourcedScan: sourceConfigGet({ repoRoot, name: "sourced-scan" }).data,
    },
    afterFirstPreparation,
    "equivalent preparation must leave source inputs unchanged"
  );
  assert.equal(unchanged.reused, true);
  assert.equal(unchanged.run.id, first.run.id);
  assert.equal(
    latestSourcingRunForUi({ repoRoot, env: {}, purpose: "first-search" }).inputsChanged,
    false
  );

  saveSearchPrompts({
    repoRoot,
    prompts: [{ text: "Find matching engineering roles" }],
    defaultSource: "generated",
  });
  assert.equal(
    latestSourcingRunForUi({ repoRoot, env: {}, purpose: "first-search" }).inputsChanged,
    false,
    "AI prompt cache writes are not deterministic sourcing inputs"
  );

  const watermarkedSources = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      ...watermarkedSources,
      searches: watermarkedSources.searches.map((source, index) =>
        index === 0
          ? {
              ...source,
              recency: { ...(source.recency || {}), lastRunAt: "2026-08-25T12:00:00.000Z" },
            }
          : source
      ),
    },
  });
  const watermarkOnly = await startFirstSearchRun({ repoRoot, env: {} });
  assert.equal(watermarkOnly.reused, true);
  assert.equal(watermarkOnly.run.id, first.run.id);

  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "AI builder", titles: ["Senior AI Engineer"] }],
    },
  });
  assert.equal(
    latestSourcingRunForUi({ repoRoot, env: {}, purpose: "first-search" }).inputsChanged,
    true
  );
  const changedTargeting = await startFirstSearchRun({ repoRoot, env: {} });
  assert.equal(changedTargeting.reused, false);
  assert.notEqual(changedTargeting.run.id, first.run.id);
  assert.notEqual(
    changedTargeting.run.metadata.inputFingerprint,
    first.run.metadata.inputFingerprint
  );

  sourcingRunComplete({
    repoRoot,
    id: changedTargeting.run.id,
    summary: { scanned: 1, new: 0, errors: [], offers: [] },
  });
  const currentSearchSources = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      ...currentSearchSources,
      searches: [
        ...currentSearchSources.searches,
        {
          label: "New RSS",
          source_type: "rss",
          rssUrl: "https://new.example.test/jobs.xml",
          enabled: true,
        },
      ],
    },
  });

  const changedSources = await startFirstSearchRun({ repoRoot, env: {} });
  assert.equal(changedSources.reused, false);
  assert.notEqual(changedSources.run.id, changedTargeting.run.id);
  assert.notEqual(
    changedSources.run.metadata.inputFingerprint,
    changedTargeting.run.metadata.inputFingerprint
  );
});

test("zero-result scans with attempted deterministic sources complete with zero-result summary", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot, { domain: "operations" });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      title_filter: {},
      location_filter: null,
      searches: [
        {
          label: "Empty RSS",
          source_type: "rss",
          rssUrl: "https://example.test/empty.xml",
          enabled: true,
        },
      ],
      tracked_companies: [],
      source_catalog: {},
    },
  });

  const start = await startFirstSearchRun({ repoRoot, env: {} });
  assert.equal(start.run.status, "running");

  await runFirstSearchInBackground({
    repoRoot,
    env: {},
    runId: start.run.id,
    fetchImpl: async (url) =>
      new URL(url).hostname === "www.arbeitnow.com"
        ? new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response('<?xml version="1.0"?><rss><channel></channel></rss>', {
            status: 200,
          }),
  });

  const latest = sourcingRunLatest({ repoRoot, purpose: "first-search" });
  assert.equal(latest.run.status, "completed");
  assert.equal(latest.run.summary.new, 0);
  assert.equal(latest.run.summary.zeroResults, true);
  assert.equal(latest.run.summary.deterministicSources.attempted, 2);
});

test("completed search runs preserve bounded rejection evidence", async () => {
  const repoRoot = tempRepo();
  sourceConfigPut({
    repoRoot,
    name: "sourced-scan",
    data: {
      title_filter: { positive: [], negative: ["Sales"] },
      location_filter: null,
      tracked_companies: [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }],
    },
  });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: { title_filter: {}, location_filter: null, searches: [] },
  });
  const started = sourcingRunStart({ repoRoot, purpose: "first-search" });

  await runFirstSearchInBackground({
    repoRoot,
    env: {},
    runId: started.run.id,
    fetchImpl: async () =>
      new Response(
        JSON.stringify([
          {
            text: "Sales Engineer",
            hostedUrl: "https://jobs.lever.co/acme/sales-engineer",
            categories: { location: "Remote - US" },
            descriptionBodyPlain: "Customer-facing sales role.",
          },
        ]),
        { status: 200 }
      ),
  });

  const latest = sourcingRunLatest({ repoRoot, purpose: "first-search" });
  assert.equal(latest.run.status, "completed");
  assert.equal(latest.run.summary.reasonCounts.titleBlocker, 1);
  assert.deepEqual(latest.run.summary.rejectionSamples.title, [
    {
      company: "Acme",
      title: "Sales Engineer",
      location: "Remote - US",
      reason: "title-negative-blocker",
      kind: "blocker",
      provider: "lever",
    },
  ]);
});

test("background first search publishes a growing found count before completion", async () => {
  const repoRoot = tempRepo();
  const betaResponse = deferred();
  const betaRequested = deferred();
  let background;
  try {
    sourceConfigPut({
      repoRoot,
      name: "sourced-scan",
      data: {
        title_filter: { positive: [], negative: [] },
        location_filter: null,
        tracked_companies: [
          { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
          { name: "Beta", careers_url: "https://jobs.lever.co/beta" },
        ],
      },
    });
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: { title_filter: {}, location_filter: null, searches: [] },
    });
    const started = sourcingRunStart({ repoRoot, purpose: "first-search" });

    background = runFirstSearchInBackground({
      repoRoot,
      env: {},
      runId: started.run.id,
      fetchImpl: async (url) => {
        if (String(url).includes("/acme")) {
          return leverResponse({
            title: "Applied AI Engineer",
            url: "https://jobs.lever.co/acme/applied-ai",
          });
        }
        if (String(url).includes("/beta")) {
          betaRequested.resolve();
          return betaResponse.promise;
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    await betaRequested.promise;
    const deadline = Date.now() + 1000;
    let running;
    do {
      running = latestSourcingRunForUi({
        repoRoot,
        purpose: "first-search",
      }).run;
      if (running.progress?.foundCount === 1) break;
      await new Promise((resolve) => setImmediate(resolve));
    } while (Date.now() < deadline);
    assert.equal(running.status, "running");
    assert.equal(running.progress.foundCount, 1);
    assert.equal(running.progress.offerCount, 1);
    assert.equal(running.progress.completedSources, 1);
    assert.equal(running.progress.totalSources, 2);

    betaResponse.resolve(
      leverResponse({
        title: "Identity Automation Engineer",
        url: "https://jobs.lever.co/beta/identity-automation",
      })
    );
    await background;

    const completed = sourcingRunLatest({
      repoRoot,
      purpose: "first-search",
    }).run;
    assert.equal(completed.status, "completed");
    assert.equal(completed.progress.foundCount, 2);
    assert.equal(completed.progress.foundCount, completed.summary.new);
    assert.equal(completed.progress.offerCount, completed.summary.offerCount);
    assert.equal(completed.progress.completedSources, 2);
  } finally {
    betaResponse.resolve(new Response("[]", { status: 200 }));
    await background?.catch(() => {});
  }
});

test("background sourcing heartbeats while quiet and stays resumable when the app shuts down", async () => {
  const repoRoot = tempRepo();
  const requested = deferred();
  sourceConfigPut({
    repoRoot,
    name: "sourced-scan",
    data: {
      title_filter: { positive: [], negative: [] },
      location_filter: null,
      tracked_companies: [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }],
    },
  });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: { title_filter: {}, location_filter: null, searches: [] },
  });
  const started = sourcingRunStart({ repoRoot, purpose: "manual-search" });
  const controller = new AbortController();
  const stopped = new Error("CareerRat stopped this search because the app closed.");
  stopped.code = "SOURCING_RUN_SERVER_STOPPED";

  const background = runFirstSearchInBackground({
    repoRoot,
    env: {},
    runId: started.run.id,
    signal: controller.signal,
    heartbeatMs: 5,
    fetchImpl: async (_url, init = {}) => {
      requested.resolve();
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  });

  await requested.promise;
  await new Promise((resolve) => setTimeout(resolve, 15));
  const heartbeat = sourcingRunLatest({ repoRoot, purpose: "manual-search" }).run;
  assert.equal(heartbeat.status, "running");
  assert.equal(heartbeat.progress.completedSources, 0);
  assert.equal(heartbeat.progress.totalSources, 1);

  controller.abort(stopped);
  await assert.rejects(background, (error) => error?.code === "SOURCING_RUN_SERVER_STOPPED");
  const resumable = sourcingRunLatest({ repoRoot, purpose: "manual-search" }).run;
  assert.equal(resumable.status, "running");
  assert.equal(resumable.id, started.run.id);
});

test("a superseded background search cannot write stale watermarks, offers, or completion", async () => {
  const repoRoot = tempRepo();
  const oldResponse = deferred();
  const oldRequested = deferred();
  sourceConfigPut({
    repoRoot,
    name: "sourced-scan",
    data: {
      title_filter: { positive: [], negative: [] },
      location_filter: null,
      tracked_companies: [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }],
    },
  });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: { title_filter: {}, location_filter: null, searches: [] },
  });
  const first = sourcingRunStart({
    repoRoot,
    purpose: "first-search",
    inputFingerprint: "inputs-v1",
  });
  const background = runFirstSearchInBackground({
    repoRoot,
    env: {},
    runId: first.run.id,
    fetchImpl: async () => {
      oldRequested.resolve();
      return oldResponse.promise;
    },
  });

  await oldRequested.promise;
  const current = sourceConfigGet({ repoRoot, name: "sourced-scan" }).data;
  sourceConfigPut({
    repoRoot,
    name: "sourced-scan",
    data: {
      ...current,
      tracked_companies: [
        ...current.tracked_companies,
        { name: "Beta", careers_url: "https://jobs.lever.co/beta" },
      ],
    },
  });
  const replacement = sourcingRunStart({
    repoRoot,
    purpose: "first-search",
    inputFingerprint: "inputs-v2",
  });
  oldResponse.resolve(
    leverResponse({
      title: "Applied AI Engineer",
      url: "https://jobs.lever.co/acme/applied-ai",
    })
  );

  await assert.rejects(background, { code: "SOURCING_RUN_SUPERSEDED" });
  const after = sourceConfigGet({ repoRoot, name: "sourced-scan" }).data;
  assert.deepEqual(
    after.tracked_companies.map(({ name }) => name),
    ["Acme", "Beta"]
  );
  assert.equal(after.tracked_companies[0].lastRunAt, undefined);
  assert.equal(
    openDb({ repoRoot }).prepare("SELECT COUNT(*) AS count FROM sourced").get().count,
    0
  );
  const latest = sourcingRunLatest({ repoRoot, purpose: "first-search" }).run;
  assert.equal(latest.id, replacement.run.id);
  assert.equal(latest.status, "running");
});
