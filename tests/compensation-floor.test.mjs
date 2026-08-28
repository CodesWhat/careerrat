import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { cloneCandidateDefault } from "../src/core/profile/candidate-defaults.mjs";
import * as compensation from "../src/core/profile/compensation.mjs";

const { hasConfiguredCompensationFloor } = compensation;

test("minimum annual earnings is a canonical compensation floor", () => {
  assert.equal(hasConfiguredCompensationFloor({ minimum_annual_earnings: 85_000 }), true);
  assert.equal(hasConfiguredCompensationFloor({ minimum_annual_earnings: null }), false);
});

test("candidate profile defaults and schema declare minimum annual earnings", () => {
  const profile = cloneCandidateDefault("profile");
  const schema = JSON.parse(
    readFileSync(new URL("../config/profile.schema.json", import.meta.url), "utf8")
  );

  assert.equal(profile.compensation.minimum_annual_earnings, null);
  assert.deepEqual(schema.properties.compensation.properties.minimum_annual_earnings, {
    type: ["number", "null"],
    minimum: 0,
    description:
      "Minimum expected annual cash earnings from base pay, wages, tips, commissions, and recurring cash bonuses; excludes equity and benefits.",
  });
});

test("compensation floor comparison keeps overlapping and unknown bands for review", () => {
  const compare = compensation.compareCompensationBandToFloor;

  assert.equal(compare(null, 85_000), "unknown");
  assert.equal(compare({ min: 70_000, max: 80_000 }, 85_000), "below");
  assert.equal(compare({ min: 80_000, max: 95_000 }, 85_000), "overlap");
  assert.equal(compare({ min: 90_000, max: 110_000 }, 85_000), "clear");
  assert.equal(compare({ min: 70_000, max: 80_000 }, null), "no-floor");
});

test("annual earnings stays unknown when low base pay may be supplemented by tips", () => {
  const assess = compensation.assessCompensationFloors;

  assert.deepEqual(
    assess({
      baseBand: { min: 23_608, max: 23_608 },
      annualEarningsBand: null,
      minimumBase: null,
      minimumAnnualEarnings: 85_000,
    }),
    { base: "no-floor", annualEarnings: "unknown" }
  );
  assert.deepEqual(
    assess({
      baseBand: { min: 104_000, max: 104_000 },
      annualEarningsBand: null,
      minimumBase: null,
      minimumAnnualEarnings: 85_000,
    }),
    { base: "no-floor", annualEarnings: "clear" }
  );
});

test("tracker evaluation schema keeps annual earnings separate from base pay", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../config/tracker.schema.json", import.meta.url), "utf8")
  );
  const compensationSchema =
    schema.properties.applications.items.properties.evaluation.properties.compensation.properties;

  assert.deepEqual(compensationSchema.minAnnualEarnings, {
    type: ["number", "null"],
    minimum: 0,
  });
  assert.deepEqual(compensationSchema.maxAnnualEarnings, {
    type: ["number", "null"],
    minimum: 0,
  });
  assert.deepEqual(compensationSchema.basis, {
    type: ["string", "null"],
    enum: ["base", "annual-earnings", null],
  });
});
