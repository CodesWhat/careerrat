// tests/scan-sourced.test.mjs
// node:test suite for the M3 promotion of scripts/scan-sourced.mjs's
// orchestration into an exported, importable runSourcedScan() (see that
// file's own header comment). Covers:
//   - runSourcedScan() against a stubbed fetchImpl (no real network) —
//     summary shape, write/intake side effects, and no cross-call state
//     leakage between two different repoRoots (the refactor's main risk:
//     the old code cached candidate config in module-level variables tied to
//     a single fixed _scriptRoot).
//   - the CLI (main(), behind the import.meta.url entry guard) still parses
//     its flags and prints identically post-refactor — run for real as a
//     child process against the real repo with --company set to a name that
//     matches nothing, which also skips the search-sources.yml RSS scan (see
//     runSourcedScan's own `!companyFilter` guard), so this hits zero
//     network and stays fast/deterministic even though _scriptRoot always
//     resolves to the real installed script location.
//
// Does not re-test sourced-scanner.mjs's scoring/filtering rules — that's
// tests/sourced-scanner.test.mjs's job; this file only confirms the
// orchestration promotion didn't change behavior.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSourcedScan } from "../scripts/scan-sourced.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  candidateConfigPatch,
  candidateSetupInitialize,
  companyAtsUpsert,
  sourceConfigGet,
  sourceConfigPut,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { parseYaml, stringifyYaml } from "../src/core/profile/yaml.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-scan-sourced-"));
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  mkdirSync(join(repoRoot, "workspace"), { recursive: true });
  return repoRoot;
}

function writeSourcedScanConfig(repoRoot, overrides = {}) {
  const doc = {
    title_filter: { positive: [], negative: [] },
    location_filter: null,
    tracked_companies: [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }],
    ...overrides,
  };
  writeFileSync(join(repoRoot, "config/sourced-scan.json"), JSON.stringify(doc, null, 2));
}

function writeTargeting(repoRoot, keepSignals) {
  mkdirSync(join(repoRoot, "candidate"), { recursive: true });
  writeFileSync(
    join(repoRoot, "candidate/targeting.yml"),
    `${stringifyYaml({ keep_signals: keepSignals })}\n`
  );
}

function searchSourcesFixture() {
  return {
    searches: [
      {
        provider: "Example RSS",
        source_type: "rss",
        label: "Example feed",
        rssUrl: "https://example.test/jobs.xml",
        enabled: true,
        recency: { mode: "since-last-run" },
      },
    ],
  };
}

function writeSearchSourcesConfig(repoRoot, config = searchSourcesFixture()) {
  writeFileSync(join(repoRoot, "config/search-sources.yml"), `${stringifyYaml(config)}\n`);
}

