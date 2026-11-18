// tests/search-zero-result-contract.test.mjs
// CR116 slice F: pin how a search run reports health, end to end through the
// real scan entry point (runSourcedScan for the summary, scripts/scan-sourced.mjs
// as a child process for the exit code). The rules under test live in
// src/core/search/search-health.mjs; this file proves the scan wires them up:
//   - every source fails            -> failed, exit 3
//   - failed share >= 10%, < 50%    -> degraded, exit 0
//   - all read, jobs found          -> ok, exit 0
//   - all read, zero jobs           -> ok (an empty result is not an error), exit 0
//   - browser-only sources          -> left out of "attempted", listed once

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSourcedScan } from "../scripts/scan-sourced.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { candidateSetupInitialize, sourceConfigPut } from "../src/core/db/verbs.mjs";
import {
  SEARCH_NOT_SEARCHABLE_BROWSER_REASON,
  summarizeSearchHealth,
} from "../src/core/search/search-health.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function slugsFor(count) {
  return Array.from({ length: count }, (_, index) => `co${index}`);
}

function writeConfig(dir, slugs) {
  mkdirSync(join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, "workspace"), { recursive: true });
  const configPath = join(dir, "config/sourced-scan.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      title_filter: { positive: [], negative: [] },
      location_filter: null,
      tracked_companies: slugs.map((slug) => ({
        name: slug,
        careers_url: `https://jobs.lever.co/${slug}`,
      })),
    })
  );
  return configPath;
}

// Lever stub: slugs in `fail` throw, slugs in `empty` answer with no jobs,
// everything else answers with one job.
function leverStub({ fail = [], empty = [] } = {}) {
  return async (url) => {
    const slug = new URL(String(url)).pathname.split("/").filter(Boolean).at(-1);
    if (fail.includes(slug)) throw new TypeError("fetch failed");
    if (empty.includes(slug)) return new Response("[]", { status: 200 });
    return new Response(
      JSON.stringify([
        {
          text: `Staff Platform Engineer ${slug}`,
          hostedUrl: `https://jobs.lever.co/${slug}/req-${slug}`,
          categories: { location: "Remote - US" },
          descriptionPlain: "Own platform infrastructure, identity, and automation systems.",
        },
      ]),
      { status: 200 }
    );
  };
}

