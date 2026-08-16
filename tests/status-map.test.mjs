// tests/status-map.test.mjs
// node:test coverage for src/core/automation/status-map.mjs — the
// raw-ATS-label → canonical-status normalizer and transition classifier that
// the sync-status skill (Phase 1 status polling) and workspace-agent's
// status.record-portal/status.apply-transition handlers both build on.

import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAtsStatus,
  statusTransition,
  toTrackOutcomeStatus,
} from "../src/core/automation/status-map.mjs";

// ---------------------------------------------------------------------------
// normalizeAtsStatus — one representative per ATS_STATUS_RULES bucket
// ---------------------------------------------------------------------------

test("normalizeAtsStatus: withdrawn bucket", () => {
  const result = normalizeAtsStatus("You withdrew your application for this role.");
  assert.equal(result.canonical, "withdrawn");
  assert.equal(result.confidence, "high");
  assert.equal(result.stage, "withdrawn");
});

test("normalizeAtsStatus: rejected bucket", () => {
  const result = normalizeAtsStatus(
    "We regret to inform you we are moving forward with other candidates."
  );
  assert.equal(result.canonical, "rejected");
  assert.equal(result.confidence, "high");
  assert.equal(result.stage, "rejected");
});

test("normalizeAtsStatus: offer bucket", () => {
  const result = normalizeAtsStatus(
    "Congratulations — we are pleased to say the offer letter is attached."
  );
  assert.equal(result.canonical, "offer");
  assert.equal(result.confidence, "high");
});

test("normalizeAtsStatus: interview bucket", () => {
  const result = normalizeAtsStatus("Please join us for your virtual onsite next week.");
  assert.equal(result.canonical, "interview");
  assert.equal(result.confidence, "high");
});

test("normalizeAtsStatus: assessment bucket", () => {
  const result = normalizeAtsStatus("Please complete this online assessment by Friday.");
  assert.equal(result.canonical, "assessment");
  assert.equal(result.confidence, "high");
});

test("normalizeAtsStatus: screen bucket", () => {
  const result = normalizeAtsStatus("We'd like to schedule a recruiter screen with you.");
  assert.equal(result.canonical, "screen");
  assert.equal(result.confidence, "high");
});

test("normalizeAtsStatus: reviewing bucket", () => {
  const result = normalizeAtsStatus("Your application is currently being reviewed.");
  assert.equal(result.canonical, "reviewing");
  assert.equal(result.confidence, "high");
});

test("normalizeAtsStatus: awaiting bucket", () => {
  const result = normalizeAtsStatus("Thank you for applying to this role.");
  assert.equal(result.canonical, "awaiting");
  assert.equal(result.confidence, "high");
});

// ---------------------------------------------------------------------------
// Ordering-sensitive cases the module comments call out
// ---------------------------------------------------------------------------

test("normalizeAtsStatus: 'no longer under consideration' maps to rejected, not awaiting", () => {
  const result = normalizeAtsStatus("You are no longer under consideration for this role.");
  assert.equal(result.canonical, "rejected");
});

test("normalizeAtsStatus: 'unable to offer'-style text maps to rejected, not offer", () => {
  const result = normalizeAtsStatus("We are unable to offer you the position at this time.");
  assert.equal(result.canonical, "rejected");
});

// ---------------------------------------------------------------------------
// Unrecognized / empty input
// ---------------------------------------------------------------------------

test("normalizeAtsStatus: unrecognized non-empty text defaults to awaiting at low confidence", () => {
  const result = normalizeAtsStatus("Xyzzy quantum flux capacitor status.");
  assert.equal(result.canonical, "awaiting");
  assert.equal(result.confidence, "low");
});

test("normalizeAtsStatus: empty string yields canonical null, confidence none", () => {
  const result = normalizeAtsStatus("");
  assert.equal(result.canonical, null);
  assert.equal(result.stage, null);
  assert.equal(result.round, null);
  assert.equal(result.confidence, "none");
});

test("normalizeAtsStatus: null yields canonical null, confidence none", () => {
  const result = normalizeAtsStatus(null);
  assert.equal(result.canonical, null);
  assert.equal(result.confidence, "none");
  assert.equal(result.raw, "");
});

// ---------------------------------------------------------------------------
// Round derivation
// ---------------------------------------------------------------------------

test("normalizeAtsStatus: a phone-screen label derives the recruiter-screen round", () => {
  const result = normalizeAtsStatus("Phone screen scheduled for Tuesday at 2pm.");
  assert.equal(result.canonical, "screen");
  assert.equal(result.round, "recruiter screen");
});

