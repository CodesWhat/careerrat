import assert from "node:assert/strict";
import test from "node:test";

import { buildOutcomeSummary, classifyRoleFamily } from "../src/core/tracker/outcome-analysis.mjs";

// ---------------------------------------------------------------------------
// Fixtures: targeting configs with explicit role_families or role_buckets
// ---------------------------------------------------------------------------

const techTargeting = {
  role_families: [
    { name: "fde", patterns: ["forward deployed", "deployed engineer", "field engineer", "fde"] },
    {
      name: "solutions",
      patterns: ["solutions engineer", "sales engineer", "solutions architect"],
    },
    { name: "iam-security", patterns: ["iam", "identity", "security"] },
    { name: "applied-ai", patterns: ["applied ai", "ai workflows", "agent", "llm", "genai"] },
  ],
};

// ---------------------------------------------------------------------------
// classifyRoleFamily — config-driven tiers
// ---------------------------------------------------------------------------

test("classifies role families when targeting.role_families is provided", () => {
  assert.equal(classifyRoleFamily("Forward Deployed Engineer, Applied AI", techTargeting), "fde");
  assert.equal(classifyRoleFamily("AI Solutions Engineer", techTargeting), "solutions");
  assert.equal(classifyRoleFamily("Staff Security Engineer, IAM", techTargeting), "iam-security");
  assert.equal(classifyRoleFamily("Software Engineer, AI Workflows", techTargeting), "applied-ai");
});

test("classifies via role_buckets when role_families is absent", () => {
  const targeting = {
    role_buckets: [
      { name: "Nursing", titles: ["Bedside RN", "Travel Nurse", "ICU RN"] },
      { name: "Admin", titles: ["Nurse Manager", "Director of Nursing"] },
    ],
  };
  assert.equal(classifyRoleFamily("Bedside RN", targeting), "nursing");
  assert.equal(classifyRoleFamily("Director of Nursing", targeting), "admin");
  assert.equal(classifyRoleFamily("Something Else", targeting), "other");
});

// ---------------------------------------------------------------------------
// classifyRoleFamily — neutral slug fallback (no targeting config)
// ---------------------------------------------------------------------------

test("returns neutral slug from role title when no targeting config is supplied", () => {
  assert.equal(classifyRoleFamily("Bedside RN"), "bedside-rn");
  assert.equal(classifyRoleFamily("Forward Deployed Engineer"), "forward-deployed-engineer");
  assert.equal(
    classifyRoleFamily("Software Engineer, AI Workflows"),
    "software-engineer-ai-workflows"
  );
  assert.equal(classifyRoleFamily("Product Manager"), "product-manager");
});

test("returns uncategorized for empty/blank role when no targeting config is supplied", () => {
  assert.equal(classifyRoleFamily(""), "uncategorized");
  assert.equal(classifyRoleFamily("   "), "uncategorized");
  assert.equal(classifyRoleFamily(), "uncategorized");
});

// The `role = ""` default parameter only covers an omitted/undefined arg. A
// row that stores role as an explicit null (not just missing) reaches
// classifyRoleFamily with that exact value — and every outcome-changing verb
// (appUpsert/appSetStatus/...) classifies every applications row inside one
// shared transaction, so this must not throw: one bad row would otherwise
// wedge all future outcome-changing writes until hand-fixed.
test("is null-safe: an explicit role:null does not throw, with or without a targeting config", () => {
  assert.equal(classifyRoleFamily(null), "uncategorized");
  assert.equal(classifyRoleFamily(undefined), "uncategorized");
  assert.equal(classifyRoleFamily(null, techTargeting), "other");
});

test("neutral slug collapses runs of non-alphanumeric chars to single hyphen", () => {
  // Multiple separators → single "-"
  assert.equal(classifyRoleFamily("Sr. / Lead Engineer"), "sr-lead-engineer");
  // No leading or trailing hyphens
  assert.equal(classifyRoleFamily("  --Engineer--  "), "engineer");
});

// ---------------------------------------------------------------------------
// buildOutcomeSummary — config-driven (role_families provided)
// ---------------------------------------------------------------------------

test("builds outcome summaries from tracker entries with targeting config", () => {
  const summary = buildOutcomeSummary({
    apps: [
      {
        co: "Acme",
        role: "Forward Deployed Engineer",
        status: "awaiting",
        channel: "board",
        mode: "remote",
        score: 88,
      },
      {
        co: "Beta",
        role: "Staff Security Engineer IAM",
        status: "rejected",
        channel: "portal",
        mode: "remote",
        score: 60,
      },
      {
        co: "Gamma",
        role: "AI Solutions Engineer",
        status: "interview",
        channel: "referral",
        mode: "hybrid",
        score: 90,
      },
    ],
    sourced: [
      { co: "Delta", role: "Applied AI Engineer", channel: "board", mode: "remote", score: 84 },
    ],
    targeting: techTargeting,
  });

  assert.equal(summary.counts.apps, 3);
  assert.equal(summary.byStatus.awaiting, 1);
  assert.equal(summary.byStatus.interview, 1);
  assert.equal(summary.byRoleFamily.fde, 1);
  assert.equal(summary.byRoleFamily["iam-security"], 1);
  assert.equal(summary.topSourced[0].co, "Delta");
});

// ---------------------------------------------------------------------------
// buildOutcomeSummary — no targeting config → neutral slug families
// ---------------------------------------------------------------------------

test("builds outcome summaries with neutral slug families when no targeting config", () => {
  const summary = buildOutcomeSummary({
    apps: [
      { co: "Clinic A", role: "Bedside RN", status: "awaiting", channel: "board", mode: "onsite" },
      {
        co: "Clinic B",
        role: "Travel Nurse",
        status: "interview",
        channel: "referral",
        mode: "relo",
      },
      { co: "Clinic C", role: "Bedside RN", status: "rejected", channel: "board", mode: "onsite" },
    ],
    sourced: [{ co: "Hospital X", role: "ICU RN", channel: "board", mode: "onsite", score: 79 }],
  });

  assert.equal(summary.counts.apps, 3);
  // Families are neutral slugs from the role titles
  assert.equal(summary.byRoleFamily["bedside-rn"], 2);
  assert.equal(summary.byRoleFamily["travel-nurse"], 1);
  assert.equal(summary.sourcedFamilies["icu-rn"], 1);
  assert.equal(summary.topSourced[0].co, "Hospital X");
  assert.equal(summary.topSourced[0].family, "icu-rn");
});
