// verbs/app.mjs — applications[] domain actions.
//
// Every export here is the ONE shared write path (decision 6): the CLI
// (src/cli/data.mjs) and the HTTP route (src/cli/data-route.mjs) both call
// these exact functions, never reimplementing the SQL. Each is built on
// runVerb() (verbs/shared.mjs), so each is exactly one BEGIN IMMEDIATE ...
// COMMIT: state change + meta bump + activity event, then (outside the
// transaction) an export back to tracker.json/activity.jsonl.
//
// "Outcome-changing" (per AGENTS.md's Tracker Write Contract: new
// applications, status transitions, rejections, advances) verbs ALSO refresh
// the persisted analytics block, WITHOUT bumping the freshness stamp a second
// time (decision 4) — that's appUpsert and appSetStatus here. appSetFields/
// appScheduleInterview/appRegisterArtifact are comms/scheduling/artifact-style
// writes (like email-comms/schedule-meeting/tailor-application) and do not.

import { packetManifestSchema } from "../../packet/schemas/packet-schemas.mjs";
import { validate } from "../../profile/schema-validator.mjs";
import { classifyStage, isKnownStatusLabel } from "../../tracker/dashboard.mjs";
import { buildReevaluationAnalytics } from "../../tracker/outcome-analysis.mjs";
import { requireDb } from "../connection.mjs";
import { completeSubmitGatesForApplicationInDb, ensureJobThreadInDb } from "./chat-first.mjs";
import {
  bumpMeta,
  getRow,
  logActivityEvent,
  nowIso,
  putRow,
  refreshAnalyticsInDb,
  requireRow,
  runVerb,
} from "./shared.mjs";

function requireApp(db, id) {
  return requireRow(db, "applications", id, "application");
}

const APP_SETTABLE_FIELDS = new Set([
  "artifacts",
  "sourceMeta",
  "link",
  "coachingPlan",
  "nextAction",
  "nextActionDue",
  "statusUrl",
  "statusPlatform",
  "followUp",
  "priority",
  "statusNote",
  "compNote",
  "roleFit",
  "compensation",
  "loc",
  "mode",
  "base",
  "tc",
  "ask",
  "compEstimate",
  "benefits",
  "sub",
  "warn",
  "note",
  "domain",
  "channel",
]);

function assertSettableApplicationFields(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("appSetFields: patch must be an object");
  }
  const forbidden = Object.keys(patch).filter((key) => !APP_SETTABLE_FIELDS.has(key));
  if (forbidden.length) {
    const error = new Error(
      `appSetFields: unsupported or protected field${forbidden.length === 1 ? "" : "s"}: ${forbidden.join(", ")}`
    );
    error.code = "APP_FIELDS_FORBIDDEN";
    error.details = { fields: forbidden };
    throw error;
  }
}

function refreshAnalytics(db, now = new Date()) {
  return refreshAnalyticsInDb(db, { buildReevaluationAnalytics, now });
}

function validatePacketManifest(manifest) {
  const result = validate(manifest, packetManifestSchema);
  if (!result.valid) {
    const err = new Error("packet manifest is invalid");
    err.code = "BAD_PACKET_MANIFEST";
    err.details = result.errors;
    throw err;
  }
}

function assertWorkspacePath(path, key) {
  const value = String(path || "");
  if (!value.startsWith("workspace/") || value.includes("\0") || value.includes("../")) {
    const err = new Error(`packet artifact ${key} must be a workspace-relative path`);
    err.code = "BAD_PACKET_ARTIFACT";
    throw err;
  }
}

function assertInterviewCapturePath(path) {
  const value = String(path || "");
  if (!value) return null;
  if (!value.startsWith("workspace/") || value.includes("\0") || value.includes("../")) {
    const err = new Error("interview intake artifact must be a workspace-relative path");
    err.code = "BAD_INTERVIEW_ARTIFACT";
    throw err;
  }
  return value;
}

function interviewLogisticsNote(at, who) {
  const formatted = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(at));
  const firstName = String(who || "")
    .trim()
    .split(/\s+/)[0];
  return `Interview: ${formatted}${firstName ? ` with ${firstName}` : ""}`.slice(0, 60);
}

// appUpsert({row}) — full-row insert/replace (capture-intake shape): a brand
// new application row, or a wholesale replace of an existing one by id.
export function appUpsert({ repoRoot, env, row } = {}) {
  if (!row?.id) throw new Error("appUpsert: row.id is required");
  return runVerb({ repoRoot, env }, (db) => {
    const existed = Boolean(getRow(db, "applications", row.id));
    putRow(db, "applications", row.id, row);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: existed ? "status_change" : "applied",
      title: `${row.company || row.id}: ${row.role || "application"} ${existed ? "updated" : "captured"}`,
      refs: { applicationId: row.id, company: row.company, role: row.role },
    });
    const analytics = refreshAnalytics(db);
    return { id: row.id, meta, event, analytics };
  });
}

