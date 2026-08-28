import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("both live-search fixtures require three presented roles across two target buckets", () => {
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

test("both domain-neutral live-search fixtures save the receipt fit floor explicitly", () => {
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

test("live-search fixtures express saved compensation floors as annual base salary", () => {
  const script = readFileSync(
    new URL("../scripts/qa-live-runtime-search.mjs", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(script, /salary or (?:credible )?total compensation/i);
  assert.doesNotMatch(script, /roles paying at least \$[\d,]+/i);
  assert.match(script, /\$85,000 minimum annual base salary/i);
  assert.match(script, /\$150,000 minimum annual base salary/i);
  assert.ok(
    (script.match(/annual base salary/gi) || []).length >= 8,
    "every live-search fixture prompt must preserve base-salary semantics"
  );
});

test("live-search verification binds the selected runtime to its current executable identity", () => {
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
    /verification:\s*\{\s*\.\.\.identity,\s*capabilities: probe\.capabilities,\s*checkedAt:/
  );
});

test("completed live searches emit diagnostics before the release gate writes a receipt", () => {
  const script = readFileSync(
    new URL("../scripts/qa-live-runtime-search.mjs", import.meta.url),
    "utf8"
  );

  const diagnostic = script.indexOf('kind: "live-search-diagnostic"');
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
