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
import { classifyStage } from "../../tracker/dashboard.mjs";
import { buildReevaluationAnalytics } from "../../tracker/outcome-analysis.mjs";
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
      title: `${row.company || row.id} — ${row.role || "application"} ${existed ? "updated" : "captured"}`,
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

// appSetStatus({id, to, note?, followUpDueAt?, clearInterview?})
export function appSetStatus({ repoRoot, env, id, to, note, followUpDueAt, clearInterview } = {}) {
  if (!to) throw new Error("appSetStatus: to is required");
  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const from = app.status;

    const wasInterview = classifyStage(from).id === "interview";
    const autoClear = clearInterview !== false && wasInterview && to !== from;
    const willClear = clearInterview === true || autoClear;

    const updated = { ...app, status: to };
    if (note) updated.statusNote = note;
    if (followUpDueAt) updated.followUp = { ...(app.followUp || {}), dueAt: followUpDueAt };
    if (willClear) Object.assign(updated, applyRoundCompletionClearing(app));

    putRow(db, "applications", id, updated);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "status_change",
      title: `${app.company || id} — status ${from || "unknown"} → ${to}`,
      refs: { applicationId: id, company: app.company, role: app.role },
      tags: [`status:${to}`],
    });
    const analytics = refreshAnalytics(db);
    return { id, from, to, meta, event, analytics };
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

// appSetFields({id, patch}) — shallow merge (objects merge one level,
// arrays/scalars replace). Not outcome-changing: no analytics refresh.
export function appSetFields({ repoRoot, env, id, patch } = {}) {
  if (!patch || typeof patch !== "object") throw new Error("appSetFields: patch is required");
  return runVerb({ repoRoot, env }, (db) => {
    const app = requireApp(db, id);
    const updated = shallowMergeOneLevel(app, patch);
    putRow(db, "applications", id, updated);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "status_change",
      title: `${app.company || id} — fields updated`,
      refs: { applicationId: id, company: app.company, role: app.role },
    });
    return { id, meta, event };
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
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "interview",
      title: `${app.company || id} — ${round || "interview"} scheduled`,
      refs: { applicationId: id, company: app.company, role: app.role },
    });
    return { id, meta, event };
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
      title: `${app.company || id} — ${stage || target.kind || "round"} outcome: ${outcome}`,
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
    const event = logActivityEvent(db, {
      type: "tailored",
      title: `${app.company || id} — ${kind} artifact registered`,
      refs: { applicationId: id, company: app.company, role: app.role },
    });
    return { id, meta, event };
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

    const questionSummary = {
      source: path,
      capturedAt: artifacts.packetQuestionsCapturedAt,
      answerableCount: questions.length,
      excludedCount: excluded.length,
      answerableIds: questions.map((q) => String(q.id)),
      excludedIds: excluded.map((q) => String(q.id)),
      demographicSectionPresent: Boolean(demographicSectionPresent),
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
      title: `${app.company || id} — packet questions captured`,
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

    const updatedArtifacts = {
      ...(app.artifacts || {}),
      ...Object.fromEntries(
        Object.entries(artifacts).filter(([, value]) => value !== null && value !== undefined)
      ),
      packetGeneratedAt: nowIso(),
    };
    if (note) updatedArtifacts.packetNote = note;

    const updated = { ...app, artifacts: updatedArtifacts, packetManifest };
    putRow(db, "applications", id, updated);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "tailored",
      title: `${app.company || id} — packet artifacts registered`,
      refs: { applicationId: id, company: app.company, role: app.role },
    });
    return { id, meta, event, artifacts: updatedArtifacts, packetManifest };
  });
}
