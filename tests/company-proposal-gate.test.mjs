// tests/company-proposal-gate.test.mjs
// node:test suite for company-proposal-gate.mjs's exclusion-matching normalizer.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCompanyProposal } from "../src/core/discovery/company-proposal-gate.mjs";

function proposalArgs(overrides = {}) {
  return {
    seed: { name: "Acme AI" },
    resolution: {},
    scanResult: { offers: [] },
    context: {},
    proposalId: "proposal-1",
    version: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// excluded-company matching — legal-suffix normalization
// ---------------------------------------------------------------------------

test("buildCompanyProposal rejects a discovered company whose legal suffix differs from the excluded entry's short form", () => {
  for (const discoveredName of [
    "Acme AI, Inc.",
    "Acme AI Inc",
    "Acme AI, LLC",
    "Acme AI Corporation",
  ]) {
    const result = buildCompanyProposal(
      proposalArgs({
        seed: { name: discoveredName },
        context: { excludedCompanies: ["Acme AI"] },
      })
    );
    assert.ok(result.rejected, `expected "${discoveredName}" to be rejected as excluded`);
    assert.equal(result.rejected.reason, "excluded-company");
    assert.ok(result.rejected.rejectReasons.includes("excluded-company"));
  }
});

test("buildCompanyProposal rejects when the excluded entry itself carries the legal suffix and the discovery is the short form", () => {
  const result = buildCompanyProposal(
    proposalArgs({
      seed: { name: "Acme AI" },
      context: { excludedCompanies: ["Acme AI, Inc."] },
    })
  );
  assert.ok(result.rejected);
  assert.equal(result.rejected.reason, "excluded-company");
});

test("buildCompanyProposal does not reject a distinct company that merely shares a legal suffix", () => {
  const result = buildCompanyProposal(
    proposalArgs({
      seed: { name: "Zenith Corp" },
      context: { excludedCompanies: ["Acme AI, Inc."] },
    })
  );
  // No resolution/ATS data is supplied, so this still falls through to an
  // unrelated rejection reason — the point under test is that it must NOT be
  // rejected as "excluded-company".
  assert.notEqual(result.rejected?.reason, "excluded-company");
});

test("buildCompanyProposal rejects a discovered company carrying a PBC suffix against an excluded short form", () => {
  const result = buildCompanyProposal(
    proposalArgs({
      seed: { name: "Anthropic PBC" },
      context: { excludedCompanies: ["Anthropic"] },
    })
  );
  assert.ok(result.rejected, 'expected "Anthropic PBC" to be rejected as excluded');
  assert.equal(result.rejected.reason, "excluded-company");
  assert.ok(result.rejected.rejectReasons.includes("excluded-company"));
});

test("buildCompanyProposal domain matching stays exact (unaffected by the legal-suffix strip)", () => {
  const excluded = buildCompanyProposal(
    proposalArgs({
      seed: { name: "Different Name", domain_hint: "acme.example" },
      context: { excludedCompanies: ["acme.example"] },
    })
  );
  assert.equal(excluded.rejected?.reason, "excluded-company");

  const notExcluded = buildCompanyProposal(
    proposalArgs({
      seed: { name: "Different Name", domain_hint: "notacme.example" },
      context: { excludedCompanies: ["acme.example"] },
    })
  );
  assert.notEqual(notExcluded.rejected?.reason, "excluded-company");
});

function compensationProposal(offer, compensationFloors) {
  const capturedOffer = { bodyChars: 120, bodyPartial: false, ...offer };
  return buildCompanyProposal(
    proposalArgs({
      resolution: {
        companyName: offer.company,
        atsProvider: "lever",
        jobBoardUrl: "https://jobs.example.test/company",
      },
      scanResult: { offers: [offer], errors: [] },
      capturedOffers: [capturedOffer],
      context: { compensationFloors },
    })
  );
}

test("company proposals keep unlabeled pay reviewable instead of rejecting it as base", () => {
  const result = compensationProposal(
    {
      company: "Unknown Basis Co",
      title: "Lead Bartender",
      url: "https://jobs.example.test/company/unknown-basis",
      comp: "$95k-$120k",
      gate: "review",
      ruleFlags: ["comp-below-floor"],
    },
    { minimum_base: 130_000 }
  );

  assert.equal(result.rejected, undefined);
  assert.equal(result.proposal.confidenceTier, "borderline");
  assert.ok(result.proposal.reviewReasons.includes("comp-uncertain"));
});

test("company proposals apply annual cash floors to tipped roles by basis", () => {
  const below = compensationProposal(
    {
      company: "Below Tips Co",
      title: "Lead Bartender",
      url: "https://jobs.example.test/company/below-tips",
      baseComp: "$11.35 per hour",
      annualEarningsComp: "$60,000-$75,000",
    },
    { minimum_base: 20_000, minimum_annual_earnings: 85_000 }
  );
  const unknown = compensationProposal(
    {
      company: "Unknown Tips Co",
      title: "Lead Bartender",
      url: "https://jobs.example.test/company/unknown-tips",
      baseComp: "$11.35 per hour including tips",
    },
    { minimum_base: 20_000, minimum_annual_earnings: 85_000 }
  );

  assert.equal(below.rejected?.reason, "annual-earnings-below-floor");
  assert.ok(below.rejected?.rejectReasons.includes("annual-earnings-below-floor"));
  assert.equal(unknown.rejected, undefined);
  assert.equal(unknown.proposal.confidenceTier, "borderline");
  assert.ok(unknown.proposal.reviewReasons.includes("annual-earnings-unverified"));
});

test("CR5: company proposals review foreign-currency bands but keep legacy comparisons", () => {
  const foreign = compensationProposal(
    {
      company: "Foreign Currency Co",
      title: "Bar Manager",
      url: "https://jobs.example.test/company/foreign-currency",
      baseComp: "GBP 60,000 - 75,000",
    },
    { currency: "USD", minimum_base: 85_000 }
  );
  const legacy = compensationProposal(
    {
      company: "Legacy Currency Co",
      title: "Bar Manager",
      url: "https://jobs.example.test/company/legacy-currency",
      baseComp: "60k - 75k",
    },
    { currency: "USD", minimum_base: 85_000 }
  );

  assert.equal(foreign.rejected, undefined);
  assert.equal(foreign.proposal.confidenceTier, "borderline");
  assert.ok(foreign.proposal.reviewReasons.some((reason) => /comp|currency/i.test(reason)));
  assert.equal(legacy.rejected?.reason, "comp-below-floor");
});

test("company proposals fall back from a blank nested floor currency", () => {
  const offer = {
    company: "Foreign Currency Co",
    title: "Bar Manager",
    url: "https://jobs.example.test/company/foreign-currency-blank-floor",
    baseComp: "GBP 60,000 - 75,000",
  };
  const result = buildCompanyProposal(
    proposalArgs({
      resolution: {
        companyName: offer.company,
        atsProvider: "lever",
        jobBoardUrl: "https://jobs.example.test/company",
      },
      scanResult: { offers: [offer], errors: [] },
      capturedOffers: [{ bodyChars: 120, bodyPartial: false, ...offer }],
      context: {
        currency: "USD",
        compensationFloors: { currency: "", minimum_base: 85_000 },
      },
    })
  );

  assert.equal(result.rejected, undefined);
  assert.equal(result.proposal.confidenceTier, "borderline");
  assert.ok(result.proposal.reviewReasons.some((reason) => /comp|currency/i.test(reason)));
});
