import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