async function scan({ count, fail = [], empty = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-zero-result-"));
  try {
    const slugs = slugsFor(count);
    const configPath = writeConfig(dir, slugs);
    return await runSourcedScan({
      repoRoot: dir,
      fetchImpl: leverStub({
        fail: fail.map((i) => slugs[i]),
        empty: empty.map((i) => slugs[i]),
      }),
      configPath,
      write: false,
    });
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
}

// The CLI pins its repo root to wherever the script file sits. Link the script,
// src and node_modules into a scratch dir and keep symlinks unresolved so the
// scan runs against the scratch workspace and a preloaded fetch stub, with no
// network.
function runCli({ count, fail = [], empty = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-zero-result-cli-"));
  try {
    const slugs = slugsFor(count);
    const configPath = writeConfig(dir, slugs);
    mkdirSync(join(dir, "scripts"));
    symlinkSync(join(REPO_ROOT, "scripts/scan-sourced.mjs"), join(dir, "scripts/scan-sourced.mjs"));
    symlinkSync(join(REPO_ROOT, "src"), join(dir, "src"));
    symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
    symlinkSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
    const preload = join(dir, "stub-fetch.mjs");
    writeFileSync(
      preload,
      `const fail = JSON.parse(process.env.STUB_FAIL);
const empty = JSON.parse(process.env.STUB_EMPTY);
globalThis.fetch = async (url) => {
  const slug = new URL(String(url)).pathname.split("/").filter(Boolean).at(-1);
  if (fail.includes(slug)) throw new TypeError("fetch failed");
  if (empty.includes(slug)) return new Response("[]", { status: 200 });
  return new Response(JSON.stringify([{
    text: "Staff Platform Engineer " + slug,
    hostedUrl: "https://jobs.lever.co/" + slug + "/req-" + slug,
    categories: { location: "Remote - US" },
    descriptionPlain: "Own platform infrastructure, identity, and automation systems.",
  }]), { status: 200 });
};
`
    );
    const result = spawnSync(
      process.execPath,
      [
        "--preserve-symlinks",
        "--preserve-symlinks-main",
        "--import",
        preload,
        join(dir, "scripts/scan-sourced.mjs"),
        "--config",
        configPath,
      ],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          STUB_FAIL: JSON.stringify(fail.map((i) => slugs[i])),
          STUB_EMPTY: JSON.stringify(empty.map((i) => slugs[i])),
        },
      }
    );
    return { status: result.status, stderr: result.stderr, summary: JSON.parse(result.stdout) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MATRIX = [
  {
    name: "every source fails",
    run: { count: 3, fail: [0, 1, 2] },
    status: "failed",
    exit: 3,
    failed: 3,
    readable: 3,
  },
  {
    name: "half the sources fail",
    run: { count: 4, fail: [0, 1] },
    status: "failed",
    exit: 3,
    failed: 2,
    readable: 4,
  },
  {
    name: "some fail, under the failed threshold",
    run: { count: 4, fail: [0] },
    status: "degraded",
    exit: 0,
    failed: 1,
    readable: 4,
  },
  {
    name: "all succeed with jobs",
    run: { count: 3 },
    status: "ok",
    exit: 0,
    failed: 0,
    readable: 3,
  },
  {
    name: "all succeed but return zero jobs",
    run: { count: 3, empty: [0, 1, 2] },
    status: "ok",
    exit: 0,
    failed: 0,
    readable: 3,
    zeroJobs: true,
  },
];

for (const row of MATRIX) {
  test(`zero-result contract (summary): ${row.name} -> ${row.status}`, async () => {
    const summary = await scan(row.run);
    assert.equal(summary.health.status, row.status);
    assert.equal(summary.health.failed, row.failed);
    assert.equal(summary.health.readable, row.readable);
    assert.equal(summary.attemptedSources, row.run.count);
    assert.equal(summary.errors.length, row.failed);
    if (row.zeroJobs) {
      assert.equal(summary.new, 0);
      assert.deepEqual(summary.offers, []);
      assert.equal(summary.health.failedShare, 0);
      assert.equal(summary.health.warningCount, 0);
      assert.match(summary.health.message, /^All 3 sources read/);
    }
  });

  test(`zero-result contract (CLI): ${row.name} -> exit ${row.exit}`, () => {
    const { status, stderr, summary } = runCli(row.run);
    assert.equal(status, row.exit, stderr);
    assert.equal(summary.health.status, row.status);
    if (row.zeroJobs) assert.equal(summary.new, 0);
  });
}

test("zero-result contract: an empty answer is a successful read, not a failed or degraded one", async () => {
  const summary = await scan({ count: 1, empty: [0] });
  assert.equal(summary.health.status, "ok");
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.scanned, 0);
  assert.equal(summary.new, 0);
});

test("zero-result contract: browser-only sources are left out of attempted and listed once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-zero-result-browser-"));
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    mkdirSync(join(dir, "workspace"), { recursive: true });
    candidateSetupInitialize({ repoRoot: dir });
    sourceConfigPut({
      repoRoot: dir,
      name: "search-sources",
      data: {
        searches: [
          {
            label: "Example feed",
            source_type: "rss",
            rssUrl: "https://example.test/jobs.xml",
            enabled: true,
            recency: { mode: "since-last-run" },
          },
          {
            label: "Browser board",
            source_type: "browser",
            url: "https://boards.example.test/search?q=it",
            enabled: true,
          },
        ],
      },
    });
    const summary = await runSourcedScan({
      repoRoot: dir,
      write: true,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (url) => {
        assert.equal(String(url), "https://example.test/jobs.xml");
        return new Response("<rss><channel><title>No roles</title></channel></rss>", {
          status: 200,
        });
      },
    });
    assert.equal(summary.attemptedSources, 1);
    assert.equal(summary.health.attempted, 1);
    assert.equal(summary.health.readable, 1);
    assert.equal(summary.health.failed, 0);
    assert.equal(summary.health.skipped, 0);
    assert.equal(summary.health.notSearchable, 1);
    assert.equal(summary.health.status, "ok");
    assert.equal(summary.errors.length, 0);
    assert.deepEqual(summary.notSearchable, {
      count: 1,
      sources: [{ label: "Browser board", reason: SEARCH_NOT_SEARCHABLE_BROWSER_REASON }],
    });
    assert.equal(
      summary.sourceCoverage.filter((entry) => /Browser board/.test(JSON.stringify(entry))).length,
      0
    );
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zero-result contract: only browser-only sources means failed, nothing searched", () => {
  const health = summarizeSearchHealth({
    errors: [],
    attemptedSources: 0,
    notSearchable: { count: 1, sources: [{ label: "Browser board" }] },
  });
  assert.equal(health.status, "failed");
  assert.match(health.message, /^None of the 1 sources can be searched/);
});
