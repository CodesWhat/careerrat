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

describe("relativeSeniority generic level fallback", () => {
  const withCeiling = {
    role_buckets: [
      {
        name: "Engineering",
        titles: ["Platform Engineer"],
        seniority_ceiling: 30,
        seniority_ladder: [
          { rank: 20, titles: ["Platform Engineer"] },
          { rank: 30, titles: ["Staff Platform Engineer"] },
        ],
      },
    ],
  };

  it("treats executive words as above the ceiling when the ladder does not list them", () => {
    for (const title of [
      "VP, Customer Success",
      "Vice President of Operations",
      "SVP Sales",
      "Chief Revenue Officer",
      "CFO",
      "Head of Support",
      "Director of Operations",
    ]) {
      assert.equal(relativeSeniority(title, withCeiling).classification, "above-target", title);
    }
  });

  it("treats entry-level words as below the lowest wanted rank", () => {
    for (const title of [
      "Summer Intern",
      "New Grad RN Residency - ICU",
      "Graduate Program, Finance",
      "Apprentice Technician",
      "Junior Analyst",
      "Entry-Level Associate",
      "Associate Analyst",
    ]) {
      assert.equal(relativeSeniority(title, withCeiling).classification, "below-target", title);
    }
  });

  it("lets ladder entries win over the fallback", () => {
    const ladder = {
      role_buckets: [
        {
          titles: ["Associate Product Manager"],
          seniority_ceiling: 40,
          seniority_ladder: [
            { rank: 10, titles: ["Associate Product Manager"] },
            { rank: 20, titles: ["Product Manager"] },
            { rank: 40, titles: ["Director of Product"] },
            { rank: 50, titles: ["VP of Product"] },
          ],
        },
      ],
    };
    assert.equal(
      relativeSeniority("Associate Product Manager", ladder).classification,
      "at-or-above-target"
    );
    assert.equal(
      relativeSeniority("Director of Product", ladder).classification,
      "at-or-above-target"
    );
    assert.equal(relativeSeniority("VP of Product", ladder).classification, "above-target");
    // The ladder uses "associate" and "director", so those words are the candidate's.
    assert.equal(
      relativeSeniority("Associate Director, Growth", ladder).classification,
      "unclassified"
    );
  });

  it("skips executive words when no ceiling is configured, but still cuts entry level", () => {
    const noCeiling = {
      role_buckets: [{ ...withCeiling.role_buckets[0], seniority_ceiling: undefined }],
    };
    assert.equal(
      relativeSeniority("VP, Customer Success", noCeiling).classification,
      "unclassified"
    );
    assert.equal(relativeSeniority("Intern, Platform", noCeiling).classification, "below-target");
  });

  it("does nothing without a ladder", () => {
    const bare = { role_buckets: [{ titles: ["Platform Engineer"] }] };
    assert.equal(relativeSeniority("VP, Customer Success", bare).classification, "unclassified");
  });

  it("does not match level words inside other words", () => {
    assert.equal(
      relativeSeniority("Internal Tools Engineer", withCeiling).classification,
      "unclassified"
    );
    assert.equal(
      relativeSeniority("Directory Services Engineer", withCeiling).classification,
      "unclassified"
    );
  });
});
