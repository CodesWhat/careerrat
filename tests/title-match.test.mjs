import assert from "node:assert/strict";
import test from "node:test";

import { normalizedTitleWords, titleMatchesBucket } from "../src/core/search/title-match.mjs";

test("title matching treats event and events as the same role word", () => {
  assert.deepEqual(
    [...normalizedTitleWords("Events Team Coordinator")],
    ["event", "team", "coordinator"]
  );
  assert.equal(
    titleMatchesBucket("Events Team Coordinator", {
      titles: ["Event Coordinator"],
    }),
    true
  );
});

test("title matching does not stem unrelated words", () => {
  assert.deepEqual(
    [...normalizedTitleWords("Business Operations Manager")],
    ["business", "operations", "manager"]
  );
  assert.equal(
    titleMatchesBucket("Business Operations Manager", {
      titles: ["Bus Operation Manager"],
    }),
    false
  );
});
