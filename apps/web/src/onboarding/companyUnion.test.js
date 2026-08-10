// apps/web/src/onboarding/companyUnion.test.js
// vitest coverage for Lane A / R2's union helper. Pure function — every
// write to targeting.tracked_companies must be a union of the existing list
// plus newly accepted names, deduped, as plain strings, never a replace.

import { describe, expect, it } from "vitest";
import { unionCompanyNames } from "./companyUnion.js";

describe("unionCompanyNames", () => {
  it("unions existing and added, preserving existing-then-added order", () => {
    expect(unionCompanyNames(["Stripe"], ["Anthropic"])).toEqual(["Stripe", "Anthropic"]);
  });

  it("dedupes exact-string repeats, keeping the first occurrence", () => {
    expect(unionCompanyNames(["Stripe"], ["Stripe"])).toEqual(["Stripe"]);
    expect(unionCompanyNames(["Stripe", "Anthropic"], ["Anthropic", "OpenAI"])).toEqual([
      "Stripe",
      "Anthropic",
      "OpenAI",
    ]);
  });

  it("trims whitespace before comparing/storing", () => {
    expect(unionCompanyNames(["Stripe"], ["  Stripe  "])).toEqual(["Stripe"]);
    expect(unionCompanyNames([], ["  Anthropic  "])).toEqual(["Anthropic"]);
  });

  it("drops blank/whitespace-only entries", () => {
    expect(unionCompanyNames(["Stripe"], ["", "   "])).toEqual(["Stripe"]);
  });

  it("tolerates missing/non-array inputs, treating them as empty", () => {
    expect(unionCompanyNames(undefined, ["Stripe"])).toEqual(["Stripe"]);
    expect(unionCompanyNames(["Stripe"], undefined)).toEqual(["Stripe"]);
    expect(unionCompanyNames(null, null)).toEqual([]);
  });

  it("never mutates the input arrays", () => {
    const existing = ["Stripe"];
    const added = ["Anthropic"];
    unionCompanyNames(existing, added);
    expect(existing).toEqual(["Stripe"]);
    expect(added).toEqual(["Anthropic"]);
  });
});
