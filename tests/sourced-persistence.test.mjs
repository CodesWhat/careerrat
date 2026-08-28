import assert from "node:assert/strict";
import { test } from "node:test";

import { sourcedRowsFromScanOffers } from "../src/core/scoring/sourced-persistence.mjs";

function offer(overrides = {}) {
  return {
    company: "Acme",
    title: "Staff Engineer",
    url: "https://jobs.example.test/acme/staff-engineer",
    bodyPartial: false,
    ...overrides,
  };
}

test("sourced rows recover explicit base-pay and salary ranges from canonical bodies", () => {
  const rows = sourcedRowsFromScanOffers([
    offer({
      bodyText: "The base pay range for this role is $180,000 - $220,000 per year.",
    }),
    offer({
      title: "Principal Engineer",
      url: "https://jobs.example.test/acme/principal-engineer",
      bodyText: "The annual salary range is $205,000 - $255,000.",
    }),
    offer({
      title: "Engineering Director",
      url: "https://jobs.example.test/acme/engineering-director",
      bodyText: "Estimated Base Pay Range\n$175,000—$196,800 USD",
    }),
  ]);

  assert.equal(rows[0].base, "$180,000 - $220,000");
  assert.equal(rows[1].base, "$205,000 - $255,000");
  assert.equal(rows[2].base, "$175,000—$196,800 USD");
});

test("sourced rows keep bonus, OTE, equity, and total-comp ranges unverified", () => {
  const bodies = [
    "The salary range, inclusive of annual bonus, is $180,000 - $240,000.",
    "The OTE range for this role is $210,000 - $280,000.",
    "The equity grant range is $150,000 - $225,000.",
    "Total compensation, including base salary and bonus, ranges from $220,000 - $300,000.",
    "Zone 1 Pay:\n$183,000 - $229,000 USD\nThis pay is in addition to salary, bonus, and equity.",
  ];

  const rows = sourcedRowsFromScanOffers(
    bodies.map((bodyText, index) =>
      offer({
        title: `Staff Engineer ${index}`,
        url: `https://jobs.example.test/acme/staff-engineer-${index}`,
        bodyText,
      })
    )
  );

  assert.deepEqual(
    rows.map((row) => row.base),
    ["verify", "verify", "verify", "verify", "verify"]
  );
});

test("existing offer compensation takes precedence over canonical-body extraction", () => {
  const [row] = sourcedRowsFromScanOffers([
    offer({
      comp: "$230,000 - $270,000 base",
      bodyText: "The base salary range is $180,000 - $220,000.",
    }),
  ]);

  assert.equal(row.base, "$230,000 - $270,000 base");
});

test("generic compensation is classified instead of assumed to be base pay", () => {
  const rows = sourcedRowsFromScanOffers([
    offer({ comp: "$180,000 - $220,000 base salary" }),
    offer({
      title: "Lead Bartender",
      url: "https://jobs.example.test/acme/lead-bartender",
      comp: "$90,000 - $110,000 including tips",
    }),
    offer({
      title: "Account Executive",
      url: "https://jobs.example.test/acme/account-executive",
      comp: "$180,000 - $240,000 total compensation including equity",
    }),
  ]);

  assert.deepEqual(
    rows.map(({ base, tc, compBasis }) => ({ base, tc, compBasis })),
    [
      { base: "$180,000 - $220,000 base salary", tc: null, compBasis: undefined },
      {
        base: "verify",
        tc: "$90,000 - $110,000 including tips",
        compBasis: "annual-earnings",
      },
      { base: "verify", tc: null, compBasis: undefined },
    ]
  );
});

test("sourced rows persist base pay and annual earnings separately", () => {
  const [row] = sourcedRowsFromScanOffers([
    offer({
      baseComp: "$11.35 per hour",
      annualEarningsComp: "$95,000 - $120,000 including tips",
      bodyText:
        "Base pay: $11.35 per hour. Estimated annual earnings including tips: $95,000 - $120,000.",
    }),
  ]);

  assert.equal(row.base, "$11.35 per hour");
  assert.equal(row.tc, "$95,000 - $120,000 including tips");
  assert.equal(row.compBasis, "annual-earnings");
});

test("partial bodies do not infer compensation but existing offer compensation still wins", () => {
  const rows = sourcedRowsFromScanOffers([
    offer({
      bodyPartial: true,
      bodyText: "The base salary range is $180,000 - $220,000.",
    }),
    offer({
      title: "Principal Engineer",
      url: "https://jobs.example.test/acme/principal-engineer",
      comp: "$240,000 - $280,000 base",
      bodyPartial: true,
      bodyText: "The visible excerpt says the base salary range starts at $180,000.",
    }),
  ]);

  assert.equal(rows[0].base, "verify");
  assert.equal(rows[1].base, "$240,000 - $280,000 base");
});

test("sourced rows preserve qualification unknowns and unverified search status", () => {
  const [row] = sourcedRowsFromScanOffers([
    offer({
      qualificationUnknowns: ["compensation", "location"],
      source: "ai-web-search",
      bodyPartial: true,
      bodyText: "Unverified open-web evidence for a specific employer and role.",
    }),
  ]);

  assert.deepEqual(row.scanner.qualificationUnknowns, ["compensation", "location"]);
  assert.equal(row.scanner.unverified, true);
});