// AGENTS.md's Tracker Write Contract, "On round completion" (transitioning OUT
// of `interview`): null nextInterviewAt + interviewNote always; null
// interviewAt too only when this was the LAST scheduled round (no
// nextInterviewAt was already booked ahead of it) — see track-outcomes
// SKILL.md STEP 2. `clearInterview` lets a caller force this even when `to`
// doesn't change the status string (e.g. staying "interview" while advancing
// to the next round) — the one case the automatic "leaving the interview
// stage" detection below can't see by itself.
function applyRoundCompletionClearing(app) {
  const hadNextRound = Boolean(app.nextInterviewAt);
  const patch = { nextInterviewAt: null, interviewNote: null };
  if (!hadNextRound) patch.interviewAt = null;
  return patch;
}

function activityStatusLabel(status) {
  const value = String(status || "unknown").toLowerCase();
  const labels = {
    "reviewed-hold": "Saved for review",
    "manual-apply": "Manual apply needed",
    applied: "Applied",
    awaiting: "Awaiting response",
    waiting: "Awaiting response",
    interview: "Interview",
    offer: "Offer",
    accepted: "Accepted",
    rejected: "Rejected",
    withdrawn: "Withdrawn",
    cut: "Archived",
  };
  return (
    labels[value] ||
    value.replace(/[-_]/g, " ").replace(/\b\w/g, (character) => character.toUpperCase())
  );
}

function statusProvesApplicationWasSubmitted(status) {
  if (!isKnownStatusLabel(status)) return false;
  return new Set(["applied", "screen", "interview", "final", "offer", "accepted", "rejected"]).has(
    classifyStage(status).id
  );
}

function reconcileSubmitGates(db, application) {
  if (!statusProvesApplicationWasSubmitted(application?.status)) {
    return { completedStepIds: [], completedMissionIds: [] };
  }
  return completeSubmitGatesForApplicationInDb(db, {
    applicationId: application.id,
    applicationStatus: application.status,
    appliedAt: application.appliedAt || null,
  });
}

function applyStatusUpdate(app, { to, note, round, appliedAt, followUpDueAt, clearInterview, at }) {
  const from = app.status;
  const wasInterview = classifyStage(from).id === "interview";
  const autoClear = clearInterview !== false && wasInterview && to !== from;
  const willClear = clearInterview === true || autoClear;
  const updated = { ...app, status: to };
  if (note) updated.statusNote = note;
  if (round) {
    const conversations = Array.isArray(app.conversations) ? app.conversations.slice() : [];
    conversations.push({
      date: at || nowIso(),
      kind: String(round).trim().slice(0, 60),
      who: null,
      notes: note || null,
    });
    updated.conversations = conversations;
  }
  if (appliedAt != null) updated.appliedAt = String(appliedAt);
  if (to === "applied") {
    updated.nextAction = null;
    updated.nextActionDue = null;
  }
  if (followUpDueAt) updated.followUp = { ...(app.followUp || {}), dueAt: followUpDueAt };
  if (willClear) Object.assign(updated, applyRoundCompletionClearing(app));
  return { from, updated };
}

// appSetStatus({id, to, note?, appliedAt?, followUpDueAt?, clearInterview?})
export function appSetStatus({
  repoRoot,
  env,
  id,
  to,
  note,
  round,
  appliedAt,
  followUpDueAt,
  clearInterview,
} = {}) {
  if (!to) throw new Error("appSetStatus: to is required");
  if (appliedAt != null && Number.isNaN(Date.parse(appliedAt))) {
    const error = new Error("appSetStatus: appliedAt must be an ISO date or datetime");
    error.code = "BAD_APPLIED_AT";
    throw error;
  }
  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const { from, updated } = applyStatusUpdate(app, {
      to,
      note,
      round,
      appliedAt,
      followUpDueAt,
      clearInterview,
    });

    putRow(db, "applications", id, updated);
    const submitGates = reconcileSubmitGates(db, updated);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "status_change",
      title: `${app.company || id}: Status changed to ${activityStatusLabel(to)}`,
      summary: `Previous status: ${activityStatusLabel(from)}.`,
      refs: { applicationId: id, company: app.company, role: app.role },
      tags: [`status:${to}`, "operation:application:status-update"],
    });
    const analytics = refreshAnalytics(db);
    return {
      id,
      from,
      to,
      appliedAt: updated.appliedAt || null,
      submitGates,
      meta,
      event,
      analytics,
    };
  });
}

const RECORDED_OUTCOME_STATUSES = new Set([
  "applied",
  "manual-apply",
  "awaiting",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
]);

function outcomeCommunicationStatus(status) {
  if (status === "rejected" || status === "withdrawn") return "closed";
  if (status === "applied" || status === "interview" || status === "offer") return "waiting";
  return null;
}

