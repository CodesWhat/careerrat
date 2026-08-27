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
