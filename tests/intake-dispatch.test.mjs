// tests/intake-dispatch.test.mjs — src/core/intake/dispatch.mjs's pure
// {lane, action, params} table. No I/O, no verb calls — just the lookup
// itself, including the one hard rule this milestone leans on hardest:
// status-update NEVER guesses an application id.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveIntakeDispatch } from "../src/core/intake/dispatch.mjs";

test("jd-text and job-url both dispatch to Lane B: run_skill evaluate-job", () => {
  for (const kind of ["jd-text", "job-url"]) {
    const result = resolveIntakeDispatch({ kind, entities: {}, trackerMatch: null });
    assert.deepEqual(result, { lane: "B", action: "run_skill", params: { skill: "evaluate-job" } });
  }
});

test("ISSUE-038 recruiter-email dispatches into the one workspace agent", () => {
  const result = resolveIntakeDispatch({
    kind: "recruiter-email",
    entities: {},
    trackerMatch: null,
  });
  assert.deepEqual(result, {
    lane: "W",
    action: "workspace_intent",
    params: { intentType: "communication.capture-inbound" },
  });
});

test("interview-transcript requires an unambiguous application before entering workspace-main", () => {
  const unmatched = resolveIntakeDispatch({
    kind: "interview-transcript",
    entities: {},
    trackerMatch: null,
  });
  assert.equal(unmatched.action, "needs_you");

  const matched = resolveIntakeDispatch({
    kind: "interview-transcript",
    entities: { interviewDate: "2030-01-08T15:00:00.000Z" },
    trackerMatch: {
      matched: true,
      recordType: "application",
      id: "app-1",
      confidence: "company_role",
    },
  });
  assert.deepEqual(matched, {
    lane: "W",
    action: "workspace_intent",
    params: { intentType: "interview.capture-context" },
  });
});

test("status-update with an unambiguous exact_req_id application match dispatches to Lane A", () => {
  const trackerMatch = {
    matched: true,
    recordType: "application",
    id: "app-1",
    confidence: "exact_req_id",
  };
  const result = resolveIntakeDispatch({
    kind: "status-update",
    entities: { statusTo: "rejected", statusNote: "heard back today" },
    trackerMatch,
  });
  assert.deepEqual(result, {
    lane: "A",
    action: "app_set_status",
    params: {
      applicationId: "app-1",
      to: "rejected",
      note: "heard back today",
      matchedCompany: null,
      matchedRole: null,
      matchedSummary: null,
    },
  });
});

test("status-update accepts exact_url, company_role, and company_unique confidences too", () => {
  for (const confidence of ["exact_url", "company_role", "company_unique"]) {
    const trackerMatch = { matched: true, recordType: "application", id: "app-2", confidence };
    const result = resolveIntakeDispatch({
      kind: "status-update",
      entities: { statusTo: "offer" },
      trackerMatch,
    });
    assert.equal(result.lane, "A");
    assert.equal(result.params.applicationId, "app-2");
  }
});

test("status-update: company_unique match carries matchedCompany/matchedRole/matchedSummary through for the confirm-time preview", () => {
  const trackerMatch = {
    matched: true,
    recordType: "application",
    id: "demo-app-1",
    confidence: "company_unique",
    company: "E Corp",
    role: "Staff Software Engineer",
    status: "applied",
    summary:
      "You already applied to E Corp — Staff Software Engineer on 2026-06-01. Current status: applied.",
  };
  const result = resolveIntakeDispatch({
    kind: "status-update",
    entities: { statusTo: "rejected", statusNote: "passed after final round, filled internally" },
    trackerMatch,
  });
  assert.deepEqual(result, {
    lane: "A",
    action: "app_set_status",
    params: {
      applicationId: "demo-app-1",
      to: "rejected",
      note: "passed after final round, filled internally",
      matchedCompany: "E Corp",
      matchedRole: "Staff Software Engineer",
      matchedSummary: trackerMatch.summary,
    },
  });
});

test("status-update: no trackerMatch at all -> needs_you (never guesses)", () => {
  const result = resolveIntakeDispatch({
    kind: "status-update",
    entities: { statusTo: "rejected" },
  });
  assert.equal(result.lane, null);
  assert.equal(result.action, "needs_you");
  assert.match(result.params.reason, /never guess/);
});

test("status-update: trackerMatch present but matched:false -> needs_you", () => {
  const result = resolveIntakeDispatch({
    kind: "status-update",
    entities: { statusTo: "rejected" },
    trackerMatch: { matched: false, recordType: null, id: null, confidence: null },
  });
  assert.equal(result.action, "needs_you");
});

test("status-update: trackerMatch matched but recordType is 'sourced' (not an application) -> needs_you", () => {
  const result = resolveIntakeDispatch({
    kind: "status-update",
    entities: { statusTo: "rejected" },
    trackerMatch: {
      matched: true,
      recordType: "sourced",
      id: "sourced-1",
      confidence: "exact_url",
    },
  });
  assert.equal(result.action, "needs_you");
});

test("status-update: trackerMatch matched with an unrecognized confidence label -> needs_you", () => {
  const result = resolveIntakeDispatch({
    kind: "status-update",
    entities: { statusTo: "rejected" },
    trackerMatch: {
      matched: true,
      recordType: "application",
      id: "app-3",
      confidence: "fuzzy_guess",
    },
  });
  assert.equal(result.action, "needs_you");
});

test("'other' kind always -> needs_you", () => {
  const result = resolveIntakeDispatch({ kind: "other", entities: {} });
  assert.equal(result.lane, null);
  assert.equal(result.action, "needs_you");
});

test("an unrecognized kind -> needs_you with a message naming the kind", () => {
  const result = resolveIntakeDispatch({ kind: "not-a-real-kind", entities: {} });
  assert.equal(result.action, "needs_you");
  assert.match(result.params.reason, /not-a-real-kind/);
});

test("missing kind entirely -> needs_you (the default-case branch)", () => {
  const result = resolveIntakeDispatch({});
  assert.equal(result.action, "needs_you");
});