// A recorded application outcome owns the linked communication state too.
// Keeping both tables in one runVerb transaction prevents a terminal or
// advancing outcome from leaving stale reply actions and drafts in the app.
export function appRecordOutcome({ repoRoot, env, id, to, note, round, at } = {}) {
  if (!RECORDED_OUTCOME_STATUSES.has(to)) {
    const error = new Error("appRecordOutcome: unsupported outcome status");
    error.code = "BAD_OUTCOME_STATUS";
    throw error;
  }
  const timestamp = at || nowIso();
  if (Number.isNaN(Date.parse(timestamp))) {
    const error = new Error("appRecordOutcome: at must be an ISO date or datetime");
    error.code = "BAD_OUTCOME_AT";
    throw error;
  }

  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const { from, updated } = applyStatusUpdate(app, {
      to,
      note,
      round,
      at: timestamp,
      ...(to === "applied" ? { appliedAt: timestamp } : {}),
    });
    const communicationStatus = outcomeCommunicationStatus(to);
    if (communicationStatus && updated.followUp?.draft != null) {
      updated.followUp = { ...updated.followUp, draft: null };
    }
    putRow(db, "applications", id, updated);
    const submitGates = reconcileSubmitGates(db, updated);

    const clearedCommunicationIds = [];
    if (communicationStatus) {
      const rows = db
        .prepare("SELECT id, data FROM communications WHERE application_id = ? ORDER BY id")
        .all(id);
      for (const row of rows) {
        const communication = JSON.parse(row.data);
        const messages = Array.isArray(communication.messages)
          ? communication.messages.slice()
          : [];
        const summary = [
          `Application outcome recorded: ${activityStatusLabel(to)}.`,
          String(note || "").trim(),
        ]
          .filter(Boolean)
          .join(" ")
          .slice(0, 240);
        messages.push({
          id: `outcome:${timestamp}:${row.id}`,
          direction: "note",
          at: timestamp,
          summary,
        });
        putRow(
          db,
          "communications",
          row.id,
          {
            ...communication,
            status: communicationStatus,
            nextAction: null,
            nextActionDue: null,
            draft: null,
            messages,
          },
          { application_id: id }
        );
        clearedCommunicationIds.push(row.id);
      }
    }

    const meta = bumpMeta(db, timestamp);
    const event = logActivityEvent(
      db,
      {
        type: "status_change",
        title: `${app.company || id}: Status changed to ${activityStatusLabel(to)}`,
        summary: `Previous status: ${activityStatusLabel(from)}.`,
        refs: { applicationId: id, company: app.company, role: app.role },
        tags: [`status:${to}`, "operation:application:outcome-record"],
      },
      { now: new Date(timestamp) }
    );
    const analytics = refreshAnalytics(db, new Date(timestamp));
    return { id, from, to, clearedCommunicationIds, submitGates, meta, event, analytics };
  });
}

function statusSyncAction(value) {
  const text = String(value || "").toLowerCase();
  return (
    /\b(?:check|sync|verify|review|refresh)\b[^.!?]*\b(?:application )?(?:status|portal)\b/.test(
      text
    ) || /\b(?:status|portal)\b[^.!?]*\b(?:check|sync|verify|review|refresh)\b/.test(text)
  );
}

// Status-sync completion owns the application transition and every matching
// portal-check CTA in one transaction. This prevents a verified portal read
// from advancing the application while leaving a ghost communication draft or
// stale "check status" action behind.
export function appApplySyncedStatus({ repoRoot, env, id, to, rawStatus, round, at } = {}) {
  if (!to) throw new Error("appApplySyncedStatus: to is required");
  const timestamp = at || nowIso();
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error("appApplySyncedStatus: at must be an ISO datetime");
  }
  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const from = app.status;
    const note = String(rawStatus || `Portal status: ${to}`)
      .trim()
      .slice(0, 120);
    const updated = {
      ...app,
      status: to,
      statusNote: note,
    };
    if (statusSyncAction(app.nextAction)) {
      updated.nextAction = null;
      updated.nextActionDue = null;
    }
    if (round) {
      updated.conversations = [
        ...(Array.isArray(app.conversations) ? app.conversations : []),
        {
          date: timestamp,
          kind: String(round).trim().slice(0, 60),
          who: null,
          notes: note.slice(0, 200),
        },
      ];
    }
    const wasInterview = classifyStage(from).id === "interview";
    if (wasInterview && to !== from) Object.assign(updated, applyRoundCompletionClearing(app));
    putRow(db, "applications", id, updated);
    const submitGates = reconcileSubmitGates(db, updated);

    const clearedCommunicationIds = [];
    const commRows = db
      .prepare("SELECT id, data FROM communications WHERE application_id = ? ORDER BY id")
      .all(id);
    for (const row of commRows) {
      const communication = JSON.parse(row.data);
      if (
        !statusSyncAction(communication.nextAction) &&
        !statusSyncAction(communication.summary) &&
        !statusSyncAction(communication.subject)
      ) {
        continue;
      }
      const messages = Array.isArray(communication.messages) ? communication.messages.slice() : [];
      messages.push({
        id: `status-sync:${timestamp}:${row.id}`,
        direction: "note",
        at: timestamp,
        summary: `Verified portal status: ${note}`.slice(0, 240),
      });
      putRow(
        db,
        "communications",
        row.id,
        {
          ...communication,
          status: "waiting",
          nextAction: null,
          nextActionDue: null,
          draft: null,
          messages,
          summary: note,
        },
        { application_id: id }
      );
      clearedCommunicationIds.push(row.id);
    }

    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "status_change",
      title: `${app.company || id}: Status changed to ${activityStatusLabel(to)}`,
      summary: `Verified from the application portal. Previous status: ${activityStatusLabel(from)}.`,
      refs: { applicationId: id, company: app.company, role: app.role },
      tags: [`status:${to}`, "operation:application:status-sync"],
    });
    const analytics = refreshAnalytics(db, new Date(timestamp));
    return {
      id,
      from,
      to,
      clearedCommunicationIds,
      submitGates,
      meta,
      event,
      analytics,
    };
  });
}

