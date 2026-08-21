// tests/skill-shape-qa.test.mjs — deterministic, AI-free shape coverage for
// scripts/eval/skill-shape-qa.mjs's four lanes, matching tests/schema-
// validator.test.mjs's style: a known-good fixture per schema plus at least
// two deliberately malformed fixtures that each fail for a distinct,
// asserted reason. No AI calls here — the real end-to-end lanes (one real AI
// call each) live only in scripts/eval/skill-shape-qa.mjs itself, run
// manually or by dispatch, never in CI.
import assert from "node:assert/strict";
import test from "node:test";
import { SINGLE_ROLE_SCHEMA } from "../scripts/eval/lib/single-role-schema.mjs";
import { LANES } from "../scripts/eval/skill-shape-qa.mjs";
import { coachingPlanSchema } from "../src/core/coaching/schemas.mjs";
import { validateCompanyHealth } from "../src/core/db/verbs/company-health.mjs";
import { packetGateAiVerdictSchema } from "../src/core/packet/schemas/packet-schemas.mjs";
import { formatErrors, validate } from "../src/core/profile/schema-validator.mjs";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makePacketVerdict(overrides = {}) {
  return {
    gate: "keep",
    fitScore: 82,
    fitSummary: "Strong overlap with the candidate's forward-deployed AI experience.",
    compensation: {
      status: "clears-floor",
      currency: "USD",
      minBase: 190000,
      maxBase: 230000,
      source: "job-description",
      summary: "$190K-$230K base clears the remote floor.",
    },
    action: "apply-now",
    fitReasons: ["Direct RAG production experience", "Customer-facing deployment track record"],
    fitRisks: ["No formal EM title on record"],
    confidence: "high",
    ...overrides,
  };
}

function makeCoachingPlan(overrides = {}) {
  return {
    gaps: [
      {
        gapText: "No direct Kubernetes production experience on record",
        suggestion: {
          kind: "no-close-path",
          draftClaim: null,
          rationale: "Nothing on record honestly closes this gap; flag it for manual review.",
        },
      },
    ],
    ...overrides,
  };
}

function makeSingleRoleTriage(overrides = {}) {
  return {
    fit_score: 78,
    fit_bucket: "high",
    fit_basis: "triage",
    rule_flags: [],
    source_evidence: "Title matches the Applied AI Engineer role bucket.",
    ...overrides,
  };
}

function makeCompanyHealth(overrides = {}) {
  return {
    rating: "healthy",
    forFunction: "Staff ML Engineering",
    asOf: "2026-08-20",
    provenance: "built-from-data",
    crossCut: [],
    fitDelta: 0,
    dimensions: {
      layoffRisk: { level: "good", note: "No layoffs reported in the last 18 months." },
      hiringMomentum: { level: "good", note: "Open reqs growing for the target function." },
    },
    rationale: "No function-scoped risk signals found; hiring and financials hold up.",
    signals: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lane 1 — evaluate-job / packet-gate verdict → packetGateAiVerdictSchema
// ---------------------------------------------------------------------------

test("evaluate-job verdict: known-good fixture passes packetGateAiVerdictSchema", () => {
  const result = validate(makePacketVerdict(), packetGateAiVerdictSchema);
  assert.equal(result.valid, true, formatErrors(result.errors));
});

test("evaluate-job verdict: wrong gate enum value fails", () => {
  const data = makePacketVerdict({ gate: "maybe" });
  const result = validate(data, packetGateAiVerdictSchema);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) => error.path === "gate" && /not one of the allowed values/.test(error.message)
    ),
    `expected a gate enum error, got: ${JSON.stringify(result.errors)}`
  );
});

test("evaluate-job verdict: fitScore over its 0-100 cap fails", () => {
  // schema-validator.mjs's supported keyword subset enforces numeric
  // minimum/maximum but not array minItems/maxItems (verified directly: an
  // over-length array against a maxItems schema comes back valid:true) — so
  // this schema's "over-cap" case is exercised through fitScore's numeric
  // maximum:100, the one cap keyword the validator actually checks, rather
  // than fitReasons/fitRisks' unenforced maxItems:3.
  const data = makePacketVerdict({ fitScore: 150 });
  const result = validate(data, packetGateAiVerdictSchema);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) => error.path === "fitScore" && /must be at most 100/.test(error.message)
    ),
    `expected a fitScore maximum error, got: ${JSON.stringify(result.errors)}`
  );
});

// ---------------------------------------------------------------------------
// Lane 2 — coach-gaps plan → coachingPlanSchema
// ---------------------------------------------------------------------------

