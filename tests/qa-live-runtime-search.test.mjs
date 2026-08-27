import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("hospitality live QA requires three presented roles across two target buckets", () => {
  const script = readFileSync(
    new URL("../scripts/qa-live-runtime-search.mjs", import.meta.url),
    "utf8"
  );

  assert.match(script, /presented[^\n]*<\s*3/);
  assert.match(script, /presentedBucketCount[^\n]*<\s*2/);
  assert.match(script, /fixtureId\s*===\s*"hospitality"/);
});