function shallowMergeOneLevel(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const baseIsObj =
      base[key] !== null && typeof base[key] === "object" && !Array.isArray(base[key]);
    const patchIsObj = value !== null && typeof value === "object" && !Array.isArray(value);
    out[key] = baseIsObj && patchIsObj ? { ...base[key], ...value } : value;
  }
  return out;
}

function applicationFieldsActivity(patch) {
  const keys = new Set(Object.keys(patch || {}));
  if (
    ["gateVerdict", "gateVerdictReason", "roleFit", "compNote", "compensation"].some((key) =>
      keys.has(key)
    )
  ) {
    return {
      title: "Fit and compensation updated",
      summary: "Saved the latest evaluation, fit reasons, risks, and compensation evidence.",
    };
  }
  if (keys.has("followUp") || keys.has("nextAction") || keys.has("nextActionDue")) {
    return {
      title: "Next action updated",
      summary: "Saved the next candidate action and follow-up timing.",
    };
  }
  if (keys.has("interviewAt") || keys.has("nextInterviewAt") || keys.has("interviewNote")) {
    return {
      title: "Interview details updated",
      summary: "Saved structured interview timing and logistics.",
    };
  }
  return {
    title: "Application details updated",
    summary: "Saved changes to the tracked application.",
  };
}

// appSetFields({id, patch}) — shallow merge (objects merge one level,
// arrays/scalars replace). Not outcome-changing: no analytics refresh.
export function appSetFields({ repoRoot, env, id, patch } = {}) {
  assertSettableApplicationFields(patch);
  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const activity = applicationFieldsActivity(patch);
    const updated = shallowMergeOneLevel(app, patch);
    putRow(db, "applications", id, updated);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "status_change",
      title: `${app.company || id}: ${activity.title}`,
      summary: activity.summary,
      refs: { applicationId: id, company: app.company, role: app.role },
      tags: ["operation:application:details-update"],
    });
    return { id, meta, event };
  });
}

export function appApproveReview({ repoRoot, env, id, expectedEvaluatedAt, at } = {}) {
  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const evaluation = app.evaluation;
    const evaluatedAt = String(evaluation?.evaluatedAt || "").trim();
    if (String(evaluation?.gate || "").toLowerCase() !== "review" || !evaluatedAt) {
      const error = new Error(
        "appApproveReview: a current REVIEW evaluation is required before approval"
      );
      error.code = "REVIEW_APPROVAL_NOT_AVAILABLE";
      throw error;
    }
    if (!expectedEvaluatedAt || String(expectedEvaluatedAt).trim() !== evaluatedAt) {
      const error = new Error("appApproveReview: the REVIEW evaluation changed before approval");
      error.code = "REVIEW_APPROVAL_STALE";
      throw error;
    }
    const approvedAt = at || nowIso();
    putRow(db, "applications", id, {
      ...app,
      reviewApproval: { evaluatedAt, approvedAt },
    });
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "status_change",
      title: `${app.company || id}: Review verdict approved`,
      summary: "The candidate explicitly approved preparing this REVIEW role.",
      refs: { applicationId: id, company: app.company, role: app.role },
      tags: ["operation:application:review-approve"],
    });
    return { id, evaluatedAt, approvedAt, meta, event };
  });
}

// evaluation.gate -> the status a synced application should carry. Reused
// verbatim from evaluate-job SKILL.md STEP 9 ("GATE: CUT -> status: cut",
// "GATE: KEEP or REVIEW -> status: reviewed-hold") rather than inventing a
// second mapping here.
const EVALUATION_GATE_STATUS = Object.freeze({
  keep: "reviewed-hold",
  review: "reviewed-hold",
  cut: "cut",
});

function evaluationGateNote(evaluation) {
  const gate = String(evaluation?.gate || "review").toLowerCase();
  const score = evaluation?.fitScore;
  const parts = [`gate ${gate}`, score == null ? "" : `fit ${score}`].filter(Boolean);
  return parts.join("; ").slice(0, 60);
}

// True when `status` is still at or before the gate: unset, the gate-pass
// hold, or a previous cut. A fresh evaluation is always allowed to resync
// gate/status/note here. Anything further along (applied, screen, interview,
// offer, ...) was advanced by a real submission or the candidate's own hand;
// a later re-evaluation (e.g. a captured JD deduping onto this row per
// matchTrackerRecord) must never regress it back to reviewed-hold/cut.
// classifyStage's own keyword rules put the literal status "cut" on the
// withdrawn rung (order 91), so it needs its own check here rather than the
// order cutoff alone.
function isPreApplicationStatus(status) {
  const value = String(status || "").toLowerCase();
  if (!value || value === "cut") return true;
  return classifyStage(value).order <= 0.5;
}

