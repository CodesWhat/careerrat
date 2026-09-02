import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { estimateCompFromComparables } from "../src/core/evaluate/comp-comparables.mjs";

function estimateHourlyComparable(base) {
  return estimateCompFromComparables({
    role: "Bar Manager",
    loc: "New York, NY",
    mode: "onsite",
    tracker: {
      applications: [
        {
          company: "Ownership Co",
          role: "Bar Manager",
          loc: "New York, NY",
          mode: "onsite",
          base,
          status: "rejected",
        },
      ],
    },
    targeting: { role_buckets: [{ name: "Hospitality", titles: ["Bar Manager"] }] },
    compFloors: { home_metro: ["New York"] },
  });
}

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

  it("scores tipped total earnings, not just the base line, for annual-earnings", () => {
    const estimate = estimateCompFromComparables({
      role: "Bar Manager",
      targeting: TARGETING,
      compensationBasis: "annual-earnings",
      tracker: {
        applications: [
          {
            company: "One",
            role: "Bar Manager",
            tc: "Base salary $50,000 plus average tips of $30,000, for total annual earnings of $70,000-$80,000.",
            compBasis: "annual-earnings",
          },
        ],
      },
    });

    assert.equal(estimate.compensationBasis, "annual-earnings");
    assert.equal(estimate.midpointK, 75);
    assert.equal(estimate.lowK, 75);
    assert.equal(estimate.highK, 75);
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

  it("excludes a labeled annual-earnings row whose figure is unavailable, instead of falling back to the base line", () => {
    const estimate = estimateCompFromComparables({
      role: "Bar Manager",
      targeting: TARGETING,
      compensationBasis: "annual-earnings",
      tracker: {
        applications: [
          {
            company: "One",
            role: "Bar Manager",
            tc: "Base salary $50,000; total annual earnings unavailable",
            compBasis: "annual-earnings",
          },
          {
            company: "Two",
            role: "Bar Manager",
            tc: "$90,000 - $100,000",
            compBasis: "annual-earnings",
          },
        ],
      },
    });

    assert.equal(estimate.compensationBasis, "annual-earnings");
    assert.equal(estimate.midpointK, 95);
    assert.equal(estimate.comparables.length, 1);
    assert.deepEqual(
      estimate.comparables.map((row) => row.company),
      ["Two"]
    );
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

test("historical unlabeled hourly pay enters the comparable estimate pool", () => {
  const estimate = estimateCompFromComparables({
    role: "Bar Manager",
    loc: "New York, NY",
    mode: "onsite",
    tracker: {
      applications: [
        {
          id: "past-bar-manager",
          company: "Example Hospitality",
          role: "Bar Manager",
          loc: "New York, NY",
          mode: "onsite",
          base: "Pay: $18-$22/hour",
          status: "rejected",
        },
      ],
    },
    targeting: {
      role_buckets: [{ name: "Hospitality", titles: ["Bar Manager"] }],
    },
    compFloors: { home_metro: ["New York"] },
  });

  assert.equal(estimate?.sampleSize, 1);
  assert.equal(estimate?.midpointK, 42);
  assert.equal(estimate?.lowK, 42);
  assert.equal(estimate?.highK, 42);
  assert.deepEqual(estimate?.comparables, [
    {
      company: "Example Hospitality",
      role: "Bar Manager",
      base: "Pay: $18-$22/hour",
      status: "rejected",
    },
  ]);
});

test("hourly comparable honors later weekly hours and unquantified bonus language", () => {
  const estimate = estimateCompFromComparables({
    role: "Bar Manager",
    loc: "New York, NY",
    mode: "onsite",
    tracker: {
      applications: [
        {
          id: "past-bar-manager",
          company: "Example Hospitality",
          role: "Bar Manager",
          loc: "New York, NY",
          mode: "onsite",
          base: "Pay: $20/hour plus bonus. Schedule: 30 hours per week.",
          status: "rejected",
        },
      ],
    },
    targeting: {
      role_buckets: [{ name: "Hospitality", titles: ["Bar Manager"] }],
    },
    compFloors: { home_metro: ["New York"] },
  });

  assert.equal(estimate?.sampleSize, 1);
  assert.equal(estimate?.midpointK, 31);
  assert.equal(estimate?.lowK, 31);
  assert.equal(estimate?.highK, 31);
});

test("non-dollar hourly comparable ignores volunteer weekly hours", () => {
  const estimate = estimateCompFromComparables({
    role: "Bar Manager",
    loc: "London, UK",
    mode: "onsite",
    tracker: {
      applications: [
        {
          id: "past-bar-manager",
          company: "Example Hospitality",
          role: "Bar Manager",
          loc: "London, UK",
          mode: "onsite",
          base: "Pay: EUR 20/hour. Volunteer commitment: 10 hours per week.",
          status: "rejected",
        },
      ],
    },
    targeting: {
      role_buckets: [{ name: "Hospitality", titles: ["Bar Manager"] }],
    },
    compFloors: { home_metro: ["London"] },
  });

  assert.equal(estimate?.sampleSize, 1);
  assert.equal(estimate?.midpointK, 42);
  assert.equal(estimate?.lowK, 42);
  assert.equal(estimate?.highK, 42);
});

test("CR5: comparable estimation excludes explicit foreign currencies and preserves candidate currency", () => {
  const estimate = estimateCompFromComparables({
    role: "Bar Manager",
    loc: "New York, NY",
    mode: "onsite",
    tracker: {
      applications: [
        {
          company: "Matching Currency",
          role: "Bar Manager",
          loc: "New York, NY",
          mode: "onsite",
          base: "USD 90k-110k",
          status: "rejected",
        },
        {
          company: "Legacy Currency",
          role: "Bar Manager",
          loc: "New York, NY",
          mode: "onsite",
          base: "100k-120k",
          status: "rejected",
        },
        {
          company: "Foreign Currency",
          role: "Bar Manager",
          loc: "New York, NY",
          mode: "onsite",
          base: "GBP 300k-400k",
          status: "rejected",
        },
      ],
    },
    targeting: {
      role_buckets: [{ name: "Hospitality", titles: ["Bar Manager"] }],
    },
    compFloors: { currency: "USD", home_metro: ["New York"] },
  });

  assert.equal(estimate?.currency, "USD");
  assert.equal(estimate?.sampleSize, 2);
  assert.deepEqual(
    estimate?.comparables.map(({ company }) => company),
    ["Legacy Currency", "Matching Currency"]
  );
  assert.equal(estimate?.lowK, 100);
  assert.equal(estimate?.midpointK, 105);
  assert.equal(estimate?.highK, 110);
});

test("CR5 closeout: comparables exclude every adjacent foreign ISO marker but keep legacy evidence", () => {
  const estimate = estimateCompFromComparables({
    role: "Bar Manager",
    loc: "New York, NY",
    mode: "onsite",
    tracker: {
      applications: [
        ...["CHF", "AUD", "PLN"].map((currency) => ({
          company: `${currency} Co`,
          role: "Bar Manager",
          loc: "New York, NY",
          mode: "onsite",
          base: `90k-110k ${currency}`,
          status: "rejected",
        })),
        {
          company: "Legacy Co",
          role: "Bar Manager",
          loc: "New York, NY",
          mode: "onsite",
          base: "90k-110k",
          status: "rejected",
        },
      ],
    },
    targeting: { role_buckets: [{ name: "Hospitality", titles: ["Bar Manager"] }] },
    compFloors: { currency: "USD", home_metro: ["New York"] },
  });

  assert.equal(estimate?.currency, "USD");
  assert.equal(estimate?.sampleSize, 1);
  assert.deepEqual(
    estimate?.comparables.map(({ company }) => company),
    ["Legacy Co"]
  );
});

test("CR5 closeout: comparable hourly pay ignores store hours but honors employee schedules", () => {
  function estimate(base) {
    return estimateCompFromComparables({
      role: "Bar Manager",
      loc: "New York, NY",
      mode: "onsite",
      tracker: {
        applications: [
          {
            company: "Schedule Co",
            role: "Bar Manager",
            loc: "New York, NY",
            mode: "onsite",
            base,
            status: "rejected",
          },
        ],
      },
      targeting: { role_buckets: [{ name: "Hospitality", titles: ["Bar Manager"] }] },
      compFloors: { home_metro: ["New York"] },
    });
  }

  assert.equal(estimate("Pay: $20/hour. Store hours: 30 hours per week.")?.midpointK, 42);
  assert.equal(estimate("Pay: $20/hour. Employee schedule: 30 hours per week.")?.midpointK, 31);
});

test("CR5: semantic business operating hours never add the bad 83K midpoint to comparables", () => {
  function estimate(base) {
    return estimateCompFromComparables({
      role: "Bar Manager",
      loc: "New York, NY",
      mode: "onsite",
      tracker: {
        applications: [
          {
            company: "Schedule Co",
            role: "Bar Manager",
            loc: "New York, NY",
            mode: "onsite",
            base,
            status: "rejected",
          },
        ],
      },
      targeting: { role_buckets: [{ name: "Hospitality", titles: ["Bar Manager"] }] },
      compFloors: { home_metro: ["New York"] },
    });
  }

  for (const base of [
    "Store operates 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Store operates 80 hours per week.",
    "Store operates for 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Store operates for 80 hours per week.",
    "Store operates a total of 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Store operates a total of 80 hours per week.",
    "Store is operating 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Store is operating 80 hours per week.",
    "Store currently operates 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Store currently operates 80 hours per week.",
  ]) {
    const comparableEstimate = estimate(base);

    assert.equal(comparableEstimate?.sampleSize, 1, base);
    assert.equal(comparableEstimate?.midpointK, 42, base);
    assert.notEqual(comparableEstimate?.midpointK, 83, base);
  }
});

test("CR5: business-entity hours stay out of comparables while generic schedules remain", () => {
  function estimate(base) {
    return estimateCompFromComparables({
      role: "Bar Manager",
      loc: "New York, NY",
      mode: "onsite",
      tracker: {
        applications: [
          {
            company: "Context Co",
            role: "Bar Manager",
            loc: "New York, NY",
            mode: "onsite",
            base,
            status: "rejected",
          },
        ],
      },
      targeting: { role_buckets: [{ name: "Hospitality", titles: ["Bar Manager"] }] },
      compFloors: { home_metro: ["New York"] },
    });
  }

  for (const base of [
    "Restaurant stays open 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Restaurant stays open 80 hours per week.",
    "Store runs 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Store runs 80 hours per week.",
    "Facility open 80 hours per week. Pay: $20/hour.",
    "Pay: $20/hour. Facility open 80 hours per week.",
  ]) {
    const result = estimate(base);
    assert.equal(result?.sampleSize, 1, base);
    assert.equal(result?.midpointK, 42, base);
    assert.notEqual(result?.midpointK, 83, base);
  }

  assert.equal(estimate("Schedule: 30 hours per week. Pay: $20/hour.")?.midpointK, 31);
});

test("CR5 ownership: incidental employee nouns do not claim comparable business hours", () => {
  for (const clause of [
    "Restaurant is open 80 hours/week to give employees flexible shifts",
    "Restaurant operates 80 hours/week for staff coverage",
  ]) {
    for (const base of [`${clause}. Pay: $20/hour.`, `Pay: $20/hour. ${clause}.`]) {
      assert.equal(estimateHourlyComparable(base)?.midpointK, 42, base);
    }
  }
});

test("CR5 ownership: a business regular schedule keeps the default comparable workweek", () => {
  for (const base of [
    "Store's regular schedule is 80 hours/week. Pay: $20/hour.",
    "Pay: $20/hour. Store's regular schedule is 80 hours/week.",
  ]) {
    assert.equal(estimateHourlyComparable(base)?.midpointK, 42, base);
  }
});

test("CR5 next-sentence: regular hours determine the comparable midpoint", () => {
  assert.equal(
    estimateHourlyComparable(
      "Pay: $20/hour. The position includes 10 overtime hours and 30 regular hours per week."
    )?.midpointK,
    31
  );
});

test("CR5 whole-clause: business hours never become a comparable workweek", () => {
  function estimate(base) {
    return estimateCompFromComparables({
      role: "Bar Manager",
      loc: "New York, NY",
      mode: "onsite",
      tracker: {
        applications: [
          {
            company: "Whole Clause Co",
            role: "Bar Manager",
            loc: "New York, NY",
            mode: "onsite",
            base,
            status: "rejected",
          },
        ],
      },
      targeting: { role_buckets: [{ name: "Hospitality", titles: ["Bar Manager"] }] },
      compFloors: { home_metro: ["New York"] },
    });
  }

  const businessHoursClauses = [
    "Open 80 hours/week at this restaurant",
    "We are open 80 hours/week",
    "Hours of operation: 80 hours/week",
    "Restaurant operating schedule: 80 hours/week",
    "Store work hours: 80 hours/week",
    "80 hours/week are the restaurant opening hours",
  ];

  for (const clause of businessHoursClauses) {
    for (const base of [`${clause}. Pay: $20/hour.`, `Pay: $20/hour. ${clause}.`]) {
      const result = estimate(base);

      assert.equal(result?.sampleSize, 1, base);
      assert.equal(result?.midpointK, 42, base);
      assert.notEqual(result?.midpointK, 83, base);
    }
  }

  assert.equal(estimate("This role requires 30 hours/week. Pay: $20/hour.")?.midpointK, 31);
  assert.equal(estimate("Pay: $20/hour. Expected commitment is 30 hours/week.")?.midpointK, 31);
  assert.equal(
    estimate("We are open 80 hours/week. This role requires 30 hours/week. Pay: $20/hour.")
      ?.midpointK,
    31
  );
  assert.equal(
    estimate("Pay: $20/hour. Expected commitment is 30 hours/week. We are open 80 hours/week.")
      ?.midpointK,
    31
  );
});
