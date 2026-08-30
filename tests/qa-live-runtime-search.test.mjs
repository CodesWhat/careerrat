import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertExpectedSourceRevision } from "../scripts/lib/live-search-revision-guard.mjs";

const GIT_REPOSITORY_ENV_VARS = execFileSync("git", ["rev-parse", "--local-env-vars"], {
  encoding: "utf8",
})
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);

function withoutGitRepositoryEnv(env = process.env) {
  const isolated = { ...env };
  for (const name of GIT_REPOSITORY_ENV_VARS) delete isolated[name];
  return isolated;
}

function git(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...withoutGitRepositoryEnv(),
      GIT_AUTHOR_NAME: "CareerRat Test",
      GIT_AUTHOR_EMAIL: "test@careerrat.invalid",
      GIT_COMMITTER_NAME: "CareerRat Test",
      GIT_COMMITTER_EMAIL: "test@careerrat.invalid",
    },
  }).trim();
}

function committedRepo(repoRoot = mkdtempSync(join(tmpdir(), "careerrat-live-search-revision-"))) {
  git(repoRoot, ["init", "--quiet"]);
  writeFileSync(join(repoRoot, "source.mjs"), "export const value = 1;\n", "utf8");
  git(repoRoot, ["add", "source.mjs"]);
  git(repoRoot, ["commit", "--quiet", "-m", "test: initial source"]);
  return repoRoot;
}