// appPersistEvaluation({id, evaluation, projection}) — the SOLE write path
// for a packet-gate verdict landing on an application (see
// src/core/packet/evaluate.mjs#evaluateAndPersistPacketGate). `projection`
// carries the fit/comp fields packetEvaluationProjection() already derives
// from `evaluation` (the nested typed verdict); this verb additionally
// derives gate/status/note from evaluation.gate IN THE SAME transaction, so
// the top-level fields can never diverge from the nested verdict the way two
// separate writes could (the bug this verb fixes: a re-evaluation used to
// patch `evaluation` only, leaving the old gate/status/note stamped on the
// row from the FIRST evaluation). Scoped by isPreApplicationStatus() above:
// an application already past the gate keeps its real pipeline status and
// only picks up the refreshed evaluation/fit fields.
export function appPersistEvaluation({ repoRoot, env, id, evaluation, projection } = {}) {
  if (!evaluation || typeof evaluation !== "object") {
    throw new Error("appPersistEvaluation: evaluation is required");
  }
  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const from = app.status;
    const patch = { ...(projection || {}), reviewApproval: null };
    const resynced = isPreApplicationStatus(from);
    if (resynced) {
      const raw = String(evaluation.gate || "review").toLowerCase();
      const gate = raw in EVALUATION_GATE_STATUS ? raw : "review";
      patch.gate = gate;
      patch.status = EVALUATION_GATE_STATUS[gate];
      patch.note = evaluationGateNote(evaluation);
    }
    const statusChanged = resynced && patch.status !== from;
    const updated = shallowMergeOneLevel(app, patch);
    putRow(db, "applications", id, updated);
    const meta = bumpMeta(db);
    const fieldsActivity = statusChanged ? null : applicationFieldsActivity(patch);
    const event = statusChanged
      ? logActivityEvent(db, {
          type: "status_change",
          title: `${app.company || id}: Status changed to ${activityStatusLabel(patch.status)}`,
          summary: `Previous status: ${activityStatusLabel(from)}.`,
          refs: { applicationId: id, company: app.company, role: app.role },
          tags: [`status:${patch.status}`, "operation:application:status-update"],
        })
      : logActivityEvent(db, {
          type: "status_change",
          title: `${app.company || id}: ${fieldsActivity.title}`,
          summary: fieldsActivity.summary,
          refs: { applicationId: id, company: app.company, role: app.role },
          tags: ["operation:application:details-update"],
        });
    const analytics = statusChanged ? refreshAnalytics(db) : undefined;
    return { id, from, to: patch.status || from, resynced, meta, event, analytics };
  });
}

// appScheduleInterview({id, at, round?, note?, who?}) — the booking action. A
// real FUTURE interviewAt is what promotes an interview to the dashboard
// Focus card; a second call while one is already future-set books the NEXT
// round into nextInterviewAt instead (Content Register: nextInterviewAt
// "supersedes interviewAt once a follow-on is booked"). Not outcome-changing.
export function appScheduleInterview({ repoRoot, env, id, at, round, note, who } = {}) {
  if (!at) throw new Error("appScheduleInterview: at is required");
  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const isFutureAlready =
      app.interviewAt &&
      !Number.isNaN(Date.parse(app.interviewAt)) &&
      Date.parse(app.interviewAt) > Date.now();

    const patch = {};
    if (isFutureAlready) patch.nextInterviewAt = at;
    else patch.interviewAt = at;
    if (note) patch.interviewNote = note;

    const conversations = Array.isArray(app.conversations) ? app.conversations.slice() : [];
    conversations.push({
      date: at,
      kind: round || "Interview",
      who: who || null,
      notes: note || null,
    });
    patch.conversations = conversations;

    const updated = { ...app, ...patch };
    putRow(db, "applications", id, updated);
    ensureJobThreadInDb(db, { applicationId: id, reason: "human-entered" });
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "interview",
      title: `${app.company || id}: ${round || "interview"} scheduled`,
      refs: { applicationId: id, company: app.company, role: app.role },
    });
    return { id, meta, event };
  });
}

