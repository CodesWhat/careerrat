// tests/company-identity.test.mjs — shared company-name matching helpers.
import assert from "node:assert/strict";
import { test } from "node:test";

import { companyMatchesAny, companyMatchKey } from "../src/core/discovery/company-identity.mjs";
import { buildCompanyProposal } from "../src/core/discovery/company-proposal-gate.mjs";

test("companyMatchKey folds '&' into 'and' and drops trailing legal suffixes", () => {
  assert.equal(companyMatchKey("A & B"), companyMatchKey("A and B"));
  assert.equal(companyMatchKey("Acme, Inc."), companyMatchKey("Acme"));
  assert.equal(companyMatchKey("A & B LLC"), companyMatchKey("A and B"));
});

test("companyMatchKey keeps distinct names and domains distinct", () => {
  assert.notEqual(companyMatchKey("Acme Holdings"), companyMatchKey("Acme"));
  assert.notEqual(companyMatchKey("acme.com"), companyMatchKey("acme.io"));
  assert.notEqual(companyMatchKey("acme.com"), companyMatchKey("Acme"));
  assert.equal(companyMatchKey("https://www.Acme.com/careers"), "acme.com");
});

test("companyMatchesAny matches by name or exact domain", () => {
  const company = { name: "A and B", domain: "ab.com" };
  assert.equal(companyMatchesAny(["A & B Inc"], company), true);
  assert.equal(companyMatchesAny(["https://ab.com/jobs"], company), true);
  assert.equal(companyMatchesAny(["ab.io", "A and C"], company), false);
});

test("an 'A & B' tracked company marks an 'A and B' proposal as already tracked", () => {
  const result = buildCompanyProposal({
    seed: { name: "A and B" },
    resolution: {},
    scanResult: { offers: [] },
    context: { trackedCompanies: ["A & B"] },
    proposalId: "p1",
    version: 1,
  });
  assert.ok(JSON.stringify(result).includes("tracked"), JSON.stringify(result).slice(0, 300));
});
