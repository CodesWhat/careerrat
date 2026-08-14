import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import {
  candidateArtifactPut,
  candidateConfigPatch,
  candidateSetupInitialize,
  companyBoardResolutionUpsert,
  sourceConfigGet,
  sourceConfigPut,
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
      location: { home: "New York, NY", remote: true, hybrid: true, onsite: false },
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

test("first search parks with an actionable location error before creating a live run", async () => {
  const repoRoot = tempRepo();
  markSearchReady(repoRoot);
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: { location: "" },
      location: { home: "", remote: false, hybrid: false, onsite: false, relocation: [] },
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
  assert.deepEqual(result.companyBoardResolution, { attempted: 0, resolved: 0, promoted: 0 });
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
        { source_type: "rss", rssUrl: "https://example.test/jobs.xml", enabled: true },
        { source_type: "browser", url: "https://hiring.cafe/search?q=ai", enabled: true },
        { source_type: "auth", url: "https://www.linkedin.com/jobs/search", enabled: true },
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
        { source_type: "rss", rssUrl: "https://example.test/off.xml", enabled: false },
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
        { source_type: "rss", rssUrl: "https://example.test/jobs.xml", enabled: true },
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

  const retry = await startFirstSearchRun({ repoRoot, env: {}, retryFailed: true });
  assert.equal(retry.reused, false);
  assert.equal(retry.run.status, "running");
  assert.notEqual(retry.run.id, failed.run.id);
  assert.equal(retry.run.metadata.retryOf, failed.run.id);
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
    fetchImpl: async () =>
      new Response('<?xml version="1.0"?><rss><channel></channel></rss>', { status: 200 }),
  });

  const latest = sourcingRunLatest({ repoRoot, purpose: "first-search" });
  assert.equal(latest.run.status, "completed");
  assert.equal(latest.run.summary.new, 0);
  assert.equal(latest.run.summary.zeroResults, true);
  assert.equal(latest.run.summary.deterministicSources.attempted, 1);
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

    const running = latestSourcingRunForUi({ repoRoot, purpose: "first-search" }).run;
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

    const completed = sourcingRunLatest({ repoRoot, purpose: "first-search" }).run;
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
