// apps/web/src/onboarding/patchFields.test.js
// vitest coverage for flattenPatchLeaves, the pure helper ConfirmPill uses to
// render WHAT a candidate_patch confirm block is about to save.

import { describe, expect, it } from "vitest";
import { flattenPatchLeaves } from "./patchFields.js";

describe("flattenPatchLeaves", () => {
  it("flattens a single-level nested patch into humanized leaf path/value pairs", () => {
    expect(
      flattenPatchLeaves({ candidate: { full_name: "Ada Lovelace", email: "ada@example.com" } })
    ).toEqual([
      { path: ["candidate", "full_name"], label: "Full name", value: "Ada Lovelace" },
      { path: ["candidate", "email"], label: "Email", value: "ada@example.com" },
    ]);
  });

  it("walks arbitrarily deep nesting, keeping the full path but labeling only the leaf key", () => {
    expect(flattenPatchLeaves({ location: { home: { city: "Austin" } } })).toEqual([
      { path: ["location", "home", "city"], label: "City", value: "Austin" },
    ]);
  });

  it("treats arrays as leaves (comma-joined), never recursing element-wise", () => {
    expect(flattenPatchLeaves({ tracked_companies: ["Stripe", "Anthropic"] })).toEqual([
      { path: ["tracked_companies"], label: "Tracked companies", value: "Stripe, Anthropic" },
    ]);
  });

  it("renders booleans as Yes/No", () => {
    expect(flattenPatchLeaves({ requires_sponsorship: false })).toEqual([
      { path: ["requires_sponsorship"], label: "Requires sponsorship", value: "No" },
    ]);
  });

  it("renders null/undefined leaves as an empty string rather than 'null'/'undefined'", () => {
    expect(flattenPatchLeaves({ phone: null })).toEqual([
      { path: ["phone"], label: "Phone", value: "" },
    ]);
  });

  it("returns an empty array for an empty or non-object patch", () => {
    expect(flattenPatchLeaves({})).toEqual([]);
    expect(flattenPatchLeaves(null)).toEqual([]);
    expect(flattenPatchLeaves(undefined)).toEqual([]);
    expect(flattenPatchLeaves("not an object")).toEqual([]);
  });
});