// Capture a confirmed interview invite/transcript from universal intake in one
// application write. A future ISO datetime schedules the round and advances an
// earlier-stage application; notes without a reliable future time are retained
// as non-rung debrief context instead of inventing calendar state.
export function appCaptureInterviewIntake({
  repoRoot,
  env,
  id,
  interviewAt,
  summary,
  artifactPath,
  who,
  at,
} = {}) {
  const cleanSummary = String(summary || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanSummary) throw new Error("appCaptureInterviewIntake: summary is required");
  const cleanArtifactPath = assertInterviewCapturePath(artifactPath);
  const capturedAt = at || nowIso();
  const rawInterviewAt = String(interviewAt || "").trim();
  if (
    rawInterviewAt &&
    (!rawInterviewAt.includes("T") || Number.isNaN(Date.parse(rawInterviewAt)))
  ) {
    const error = new Error(
      "appCaptureInterviewIntake: interviewAt must be an ISO datetime with an explicit time"
    );
    error.code = "BAD_INTERVIEW_AT";
    throw error;
  }

  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const referenceMs = Number.isNaN(Date.parse(capturedAt)) ? Date.now() : Date.parse(capturedAt);
    const scheduled = Boolean(rawInterviewAt && Date.parse(rawInterviewAt) > referenceMs);
    const conversations = Array.isArray(app.conversations) ? app.conversations.slice() : [];
    conversations.push({
      date: scheduled ? new Date(rawInterviewAt).toISOString() : capturedAt,
      kind: scheduled ? "interview" : "post-round-follow-up",
      who: String(who || "").trim() || null,
      notes: cleanSummary.slice(0, 200),
      ...(cleanArtifactPath ? { artifactPath: cleanArtifactPath } : {}),
    });

    const updated = { ...app, conversations };
    let statusChanged = false;
    let scheduledField = null;
    let scheduledAt = null;
    if (scheduled) {
      scheduledAt = new Date(rawInterviewAt).toISOString();
      const hasFutureCurrent =
        app.interviewAt &&
        !Number.isNaN(Date.parse(app.interviewAt)) &&
        Date.parse(app.interviewAt) > referenceMs;
      scheduledField = hasFutureCurrent ? "nextInterviewAt" : "interviewAt";
      updated[scheduledField] = scheduledAt;
      updated.interviewNote = interviewLogisticsNote(scheduledAt, who);
      if (classifyStage(app.status).order < classifyStage("interview").order) {
        updated.status = "interview";
        statusChanged = updated.status !== app.status;
      }
    }

    putRow(db, "applications", id, updated);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "interview",
      title: `${app.company || id}: ${scheduled ? "interview captured" : "interview notes captured"}`,
      summary: scheduled
        ? "Saved the confirmed interview time and its source context."
        : "Saved interview context without inventing a schedule.",
      refs: { applicationId: id, company: app.company, role: app.role },
      tags: ["operation:interview:capture-intake"],
    });
    const analytics = statusChanged ? refreshAnalytics(db) : null;
    return { id, scheduled, scheduledAt, scheduledField, statusChanged, meta, event, analytics };
  });
}

const ROUND_OUTCOMES = new Set(["pending", "advanced", "rejected", "cancelled"]);

// A completed round always takes its linked "scheduled" comm thread off the
// live-actionable list: "advanced"/"pending" still have a next step (the
// thread just isn't waiting on a scheduled event anymore), "rejected"/
// "cancelled" close it out.
const COMM_STATUS_BY_ROUND_OUTCOME = {
  pending: "waiting",
  advanced: "waiting",
  rejected: "closed",
  cancelled: "closed",
};

// appRecordRoundOutcome({id, outcome, note, stage?, who?}) — the coordinated
// "round is done" write. ONE transaction: (1) stamps stage/outcome/who onto
// the round's conversations[] entry (updates the most recently recorded round
// if one exists, else appends a new one so this verb also works stand-alone),
// and (2) resolves every linked communications[] row still sitting in
// status "scheduled" (found by applicationId) — moved off "scheduled" per
// COMM_STATUS_BY_ROUND_OUTCOME and nextAction/nextActionDue cleared — so a
// resolved round's thread stops reading as a live actionable item. Without
// this second half, `appScheduleInterview` leaves the comm thread pinned to
// "scheduled" forever once the round has actually happened. Not
// outcome-changing (mirrors appScheduleInterview/comm.mjs's carve-out): no
// analytics refresh.
export function appRecordRoundOutcome({ repoRoot, env, id, outcome, note, stage, who } = {}) {
  if (!ROUND_OUTCOMES.has(outcome)) {
    throw new Error(
      `appRecordRoundOutcome: outcome must be one of ${[...ROUND_OUTCOMES].join(", ")}`
    );
  }
  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);

    const conversations = Array.isArray(app.conversations) ? app.conversations.slice() : [];
    const lastIndex = conversations.length - 1;
    const target = lastIndex >= 0 ? { ...conversations[lastIndex] } : { date: nowIso() };
    if (!target.kind) target.kind = stage || "Interview";
    target.outcome = outcome;
    if (stage) target.stage = stage;
    if (who) target.who = who;
    if (note) target.notes = note;
    if (lastIndex >= 0) conversations[lastIndex] = target;
    else conversations.push(target);

    const updated = { ...app, conversations };
    putRow(db, "applications", id, updated);

    const commRows = db
      .prepare(
        "SELECT id, data FROM communications WHERE application_id = ? AND status = 'scheduled'"
      )
      .all(String(id));
    const resolvedCommIds = [];
    for (const row of commRows) {
      const comm = JSON.parse(row.data);
      const resolvedComm = {
        ...comm,
        status: COMM_STATUS_BY_ROUND_OUTCOME[outcome],
        nextAction: null,
        nextActionDue: null,
      };
      putRow(db, "communications", row.id, resolvedComm, { application_id: id });
      resolvedCommIds.push(row.id);
    }

    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "interview",
      title: `${app.company || id}: ${stage || target.kind || "round"} outcome: ${outcome}`,
      refs: { applicationId: id, company: app.company, role: app.role },
      tags: [`outcome:${outcome}`],
    });
    return { id, outcome, meta, event, resolvedCommIds };
  });
}

