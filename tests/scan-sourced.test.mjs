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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSourcedScan } from "../scripts/scan-sourced.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { stringifyYaml } from "../src/core/profile/yaml.mjs";

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
