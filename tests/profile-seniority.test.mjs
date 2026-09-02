import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { relativeSeniority, titlesBelowTarget } from "../src/core/profile/seniority.mjs";

const TARGETING = {
  role_buckets: [
    {
      name: "Engineering",
      titles: ["Platform Engineer"],
      seniority_ladder: [
        { rank: 20, titles: ["Platform Engineer"] },
        { rank: 30, titles: ["Staff Platform Engineer"] },
      ],
    },
  ],
};

describe("relativeSeniority title matching", () => {
  it("matches a contiguous higher-rung title", () => {
    const result = relativeSeniority("Staff Platform Engineer", TARGETING);
    assert.equal(result.rank, 30);
    assert.equal(result.classification, "at-or-above-target");
  });

  it("matches the same rung rendered as 'Role, Level'", () => {
    const result = relativeSeniority("Platform Engineer, Staff", TARGETING);
    assert.equal(result.rank, 30);
    assert.equal(result.classification, "at-or-above-target");
  });

  it("matches the same rung rendered as 'Role (Level)'", () => {
    const result = relativeSeniority("Platform Engineer (Staff)", TARGETING);
    assert.equal(result.rank, 30);
    assert.equal(result.classification, "at-or-above-target");
  });

  it("matches the base rung with no level word", () => {
    const result = relativeSeniority("Platform Engineer", TARGETING);
    assert.equal(result.rank, 20);
    assert.equal(result.classification, "at-or-above-target");
  });

  it("does not promote a title missing the level word to the higher rung", () => {
    const result = relativeSeniority("Associate Platform Engineer", TARGETING);
    assert.equal(result.rank, 20);
  });

  it("does not promote a trailing modifier title to the higher rung", () => {
    const result = relativeSeniority("Platform Engineer Intern", TARGETING);
    assert.equal(result.rank, 20);
  });

  it("does not match an unrelated title that only shares a word with the higher rung", () => {
    const result = relativeSeniority("Engineering Manager, Platform", TARGETING);
    assert.equal(result.classification, "unclassified");
  });
});

const SENIOR_ENGINEER_TARGETING = {
  role_buckets: [
    {
      name: "Engineering",
      titles: ["Engineer"],
      seniority_ladder: [
        { rank: 20, titles: ["Engineer"] },
        { rank: 30, titles: ["Senior Engineer"] },
      ],
    },
  ],
};

describe("relativeSeniority does not interleave words across unrelated segments", () => {
  it("does not promote a title where 'senior' only modifies an unrelated manager", () => {
    const result = relativeSeniority(
      "Engineer reporting to a Senior Manager",
      SENIOR_ENGINEER_TARGETING
    );
    assert.equal(result.rank, 20);
  });

  it("does not promote a title where 'senior' and 'engineer' sit in different segments", () => {
    const result = relativeSeniority(
      "Senior Manager, Engineer Enablement",
      SENIOR_ENGINEER_TARGETING
    );
    assert.equal(result.rank, 20);
  });

  it("does not promote a single-segment title where the words are out of order and non-adjacent", () => {
    const result = relativeSeniority(
      "Junior Engineer supporting Senior staff",
      SENIOR_ENGINEER_TARGETING
    );
    assert.equal(result.rank, 20);
  });

  it("still matches the contiguous higher rung", () => {
    const result = relativeSeniority("Senior Engineer", SENIOR_ENGINEER_TARGETING);
    assert.equal(result.rank, 30);
  });

  it("still matches the higher rung reordered across a comma", () => {
    const result = relativeSeniority("Engineer, Senior", SENIOR_ENGINEER_TARGETING);
    assert.equal(result.rank, 30);
  });
});

describe("titlesBelowTarget", () => {
  it("lists titles below the bucket's minimum configured rank", () => {
    const { configured, titles } = titlesBelowTarget(TARGETING);
    assert.equal(configured, true);
    assert.deepEqual(titles, []);
  });

  it("lists lower-rung titles when the bucket targets the higher rung", () => {
    const targeting = {
      role_buckets: [
        {
          name: "Engineering",
          titles: ["Staff Platform Engineer"],
          seniority_ladder: [
            { rank: 20, titles: ["Platform Engineer"] },
            { rank: 30, titles: ["Staff Platform Engineer"] },
          ],
        },
      ],
    };
    const { configured, titles } = titlesBelowTarget(targeting);
    assert.equal(configured, true);
    assert.deepEqual(titles, ["Platform Engineer"]);
  });
});