// appRegisterArtifact({id, kind, path, note?}) — stamp a generated artifact
// (resume/coverLetter/jd/...) into the blob's artifacts map, mirroring the
// existing <kind>Note / <kind>GeneratedAt convention. Not outcome-changing.
export function appRegisterArtifact({ repoRoot, env, id, kind, path, note } = {}) {
  if (!kind || !path) throw new Error("appRegisterArtifact: kind and path are required");
  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const artifacts = { ...(app.artifacts || {}) };
    artifacts[kind] = path;
    artifacts[`${kind}GeneratedAt`] = nowIso();
    if (note) artifacts[`${kind}Note`] = note;

    const updated = { ...app, artifacts };
    putRow(db, "applications", id, updated);
    const meta = bumpMeta(db);
    const artifactActivity =
      {
        jd: "Job description captured",
        resume: "Résumé created",
        coverLetter: "Cover letter created",
        interviewDossier: "Interview dossier created",
      }[kind] || "Application document saved";
    const event = logActivityEvent(db, {
      type: "tailored",
      title: `${app.company || id}: ${artifactActivity}`,
      summary: note || "Saved the document to this application.",
      refs: { applicationId: id, company: app.company, role: app.role },
      tags: [`artifact:${kind}`, "operation:application:artifact-save"],
    });
    return { id, meta, event };
  });
}

// appRegisterInterviewDossier({id, dossier}) — interview-prep's typed artifact
// write. Unlike appRegisterArtifact's string-path convention, the dashboard's
// Focus card requires the complete object declared in tracker.schema.json so it
// can open the dossier immediately without a second filesystem read.
export function appRegisterInterviewDossier({ repoRoot, env, id, dossier } = {}) {
  if (!id) throw new Error("appRegisterInterviewDossier: id is required");
  if (!dossier || typeof dossier !== "object" || Array.isArray(dossier)) {
    throw new Error("appRegisterInterviewDossier: dossier object is required");
  }

  const markdown = String(dossier.markdown || "").trim();
  const path = String(dossier.path || "").trim();
  const generatedAt = String(dossier.generatedAt || "").trim();
  if (!markdown || !path || !generatedAt) {
    throw new Error(
      "appRegisterInterviewDossier: dossier markdown, path, and generatedAt are required"
    );
  }
  assertWorkspacePath(path, "interviewDossier");
  if (Number.isNaN(Date.parse(generatedAt))) {
    const err = new Error("interview dossier generatedAt must be an ISO datetime");
    err.code = "BAD_INTERVIEW_DOSSIER";
    throw err;
  }

  const normalized = {
    title: dossier.title == null ? null : String(dossier.title),
    round: dossier.round == null ? null : String(dossier.round),
    path,
    generatedAt,
    markdown,
  };

  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const artifacts = { ...(app.artifacts || {}), interviewDossier: normalized };
    putRow(db, "applications", id, { ...app, artifacts });
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "interview",
      title: `${app.company || id}: Interview dossier created`,
      summary: `${normalized.round || "Interview"} preparation is ready to review.`,
      refs: { applicationId: id, company: app.company, role: app.role },
      tags: ["artifact:interviewDossier", "operation:application:interview-prep"],
    });
    return { id, dossier: normalized, meta, event };
  });
}

export function appRegisterPacketQuestionCapture({
  repoRoot,
  env,
  id,
  path,
  capturedAt,
  questions = [],
  excluded = [],
  demographicSectionPresent = false,
} = {}) {
  if (!id || !path) {
    throw new Error("appRegisterPacketQuestionCapture: id and path are required");
  }
  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const artifacts = { ...(app.artifacts || {}) };
    artifacts.packetQuestionsSource = path;
    artifacts.packetQuestionsCapturedAt = capturedAt || nowIso();
    artifacts.packetQuestionCount = questions.length;
    artifacts.packetQuestionExcludedCount = excluded.length;

    const answerable = questions.flatMap((question) => {
      const questionId = String(question?.id || "").trim();
      const label = String(question?.label || "").trim();
      if (!questionId || !label) return [];
      const seen = new Set();
      const options = Array.isArray(question?.options)
        ? question.options.flatMap((option) => {
            if (typeof option !== "string") return [];
            const optionLabel = option.trim();
            if (!optionLabel || seen.has(optionLabel) || seen.size >= 12) return [];
            seen.add(optionLabel);
            return [optionLabel];
          })
        : [];
      return [
        {
          id: questionId,
          label,
          type: String(question?.type || "text").trim() || "text",
          required: question?.required !== false,
          ...(options.length ? { options } : {}),
        },
      ];
    });
    const questionSummary = {
      source: path,
      capturedAt: artifacts.packetQuestionsCapturedAt,
      answerableCount: questions.length,
      excludedCount: excluded.length,
      answerableIds: questions.map((q) => String(q.id)),
      excludedIds: excluded.map((q) => String(q.id)),
      demographicSectionPresent: Boolean(demographicSectionPresent),
      answerable,
    };

    const packetManifest = {
      ...(app.packetManifest || {}),
      questions: questionSummary,
    };

    const updated = { ...app, artifacts, packetManifest };
    putRow(db, "applications", id, updated);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "tailored",
      title: `${app.company || id}: packet questions captured`,
      refs: { applicationId: id, company: app.company, role: app.role },
    });
    return { id, meta, event, packetManifest: questionSummary };
  });
}

