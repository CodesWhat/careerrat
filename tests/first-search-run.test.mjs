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
  sourceConfigGet,
  sourceConfigPut,
  sourcingRunLatest,
} from "../src/core/db/verbs.mjs";
import {
  countDeterministicSources,
  prepareFirstSearchSources,
  runFirstSearchInBackground,
  startFirstSearchRun,
} from "../src/core/onboarding/first-search-run.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-first-search-run-"));
  cleanupRoots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
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
});

test("countDeterministicSources separates fetchable RSS and supported ATS from skipped sources", () => {
  const counts = countDeterministicSources({
    searchSources: {
      searches: [
        { source_type: "rss", rssUrl: "https://example.test/jobs.xml", enabled: true },
        { source_type: "browser", url: "https://hiring.cafe/search?q=ai", enabled: true },
        { source_type: "auth", url: "https://www.linkedin.com/jobs/search", enabled: true },
        { url: "https://example.test/jobs?query=ai", enabled: true },
        { source_type: "rss", rssUrl: "https://example.test/off.xml", enabled: false },
      ],
    },
    sourcedScan: {
      tracked_companies: [
        { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
        { name: "Beta", careers_url: "https://job-boards.greenhouse.io/beta" },
      ],
    },
  });

  assert.deepEqual(counts, {
    attempted: 3,
    rss: 1,
    supportedAtsCompanies: 2,
    skipped: 3,
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
