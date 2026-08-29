import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { estimateCompFromComparables } from "../src/core/evaluate/comp-comparables.mjs";

const TARGETING = {
  role_families: [{ name: "Hospitality Management", patterns: ["bar manager"] }],
};

describe("estimateCompFromComparables", () => {
  it("uses annual cash evidence for an annual-earnings estimate", () => {
    const estimate = estimateCompFromComparables({
      role: "Bar Manager",
      loc: "Remote",
      mode: "remote",
      targeting: TARGETING,
      compensationBasis: "annual-earnings",
      tracker: {
        applications: [
          {
            company: "One",
            role: "Bar Manager",
            loc: "Remote",
            mode: "remote",
            base: "$12 per hour",
            tc: "$70,000 - $80,000",
            compBasis: "annual-earnings",
          },
          {
            company: "Two",
            role: "Bar Manager",
            loc: "Remote",
            mode: "remote",
            base: "$14 per hour",
            comp: { tc: "$80,000 - $90,000", basis: "annual-earnings" },
          },
          {
            company: "Three",
            role: "Bar Manager",
            loc: "Remote",
            mode: "remote",
            base: "$16 per hour",
            tc: "$90,000 - $100,000",
            evaluation: {
              compensation: { minAnnualEarnings: 90_000, maxAnnualEarnings: 100_000 },
            },
          },
        ],
      },
    });

    assert.equal(estimate.compensationBasis, "annual-earnings");
    assert.equal(estimate.midpointK, 85);
    assert.equal(estimate.lowK, 75);
    assert.equal(estimate.highK, 95);
    assert.deepEqual(
      estimate.comparables.map((row) => row.annualEarnings),
      ["$90,000 - $100,000", "$80,000 - $90,000", "$70,000 - $80,000"]
    );
  });

  it("does not build an annual-earnings estimate from base-only evidence", () => {
    const estimate = estimateCompFromComparables({
      role: "Bar Manager",
      targeting: TARGETING,
      compensationBasis: "annual-earnings",
      tracker: {
        applications: [
          { company: "One", role: "Bar Manager", base: "$70,000 - $80,000" },
          { company: "Two", role: "Bar Manager", comp: { base: "$80,000 - $90,000" } },
        ],
      },
    });

    assert.equal(estimate, null);
  });

  it("does not treat legacy equity-inclusive total compensation as annual cash", () => {
    const estimate = estimateCompFromComparables({
      role: "Bar Manager",
      targeting: TARGETING,
      compensationBasis: "annual-earnings",
      tracker: {
        applications: [
          {
            company: "Legacy",
            role: "Bar Manager",
            tc: "$200,000 - $300,000 total compensation including equity",
          },
        ],
      },
    });

    assert.equal(estimate, null);
  });

  it("preserves base estimates by default", () => {
    const estimate = estimateCompFromComparables({
      role: "Bar Manager",
      targeting: TARGETING,
      tracker: {
        applications: [
          { company: "One", role: "Bar Manager", base: "$100,000 - $120,000" },
          { company: "Two", role: "Bar Manager", comp: { base: "$120,000 - $140,000" } },
        ],
      },
    });

    assert.equal(estimate.compensationBasis, "base");
    assert.equal(estimate.midpointK, 120);
    assert.deepEqual(
      estimate.comparables.map((row) => row.base),
      ["$120,000 - $140,000", "$100,000 - $120,000"]
    );
  });
});