export function appRegisterPacketArtifacts({
  repoRoot,
  env,
  id,
  artifacts = {},
  manifest,
  note,
} = {}) {
  if (!id) throw new Error("appRegisterPacketArtifacts: id is required");
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    throw new Error("appRegisterPacketArtifacts: artifacts object is required");
  }

  for (const [key, value] of Object.entries(artifacts)) {
    if (value === null || value === undefined) continue;
    // <kind>GeneratedAt stamps (the appRegisterArtifact convention, mirrored
    // here for the plain resume/coverLetter/answers keys) are ISO timestamps,
    // not workspace paths — exempt them from the path check.
    if (key.endsWith("GeneratedAt")) continue;
    assertWorkspacePath(value, key);
  }

  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const existingManifest = app.packetManifest || {};
    const packetManifest = {
      ...existingManifest,
      ...(manifest || {}),
    };
    if (manifest?.questions || existingManifest.questions) {
      packetManifest.questions = manifest?.questions || existingManifest.questions;
    } else {
      delete packetManifest.questions;
    }
    validatePacketManifest(packetManifest);

    // An explicit null in `artifacts` deletes that key from the stored
    // app row instead of being skipped: exportPacketArtifacts seeds null
    // for a document kind's unrequested pdf/docx/text keys so a text-only
    // or docx-only regeneration replaces the kind's artifacts rather than
    // merging on top of a stale one (e.g. an old resumePdf that apply
    // could otherwise still pick). A key simply absent from `artifacts`
    // (undefined) is left untouched, same as before.
    const updatedArtifacts = { ...(app.artifacts || {}) };
    for (const [key, value] of Object.entries(artifacts)) {
      if (value === undefined) continue;
      if (value === null) delete updatedArtifacts[key];
      else updatedArtifacts[key] = value;
    }
    updatedArtifacts.packetGeneratedAt = nowIso();
    if (note) updatedArtifacts.packetNote = note;

    const updated = { ...app, artifacts: updatedArtifacts, packetManifest };
    putRow(db, "applications", id, updated);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "tailored",
      title: `${app.company || id}: Tailored application packet created`,
      summary:
        updatedArtifacts.resume && updatedArtifacts.coverLetter
          ? "Created tailored résumé and cover letter."
          : "Created a tailored application packet for review.",
      refs: { applicationId: id, company: app.company, role: app.role },
      tags: ["operation:application:packet-create"],
    });
    return { id, meta, event, artifacts: updatedArtifacts, packetManifest };
  });
}

// Every per-format output key this domain produces ends in one of these
// suffixes (outputKey(kind, format) in packet/exports.mjs: resumePdf,
// coverLetterDocx, answersText, ...). Kept here rather than imported from
// packet/exports.mjs so this read-only db-layer verb has no dependency on
// the packet layer that calls it.
const ARTIFACT_KEY_FORMAT_SUFFIX = { Pdf: "pdf", Docx: "docx", Text: "text" };
const PLAIN_ARTIFACT_KINDS = new Set(["resume", "coverLetter", "answers"]);

// Classifies one `application.artifacts` key into the {kind, format} an
// artifact-path owner index needs, or returns null for a key that isn't a
// path at all (packetGeneratedAt, resumeGeneratedAt, packetNote, ...).
function classifyArtifactKey(key) {
  if (key === "packetManifest") return { kind: "packetManifest", format: "manifest" };
  if (key.endsWith("Source")) {
    return { kind: key.slice(0, -"Source".length), format: "source" };
  }
  for (const [suffix, format] of Object.entries(ARTIFACT_KEY_FORMAT_SUFFIX)) {
    if (key.length > suffix.length && key.endsWith(suffix)) {
      return { kind: key.slice(0, -suffix.length), format };
    }
  }
  if (PLAIN_ARTIFACT_KINDS.has(key)) return { kind: key, format: "plain" };
  return null;
}

// appListArtifactRegistrations({repoRoot, env}) — the cross-application
// owner index packet/exports.mjs needs before it can reuse a destination
// path: every source/output/manifest path ANY application currently
// registers, tagged with which application registered it and what kind +
// format it is. A same-application readback (app.artifacts alone) can only
// ever answer "did I register this path" — it cannot answer "did somebody
// else," so a shared or foreign-registered destination looked unowned and
// was reused/overwritten. Read-only: no transaction, no meta bump, no
// activity event.
export function appListArtifactRegistrations({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  const rows = db.prepare("SELECT id, data FROM applications ORDER BY rowid ASC").all();
  const registrations = [];
  for (const row of rows) {
    let app;
    try {
      app = JSON.parse(row.data);
    } catch {
      continue;
    }
    const applicationId = String(app?.id ?? row.id);
    const artifacts = app?.artifacts || {};
    for (const [key, value] of Object.entries(artifacts)) {
      if (typeof value !== "string" || !value.trim()) continue;
      const classified = classifyArtifactKey(key);
      if (!classified) continue;
      registrations.push({
        applicationId,
        kind: classified.kind,
        format: classified.format,
        path: value,
      });
    }
  }
  return registrations;
}