// A single-job Lever fixture, matching tests/sourced-scanner.test.mjs's own
// Lever fixture shape.
function leverFetchStub(title = "Director of IT") {
  return async (url) => {
    if (String(url).includes("api.lever.co")) {
      return new Response(
        JSON.stringify([
          {
            text: title,
            hostedUrl: "https://jobs.lever.co/acme/abc",
            categories: { location: "Remote" },
            descriptionBodyPlain: "Own corporate IT, identity, endpoint, and automation.",
          },
        ]),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function rssFetchStub() {
  return async (url) => {
    assert.equal(String(url), "https://example.test/jobs.xml");
    return new Response(
      `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Example jobs</title>
    <item>
      <title>Acme — Director of IT (Remote)</title>
      <link>https://example.test/jobs/director-it</link>
      <description>Own corporate IT, identity, endpoint, and automation.</description>
      <guid>director-it</guid>
      <pubDate>Fri, 03 Jul 2026 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`,
      { status: 200 }
    );
  };
}

// ---------------------------------------------------------------------------
// runSourcedScan()
// ---------------------------------------------------------------------------

test("runSourcedScan returns the documented summary shape from a stubbed fetch", async () => {
  const repoRoot = tempRepo();
  try {
    writeSourcedScanConfig(repoRoot);
    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl: leverFetchStub(),
      write: false,
      intake: false,
    });
    assert.equal(summary.scanned, 1);
    assert.equal(summary.new, 1);
    assert.equal(summary.duplicates, 0);
    assert.equal(summary.invalid, 0);
    assert.ok(Array.isArray(summary.errors));
    assert.ok(Array.isArray(summary.offers));
    assert.equal(summary.offers.length, 1);
    const offer = summary.offers[0];
    assert.equal(offer.company, "Acme");
    assert.equal(offer.title, "Director of IT");
    assert.equal(typeof offer.score, "number");
    assert.equal(typeof offer.fit, "string");
    assert.equal(typeof offer.bodyChars, "number");
    assert.ok(!("bodyText" in offer), "bodyText should be stripped to bodyChars for output");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("write:true persists workspace/scan-results/sourced-<date>.json; write:false does not", async () => {
  const repoRoot = tempRepo();
  try {
    writeSourcedScanConfig(repoRoot);
    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl: leverFetchStub(),
      write: true,
      intake: false,
    });
    const date = new Date().toISOString().slice(0, 10);
    const outPath = userPath({ repoRoot }, `workspace/scan-results/sourced-${date}.json`);
    assert.ok(existsSync(outPath), "expected a persisted scan-results file");
    const written = JSON.parse(readFileSync(outPath, "utf8"));
    assert.deepEqual(written, summary);
    assert.match(summary.offers[0].artifacts.jd, /^workspace\/jobs\/acme-director-of-it-/);
    const jdText = readFileSync(userPath({ repoRoot }, summary.offers[0].artifacts.jd), "utf8");
    assert.match(jdText, /company: Acme/);
    assert.match(jdText, /role: Director of IT/);
    assert.match(jdText, /source: "?https:\/\/jobs\.lever\.co\/acme\/abc"?/);
    assert.match(jdText, /Own corporate IT, identity, endpoint, and automation\./);
    assert.ok(
      !existsSync(userPath({ repoRoot }, "workspace/intake")),
      "intake:false must not write intake"
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("intake:true renders workspace/intake/sourced-<date>.md", async () => {
  const repoRoot = tempRepo();
  try {
    writeSourcedScanConfig(repoRoot);
    await runSourcedScan({ repoRoot, fetchImpl: leverFetchStub(), write: false, intake: true });
    const date = new Date().toISOString().slice(0, 10);
    const outPath = userPath({ repoRoot }, `workspace/intake/sourced-${date}.md`);
    assert.ok(existsSync(outPath));
    assert.match(readFileSync(outPath, "utf8"), /Sourced Intake/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("no cross-call state leakage: two repoRoots with different targeting score independently", async () => {
  // The pre-refactor script cached candidate config in module-level state
  // computed once against a single fixed _scriptRoot. runSourcedScan() must
  // read fresh per call so two different repoRoots (or two requests against
  // the embedded server) never bleed scoring context into each other.
  const repoA = tempRepo();
  const repoB = tempRepo();
  try {
    writeSourcedScanConfig(repoA);
    writeSourcedScanConfig(repoB);
    writeTargeting(repoA, ["director of it"]);
    writeTargeting(repoB, ["something else entirely"]);

    const summaryA = await runSourcedScan({
      repoRoot: repoA,
      fetchImpl: leverFetchStub("Director of IT"),
      write: false,
      intake: false,
    });
    const summaryB = await runSourcedScan({
      repoRoot: repoB,
      fetchImpl: leverFetchStub("Director of IT"),
      write: false,
      intake: false,
    });

    // repoA's targeting keep-signal matches the offer title -> high base score.
    // repoB's targeting doesn't -> no keep-signal bump.
    assert.ok(
      summaryA.offers[0].score > summaryB.offers[0].score,
      `expected repoA's keep-signal match (${summaryA.offers[0].score}) to outscore repoB's non-match (${summaryB.offers[0].score})`
    );
  } finally {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }
});

test("gracefully returns an empty scan when config/sourced-scan.json doesn't exist yet", async () => {
  const repoRoot = tempRepo();
  try {
    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl: async () => {
        throw new Error("should never fetch with zero tracked companies");
      },
      write: false,
      intake: false,
    });
    assert.equal(summary.scanned, 0);
    assert.equal(summary.new, 0);
    assert.deepEqual(summary.offers, []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("DB mode scans sourced companies from SQLite without config/sourced-scan.json", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    companyAtsUpsert({
      repoRoot,
      entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    });

    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl: leverFetchStub(),
      write: false,
      intake: false,
    });

    assert.equal(summary.scanned, 1);
    assert.equal(summary.new, 1);
    assert.equal(summary.offers[0].company, "Acme");
    assert.equal(existsSync(userPath({ repoRoot }, "config/sourced-scan.json")), false);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("DB mode scoring uses SQLite targeting when candidate YAML is absent", async () => {
  const repoA = tempRepo();
  const repoB = tempRepo();
  try {
    for (const repoRoot of [repoA, repoB]) {
      candidateSetupInitialize({ repoRoot });
      companyAtsUpsert({
        repoRoot,
        entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
      });
    }
    candidateConfigPatch({
      repoRoot: repoA,
      name: "targeting",
      patch: { keep_signals: ["director of it"] },
    });
    candidateConfigPatch({
      repoRoot: repoB,
      name: "targeting",
      patch: { keep_signals: ["something else entirely"] },
    });

    const summaryA = await runSourcedScan({
      repoRoot: repoA,
      fetchImpl: leverFetchStub("Director of IT"),
      write: false,
      intake: false,
    });
    const summaryB = await runSourcedScan({
      repoRoot: repoB,
      fetchImpl: leverFetchStub("Director of IT"),
      write: false,
      intake: false,
    });

    assert.equal(existsSync(userPath({ repoRoot: repoA }, "candidate/targeting.yml")), false);
    assert.equal(existsSync(userPath({ repoRoot: repoB }, "candidate/targeting.yml")), false);
    assert.ok(
      summaryA.offers[0].score > summaryB.offers[0].score,
      `expected DB targeting keep-signal match (${summaryA.offers[0].score}) to outscore non-match (${summaryB.offers[0].score})`
    );
  } finally {
    closeAll();
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }
});

test("DB mode write:true persists scan offers through sourcedUpsertBatch and exports tracker", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    companyAtsUpsert({
      repoRoot,
      entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    });

    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl: leverFetchStub(),
      write: true,
      intake: false,
    });

    const db = openDb({ repoRoot });
    const rows = db
      .prepare("SELECT data FROM sourced ORDER BY rowid ASC")
      .all()
      .map((row) => JSON.parse(row.data));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].company, "Acme");
    assert.equal(rows[0].role, "Director of IT");
    assert.equal(rows[0].artifacts.jd, summary.offers[0].artifacts.jd);
    assert.equal(existsSync(userPath({ repoRoot }, rows[0].artifacts.jd)), true);
    assert.equal(rows[0].scanner.bodyChars, summary.offers[0].bodyChars);

    const jobFiles = readdirSync(userPath({ repoRoot }, "workspace/jobs")).filter((name) =>
      name.endsWith(".md")
    );
    assert.deepEqual(jobFiles, [summary.offers[0].artifacts.jd.replace("workspace/jobs/", "")]);

    const tracker = JSON.parse(
      readFileSync(userPath({ repoRoot }, "workspace/tracker.json"), "utf8")
    );
    assert.equal(tracker.sourced.length, 1);
    assert.equal(tracker.sourced[0].id, rows[0].id);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("DB mode write:true stamps search-source watermarks in SQLite without writing YAML", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    sourceConfigPut({ repoRoot, name: "search-sources", data: searchSourcesFixture() });

    await runSourcedScan({
      repoRoot,
      fetchImpl: rssFetchStub(),
      write: true,
      intake: false,
    });

    const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
    const lastRunAt = stored.searches[0].recency.lastRunAt;
    assert.match(lastRunAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(existsSync(userPath({ repoRoot }, "config/search-sources.yml")), false);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("legacy write:true stamps search-source watermarks in search-sources.yml", async () => {
  const repoRoot = tempRepo();
  try {
    writeSourcedScanConfig(repoRoot, { tracked_companies: [] });
    writeSearchSourcesConfig(repoRoot);

    await runSourcedScan({
      repoRoot,
      fetchImpl: rssFetchStub(),
      write: true,
      intake: false,
    });

    const written = parseYaml(readFileSync(join(repoRoot, "config/search-sources.yml"), "utf8"));
    assert.match(written.searches[0].recency.lastRunAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI (main(), behind the import.meta.url entry guard) — a real child process
// against the real repo, --company filtered to a nonexistent name so it hits
// zero network (see this file's header comment).
// ---------------------------------------------------------------------------

test("CLI still runs end-to-end post-refactor: plain JSON, --summary, and --format=tracker", () => {
  const scriptPath = join(REPO_ROOT, "scripts/scan-sourced.mjs");
  const noMatchCompany = "zzz-does-not-exist-zzz";

  // _scriptRoot is always the real installed script location (see this
  // file's header comment), so main() reads the REAL repo's
  // candidate/targeting.yml — if it has any cold-board role families,
  // runSourcedScan()'s "Cold-board lanes down-weighted: ..." console.log
  // lands on stdout ahead of the plain-JSON summary. Strip it rather than
  // asserting a specific candidate-data state.
  function stripColdBoardLine(text) {
    return text
      .split("\n")
      .filter((line) => !line.startsWith("Cold-board lanes down-weighted:"))
      .join("\n");
  }

  const plain = execFileSync(process.execPath, [scriptPath, "--company", noMatchCompany], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const parsed = JSON.parse(stripColdBoardLine(plain));
  assert.equal(parsed.scanned, 0);
  assert.equal(parsed.new, 0);
  assert.deepEqual(parsed.offers, []);

  const summaryOut = execFileSync(
    process.execPath,
    [scriptPath, "--company", noMatchCompany, "--summary"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  assert.match(summaryOut, /^Scanned: 0/m);
  assert.match(summaryOut, /Top scanner output:/);

  const trackerOut = execFileSync(
    process.execPath,
    [scriptPath, "--company", noMatchCompany, "--format=tracker"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  assert.equal(stripColdBoardLine(trackerOut).trim(), "");
});
