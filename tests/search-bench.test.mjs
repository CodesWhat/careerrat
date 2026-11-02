import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  BASELINE_PATH,
  HOLDOUT_ONBOARDED_DIR,
  loadFixtures,
  METRICS,
  runSearchBench,
} from "../scripts/eval/search-bench.mjs";

// A metric may drop this far below the committed baseline before the test
// fails. To change the baseline on purpose (a search change that trades
// numbers knowingly), run `npm run bench:search -- --update-baseline` and
// commit the new tests/fixtures/search-bench/baseline.json with the change.
const TOLERANCE = 0.02;

test("search bench fixtures are well-formed", () => {
  const fixtures = loadFixtures();
  assert.ok(fixtures.length >= 3);
  for (const fixture of fixtures) {
    const ids = new Set();
    for (const p of fixture.postings) {
      assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
      ids.add(p.id);
      assert.ok([0, 1, 2, 3].includes(p.grade), `${p.id} has an invalid grade`);
      assert.ok(p.title && p.company && p.url, `${p.id} is missing title, company, or url`);
    }
  }
});

function assertNoRegression(dir, baselinePath, updateCommand) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const result = runSearchBench({ dir });
  const failures = [];
  for (const metric of METRICS) {
    if (result.overall[metric] < baseline.overall[metric] - TOLERANCE) {
      failures.push(`overall ${metric}: ${result.overall[metric]} < ${baseline.overall[metric]}`);
    }
    for (const candidate of result.candidates) {
      const expected = baseline.candidates[candidate.name]?.[metric];
      assert.notEqual(
        expected,
        undefined,
        `no baseline for ${candidate.name}; update the baseline`
      );
      if (candidate.metrics[metric] < expected - TOLERANCE) {
        failures.push(`${candidate.name} ${metric}: ${candidate.metrics[metric]} < ${expected}`);
      }
    }
  }
  assert.deepEqual(failures, [], `search quality regressed; if intentional run: ${updateCommand}`);
}

test("search ranking quality has not regressed against the committed baseline", () => {
  assertNoRegression(undefined, BASELINE_PATH, "npm run bench:search -- --update-baseline");
});

test("onboarded holdout ranking quality has not regressed against its committed baseline", () => {
  assertNoRegression(
    HOLDOUT_ONBOARDED_DIR,
    join(HOLDOUT_ONBOARDED_DIR, "baseline.json"),
    "npm run bench:search -- --fixtures tests/fixtures/search-bench/holdout-onboarded --update-baseline"
  );
});