test("coach-gaps plan: known-good fixture passes coachingPlanSchema", () => {
  const result = validate(makeCoachingPlan(), coachingPlanSchema);
  assert.equal(result.valid, true, formatErrors(result.errors));
});

test("coach-gaps plan: wrong suggestion.kind enum value fails", () => {
  const data = makeCoachingPlan();
  data.gaps[0].suggestion.kind = "guaranteed-fix";
  const result = validate(data, coachingPlanSchema);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "gaps[0].suggestion.kind" &&
        /not one of the allowed values/.test(error.message)
    ),
    `expected a suggestion.kind enum error, got: ${JSON.stringify(result.errors)}`
  );
});

test("coach-gaps plan: extra property under additionalProperties:false fails", () => {
  const data = makeCoachingPlan();
  data.gaps[0].suggestion.confidence = "very high";
  const result = validate(data, coachingPlanSchema);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.message.includes("unexpected property") && error.message.includes("confidence")
    ),
    `expected an unexpected-property error, got: ${JSON.stringify(result.errors)}`
  );
});

test("coach-gaps plan: missing required gapText fails", () => {
  const data = makeCoachingPlan();
  delete data.gaps[0].gapText;
  const result = validate(data, coachingPlanSchema);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.path === "gaps[0]" && /missing required property "gapText"/.test(error.message)
    ),
    `expected a missing-gapText error, got: ${JSON.stringify(result.errors)}`
  );
});

// ---------------------------------------------------------------------------
// Lane 3 — search-jobs coarse triage → SINGLE_ROLE_SCHEMA
// ---------------------------------------------------------------------------

test("search-jobs triage: known-good fixture passes SINGLE_ROLE_SCHEMA", () => {
  const result = validate(makeSingleRoleTriage(), SINGLE_ROLE_SCHEMA);
  assert.equal(result.valid, true, formatErrors(result.errors));
});

test("search-jobs triage: wrong fit_bucket enum value fails", () => {
  const data = makeSingleRoleTriage({ fit_bucket: "amazing" });
  const result = validate(data, SINGLE_ROLE_SCHEMA);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) => error.path === "fit_bucket" && /not one of the allowed values/.test(error.message)
    ),
    `expected a fit_bucket enum error, got: ${JSON.stringify(result.errors)}`
  );
});

test("search-jobs triage: extra property under additionalProperties:false fails", () => {
  const data = makeSingleRoleTriage({ confidence: "certain" });
  const result = validate(data, SINGLE_ROLE_SCHEMA);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.message.includes("unexpected property") && error.message.includes("confidence")
    ),
    `expected an unexpected-property error, got: ${JSON.stringify(result.errors)}`
  );
});

// ---------------------------------------------------------------------------
// Lane 4 — company-health rating → validateCompanyHealth() (not schema-
// validator — a hand-written business-rule validator that throws with a
// stable `.code`, per src/core/db/verbs/company-health.mjs)
// ---------------------------------------------------------------------------

test("company-health rating: known-good fixture passes validateCompanyHealth()", () => {
  assert.doesNotThrow(() => validateCompanyHealth(makeCompanyHealth()));
});

test("company-health rating: wrong rating enum value throws BAD_HEALTH_RATING", () => {
  const data = makeCompanyHealth({ rating: "thriving" });
  assert.throws(
    () => validateCompanyHealth(data),
    (error) => error.code === "BAD_HEALTH_RATING"
  );
});

test("company-health rating: fitDelta outside the allowed range throws BAD_HEALTH_FIT_DELTA", () => {
  // fitDelta must be <= 0 and >= -20 (a small negative nudge, never positive) —
  // this is validateCompanyHealth()'s own cap-violation case, the equivalent
  // of the other schemas' maxItems/maxLength caps.
  const data = makeCompanyHealth({ fitDelta: 5 });
  assert.throws(
    () => validateCompanyHealth(data),
    (error) => error.code === "BAD_HEALTH_FIT_DELTA"
  );
});

// ---------------------------------------------------------------------------
// Lane table — --list enumerates all four lanes (imported directly, no spawn)
// ---------------------------------------------------------------------------

test("skill-shape-qa LANES: enumerates exactly the four AI-shaped lanes", () => {
  const names = LANES.map((lane) => lane.name);
  assert.deepEqual(names, ["evaluate-job", "coach-gaps", "search-jobs", "company-health"]);
  for (const lane of LANES) {
    assert.equal(typeof lane.description, "string");
    assert.ok(lane.description.length > 0);
    assert.equal(typeof lane.schema, "object");
    assert.equal(typeof lane.buildPrompt, "function");
    assert.equal(typeof lane.check, "function");
  }
});