test("revision guard fixtures ignore an inherited Git repository context", () => {
  const sentinelRoot = mkdtempSync(join(tmpdir(), "careerrat-git-context-sentinel-"));
  const fixtureRoot = mkdtempSync(join(tmpdir(), "careerrat-live-search-revision-"));
  const isolatedEnv = withoutGitRepositoryEnv();
  const previousGitContext = new Map(
    GIT_REPOSITORY_ENV_VARS.map((name) => [name, process.env[name]])
  );
  let setupError = null;

  try {
    execFileSync("git", ["init", "--quiet"], { cwd: sentinelRoot, env: isolatedEnv });
    process.env.GIT_DIR = join(sentinelRoot, ".git");
    process.env.GIT_WORK_TREE = sentinelRoot;
    try {
      committedRepo(fixtureRoot);
    } catch (error) {
      setupError = error;
    }
    assert.ifError(setupError);
    assert.equal(
      realpathSync(
        execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: fixtureRoot,
          encoding: "utf8",
          env: isolatedEnv,
        }).trim()
      ),
      realpathSync(fixtureRoot)
    );
    const expectedRevision = git(fixtureRoot, ["rev-parse", "HEAD"]);
    let guardError = null;
    try {
      assertExpectedSourceRevision({ repoRoot: fixtureRoot, expectedRevision });
    } catch (error) {
      guardError = error;
    }
    assert.ifError(guardError);
  } finally {
    for (const [name, value] of previousGitContext) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(sentinelRoot, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("both native AI search fixtures require three presented roles across two target buckets", () => {
  const script = readFileSync(
    new URL("../scripts/qa-live-runtime-search.mjs", import.meta.url),
    "utf8"
  );
  const receipts = readFileSync(
    new URL("../scripts/lib/live-search-receipts.mjs", import.meta.url),
    "utf8"
  );

  assert.match(script, /verifyLiveSearchReceiptForReview\(receipt\)/);
  assert.match(receipts, /minimumPresentedRows:\s*3/);
  assert.match(receipts, /minimumPresentedBuckets:\s*2/);
  assert.doesNotMatch(script, /fixtureId\s*===\s*"hospitality"[\s\S]*presented/);
});

test("both domain-neutral native AI search fixtures save the receipt fit floor explicitly", () => {
  const script = readFileSync(
    new URL("../scripts/qa-live-runtime-search.mjs", import.meta.url),
    "utf8"
  );

  assert.equal(
    script.match(/fit_bands:\s*\{\s*high_min:\s*85,\s*med_min:\s*65,\s*fit_floor:\s*65\s*\}/g)
      ?.length,
    2
  );
});

test("the hospitality native AI search fixture uses expected annual cash earnings", () => {
  const script = readFileSync(
    new URL("../scripts/qa-live-runtime-search.mjs", import.meta.url),
    "utf8"
  );
  const hospitality = script.slice(script.indexOf("hospitality:"), script.indexOf("engineering:"));

  assert.match(hospitality, /compensation:\s*\{\s*minimum_annual_earnings:\s*85000\s*\}/);
  assert.doesNotMatch(hospitality, /minimum_base|target_base|minimum annual base salary/i);
  assert.match(hospitality, /\$85,000 minimum expected annual cash earnings, including tips/i);
  assert.ok(
    (hospitality.match(/wages plus expected tips/gi) || []).length >= 3,
    "every hospitality prompt must explain the tipped annual-cash floor plainly"
  );
  assert.ok(
    (hospitality.match(/posted range cannot reach \$85,000/gi) || []).length >= 3,
    "every hospitality prompt must preserve the comparable-range policy"
  );
});

test("the engineering native AI search fixture stays base-only", () => {
  const script = readFileSync(
    new URL("../scripts/qa-live-runtime-search.mjs", import.meta.url),
    "utf8"
  );
  const engineering = script.slice(script.indexOf("engineering:"));

  assert.match(
    engineering,
    /compensation:\s*\{\s*minimum_base:\s*150000,\s*target_base:\s*180000\s*\}/
  );
  assert.doesNotMatch(engineering, /minimum_annual_earnings|wages plus expected tips/i);
  assert.match(engineering, /\$150,000 minimum annual base salary/i);
  assert.ok(
    (engineering.match(/annual base salary/gi) || []).length >= 4,
    "the engineering fixture must retain its base-salary prompt contract"
  );
});

test("native AI search verification binds the selected runtime to its current executable identity", () => {
  const script = readFileSync(
    new URL("../scripts/qa-live-runtime-search.mjs", import.meta.url),
    "utf8"
  );

  assert.match(script, /installedRuntimeExecutionIdentity/);
  assert.match(
    script,
    /installedRuntimeExecutionIdentity\(\s*\{ \.\.\.runtime, version: probe\.version \},\s*\{ env \}\s*\)/
  );
  assert.match(script, /if \(!identity\) throw new Error/);
  assert.match(
    script,
    /const runtimeVerification = \{\s*\.\.\.identity,\s*capabilities: probe\.capabilities,\s*checkedAt:/
  );
  assert.match(script, /verification: runtimeVerification/);
  assert.match(script, /runtimeVerification,/);
});

test("completed native AI searches emit diagnostics before the release gate writes a receipt", () => {
  const script = readFileSync(
    new URL("../scripts/qa-live-runtime-search.mjs", import.meta.url),
    "utf8"
  );

  const diagnostic = script.indexOf('kind: "native-ai-search-diagnostic"');
  const verification = script.indexOf("verifyLiveSearchReceiptForReview(receipt)");
  const receiptWrite = script.indexOf("writeFileSync(receiptPath");

  assert.notEqual(diagnostic, -1, "completed runs must expose a machine-readable diagnostic");
  assert.match(
    script.slice(diagnostic, verification),
    /sourceRevision[\s\S]*runtimeId[\s\S]*fixtureId[\s\S]*summary[\s\S]*usefulSet[\s\S]*rows/
  );
  assert.ok(diagnostic < verification, "diagnostics must be emitted before release verification");
  assert.ok(
    verification < receiptWrite,
    "canonical receipts must be written only after verification"
  );
  assert.equal(script.match(/writeFileSync\(receiptPath/g)?.length, 1);
});

test("native AI search diagnostics retain every persisted row while receipts use canonical readback", () => {
  const script = readFileSync(
    new URL("../scripts/qa-live-runtime-search.mjs", import.meta.url),
    "utf8"
  );

  assert.match(script, /annotateCanonicalReadableRows/);
  assert.match(script, /sources:\s*result\.sources/);
  assert.match(script, /const usefulSet = presentedSetReceipt\([\s\S]*rows/);
  assert.match(script, /kind: "native-ai-search-diagnostic"[\s\S]*rows/);
  assert.doesNotMatch(script, /reviewLiveSearchReceipt/);
});

test("native search receipts exercise the deterministic-first product lane and count the combined rows", () => {
  const script = readFileSync(
    new URL("../scripts/qa-live-runtime-search.mjs", import.meta.url),
    "utf8"
  );

  assert.match(script, /import \{ runSourcedScan \} from "\.\/scan-sourced\.mjs"/);
  assert.match(script, /import \{ runUnifiedJobSearch \}/);
  assert.match(script, /await runUnifiedJobSearch\(/);
  assert.match(script, /runDeterministic:[\s\S]*runSourcedScan\(/);
  assert.match(script, /runAiWeb:[\s\S]*runAiWebSearch\([\s\S]*deterministic/);
  assert.doesNotMatch(script, /\.filter\(\(row\) => row\.source === "ai-web-search"\)/);
  assert.match(
    script,
    /discoveryLane:\s*row\.source === "ai-web-search" \? "ai-web" : "deterministic"/
  );
  assert.match(script, /expectedPromptIds:\s*fixture\.prompts\.map/);
  assert.match(script, /aiSummary,/);
});

test("failed native AI search acceptance preserves bounded row diagnostics before cleanup", () => {
  const script = readFileSync(
    new URL("../scripts/qa-live-runtime-search.mjs", import.meta.url),
    "utf8"
  );
  const safeResult = script.slice(
    script.indexOf("function safeResult"),
    script.indexOf("function presentedSetReceipt")
  );
  const diagnostic = script.indexOf('kind: "native-ai-search-diagnostic"');
  const verification = script.indexOf("verifyLiveSearchReceiptForReview(receipt)");
  const cleanup = script.indexOf("rmSync(qaHome");

  assert.match(safeResult, /captureFailures:/);
  assert.match(safeResult, /result\.captureFailures/);
  assert.match(safeResult, /slice\(0, MAX_DIAGNOSTIC_CAPTURE_FAILURES\)/);
  assert.match(safeResult, /canonicalDisqualifications:/);
  assert.match(safeResult, /result\.canonicalDisqualifications/);
  assert.match(safeResult, /fetchedPostingDecisions:/);
  assert.match(safeResult, /result\.fetchedPostingDecisions/);
  assert.match(safeResult, /canonicalOverlaps:/);
  assert.match(safeResult, /result\.canonicalOverlaps/);
  assert.match(safeResult, /validationFailures:/);
  assert.match(safeResult, /result\.validationFailures/);
  assert.ok(diagnostic < verification, "the diagnostic must precede a failing acceptance gate");
  assert.ok(verification < cleanup, "cleanup must not erase evidence before the gate fails");
});

test("native AI search fixtures heal generated source config before the live search", () => {
  const script = readFileSync(
    new URL("../scripts/qa-live-runtime-search.mjs", import.meta.url),
    "utf8"
  );
  const targetingPatch = script.indexOf('name: "targeting"');
  const heal = script.indexOf("healSearchSourceConfig({ repoRoot, env })");
  const search = script.indexOf("await runUnifiedJobSearch");

  assert.match(script, /import \{ healSearchSourceConfig \}/);
  assert.ok(targetingPatch < heal, "source healing must use the completed fixture targeting");
  assert.ok(heal < search, "the live search must consume the healed source snapshot");
});

test("native AI search acceptance keeps the version-one receipt path compatible", () => {
  const receipts = readFileSync(
    new URL("../scripts/lib/live-search-receipts.mjs", import.meta.url),
    "utf8"
  );

  assert.match(receipts, /NATIVE_AI_SEARCH_ACCEPTANCE/);
  assert.match(receipts, /LIVE_SEARCH_ACCEPTANCE\s*=\s*NATIVE_AI_SEARCH_ACCEPTANCE/);
  assert.match(receipts, /\.github\/release-evidence\/live-search/);
  assert.match(receipts, /schemaVersion:\s*1/);
  assert.doesNotMatch(receipts, /Unsupported live-search|Unexpected live-search/i);
});

test("native AI search revision guard rejects refs, short SHAs, and malformed revisions", () => {
  const repoRoot = committedRepo();
  try {
    const expectedRevision = git(repoRoot, ["rev-parse", "HEAD"]);
    git(repoRoot, ["branch", "release-candidate"]);
    for (const invalidRevision of [
      "HEAD",
      "refs/heads/release-candidate",
      expectedRevision.slice(0, 12),
      "not a revision",
      "f".repeat(39),
      "z".repeat(40),
    ]) {
      assert.throws(
        () => assertExpectedSourceRevision({ repoRoot, expectedRevision: invalidRevision }),
        /expected source revision must be a full 40-character hexadecimal commit SHA/i,
        invalidRevision
      );
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("native AI search revision guard rejects a full SHA that does not match HEAD", () => {
  const repoRoot = committedRepo();
  try {
    const firstRevision = git(repoRoot, ["rev-parse", "HEAD"]);
    writeFileSync(join(repoRoot, "source.mjs"), "export const value = 2;\n", "utf8");
    git(repoRoot, ["add", "source.mjs"]);
    git(repoRoot, ["commit", "--quiet", "-m", "test: move head"]);
    assert.throws(
      () => assertExpectedSourceRevision({ repoRoot, expectedRevision: firstRevision }),
      /expected source revision .* does not match HEAD/i
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("native AI search revision guard rejects dirty non-receipt source", () => {
  const repoRoot = committedRepo();
  try {
    const expectedRevision = git(repoRoot, ["rev-parse", "HEAD"]);
    writeFileSync(join(repoRoot, "source.mjs"), "export const value = 2;\n", "utf8");
    assert.throws(
      () => assertExpectedSourceRevision({ repoRoot, expectedRevision }),
      /requires a clean source revision \(source\.mjs\)/i
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("native AI search revision guard accepts the exact full SHA without running a search", () => {
  const repoRoot = committedRepo();
  try {
    const expectedRevision = git(repoRoot, ["rev-parse", "HEAD"]);
    assert.equal(assertExpectedSourceRevision({ repoRoot, expectedRevision }), expectedRevision);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("native AI search revision guard preserves receipt-only drift", () => {
  const repoRoot = committedRepo();
  try {
    const expectedRevision = git(repoRoot, ["rev-parse", "HEAD"]);
    const receiptDirectory = join(repoRoot, ".github/release-evidence/live-search");
    mkdirSync(receiptDirectory, { recursive: true });
    writeFileSync(join(receiptDirectory, "receipt.json"), "{}\n", "utf8");
    assert.equal(assertExpectedSourceRevision({ repoRoot, expectedRevision }), expectedRevision);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("native AI search checks the explicit expected revision before setup and after the run", () => {
  const script = readFileSync(
    new URL("../scripts/qa-live-runtime-search.mjs", import.meta.url),
    "utf8"
  );
  const checks = [...script.matchAll(/assertExpectedSourceRevision\(/g)].map(
    (match) => match.index
  );
  const setup = script.indexOf("candidateSetupInitialize(");
  const receiptWrite = script.indexOf("writeFileSync(receiptPath");

  assert.match(script, /--expected-revision <full-40-hex-sha>/);
  assert.doesNotMatch(script, /full-sha-or-ref/);
  assert.equal(checks.length, 2, "the expected revision must be checked twice");
  assert.ok(checks[0] < setup, "the first check must happen before temporary candidate setup");
  assert.ok(checks[1] < receiptWrite, "the final check must happen before receipt writes");
});
