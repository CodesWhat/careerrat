import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  candidateConfigPatch,
  candidateSetupInitialize,
  sourceConfigGet,
  sourceConfigPut,
} from "../src/core/db/verbs.mjs";
import { healSearchSourceConfig } from "../src/core/onboarding/first-search-run.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-source-self-heal-"));
  cleanupRoots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

function seedCandidate(repoRoot, titles) {
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Primary", priority: "primary", titles }],
      tracked_companies: [],
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: { candidate: { domain: "" }, location: {} },
  });
  sourceConfigPut({
    repoRoot,
    name: "sourced-scan",
    data: { title_filter: {}, location_filter: null, tracked_companies: [] },
  });
}

function preFixSearchSources() {
  return {
    title_filter: { positive: [], negative: [] },
    location_filter: { always_allow: [], allow: [], block: [] },
    searches: [
      {
        provider: "remoteok",
        label: "Remote OK",
        source_type: "board",
        url: "https://remoteok.com/api",
        enabled: false,
      },
      {
        provider: "remotive",
        label: "Remotive",
        source_type: "board",
        url: "https://remotive.com/api/remote-jobs",
        enabled: false,
      },
      {
        provider: "workingnomads",
        label: "Working Nomads",
        source_type: "board",
        url: "https://www.workingnomads.com/jobsapi/job/_search",
        enabled: false,
      },
    ],
    tracked_companies: [],
    source_catalog: {},
  };
}

function putPreFixSearchSources(repoRoot) {
  sourceConfigPut({ repoRoot, name: "search-sources", data: preFixSearchSources() });
}

function sourceConfigUpdatedAt(repoRoot) {
  return openDb({ repoRoot })
    .prepare("SELECT updated_at FROM candidate_source_configs WHERE name = ?")
    .get("search-sources").updated_at;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tech-majority pre-fix source config heals once and persists deterministic sources", () => {
  const repoRoot = tempRepo();
  seedCandidate(repoRoot, [
    "Applied AI Engineer",
    "Forward Deployed Engineer",
    "Solutions Engineer",
  ]);
  putPreFixSearchSources(repoRoot);

  const first = healSearchSourceConfig({ repoRoot, env: {} });
  assert.equal(first.healed, true);
  assert.ok(first.deterministicSources.attempted > 0);
  assert.ok(first.deterministicSources.rss > 0);
  assert.equal(
    first.searchSources.searches.some(
      (source) => source.provider === "RemoteVibeCodingJobs" && source.enabled !== false
    ),
    true
  );

  const storedAfterFirst = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
  const updatedAfterFirst = sourceConfigUpdatedAt(repoRoot);
  const second = healSearchSourceConfig({ repoRoot, env: {} });

  assert.equal(second.healed, false);
  assert.deepEqual(second.searchSources, storedAfterFirst);
  assert.deepEqual(sourceConfigGet({ repoRoot, name: "search-sources" }).data, storedAfterFirst);
  assert.equal(sourceConfigUpdatedAt(repoRoot), updatedAfterFirst);
});

test("non-tech pre-fix generated boards heal to one enabled canonical row each and converge", () => {
  const repoRoot = tempRepo();
  seedCandidate(repoRoot, ["Registered Nurse", "Nurse Practitioner", "Clinical Manager"]);
  putPreFixSearchSources(repoRoot);

  const first = healSearchSourceConfig({ repoRoot, env: {} });
  assert.equal(first.deterministicSources.attempted, 9);
  assert.equal(first.deterministicSources.rss, 0);
  assert.equal(first.deterministicSources.boards, 6);
  assert.equal(first.deterministicSources.browser, 3);
  assert.deepEqual(
    first.searchSources.searches
      .filter((source) =>
        ["remoteok", "remotive", "workingnomads", "himalayas", "jobicy"].includes(source.provider)
      )
      .map(({ provider, url, enabled, enabled_reason }) => ({
        provider,
        url,
        enabled,
        enabled_reason,
      })),
    [
      {
        provider: "remoteok",
        url: "https://remoteok.com/api",
        enabled: true,
        enabled_reason: "domain-gate",
      },
      {
        provider: "remotive",
        url: "https://remotive.com/api/remote-jobs",
        enabled: true,
        enabled_reason: "domain-gate",
      },
      {
        provider: "workingnomads",
        url: "https://www.workingnomads.com/api/exposed_jobs/",
        enabled: true,
        enabled_reason: "domain-gate",
      },
      {
        provider: "himalayas",
        url: "https://himalayas.app/jobs/api?limit=50",
        enabled: true,
        enabled_reason: "domain-gate",
      },
      {
        provider: "jobicy",
        url: "https://jobicy.com/api/v2/remote-jobs?count=50",
        enabled: true,
        enabled_reason: "domain-gate",
      },
    ]
  );
  assert.equal(
    first.searchSources.searches.some(
      (source) =>
        source.provider === "arbeitnow" &&
        source.source_type === "board" &&
        source.enabled !== false &&
        source.max_pages === 1
    ),
    true,
    "the heal must add the bounded domain-neutral baseline"
  );

  const storedAfterFirst = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
  const updatedAfterFirst = sourceConfigUpdatedAt(repoRoot);
  const second = healSearchSourceConfig({ repoRoot, env: {} });
  assert.equal(second.healed, false);
  assert.equal(second.deterministicSources.attempted, 9);
  assert.deepEqual(second.searchSources, storedAfterFirst);
  assert.equal(sourceConfigUpdatedAt(repoRoot), updatedAfterFirst);
});
