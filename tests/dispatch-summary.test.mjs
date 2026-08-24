// tests/dispatch-summary.test.mjs — src/core/intake/dispatch-summary.mjs's
// summarizeDispatch(), extracted (M10) out of src/cli/intake-route.mjs so it
// has exactly one implementation shared by the confirm-time activity-log
// title AND every intake API response's `dispatchSummary` field (capture,
// list, one, classify — see intake-route.mjs's withDispatchSummary()).
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeDispatch } from "../src/core/intake/dispatch-summary.mjs";

test("summarizeDispatch: null/undefined dispatch summarizes to null", () => {
  assert.equal(summarizeDispatch(null), null);
  assert.equal(summarizeDispatch(undefined), null);
});

test("summarizeDispatch: app_set_status prefers matchedCompany — matchedRole over the bare applicationId", () => {
  const summary = summarizeDispatch({
    lane: "A",
    action: "app_set_status",
    params: {
      applicationId: "app-1",
      to: "rejected",
      matchedCompany: "E Corp",
      matchedRole: "Staff Software Engineer",
    },
  });
  assert.equal(summary, 'update E Corp, Staff Software Engineer status to "rejected"');
});

test("summarizeDispatch: app_set_status falls back to the bare applicationId when matchedCompany/matchedRole are absent", () => {
  const summary = summarizeDispatch({
    lane: "A",
    action: "app_set_status",
    params: { applicationId: "app-1", to: "interview" },
  });
  assert.equal(summary, 'update app-1 status to "interview"');
});

test("summarizeDispatch: run_skill (Lane B)", () => {
  const summary = summarizeDispatch({
    lane: "B",
    action: "run_skill",
    params: { skill: "evaluate-job" },
  });
  assert.equal(summary, "run evaluate-job");
});

test("ISSUE-038 summarizeDispatch names a workspace-agent intent without implying another chat", () => {
  const summary = summarizeDispatch({
    lane: "W",
    action: "workspace_intent",
    params: { intentType: "communication.capture-inbound" },
  });
  assert.equal(summary, "capture the recruiter message in your workspace conversation");
});

test("summarizeDispatch keeps interview intake in the workspace conversation", () => {
  const summary = summarizeDispatch({
    lane: "W",
    action: "workspace_intent",
    params: { intentType: "interview.capture-context" },
  });
  assert.equal(summary, "capture this interview context in your workspace conversation");
});

test("summarizeDispatch describes standalone tailoring without implying application", () => {
  const summary = summarizeDispatch({
    lane: "W",
    action: "workspace_intent",
    params: { intentType: "job.tailor-request" },
  });
  assert.equal(summary, "capture, evaluate, and tailor documents for this job in your workspace");
});

test("summarizeDispatch: an unrecognized action falls back to the bare action string", () => {
  const summary = summarizeDispatch({ lane: null, action: "needs_you", params: { reason: "x" } });
  assert.equal(summary, "needs_you");
});