test("normalizeAtsStatus: an onsite label derives the onsite round", () => {
  const result = normalizeAtsStatus("Please join us for your virtual onsite next week.");
  assert.equal(result.round, "onsite");
});

test("normalizeAtsStatus: a label with no round match yields round null", () => {
  const result = normalizeAtsStatus("We received your application, thanks!");
  assert.equal(result.canonical, "awaiting");
  assert.equal(result.round, null);
});

// ---------------------------------------------------------------------------
// statusTransition
// ---------------------------------------------------------------------------

test("statusTransition: a confident forward step is autoApplicable and direction advance", () => {
  const result = statusTransition("applied", "Recruiter screen scheduled for Tuesday.");
  assert.equal(result.changed, true);
  assert.equal(result.direction, "advance");
  assert.equal(result.confidence, "high");
  assert.equal(result.autoApplicable, true);
  assert.equal(result.to, "screen");
});

test("statusTransition: a confident terminal outcome is autoApplicable and direction terminal", () => {
  const result = statusTransition(
    "interview",
    "We regret to inform you we are moving forward with other candidates."
  );
  assert.equal(result.changed, true);
  assert.equal(result.direction, "terminal");
  assert.equal(result.confidence, "high");
  assert.equal(result.autoApplicable, true);
  assert.equal(result.to, "rejected");
});

test("statusTransition: a step backward from the tracked stage is a regress and never autoApplicable", () => {
  const result = statusTransition("interview", "Application received");
  assert.equal(result.changed, true);
  assert.equal(result.direction, "regress");
  assert.equal(result.confidence, "high");
  assert.equal(result.autoApplicable, false);
});

test("statusTransition: a raw label that maps to the current stage is unchanged", () => {
  const result = statusTransition("applied", "Application submitted");
  assert.equal(result.changed, false);
  assert.equal(result.direction, "same");
});

test("statusTransition: low-confidence unrecognized text is never autoApplicable, even when it changes stage", () => {
  const result = statusTransition("reviewed-hold", "Zzyx quantum flux capacitor status.");
  assert.equal(result.changed, true);
  assert.equal(result.confidence, "low");
  assert.equal(result.autoApplicable, false);
});

test("statusTransition: empty raw yields canonical null and changed false", () => {
  const result = statusTransition("applied", "");
  assert.equal(result.canonical, null);
  assert.equal(result.changed, false);
  assert.equal(result.from, "applied");
  assert.equal(result.to, "applied");
  assert.equal(result.autoApplicable, false);
});

// ---------------------------------------------------------------------------
// toTrackOutcomeStatus
// ---------------------------------------------------------------------------

test("toTrackOutcomeStatus: maps the full canonical → track-outcome table", () => {
  assert.equal(toTrackOutcomeStatus("reviewing"), "awaiting");
  assert.equal(toTrackOutcomeStatus("screen"), "interview");
  assert.equal(toTrackOutcomeStatus("assessment"), "interview");
  assert.equal(toTrackOutcomeStatus("withdrawn"), "withdrawn");
  assert.equal(toTrackOutcomeStatus("rejected"), "rejected");
  assert.equal(toTrackOutcomeStatus("offer"), "offer");
  assert.equal(toTrackOutcomeStatus("interview"), "interview");
  assert.equal(toTrackOutcomeStatus("awaiting"), "awaiting");
});

test("toTrackOutcomeStatus: null and unknown canonical values map to null", () => {
  assert.equal(toTrackOutcomeStatus(null), null);
  assert.equal(toTrackOutcomeStatus("final"), null);
  assert.equal(toTrackOutcomeStatus("sourced"), null);
});

test("statusTransition: manual-apply → applied is an advance, not a regress", () => {
  // manual-apply sits above applied on the display ladder (1.5 vs 1), but a
  // portal confirming the application is submitted means the manual
  // submission landed — forward progress, eligible to auto-apply.
  const result = statusTransition("manual-apply", "Application received");
  assert.equal(result.from, "manual-apply");
  assert.equal(result.to, "applied");
  assert.equal(result.direction, "advance");
  assert.equal(result.autoApplicable, true);

  // The special case is scoped to manual-apply: a real backward move from a
  // later stage still surfaces as a regress for human review.
  const regress = statusTransition("interview", "Application received");
  assert.equal(regress.direction, "regress");
  assert.equal(regress.autoApplicable, false);
});
