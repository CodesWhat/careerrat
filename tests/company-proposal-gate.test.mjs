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
