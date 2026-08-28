// tests/db-verbs.test.mjs — per-verb invariants (M6 decision 4 + decision 6):
// every write verb bumps meta.version + meta.lastUpdatedAt exactly once and
// leaves a matching activity_events row; analyticsRefresh is the one
// exception (derived data, never bumps the freshness stamp); appSetStatus
// reproduces AGENTS.md's round-completion field-clearing rule set; commMarkSent
// reproduces the "sent clears draft" hard invariant across both tables.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { closeAll, dbFilePath, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import {
  activityAppend,
  analyticsRefresh,
  appApproveReview,
  appCaptureInterviewIntake,
  appPersistEvaluation,
  appRecordOutcome,
  appRegisterArtifact,
  appRegisterPacketArtifacts,
  appScheduleInterview,
  appSetFields,
  appSetStatus,
  appUpsert,
  calendarBusyUpsert,
  calendarWriteAppend,
  candidateApplicationLimitUpsert,
  candidateArtifactPut,
  candidateConfigGet,
  candidateConfigPatch,
  candidateEvidenceMerge,
  candidateEvidenceRemoveOne,
  candidateEvidenceReplace,
  candidateSetupInitialize,
  commAppendMessage,
  commCaptureInbound,
  commMarkSent,
  commSetDraft,
  commUpsert,
  kvUpsert,
  relationshipLeadSetStatus,
  relationshipLeadUpsertBatch,
  sourcedPromote,
  sourcedReconcilePolicyBatch,
  sourcedSetStatus,
  sourcedUpsertBatch,
  sourceWatermarkUpsert,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-db-verbs-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// A hand-built fixture with the exact shapes each test below needs to control
// precisely (round-completion clearing, sent-clears-draft), imported through
// the SAME importFromTracker code path db-import.test.mjs exercises.
function seedFixture(repoRoot) {
  const sourceDir = join(repoRoot, "fixture-source");
  mkdirSync(sourceDir, { recursive: true });

  const applications = [
    {
      id: "app-last-round",
      company: "Acme",
      role: "Staff Engineer",
      status: "interview",
      interviewAt: "2020-01-01T00:00:00.000Z",
      nextInterviewAt: null,
      interviewNote: "final round prep",
      followUp: { dueAt: "2020-01-05" },
    },
    {
      id: "app-next-round-booked",
      company: "Globex",
      role: "PM",
      status: "interview",
      interviewAt: "2020-01-01T00:00:00.000Z",
      nextInterviewAt: "2020-02-01T00:00:00.000Z",
      interviewNote: "round 1 notes",
    },
    {
      id: "app-non-interview",
      company: "Initech",
      role: "Analyst",
      status: "reviewed-hold",
      nextAction: "Find recruiter contact",
      nextActionDue: "2030-01-02",
    },
    {
      id: "app-eval-review-hold",
      company: "Thornfield Labs",
      role: "Forward Deployed AI Engineer",
      status: "reviewed-hold",
      gate: "review",
      note: "scanner fit review 0; gate review",
      fitScore: 55,
      fitBucket: "stretch",
      fitBasis: "evaluated",
      evaluation: { gate: "review", fitScore: 55, fitBucket: "stretch" },
    },
    {
      id: "app-eval-post-apply",
      company: "Vandelay Industries",
      role: "Staff Engineer",
      status: "interview",
      gate: "keep",
      note: "gate keep; fit 88",
      fitScore: 88,
      fitBucket: "high",
      fitBasis: "evaluated",
      evaluation: { gate: "keep", fitScore: 88, fitBucket: "high" },
    },
    {
      id: "app-with-draft",
      company: "Hooli",
      role: "SRE",
      status: "awaiting",
      followUp: { draft: "Hi there, following up on..." },
    },
  ];
  const sourced = [
    {
      id: "sourced-promote-me",
      company: "Umbrella",
      role: "Coordinator",
      fitScore: 82,
      note: "Found through a trusted referral and awaiting a careful compensation and scope review.",
    },
  ];
  const communications = [
    {
      id: "comm-with-draft",
      applicationId: "app-with-draft",
      company: "Hooli",
      channel: "email",
      status: "drafted",
      draft: "Hi there, following up on...",
    },
  ];

  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify({ meta: {}, applications, sourced, sources: [], communications }, null, 2)
  );
  importFromTracker({ repoRoot, sourceDir });
}

function readMeta(db) {
  const row = db.prepare("SELECT version, last_updated_at FROM meta WHERE id = 1").get();
  return { version: row.version, lastUpdatedAt: row.last_updated_at };
}

function activityCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM activity_events").get().n;
}

function activityRow(db, id) {
  return db.prepare("SELECT id, type, data FROM activity_events WHERE id = ?").get(id);
}

function readKv(db, key) {
  const row = db.prepare("SELECT data FROM kv WHERE key = ?").get(key);
  return row ? JSON.parse(row.data) : null;
}

// ---------------------------------------------------------------------------
// appSetStatus: round-completion field-clearing (AGENTS.md Tracker Write
// Contract / track-outcomes SKILL.md STEP 2).
// ---------------------------------------------------------------------------

test("appSetStatus: leaving interview with no next round booked clears interviewAt + nextInterviewAt + interviewNote", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  appSetStatus({ repoRoot, id: "app-last-round", to: "offer" });

  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-last-round");
  const app = JSON.parse(row.data);
  assert.equal(app.status, "offer");
  assert.equal(app.interviewAt, null, "last scheduled round: interviewAt must be cleared");
  assert.equal(app.nextInterviewAt, null);
  assert.equal(app.interviewNote, null);
});

test("appSetStatus: staying in 'interview' while advancing to the next round (clearInterview:true) clears nextInterviewAt/interviewNote but keeps interviewAt", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  appSetStatus({
    repoRoot,
    id: "app-next-round-booked",
    to: "interview",
    clearInterview: true,
  });

  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-next-round-booked");
  const app = JSON.parse(row.data);
  assert.equal(app.nextInterviewAt, null);
  assert.equal(app.interviewNote, null);
  assert.equal(
    app.interviewAt,
    "2020-01-01T00:00:00.000Z",
    "a next round was already booked ahead of it — interviewAt is not the last scheduled round, so it stays"
  );
});

test("appSetStatus: no-op status re-assert (to === from, no clearInterview) does not clear anything", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  appSetStatus({ repoRoot, id: "app-next-round-booked", to: "interview" });

  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-next-round-booked");
  const app = JSON.parse(row.data);
  assert.equal(app.nextInterviewAt, "2020-02-01T00:00:00.000Z");
  assert.equal(app.interviewNote, "round 1 notes");
  assert.equal(app.interviewAt, "2020-01-01T00:00:00.000Z");
});

test("appSetStatus: a transition that was never in the interview stage clears nothing", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  appSetStatus({ repoRoot, id: "app-non-interview", to: "cut" });

  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-non-interview");
  const app = JSON.parse(row.data);
  assert.equal(app.status, "cut");
  assert.equal(app.interviewAt, undefined);
  assert.equal(app.nextInterviewAt, undefined);
});

test("appRecordOutcome: rejection atomically clears every linked CTA and leaves unrelated communications unchanged", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  appUpsert({
    repoRoot,
    row: { id: "app-unrelated", company: "Pied Piper", role: "Engineer", status: "awaiting" },
  });
  commUpsert({
    repoRoot,
    row: {
      id: "comm-with-draft-portal",
      applicationId: "app-with-draft",
      company: "Hooli",
      channel: "portal",
      status: "needs-reply",
      summary: "Check the portal for an update.",
      nextAction: "Check the portal",
      nextActionDue: "2026-08-10",
      draft: { body: "Portal follow-up." },
      messages: [],
    },
  });
  commUpsert({
    repoRoot,
    row: {
      id: "comm-unrelated",
      applicationId: "app-unrelated",
      company: "Pied Piper",
      channel: "email",
      status: "drafted",
      summary: "Unrelated recruiter thread.",
      nextAction: "Reply to recruiter",
      nextActionDue: "2026-08-11",
      draft: { body: "Unrelated draft." },
      messages: [],
    },
  });
  commUpsert({
    repoRoot,
    row: {
      ...JSON.parse(
        openDb({ repoRoot })
          .prepare("SELECT data FROM communications WHERE id = ?")
          .get("comm-with-draft").data
      ),
      summary: "Waiting for an outcome.",
      nextAction: "Follow up",
      nextActionDue: "2026-08-09",
      messages: [],
    },
  });
  const db = openDb({ repoRoot });
  const beforeMeta = readMeta(db);
  const beforeActivity = activityCount(db);

  const result = appRecordOutcome({
    repoRoot,
    id: "app-with-draft",
    to: "rejected",
    note: "Role was filled internally.",
    at: "2026-08-09T14:03:00.000Z",
  });

  assert.equal(result.clearedCommunicationIds.length, 2);
  assert.deepEqual(result.clearedCommunicationIds, ["comm-with-draft", "comm-with-draft-portal"]);
  assert.equal(result.meta.version, beforeMeta.version + 1);
  assert.equal(activityCount(db), beforeActivity + 1);
  assert.ok(result.analytics);
  assert.equal(result.exported.ok, true);

  const app = JSON.parse(
    db.prepare("SELECT data FROM applications WHERE id = ?").get("app-with-draft").data
  );
  assert.equal(app.status, "rejected");
  assert.equal(app.statusNote, "Role was filled internally.");
  assert.equal(app.followUp.draft, null);
  for (const id of result.clearedCommunicationIds) {
    const comm = JSON.parse(
      db.prepare("SELECT data FROM communications WHERE id = ?").get(id).data
    );
    assert.equal(comm.status, "closed", id);
    assert.equal(comm.nextAction, null, id);
    assert.equal(comm.nextActionDue, null, id);
    assert.equal(comm.draft, null, id);
    assert.equal(comm.messages.at(-1).direction, "note", id);
    assert.equal(comm.messages.at(-1).at, "2026-08-09T14:03:00.000Z", id);
    assert.match(comm.messages.at(-1).summary, /rejected/i, id);
  }
  const unrelated = JSON.parse(
    db.prepare("SELECT data FROM communications WHERE id = ?").get("comm-unrelated").data
  );
  assert.equal(unrelated.status, "drafted");
  assert.equal(unrelated.nextAction, "Reply to recruiter");
  assert.equal(unrelated.nextActionDue, "2026-08-11");
  assert.deepEqual(unrelated.draft, { body: "Unrelated draft." });

  const exported = JSON.parse(
    readFileSync(userPath({ repoRoot }, "workspace/tracker.json"), "utf8")
  );
  assert.equal(exported.applications.find((row) => row.id === "app-with-draft").status, "rejected");
  assert.equal(
    exported.communications.find((row) => row.id === "comm-with-draft").status,
    "closed"
  );
});

for (const to of ["interview", "offer"]) {
  test(`appRecordOutcome: ${to} advances linked communications to waiting and preserves round clearing`, () => {
    const repoRoot = tempRepo();
    seedFixture(repoRoot);
    const db = openDb({ repoRoot });
    const applicationId = to === "offer" ? "app-last-round" : "app-with-draft";
    const communicationId = to === "offer" ? "comm-offer" : "comm-with-draft";
    if (to === "offer") {
      commUpsert({
        repoRoot,
        row: {
          id: communicationId,
          applicationId,
          company: "Acme",
          channel: "email",
          status: "needs-reply",
          summary: "Recruiter shared the offer.",
          nextAction: "Review the offer",
          nextActionDue: "2026-08-10",
          draft: { body: "Thanks for the offer." },
          messages: [],
        },
      });
    }

    appRecordOutcome({
      repoRoot,
      id: applicationId,
      to,
      note: `${to} received.`,
      at: "2026-08-09T14:03:00.000Z",
    });

    const comm = JSON.parse(
      db.prepare("SELECT data FROM communications WHERE id = ?").get(communicationId).data
    );
    assert.equal(comm.status, "waiting");
    assert.equal(comm.nextAction, null);
    assert.equal(comm.nextActionDue, null);
    assert.equal(comm.draft, null);
    assert.equal(comm.messages.at(-1).direction, "note");
    assert.match(comm.messages.at(-1).summary, new RegExp(to, "i"));
    if (to === "offer") {
      const app = JSON.parse(
        db.prepare("SELECT data FROM applications WHERE id = ?").get(applicationId).data
      );
      assert.equal(app.interviewAt, null);
      assert.equal(app.nextInterviewAt, null);
      assert.equal(app.interviewNote, null);
    }
  });
}

test("appRecordOutcome: invalid or missing applications roll back without mutating state", () => {
  for (const request of [
    { id: "app-with-draft", to: "accepted" },
    { id: "app-missing", to: "rejected" },
  ]) {
    const repoRoot = tempRepo();
    seedFixture(repoRoot);
    const db = openDb({ repoRoot });
    const beforeMeta = readMeta(db);
    const beforeActivity = activityCount(db);
    const beforeApp = db
      .prepare("SELECT data FROM applications WHERE id = ?")
      .get("app-with-draft").data;
    const beforeComm = db
      .prepare("SELECT data FROM communications WHERE id = ?")
      .get("comm-with-draft").data;

    assert.throws(() => appRecordOutcome({ repoRoot, ...request }));

    assert.deepEqual(readMeta(db), beforeMeta);
    assert.equal(activityCount(db), beforeActivity);
    assert.equal(
      db.prepare("SELECT data FROM applications WHERE id = ?").get("app-with-draft").data,
      beforeApp
    );
    assert.equal(
      db.prepare("SELECT data FROM communications WHERE id = ?").get("comm-with-draft").data,
      beforeComm
    );
  }
});

// ---------------------------------------------------------------------------
// A pre-existing application row with role: null (e.g. imported from a
// legacy tracker.json, or patched by a non-outcome-changing verb) must not
// wedge every LATER outcome-changing write. Every such verb (appUpsert,
// appSetStatus, ...) refreshes analytics inside its own transaction, scanning
// EVERY applications row and classifying its role — before the
// classifyRoleFamily null-safety fix, one row with role: null threw there and
// rolled back an otherwise-unrelated write to a different, perfectly valid
// row.
// ---------------------------------------------------------------------------

test("a pre-existing application row with role: null does not wedge later outcome-changing writes", () => {
  const repoRoot = tempRepo();
  const sourceDir = join(repoRoot, "fixture-null-role-source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify(
      {
        meta: {},
        applications: [
          {
            id: "app-null-role",
            company: "Acme",
            role: null,
            status: "applied",
          },
          {
            id: "app-valid-role",
            company: "Globex",
            role: "Engineer",
            status: "applied",
          },
        ],
        sourced: [],
        sources: [],
        communications: [],
      },
      null,
      2
    )
  );
  importFromTracker({ repoRoot, sourceDir });

  const result = appSetStatus({
    repoRoot,
    id: "app-valid-role",
    to: "interview",
  });
  assert.equal(result.ok, true);
});

test("appSetStatus clears a stale application CTA when submission is recorded", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);

  appSetStatus({
    repoRoot,
    id: "app-non-interview",
    to: "applied",
    appliedAt: "2026-08-27T20:00:00.000Z",
  });

  const application = JSON.parse(
    openDb({ repoRoot })
      .prepare("SELECT data FROM applications WHERE id = ?")
      .get("app-non-interview").data
  );
  assert.equal(application.nextAction, null);
  assert.equal(application.nextActionDue, null);
});

// ---------------------------------------------------------------------------
// appPersistEvaluation: the one write path for a packet-gate verdict landing
// on an application (src/core/packet/evaluate.mjs). Regression coverage for
// the QA-reproduced bug where a re-evaluation patched `evaluation` only and
// left the pre-fix top-level gate/status/note stamped from the FIRST
// evaluation — see that verb's doc comment in src/core/db/verbs/app.mjs.
// ---------------------------------------------------------------------------

test("appPersistEvaluation: a cut re-evaluation resyncs top-level gate/status/note on a pre-application row", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  // app-eval-review-hold starts exactly like the QA repro: nested
  // evaluation.gate "review", but top-level gate "review", status
  // "reviewed-hold", note "scanner fit review 0; gate review" — the stale
  // placeholder shape a fresh CUT verdict must overwrite.
  const cutEvaluation = {
    applicationId: "app-eval-review-hold",
    gate: "cut",
    fitScore: 55,
    fitBucket: "stretch",
  };
  appPersistEvaluation({
    repoRoot,
    id: "app-eval-review-hold",
    evaluation: cutEvaluation,
    projection: {
      evaluation: cutEvaluation,
      fitScore: 55,
      fitBucket: "stretch",
    },
  });

  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-eval-review-hold");
  const app = JSON.parse(row.data);
  assert.equal(app.evaluation.gate, "cut");
  assert.equal(app.gate, "cut", "top-level gate must resync with the new verdict");
  assert.equal(app.status, "cut", "top-level status must resync with the new verdict");
  assert.match(
    app.note,
    /gate cut/,
    "top-level note must reflect the new verdict, not the stale scan note"
  );

  // A real status transition (reviewed-hold -> cut) must log its own event,
  // same as appSetStatus.
  const latestEvent = db
    .prepare("SELECT type, data FROM activity_events ORDER BY rowid DESC LIMIT 1")
    .get();
  assert.equal(latestEvent.type, "status_change");
  assert.match(JSON.parse(latestEvent.data).title, /Status changed to Archived/);
});

test("appPersistEvaluation: a re-evaluation does not regress a post-apply status", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  // app-eval-post-apply is already at "interview" — the candidate applied
  // and advanced by hand. A later re-evaluation (e.g. a captured JD deduping
  // onto this same row) must refresh the nested evaluation/fit fields but
  // must NOT drag the application back to reviewed-hold/cut.
  const cutEvaluation = {
    applicationId: "app-eval-post-apply",
    gate: "cut",
    fitScore: 40,
    fitBucket: "stretch",
  };
  appPersistEvaluation({
    repoRoot,
    id: "app-eval-post-apply",
    evaluation: cutEvaluation,
    projection: {
      evaluation: cutEvaluation,
      fitScore: 40,
      fitBucket: "stretch",
    },
  });

  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-eval-post-apply");
  const app = JSON.parse(row.data);
  assert.equal(app.evaluation.gate, "cut", "nested evaluation still refreshes");
  assert.equal(app.fitScore, 40, "fit fields still refresh");
  assert.equal(app.status, "interview", "post-apply status must never regress");
  assert.equal(app.gate, "keep", "top-level gate is left alone once the app is past the gate");
  assert.equal(
    app.note,
    "gate keep; fit 88",
    "top-level note is left alone once the app is past the gate"
  );
});

test("appPersistEvaluation invalidates an explicit REVIEW approval when the evaluation changes", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });
  const firstEvaluation = {
    applicationId: "app-eval-review-hold",
    gate: "review",
    fitScore: 55,
    fitBucket: "stretch",
    evaluatedAt: "2030-01-02T12:00:00.000Z",
  };
  appPersistEvaluation({
    repoRoot,
    id: "app-eval-review-hold",
    evaluation: firstEvaluation,
    projection: { evaluation: firstEvaluation, fitScore: 55, fitBucket: "stretch" },
  });
  appApproveReview({
    repoRoot,
    id: "app-eval-review-hold",
    expectedEvaluatedAt: firstEvaluation.evaluatedAt,
    at: "2030-01-02T12:01:00.000Z",
  });

  const approved = JSON.parse(
    db.prepare("SELECT data FROM applications WHERE id = ?").get("app-eval-review-hold").data
  );
  assert.deepEqual(approved.reviewApproval, {
    evaluatedAt: firstEvaluation.evaluatedAt,
    approvedAt: "2030-01-02T12:01:00.000Z",
  });

  const secondEvaluation = {
    ...firstEvaluation,
    fitScore: 62,
    evaluatedAt: "2030-01-03T12:00:00.000Z",
  };
  appPersistEvaluation({
    repoRoot,
    id: "app-eval-review-hold",
    evaluation: secondEvaluation,
    projection: { evaluation: secondEvaluation, fitScore: 62, fitBucket: "stretch" },
  });

  const reevaluated = JSON.parse(
    db.prepare("SELECT data FROM applications WHERE id = ?").get("app-eval-review-hold").data
  );
  assert.equal(reevaluated.reviewApproval, null);
});

test("appApproveReview rejects approval for a superseded REVIEW evaluation", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const evaluation = {
    applicationId: "app-eval-review-hold",
    gate: "review",
    fitScore: 61,
    evaluatedAt: "2030-01-03T12:00:00.000Z",
  };
  appPersistEvaluation({
    repoRoot,
    id: "app-eval-review-hold",
    evaluation,
    projection: { evaluation, fitScore: 61, fitBucket: "stretch" },
  });

  assert.throws(
    () =>
      appApproveReview({
        repoRoot,
        id: "app-eval-review-hold",
        expectedEvaluatedAt: "2030-01-02T12:00:00.000Z",
      }),
    (error) => error?.code === "REVIEW_APPROVAL_STALE"
  );
});

test("appSetFields rejects evaluation and gate fields so generic patches cannot forge a KEEP", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });
  const before = JSON.parse(
    db.prepare("SELECT data FROM applications WHERE id = ?").get("app-eval-review-hold").data
  );

  assert.throws(
    () =>
      appSetFields({
        repoRoot,
        id: "app-eval-review-hold",
        patch: { evaluation: { gate: "keep", fitScore: 100 } },
      }),
    (error) => error?.code === "APP_FIELDS_FORBIDDEN" && /evaluation/.test(error.message)
  );
  assert.throws(
    () =>
      appSetFields({
        repoRoot,
        id: "app-eval-review-hold",
        patch: { gateVerdict: "KEEP" },
      }),
    (error) => error?.code === "APP_FIELDS_FORBIDDEN" && /gateVerdict/.test(error.message)
  );

  const after = JSON.parse(
    db.prepare("SELECT data FROM applications WHERE id = ?").get("app-eval-review-hold").data
  );
  assert.deepEqual(after, before);
});

test("chat-first interview intake atomically captures provenance and schedules a real invite", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  const result = appCaptureInterviewIntake({
    repoRoot,
    id: "app-non-interview",
    interviewAt: "2030-01-08T15:00:00.000Z",
    summary: "Recruiter invited the candidate to an initial interview.",
    artifactPath: "workspace/intake/pastes/interview-invite.md",
    who: "Jordan Lee",
    at: "2026-08-09T20:00:00.000Z",
  });

  assert.equal(result.scheduled, true);
  const app = JSON.parse(
    db.prepare("SELECT data FROM applications WHERE id = ?").get("app-non-interview").data
  );
  assert.equal(app.status, "interview");
  assert.equal(app.interviewAt, "2030-01-08T15:00:00.000Z");
  assert.match(app.interviewNote, /^Interview: /);
  assert.equal(app.conversations.at(-1).kind, "interview");
  assert.equal(app.conversations.at(-1).who, "Jordan Lee");
  assert.equal(
    app.conversations.at(-1).artifactPath,
    "workspace/intake/pastes/interview-invite.md"
  );
  assert.ok(result.analytics, "moving into interview must refresh outcome analytics");
});

// ---------------------------------------------------------------------------
// commMarkSent: "sent clears draft" hard invariant, cross-table.
// ---------------------------------------------------------------------------

test("commMarkSent clears comm.draft AND the linked app's followUp.draft in the same write", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  const result = commMarkSent({ repoRoot, id: "comm-with-draft" });
  assert.equal(result.clearedAppFollowUpDraft, true);

  const commRow = db.prepare("SELECT data FROM communications WHERE id = ?").get("comm-with-draft");
  const comm = JSON.parse(commRow.data);
  assert.equal(comm.status, "waiting");
  assert.equal(comm.draft, null);
  assert.equal(comm.nextAction, null);
  assert.equal(comm.nextActionDue, null);
  assert.equal(comm.messages.at(-1).direction, "outbound-sent");
  assert.match(comm.messages.at(-1).summary, /following up/i);

  const appRow = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-with-draft");
  const app = JSON.parse(appRow.data);
  assert.equal(app.followUp.draft, null);
});

// ---------------------------------------------------------------------------
// commMarkSent: verification tiers (email-comms skill's supervised handoff +
// verified-send paths). "verified" is executor-confirmed delivery evidence,
// "supervised" is CareerRat-prepared with the user confirming the send, and
// "user_report" is an out-of-band self report with nothing CareerRat can
// vouch for. "verified" must be earned: without deliveryEvidence the claim
// downgrades to the derived tier. Omitted values derive from draft presence (supervised when a
// CareerRat draft was in place, user_report otherwise) so every surface of
// the verb records the same tier; unknown explicit values normalize to the
// least-trusted tier rather than silently upgrading to a stronger claim than
// the caller made. The sent-clears-draft invariant above holds across every
// tier.
// ---------------------------------------------------------------------------

test("commMarkSent normalizes verification: 'verified', 'supervised', and 'user_report' each round-trip, and an unknown value falls back to 'user_report'", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);

  const verified = commMarkSent({
    repoRoot,
    id: "comm-with-draft",
    verification: "verified",
    deliveryEvidence: "Confirmation page captured at workspace/captures/send-1.png",
    at: "2026-08-09T17:00:00.000Z",
  });
  assert.equal(verified.verification, "verified");

  const supervised = commMarkSent({
    repoRoot,
    id: "comm-with-draft",
    verification: "supervised",
    at: "2026-08-09T17:05:00.000Z",
  });
  assert.equal(supervised.verification, "supervised");

  const userReport = commMarkSent({
    repoRoot,
    id: "comm-with-draft",
    verification: "user_report",
    at: "2026-08-09T17:10:00.000Z",
  });
  assert.equal(userReport.verification, "user_report");

  const unknown = commMarkSent({
    repoRoot,
    id: "comm-with-draft",
    verification: "made-up-tier",
    at: "2026-08-09T17:15:00.000Z",
  });
  assert.equal(unknown.verification, "user_report");

  const omitted = commMarkSent({
    repoRoot,
    id: "comm-with-draft",
    at: "2026-08-09T17:20:00.000Z",
  });
  assert.equal(omitted.verification, "user_report");
});

test("commMarkSent refuses an unearned 'verified': without deliveryEvidence the tier downgrades to the derived one, and evidence is stored on the sent message", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  // Explicit "verified" with no evidence: downgrade to supervised (draft in place).
  const noEvidence = commMarkSent({
    repoRoot,
    id: "comm-with-draft",
    verification: "verified",
    at: "2026-08-09T17:00:00.000Z",
  });
  assert.equal(noEvidence.verification, "supervised");

  // Draft is now cleared, so the same unearned claim lands at user_report.
  const noEvidenceNoDraft = commMarkSent({
    repoRoot,
    id: "comm-with-draft",
    verification: "verified",
    at: "2026-08-09T17:05:00.000Z",
  });
  assert.equal(noEvidenceNoDraft.verification, "user_report");

  // With real evidence the tier sticks and the evidence lands on the message.
  const earned = commMarkSent({
    repoRoot,
    id: "comm-with-draft",
    verification: "verified",
    deliveryEvidence: "Provider accepted message id <abc123@mail>",
    at: "2026-08-09T17:10:00.000Z",
  });
  assert.equal(earned.verification, "verified");

  const commRow = db.prepare("SELECT data FROM communications WHERE id = ?").get("comm-with-draft");
  const comm = JSON.parse(commRow.data);
  const lastSent = comm.messages.filter((m) => m.direction === "outbound-sent").at(-1);
  assert.equal(lastSent.deliveryEvidence, "Provider accepted message id <abc123@mail>");
});

test("commMarkSent derives the tier when verification is omitted: supervised with a draft in place, user_report without", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);

  const withDraft = commMarkSent({
    repoRoot,
    id: "comm-with-draft",
    at: "2026-08-09T17:00:00.000Z",
  });
  assert.equal(withDraft.verification, "supervised");

  const draftAlreadyCleared = commMarkSent({
    repoRoot,
    id: "comm-with-draft",
    at: "2026-08-09T17:05:00.000Z",
  });
  assert.equal(draftAlreadyCleared.verification, "user_report");
});

test("commMarkSent writes a distinct activity-log summary per verification tier", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);

  const verified = commMarkSent({
    repoRoot,
    id: "comm-with-draft",
    verification: "verified",
    deliveryEvidence: "Delivery confirmation captured",
    at: "2026-08-09T17:00:00.000Z",
  });
  assert.match(verified.event.summary, /delivery was verified/i);
  assert.match(verified.event.summary, /draft was cleared/i);

  const supervised = commMarkSent({
    repoRoot,
    id: "comm-with-draft",
    verification: "supervised",
    at: "2026-08-09T17:05:00.000Z",
  });
  assert.match(supervised.event.summary, /careerrat prepared this message/i);
  assert.match(supervised.event.summary, /user confirmed it was sent/i);

  const userReport = commMarkSent({
    repoRoot,
    id: "comm-with-draft",
    verification: "user_report",
    at: "2026-08-09T17:10:00.000Z",
  });
  assert.match(userReport.event.summary, /user reported the message sent/i);

  // Every tier's summary is distinct from the other two.
  const summaries = new Set([
    verified.event.summary,
    supervised.event.summary,
    userReport.event.summary,
  ]);
  assert.equal(summaries.size, 3);
});

test("commMarkSent still clears comm.draft (sent-clears-draft invariant) regardless of verification tier", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  commMarkSent({
    repoRoot,
    id: "comm-with-draft",
    verification: "user_report",
  });

  const commRow = db.prepare("SELECT data FROM communications WHERE id = ?").get("comm-with-draft");
  const comm = JSON.parse(commRow.data);
  assert.equal(comm.status, "waiting");
  assert.equal(comm.draft, null);
});

test("commSetDraft stores a reviewable draft and appends its durable message history", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  commSetDraft({
    repoRoot,
    id: "comm-with-draft",
    draft: {
      subject: "Re: SRE next steps",
      body: "Thanks for the update. Tuesday afternoon works well for me.",
    },
    summary: "Drafted scheduling reply for Tuesday afternoon.",
    at: "2026-08-09T17:00:00.000Z",
  });

  const row = db.prepare("SELECT data FROM communications WHERE id = ?").get("comm-with-draft");
  const comm = JSON.parse(row.data);
  assert.equal(comm.status, "drafted");
  assert.deepEqual(comm.draft, {
    subject: "Re: SRE next steps",
    body: "Thanks for the update. Tuesday afternoon works well for me.",
  });
  assert.equal(comm.nextAction, "Review and send reply");
  assert.equal(comm.messages.at(-1).direction, "outbound-draft");
  assert.equal(comm.messages.at(-1).at, "2026-08-09T17:00:00.000Z");
  assert.equal(comm.messages.at(-1).subject, "Re: SRE next steps");
});

test("ISSUE-038 commCaptureInbound opens or appends one actionable thread without losing provenance", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  const first = commCaptureInbound({
    repoRoot,
    applicationId: "app-non-interview",
    company: "Initech",
    role: "Analyst",
    channel: "email",
    subject: "Next steps",
    participant: { name: "Jordan Lee", email: "jordan@initech.example" },
    summary: "Recruiter asked for availability next week.",
    artifactPath: "workspace/intake/pastes/intake-recruiter-1.md",
    sourceId: "intake-recruiter-1",
    at: "2026-08-09T18:00:00.000Z",
  });

  assert.equal(first.created, true);
  const opened = JSON.parse(
    db.prepare("SELECT data FROM communications WHERE id = ?").get(first.id).data
  );
  assert.equal(opened.applicationId, "app-non-interview");
  assert.equal(opened.status, "needs-reply");
  assert.equal(opened.nextAction, "Review and reply");
  assert.equal(opened.messages.length, 1);
  assert.equal(opened.messages[0].direction, "inbound");
  assert.equal(opened.messages[0].artifactPath, "workspace/intake/pastes/intake-recruiter-1.md");
  assert.equal(opened.messages[0].id, "intake:intake-recruiter-1");

  const second = commCaptureInbound({
    repoRoot,
    applicationId: "app-non-interview",
    company: "Initech",
    role: "Analyst",
    channel: "email",
    summary: "Recruiter confirmed the Tuesday time.",
    artifactPath: "workspace/intake/pastes/intake-recruiter-2.md",
    sourceId: "intake-recruiter-2",
    at: "2026-08-09T19:00:00.000Z",
  });

  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  const appended = JSON.parse(
    db.prepare("SELECT data FROM communications WHERE id = ?").get(first.id).data
  );
  assert.equal(appended.messages.length, 2);
  assert.equal(appended.lastInboundAt, "2026-08-09T19:00:00.000Z");
  assert.equal(appended.summary, "Recruiter confirmed the Tuesday time.");
});

// ---------------------------------------------------------------------------
// Every verb bumps meta.version + meta.lastUpdatedAt exactly once, and leaves
// a matching activity_events row.
// ---------------------------------------------------------------------------

test("every domain-action verb bumps version by exactly 1, advances lastUpdatedAt, and logs one activity row", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  let { version: expectedVersion } = readMeta(db);

  function expectOneBump(label, fn) {
    const before = readMeta(db);
    const beforeActivity = activityCount(db);
    const result = fn();
    const after = readMeta(db);
    expectedVersion += 1;
    assert.equal(after.version, expectedVersion, `${label}: version must bump by exactly 1`);
    assert.equal(after.version, before.version + 1, `${label}: version must bump by exactly 1`);
    assert.notEqual(
      after.lastUpdatedAt,
      before.lastUpdatedAt,
      `${label}: lastUpdatedAt must advance`
    );
    assert.equal(
      activityCount(db),
      beforeActivity + 1,
      `${label}: must log exactly one activity_events row`
    );
    assert.ok(result?.event?.id, `${label}: verb result must carry the logged event`);
    assert.ok(
      activityRow(db, result.event.id),
      `${label}: the logged event id must exist in activity_events`
    );
    return result;
  }

  expectOneBump("appUpsert", () =>
    appUpsert({
      repoRoot,
      row: {
        id: "app-new-upsert",
        company: "NewCo",
        role: "Eng",
        status: "sourced",
      },
    })
  );
  expectOneBump("appSetFields", () =>
    appSetFields({
      repoRoot,
      id: "app-non-interview",
      patch: { statusNote: "note added" },
    })
  );
  expectOneBump("appPersistEvaluation", () => {
    const evaluation = {
      applicationId: "app-eval-review-hold",
      gate: "cut",
      fitScore: 55,
      fitBucket: "stretch",
    };
    return appPersistEvaluation({
      repoRoot,
      id: "app-eval-review-hold",
      evaluation,
      projection: { evaluation, fitScore: 55, fitBucket: "stretch" },
    });
  });
  expectOneBump("appScheduleInterview", () =>
    appScheduleInterview({
      repoRoot,
      id: "app-non-interview",
      at: "2030-01-01T00:00:00.000Z",
      round: "Screen",
    })
  );
  expectOneBump("appRegisterArtifact", () =>
    appRegisterArtifact({
      repoRoot,
      id: "app-non-interview",
      kind: "resume",
      path: "workspace/tailored/x.md",
    })
  );
  expectOneBump("calendarBusyUpsert", () =>
    calendarBusyUpsert({
      repoRoot,
      blocks: [
        {
          provider: "work_calendar",
          startIso: "2030-01-02T14:00:00.000Z",
          endIso: "2030-01-02T15:00:00.000Z",
        },
      ],
      source: "calendar_read",
    })
  );
  expectOneBump("calendarWriteAppend", () =>
    calendarWriteAppend({
      repoRoot,
      record: {
        provider: "google_calendar",
        eventId: "event-1",
        title: "Interview hold",
        eventIso: "2030-01-04T14:00:00.000Z",
      },
    })
  );
  expectOneBump("appCaptureInterviewIntake", () =>
    appCaptureInterviewIntake({
      repoRoot,
      id: "app-non-interview",
      summary: "Captured post-interview notes for review.",
      artifactPath: "workspace/intake/pastes/interview-notes.md",
    })
  );
  expectOneBump("commUpsert", () =>
    commUpsert({
      repoRoot,
      row: {
        id: "comm-new",
        company: "NewCo",
        channel: "email",
        status: "waiting",
      },
    })
  );
  expectOneBump("commAppendMessage", () =>
    commAppendMessage({
      repoRoot,
      id: "comm-new",
      message: { direction: "outbound-sent", at: "2030-01-01T00:00:00.000Z" },
    })
  );
  expectOneBump("commCaptureInbound", () =>
    commCaptureInbound({
      repoRoot,
      applicationId: "app-non-interview",
      company: "Initech",
      role: "Analyst",
      channel: "email",
      summary: "Recruiter sent an update.",
      artifactPath: "workspace/intake/pastes/intake-bump.md",
      sourceId: "intake-bump",
    })
  );
  expectOneBump("commSetDraft", () =>
    commSetDraft({
      repoRoot,
      id: "comm-new",
      draft: { body: "Draft body" },
      summary: "Draft reply",
    })
  );
  expectOneBump("relationshipLeadUpsertBatch", () =>
    relationshipLeadUpsertBatch({
      repoRoot,
      leads: [
        {
          applicationId: "app-non-interview",
          company: "Initech",
          role: "Analyst",
          name: "Jordan Lee",
          type: "Recruiter",
          platform: "linkedin",
          url: "https://example.test/jordan",
          basis: "Likely recruiting owner for the tracked role.",
        },
      ],
    })
  );
  expectOneBump("relationshipLeadSetStatus", () =>
    relationshipLeadSetStatus({
      repoRoot,
      id: "lead-initech-jordan-lee-linkedin",
      status: "approved",
      at: "2030-01-05T00:00:00.000Z",
      dueAt: "2030-01-08",
    })
  );
  expectOneBump("sourcedUpsertBatch", () =>
    sourcedUpsertBatch({
      repoRoot,
      rows: [{ id: "sourced-batch-1", company: "BatchCo", fitScore: 60 }],
    })
  );
  expectOneBump("sourcedSetStatus", () =>
    sourcedSetStatus({
      repoRoot,
      id: "sourced-batch-1",
      to: "cut",
      note: "Outside the target role family.",
    })
  );
  expectOneBump("sourcedPromote", () => sourcedPromote({ repoRoot, id: "sourced-promote-me" }));
});

test("sourcedSetStatus patches status and note, refreshes analytics, and rejects an unknown id", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  const result = sourcedSetStatus({
    repoRoot,
    id: "sourced-promote-me",
    to: "cut",
    note: "Role scope is not a match.",
  });

  const row = db.prepare("SELECT data FROM sourced WHERE id = ?").get("sourced-promote-me");
  const sourced = JSON.parse(row.data);
  assert.equal(sourced.status, "cut");
  assert.equal(sourced.note, "Role scope is not a match.");
  assert.equal(result.from, "sourced");
  assert.equal(result.to, "cut");
  assert.ok(result.analytics, "status changes must refresh outcome analytics");
  const storedAnalytics = db.prepare("SELECT data FROM analytics WHERE id = 1").get();
  assert.deepEqual(JSON.parse(storedAnalytics.data), result.analytics);

  assert.throws(
    () => sourcedSetStatus({ repoRoot, id: "missing-role", to: "cut" }),
    (err) => err?.code === "NOT_FOUND"
  );
});

test("sourcedUpsertBatch prepares rows before opening its write transaction", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  let prepared = false;

  sourcedUpsertBatch({
    repoRoot,
    rows: [{ id: "sourced-prepared-outside-transaction", company: "Prepared Co" }],
    prepareAcceptedRow(row) {
      const contender = new DatabaseSync(dbFilePath({ repoRoot }));
      try {
        contender.exec("PRAGMA busy_timeout = 1");
        contender.exec("BEGIN IMMEDIATE");
        contender.exec("ROLLBACK");
        prepared = true;
        return row;
      } finally {
        contender.close();
      }
    },
  });

  assert.equal(prepared, true);
});

test("sourced policy reconciliation rolls back when the active-search guard rejects the write", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });
  const before = JSON.parse(
    db.prepare("SELECT data FROM sourced WHERE id = ?").get("sourced-promote-me").data
  );
  const beforeMeta = db.prepare("SELECT version FROM meta WHERE id = 1").get().version;
  const beforeEvents = db.prepare("SELECT COUNT(*) AS count FROM activity_events").get().count;

  assert.throws(
    () =>
      sourcedReconcilePolicyBatch({
        repoRoot,
        decisions: [
          {
            id: "sourced-promote-me",
            bucket: "salary",
            reason: "comp-below-floor",
            expectedStatus: "sourced",
            expectedUpdatedAt: "",
            expectedJobArtifact: "",
          },
        ],
        guard: () => {
          const error = new Error("the search is no longer active");
          error.code = "SOURCING_RUN_NOT_ACTIVE";
          throw error;
        },
      }),
    (error) => error?.code === "SOURCING_RUN_NOT_ACTIVE"
  );

  const after = JSON.parse(
    db.prepare("SELECT data FROM sourced WHERE id = ?").get("sourced-promote-me").data
  );
  assert.deepEqual(after, before);
  assert.equal(db.prepare("SELECT version FROM meta WHERE id = 1").get().version, beforeMeta);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM activity_events").get().count,
    beforeEvents
  );
});

test("appRegisterPacketArtifacts accepts GeneratedAt timestamps but still rejects external paths", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);

  appRegisterPacketArtifacts({
    repoRoot,
    id: "app-non-interview",
    artifacts: {
      resume: "workspace/tailored/example-resume.md",
      resumeGeneratedAt: "2026-07-17T12:00:00.000Z",
    },
    manifest: {
      applicationId: "app-non-interview",
      generatedAt: "2026-07-17T12:00:00.000Z",
      uploadReady: false,
      status: "reviewable",
      gapCount: 0,
      artifacts: {},
    },
  });

  const db = openDb({ repoRoot });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-non-interview");
  assert.equal(JSON.parse(row.data).artifacts.resumeGeneratedAt, "2026-07-17T12:00:00.000Z");

  assert.throws(
    () =>
      appRegisterPacketArtifacts({
        repoRoot,
        id: "app-non-interview",
        artifacts: { resumePdf: "/tmp/outside-workspace.pdf" },
      }),
    /workspace|artifact path/i
  );
});

// activityAppend is the one domain-action-shaped verb that does NOT bump the
// freshness stamp (verbs/activity.mjs: "logging alone isn't a tracker.json
// data change") — same carve-out as analyticsRefresh, just for a different
// reason. It still must log its event.
test("activityAppend logs an activity row WITHOUT bumping meta.version or lastUpdatedAt", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  const before = readMeta(db);
  const beforeActivity = activityCount(db);

  const result = activityAppend({
    repoRoot,
    event: { type: "system", title: "standalone activity log entry" },
  });

  const after = readMeta(db);
  assert.equal(after.version, before.version, "activityAppend must not bump version");
  assert.equal(
    after.lastUpdatedAt,
    before.lastUpdatedAt,
    "activityAppend must not bump lastUpdatedAt"
  );
  assert.equal(activityCount(db), beforeActivity + 1, "activityAppend must still log its event");
  assert.ok(activityRow(db, result.event.id));
});

test("sourceWatermarkUpsert updates sources[] + meta.lastSweepAt without bumping freshness or logging activity", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  const before = readMeta(db);
  const beforeActivity = activityCount(db);

  const result = sourceWatermarkUpsert({
    repoRoot,
    sources: [
      {
        id: "apple-mail",
        kind: "apple-mail",
        name: "Apple Mail",
        lastRunAt: "2030-01-02T00:00:00.000Z",
      },
    ],
    at: "2030-01-02T00:00:00.000Z",
  });

  const after = readMeta(db);
  assert.equal(after.version, before.version, "source watermark must not bump version");
  assert.equal(
    after.lastUpdatedAt,
    before.lastUpdatedAt,
    "source watermark must not advance lastUpdatedAt"
  );
  assert.equal(activityCount(db), beforeActivity, "source watermark must not log activity");
  assert.equal(result.meta.lastSweepAt, "2030-01-02T00:00:00.000Z");

  const sourceRow = db.prepare("SELECT data FROM sources WHERE id = ?").get("apple-mail");
  assert.equal(JSON.parse(sourceRow.data).lastRunAt, "2030-01-02T00:00:00.000Z");
  const metaRow = db.prepare("SELECT last_sweep_at FROM meta WHERE id = 1").get();
  assert.equal(metaRow.last_sweep_at, "2030-01-02T00:00:00.000Z");

  const exportedTracker = JSON.parse(
    readFileSync(userPath({ repoRoot }, "workspace/tracker.json"), "utf8")
  );
  assert.equal(exportedTracker.meta.lastSweepAt, "2030-01-02T00:00:00.000Z");
  assert.equal(exportedTracker.sources[0].id, "apple-mail");
});

// ---------------------------------------------------------------------------
// analyticsRefresh is derived data: it must NOT bump the freshness stamp.
// ---------------------------------------------------------------------------

test("analyticsRefresh recomputes the analytics block WITHOUT bumping meta.version or lastUpdatedAt", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  const before = readMeta(db);
  const beforeActivity = activityCount(db);

  const result = analyticsRefresh({ repoRoot });
  assert.ok(result.analytics, "analyticsRefresh must return the recomputed analytics block");

  const after = readMeta(db);
  assert.equal(after.version, before.version, "analyticsRefresh must not bump version");
  assert.equal(
    after.lastUpdatedAt,
    before.lastUpdatedAt,
    "analyticsRefresh must not bump lastUpdatedAt"
  );
  assert.equal(
    activityCount(db),
    beforeActivity,
    "analyticsRefresh must not log an activity event"
  );

  const stored = db.prepare("SELECT data FROM analytics WHERE id = 1").get();
  assert.deepEqual(JSON.parse(stored.data), result.analytics);
});

test("calendarBusyUpsert appends opaque busy blocks, dedupes provider/start/end, and exports calendarBusy", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  const result = calendarBusyUpsert({
    repoRoot,
    blocks: [
      {
        provider: "google_calendar",
        startIso: "2030-01-02T14:00:00.000Z",
        endIso: "2030-01-02T15:00:00.000Z",
        label: "Sensitive meeting subject",
        source: "calendar_read",
      },
      {
        provider: "google_calendar",
        startIso: "2030-01-02T14:00:00.000Z",
        endIso: "2030-01-02T15:00:00.000Z",
        allDay: true,
        label: "Replacement subject",
      },
      {
        provider: "work_calendar",
        startIso: "2030-01-03T00:00:00.000Z",
        endIso: "2030-01-04T00:00:00.000Z",
        allDay: true,
      },
    ],
    source: "calendar_read",
  });

  assert.equal(result.count, 2);
  const stored = readKv(db, "calendarBusy");
  assert.equal(stored.length, 2);
  assert.deepEqual(
    stored.map((block) => block.label),
    ["Busy", "Busy"],
    "stored blocks must never carry real meeting titles"
  );
  assert.equal(stored[0].provider, "google_calendar");
  assert.equal(stored[0].allDay, true, "last duplicate wins while deduping");
  assert.equal(stored[0].source, "calendar_read");
  assert.match(stored[0].id, /^busy_[a-f0-9]{16}$/);
  assert.ok(stored[0].ingestedAt);

  const exportedTracker = JSON.parse(
    readFileSync(userPath({ repoRoot }, "workspace/tracker.json"), "utf8")
  );
  assert.deepEqual(exportedTracker.calendarBusy, stored);
  assert.ok(activityRow(db, result.event.id));
});

test("calendarWriteAppend appends calendar write history, dedupes provider/event/date/title, and exports calendarWrites", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  const first = calendarWriteAppend({
    repoRoot,
    record: {
      provider: "google_calendar",
      eventId: "evt-123",
      title: "Interview hold",
      eventIso: "2030-01-02T14:00:00.000Z",
      summary: "Initial write.",
    },
  });
  const second = calendarWriteAppend({
    repoRoot,
    record: {
      provider: "google_calendar",
      eventId: "evt-123",
      title: "Interview hold",
      eventIso: "2030-01-02T14:00:00.000Z",
      summary: "Replacement write.",
      artifactPath: "workspace/calendar/hold.ics",
    },
  });

  assert.equal(first.count, 1);
  assert.equal(second.count, 1);
  const stored = readKv(db, "calendarWrites");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, "written");
  assert.equal(stored[0].summary, "Replacement write.");
  assert.equal(stored[0].artifactPath, "workspace/calendar/hold.ics");
  assert.match(stored[0].id, /^cal_[a-f0-9]{16}$/);
  assert.ok(stored[0].wroteAt);

  const exportedTracker = JSON.parse(
    readFileSync(userPath({ repoRoot }, "workspace/tracker.json"), "utf8")
  );
  assert.deepEqual(exportedTracker.calendarWrites, stored);
  assert.ok(activityRow(db, second.event.id));
});

test("calendarWriteAppend defaults provenance to manual, coerces an invalid value, and persists automated when explicitly set", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  const defaulted = calendarWriteAppend({
    repoRoot,
    record: {
      provider: "google_calendar",
      eventId: "evt-default",
      title: "Interview hold",
      eventIso: "2030-02-01T14:00:00.000Z",
    },
  });
  assert.equal(defaulted.record.provenance, "manual");
  assert.equal(defaulted.event.title, "Calendar write recorded");

  const invalid = calendarWriteAppend({
    repoRoot,
    record: {
      provider: "apple_calendar",
      eventId: "evt-invalid",
      title: "Onsite hold",
      eventIso: "2030-02-02T14:00:00.000Z",
      provenance: "definitely-not-real",
    },
  });
  assert.equal(invalid.record.provenance, "manual");
  assert.equal(invalid.event.title, "Calendar write recorded");

  // The verb itself gates automated provenance on a live calendar_sync
  // grant, so the consent has to exist before an automated row can persist.
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "automation",
    patch: {
      setup_mode: "advanced",
      capabilities: {
        calendar_sync: { enabled: true, platforms: { outlook_calendar: true } },
      },
      consent: { outlook_calendar: true },
    },
  });
  const automated = calendarWriteAppend({
    repoRoot,
    env: {},
    record: {
      provider: "outlook_calendar",
      eventId: "evt-automated",
      title: "Screen hold",
      eventIso: "2030-02-03T14:00:00.000Z",
      provenance: "automated",
    },
  });
  assert.equal(automated.record.provenance, "automated");
  assert.equal(automated.event.title, "Calendar event synced");

  const stored = readKv(db, "calendarWrites");
  assert.equal(stored.length, 3);
});

test("calendarWriteAppend dedupe policy: same-kind re-records replace, automated always beats a manual self-report of the same event", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  // Automated rows in the matrix below must clear the verb-level consent
  // gate, so grant calendar_sync for the matrix provider up front.
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "automation",
    patch: {
      setup_mode: "advanced",
      capabilities: {
        calendar_sync: { enabled: true, platforms: { google_calendar: true } },
      },
      consent: { google_calendar: true },
    },
  });

  const sameEvent = {
    provider: "google_calendar",
    eventId: "evt-matrix",
    title: "Recurring hold",
    eventIso: "2030-03-01T14:00:00.000Z",
  };

  // manual then manual -> second replaces (a corrected summary wins).
  calendarWriteAppend({
    repoRoot,
    env: {},
    record: { ...sameEvent, provenance: "manual", summary: "First manual." },
  });
  let result = calendarWriteAppend({
    repoRoot,
    env: {},
    record: { ...sameEvent, provenance: "manual", summary: "Second manual." },
  });
  assert.equal(result.record.provenance, "manual");
  assert.equal(result.record.summary, "Second manual.");
  assert.equal(readKv(db, "calendarWrites").length, 1);

  // manual then automated -> automated replaces.
  result = calendarWriteAppend({
    repoRoot,
    env: {},
    record: {
      ...sameEvent,
      provenance: "automated",
      summary: "Now automated.",
    },
  });
  assert.equal(result.record.provenance, "automated");
  assert.equal(result.record.summary, "Now automated.");
  assert.equal(readKv(db, "calendarWrites").length, 1);

  // automated then manual -> automated stays; the manual self-report is dropped,
  // never downgrading an already app-verified record. A dropped no-op also
  // logs no activity event, so repeated self-reports can't pile up audit rows.
  result = calendarWriteAppend({
    repoRoot,
    env: {},
    record: {
      ...sameEvent,
      provenance: "manual",
      summary: "Attempted downgrade.",
    },
  });
  assert.equal(result.record.provenance, "automated");
  assert.equal(result.record.summary, "Now automated.");
  assert.equal(result.replaced, false);
  assert.equal(result.event, null);
  assert.equal(readKv(db, "calendarWrites").length, 1);

  // automated then automated -> second replaces.
  result = calendarWriteAppend({
    repoRoot,
    env: {},
    record: {
      ...sameEvent,
      provenance: "automated",
      summary: "Second automated.",
    },
  });
  assert.equal(result.record.provenance, "automated");
  assert.equal(result.record.summary, "Second automated.");
  assert.equal(readKv(db, "calendarWrites").length, 1);
});

test("calendarWriteAppend refuses an automated record without a live calendar_sync grant", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  // The gate lives in the verb itself, so the ungated legacy entry points
  // (the data route and the CLI) meet the same bar as the Ask intent: no
  // grant, no "automated, app-verified" row.
  assert.throws(
    () =>
      calendarWriteAppend({
        repoRoot,
        env: {},
        record: {
          provider: "google_calendar",
          eventId: "evt-ungated",
          title: "Fabricated hold",
          eventIso: "2030-04-01T14:00:00.000Z",
          provenance: "automated",
        },
      }),
    (error) => error.code === "CALENDAR_WRITE_NOT_ALLOWED"
  );
  assert.equal(readKv(db, "calendarWrites"), null);
});

test("relationshipLeadUpsertBatch stores review leads, dedupes company/name/platform, and clears sourcing CTAs on linked apps", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  const result = relationshipLeadUpsertBatch({
    repoRoot,
    leads: [
      {
        applicationId: "app-non-interview",
        company: "Initech",
        role: "Analyst",
        name: "Jordan Lee",
        type: "Recruiter",
        title: "Talent Partner",
        platform: "linkedin",
        url: "https://example.test/jordan",
        basis: "Likely recruiting owner for the tracked role.",
      },
      {
        applicationId: "app-non-interview",
        company: "INITECH",
        role: "Analyst",
        name: "jordan lee",
        platform: "linkedin",
        basis: "Updated basis wins on duplicate.",
      },
    ],
  });

  assert.equal(result.count, 1);
  assert.deepEqual(result.updatedApplications, ["app-non-interview"]);

  const stored = readKv(db, "relationshipLeads");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, "lead-initech-jordan-lee-linkedin");
  assert.equal(stored[0].status, "review");
  assert.equal(stored[0].basis, "Updated basis wins on duplicate.");
  assert.ok(stored[0].foundAt);
  assert.ok(stored[0].updatedAt);

  const app = JSON.parse(
    db.prepare("SELECT data FROM applications WHERE id = ?").get("app-non-interview").data
  );
  assert.equal(app.nextAction, "Review relationship leads: approve or reject in Network tab");
  assert.equal(app.nextActionDue, null);

  const exportedTracker = JSON.parse(
    readFileSync(userPath({ repoRoot }, "workspace/tracker.json"), "utf8")
  );
  assert.deepEqual(exportedTracker.relationshipLeads, stored);
  assert.ok(activityRow(db, result.event.id));
});

test("relationshipLeadUpsertBatch never clobbers a real reminder that only mentions a sourcing noun", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  // "Call the recruiter back" is an appointment and "Build a relationship
  // with the hiring manager" is coaching — neither is a sourcing CTA, so a
  // lead landing for this company must leave them (and due dates) untouched.
  const seeded = JSON.parse(
    db.prepare("SELECT data FROM applications WHERE id = ?").get("app-non-interview").data
  );
  const reminders = [
    "Call the recruiter back at 3pm",
    "Build a relationship with the hiring manager",
  ];
  for (const reminder of reminders) {
    db.prepare("UPDATE applications SET data = ? WHERE id = ?").run(
      JSON.stringify({
        ...seeded,
        nextAction: reminder,
        nextActionDue: "2030-01-05",
      }),
      "app-non-interview"
    );

    const result = relationshipLeadUpsertBatch({
      repoRoot,
      leads: [
        {
          applicationId: "app-non-interview",
          company: "Initech",
          name: "Casey Wu",
          platform: "linkedin",
        },
      ],
    });

    assert.equal(result.count, 1);
    assert.deepEqual(result.updatedApplications, []);
    const app = JSON.parse(
      db.prepare("SELECT data FROM applications WHERE id = ?").get("app-non-interview").data
    );
    assert.equal(app.nextAction, reminder);
    assert.equal(app.nextActionDue, "2030-01-05");
  }
});

test("relationshipLeadSetStatus approves or rejects leads and updates linked app action state in the same transaction", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  relationshipLeadUpsertBatch({
    repoRoot,
    leads: [
      {
        applicationId: "app-non-interview",
        company: "Initech",
        role: "Analyst",
        name: "Jordan Lee",
        type: "Recruiter",
        title: "Talent Partner",
        platform: "linkedin",
      },
      {
        applicationId: "app-non-interview",
        company: "Initech",
        role: "Analyst",
        name: "Casey Park",
        type: "Contact",
        platform: "wellfound",
      },
    ],
  });

  const approved = relationshipLeadSetStatus({
    repoRoot,
    id: "lead-initech-jordan-lee-linkedin",
    status: "approved",
    at: "2030-01-05T00:00:00.000Z",
    dueAt: "2030-01-08",
  });
  assert.equal(approved.lead.status, "approved");
  assert.equal(approved.lead.approvedAt, "2030-01-05T00:00:00.000Z");

  let app = JSON.parse(
    db.prepare("SELECT data FROM applications WHERE id = ?").get("app-non-interview").data
  );
  assert.equal(app.nextAction, "Send outreach to Jordan Lee via email-comms");
  assert.equal(app.nextActionDue, "2030-01-08");
  assert.equal(app.conversations.at(-1).kind, "relationship lead approved");

  const rejected = relationshipLeadSetStatus({
    repoRoot,
    id: "lead-initech-casey-park-wellfound",
    status: "rejected",
    at: "2030-01-06T00:00:00.000Z",
    note: "Not relevant to this role.",
  });
  assert.equal(rejected.lead.status, "rejected");
  assert.equal(rejected.lead.rejectedAt, "2030-01-06T00:00:00.000Z");

  app = JSON.parse(
    db.prepare("SELECT data FROM applications WHERE id = ?").get("app-non-interview").data
  );
  assert.equal(
    app.nextAction,
    "Send outreach to Jordan Lee via email-comms",
    "an approved lead still exists, so rejecting another lead must not replace the outreach CTA"
  );

  const stored = readKv(db, "relationshipLeads");
  assert.deepEqual(
    stored.map((lead) => [lead.name, lead.status]),
    [
      ["Jordan Lee", "approved"],
      ["Casey Park", "rejected"],
    ]
  );
});

// ---------------------------------------------------------------------------
// sourcedPromote: moves the row out of sourced[] and into applications[] in
// one transaction — not a separate deferred cleanup.
// ---------------------------------------------------------------------------

test("sourcedPromote removes the row from sourced and creates it in applications, status reviewed-hold", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);
  const db = openDb({ repoRoot });

  sourcedPromote({ repoRoot, id: "sourced-promote-me" });

  const stillSourced = db.prepare("SELECT 1 FROM sourced WHERE id = ?").get("sourced-promote-me");
  assert.equal(stillSourced, undefined);

  const promoted = db
    .prepare("SELECT data FROM applications WHERE id = ?")
    .get("sourced-promote-me");
  assert.ok(promoted, "the promoted row must now exist in applications");
  const app = JSON.parse(promoted.data);
  assert.equal(app.status, "reviewed-hold");
  assert.equal(app.note, "Found through a trusted referral and awaiting a careful comp");
  assert.equal(Array.from(app.note).length, 60);
});

// ---------------------------------------------------------------------------
// Candidate setup: DB-mode app onboarding source of truth.
// ---------------------------------------------------------------------------

test("candidate setup initializes neutral DB records without writing candidate YAML", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  candidateSetupInitialize({ repoRoot });
  const config = candidateConfigGet({ repoRoot });

  assert.equal(config.profile.candidate.full_name, "");
  assert.equal(config.profile.candidate.email, "");
  assert.equal(config.profile.location.remote_scope, "home-country");
  assert.deepEqual(config.targeting.role_buckets, []);
  assert.deepEqual(config.evidence.claims, []);
  assert.equal(config.modes.usage_mode, "standard");
  assert.equal(config.setup.readiness.search_ready, false);
  assert.equal(config.setup.readiness.gate_ready, false);
  assert.equal(config.setup.readiness.apply_ready, false);

  assert.equal(existsSync(userPath({ repoRoot }, "candidate/profile.yml")), false);
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/targeting.yml")), false);
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/evidence.yml")), false);
});

test("candidate setup patches profile, search tracks, companies, and evidence into normalized DB tables", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });

  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: {
        full_name: "Ada Lovelace",
        email: "ada@example.com",
        location: "London",
      },
      location: {
        home: "London",
        remote: true,
        hybrid: false,
        onsite: false,
        relocation: [],
      },
      compensation: { minimum_base: 181234, target_base: 223456 },
      authorization: { work_authorized: true, requires_sponsorship: false },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Applied AI",
          priority: "primary",
          titles: ["Applied AI Engineer", "Forward Deployed Engineer"],
          notes: "Best overlap.",
          fit_signals: ["agentic workflows"],
          down_signals: ["pure ML research"],
        },
        {
          name: "Platform",
          priority: "secondary",
          titles: ["Platform Engineer"],
        },
      ],
      keep_signals: ["agents", "prototype-to-production"],
      cut_signals: ["pure research"],
      tracked_companies: ["OpenAI", "Anthropic"],
      excluded_companies: ["Evil Corp"],
    },
  });
  candidateEvidenceMerge({
    repoRoot,
    claims: [
      { id: "resume-001", claim: "Built agent workflow", evidence: "Resume" },
      { claim: "Led migration", evidence: "Resume" },
    ],
  });

  const config = candidateConfigGet({ repoRoot });
  assert.equal(config.profile.candidate.full_name, "Ada Lovelace");
  assert.equal(config.profile.compensation.minimum_base, 181234);
  assert.equal(config.targeting.role_buckets.length, 2);
  assert.equal(config.targeting.role_buckets[0].titles[1], "Forward Deployed Engineer");
  assert.deepEqual(config.targeting.role_buckets[0].fit_signals, ["agentic workflows"]);
  assert.deepEqual(config.targeting.role_buckets[0].down_signals, ["pure ML research"]);
  assert.deepEqual(config.targeting.tracked_companies, ["OpenAI", "Anthropic"]);
  assert.deepEqual(config.targeting.excluded_companies, ["Evil Corp"]);
  assert.equal(config.evidence.claims.length, 2);
  assert.equal(config.evidence.claims[1].id, "seed-001");

  const db = openDb({ repoRoot });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM candidate_search_tracks").get().n, 2);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM candidate_target_companies WHERE kind = 'target'").get()
      .n,
    2
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM candidate_target_companies WHERE kind = 'excluded'").get()
      .n,
    1
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM candidate_evidence_claims").get().n, 2);

  assert.equal(existsSync(userPath({ repoRoot }, "candidate/targeting.yml")), false);
});

test("candidate profile reads normalize missing remote scope to home-country", () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  db.prepare("UPDATE candidate_profile SET data = ? WHERE id = 1").run(
    JSON.stringify({
      candidate: { full_name: "Legacy Candidate" },
      location: {
        home: "London, UK",
        remote: true,
        hybrid: false,
        onsite: false,
      },
    })
  );

  assert.equal(candidateConfigGet({ repoRoot }).profile.location.remote_scope, "home-country");
});

test("candidate profile patches distinguish a resume home market from explicit work modes", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });

  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: { location: "Brooklyn, NY" },
      location: { home: "Brooklyn, NY" },
    },
  });
  assert.equal(
    candidateConfigGet({ repoRoot }).profile.location.mode_preferences_confirmed,
    undefined,
    "resume extraction may save the home market but must not choose work modes"
  );

  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: false,
      },
    },
  });
  assert.equal(candidateConfigGet({ repoRoot }).profile.location.mode_preferences_confirmed, true);
});

test("candidate profile patches normalize a plain-English no-relocation answer", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });

  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: false,
        max_commute_days_per_week: 2,
        relocation: false,
      },
    },
  });

  assert.deepEqual(candidateConfigGet({ repoRoot }).profile.location, {
    home: "",
    remote: true,
    remote_scope: "home-country",
    hybrid: true,
    onsite: false,
    mode_preferences_confirmed: true,
    max_commute_days_per_week: 2,
    relocation: [],
    travel_tolerance: "",
  });
});

test("candidate setup recomputes quick-start readiness from SQLite setup facts", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });

  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: { full_name: "Ada Lovelace", email: "ada@example.com" },
      location: { home: "New York, NY", remote: true },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Applied AI", titles: ["Applied AI Engineer"] }],
      tracked_companies: ["Anthropic"],
    },
  });

  let config = candidateConfigGet({ repoRoot });
  assert.equal(config.setup.readiness.search_ready, false);
  assert.match(config.setup.missing.search_ready.join("\n"), /source resume/i);

  candidateArtifactPut({
    repoRoot,
    id: "source-resume",
    kind: "source-resume",
    data: { path: "candidate/SOURCE_RESUME.md" },
  });

  config = candidateConfigGet({ repoRoot });
  assert.equal(config.setup.readiness.search_ready, true);
  assert.equal(config.setup.readiness.gate_ready, false);
  assert.match(config.setup.missing.gate_ready.join("\n"), /compensation floor/i);

  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      compensation: { comp_floors: { remote: 190000, hybrid: 210000 } },
      authorization: { work_authorized: true, requires_sponsorship: false },
    },
  });

  config = candidateConfigGet({ repoRoot });
  assert.equal(config.profile.compensation.minimum_base, null);
  assert.equal(config.setup.readiness.gate_ready, true);
  assert.equal(config.setup.readiness.apply_ready, false);
  assert.match(config.setup.missing.apply_ready.join("\n"), /evidence claims/i);

  candidateEvidenceMerge({
    repoRoot,
    claims: [{ claim: "Built an agentic intake workflow", evidence: "Resume" }],
  });

  config = candidateConfigGet({ repoRoot });
  assert.equal(config.setup.readiness.search_ready, true);
  assert.equal(config.setup.readiness.gate_ready, true);
  assert.equal(config.setup.readiness.apply_ready, true);
  assert.equal(config.setup.readiness.deep_ingest_complete, false);
  assert.match(config.setup.missing.deep_ingest_complete.join("\n"), /deeper evidence/i);
});

test("candidate setup computes deep_ingest_complete from terminal Deep ingest lanes, not candidate files", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });

  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: { full_name: "Ada Lovelace", email: "ada@example.com" },
      location: { home: "New York, NY", remote: true },
      compensation: { minimum_base: 190000 },
      authorization: { work_authorized: true, requires_sponsorship: false },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Applied AI", titles: ["Applied AI Engineer"] }],
      keep_signals: ["agent workflow builder"],
      cut_signals: ["no hands-on build"],
    },
  });
  candidateArtifactPut({
    repoRoot,
    id: "source-resume",
    kind: "source-resume",
    data: { path: "workspace/intake/source-resume.md" },
  });
  candidateEvidenceMerge({
    repoRoot,
    claims: [
      { claim: "Built an agentic intake workflow", evidence: "Resume" },
      { claim: "Led a SQLite app migration", evidence: "Resume" },
      { claim: "Created bounded AI proposal tests", evidence: "Resume" },
    ],
  });

  let config = candidateConfigGet({ repoRoot });
  assert.equal(config.setup.readiness.search_ready, true);
  assert.equal(
    config.setup.readiness.deep_ingest_complete,
    false,
    "source/search readiness must not imply deep-ingest completion"
  );

  const { deepIngestLaneSetState } = await import("../src/core/db/verbs/deep-ingest.mjs");
  for (const lane of [
    "source_coverage",
    "evidence_claims",
    "story_bank",
    "honesty_boundaries",
    "writing_voice",
    "role_signals",
  ]) {
    deepIngestLaneSetState({ repoRoot, lane, status: "completed" });
  }
  deepIngestLaneSetState({
    repoRoot,
    lane: "open_gaps",
    status: "not_available",
    reason: "No extra gaps are available yet.",
  });

  config = candidateConfigGet({ repoRoot });
  assert.equal(config.setup.readiness.deep_ingest_complete, true);
  assert.deepEqual(config.setup.missing.deep_ingest_complete, []);
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/profile.yml")), false);
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/stories.yml")), false);
});

test("candidate application limits are DB-backed and upsert by company plus scope", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });

  let config = candidateConfigGet({ repoRoot });
  assert.deepEqual(config["application-limits"].companies, []);

  const first = candidateApplicationLimitUpsert({
    repoRoot,
    row: {
      company: "OpenAI",
      cap: { max: 4, window_days: 180 },
      status: "caution",
      source: "careers FAQ",
    },
  });
  assert.equal(first.ok, true);
  assert.equal(first.data.companies.length, 1);
  assert.equal(first.data.companies[0].scope, "all-roles");

  candidateApplicationLimitUpsert({
    repoRoot,
    row: {
      company: "openai",
      scope: "all-roles",
      status: "blocked",
      hit_on: "2026-07-01",
      note: "Cap hit by a recent application.",
    },
  });

  config = candidateConfigGet({ repoRoot });
  assert.equal(config["application-limits"].companies.length, 1);
  assert.equal(config["application-limits"].companies[0].company, "OpenAI");
  assert.deepEqual(config["application-limits"].companies[0].cap, {
    max: 4,
    window_days: 180,
  });
  assert.equal(config["application-limits"].companies[0].status, "blocked");
  assert.equal(config["application-limits"].companies[0].hit_on, "2026-07-01");
  assert.equal(config["application-limits"].companies[0].note, "Cap hit by a recent application.");
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/application-limits.yml")), false);
});

test("candidate setup initialize is idempotent and never resets saved DB config", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: { full_name: "Katherine Johnson", email: "kj@example.com" },
    },
  });

  candidateSetupInitialize({ repoRoot });
  const config = candidateConfigGet({ repoRoot });
  assert.equal(config.profile.candidate.full_name, "Katherine Johnson");
  assert.equal(config.profile.candidate.email, "kj@example.com");
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/profile.yml")), false);
});

// ---------------------------------------------------------------------------
// candidateConfigPatch/candidateApplicationLimitUpsert/candidateEvidenceMerge/
// candidateEvidenceRemoveOne bump tracker meta (see completeCandidateConfigWrite),
// so a candidate write must not leave an EXISTING workspace/tracker.json
// silently behind the db while tracker-dev (which watches the file, not the
// db) never sees the change. But candidate profile/targeting/evidence data
// isn't part of assembleTrackerObject()'s shape at all — a candidate-only or
// packet-only workspace that has never touched the applications pipeline must
// stay tracker.json-free (deep-ingest-db.test.mjs / packet-generate-route.test.mjs
// pin this). So these four route through runVerb's `requireExistingTracker`
// option: skip the export when tracker.json doesn't exist yet, keep it in
// sync when it does.
// ---------------------------------------------------------------------------

test("candidateConfigPatch stays tracker.json-free in a candidate-only workspace", () => {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });

  const patched = candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: { full_name: "Grace Hopper", email: "grace@example.com" },
    },
  });

  assert.equal(patched.exported, false);
  assert.equal(
    existsSync(userPath({ repoRoot }, "workspace/tracker.json")),
    false,
    "a candidate-only workspace must not be forced into tracker.json existence"
  );
});

test("candidateConfigPatch keeps an EXISTING workspace/tracker.json in sync instead of leaving its meta stamp stale", () => {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });
  const db = openDb({ repoRoot });

  // A real tracker-pipeline write materializes tracker.json first — this is
  // the "tracker-dev is already watching this file" case the fix targets.
  kvUpsert({
    repoRoot,
    key: "strategyReview",
    value: { snapshot: { rejected: 0 } },
  });
  assert.ok(existsSync(userPath({ repoRoot }, "workspace/tracker.json")));

  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: { full_name: "Grace Hopper", email: "grace@example.com" },
    },
  });

  const exportedTracker = JSON.parse(
    readFileSync(userPath({ repoRoot }, "workspace/tracker.json"), "utf8")
  );
  const dbMeta = readMeta(db);
  assert.equal(exportedTracker.meta.version, dbMeta.version);
  assert.equal(exportedTracker.meta.lastUpdatedAt, dbMeta.lastUpdatedAt);
});

test("candidateApplicationLimitUpsert, candidateEvidenceMerge, and candidateEvidenceRemoveOne all keep an existing tracker.json in sync", () => {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });
  kvUpsert({
    repoRoot,
    key: "strategyReview",
    value: { snapshot: { rejected: 0 } },
  });

  const limitResult = candidateApplicationLimitUpsert({
    repoRoot,
    row: { company: "OpenAI", cap: { max: 3, window_days: 90 } },
  });
  assert.ok(
    limitResult.exported,
    "candidateApplicationLimitUpsert must export once tracker.json exists"
  );

  const mergeResult = candidateEvidenceMerge({
    repoRoot,
    claims: [{ claim: "Shipped a scheduler", evidence: "Resume" }],
  });
  assert.ok(mergeResult.exported, "candidateEvidenceMerge must export once tracker.json exists");

  const removeResult = candidateEvidenceRemoveOne({
    repoRoot,
    id: mergeResult.data.claims[0].id,
  });
  assert.ok(
    removeResult.exported,
    "candidateEvidenceRemoveOne must export once tracker.json exists"
  );
});

test("candidate and evidence writes stamp Activity with user-facing outcomes", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  const db = openDb({ repoRoot });

  function expectCandidateActivity(label, fn, expectedTitle, expectedOperation) {
    const before = readMeta(db);
    const beforeActivity = activityCount(db);
    const result = fn();
    const after = readMeta(db);

    assert.equal(after.version, before.version + 1, `${label}: version must bump once`);
    assert.notEqual(after.lastUpdatedAt, before.lastUpdatedAt, `${label}: timestamp must advance`);
    assert.equal(activityCount(db), beforeActivity + 1, `${label}: activity must be complete`);
    assert.equal(result.event.title, expectedTitle);
    assert.ok(result.event.tags.includes(`operation:${expectedOperation}`));
  }

  expectCandidateActivity(
    "profile",
    () =>
      candidateConfigPatch({
        repoRoot,
        name: "profile",
        patch: {
          candidate: {
            full_name: "Katherine Johnson",
            email: "kj@example.com",
          },
        },
      }),
    "Candidate profile updated",
    "candidate:profile-update"
  );
  expectCandidateActivity(
    "targeting",
    () =>
      candidateConfigPatch({
        repoRoot,
        name: "targeting",
        patch: {
          role_buckets: [
            {
              name: "Platform",
              priority: "primary",
              titles: ["Staff Engineer"],
            },
          ],
        },
      }),
    "Job targets updated",
    "candidate:targeting-update"
  );
  expectCandidateActivity(
    "evidence merge",
    () =>
      candidateEvidenceMerge({
        repoRoot,
        claims: [
          {
            id: "resume-001",
            claim: "Led platform migration",
            evidence: "Resume",
          },
        ],
      }),
    "Evidence bank updated",
    "candidate:evidence-save"
  );
  expectCandidateActivity(
    "evidence remove",
    () => candidateEvidenceRemoveOne({ repoRoot, id: "resume-001" }),
    "Evidence claim removed",
    "candidate:evidence-remove"
  );
});

test("application activity names outcomes instead of internal mutation verbs", () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot);

  const status = appSetStatus({
    repoRoot,
    id: "app-non-interview",
    to: "applied",
  });
  assert.equal(status.event.title, "Initech: Status changed to Applied");
  assert.equal(status.event.summary, "Previous status: Saved for review.");
  assert.doesNotMatch(status.event.title, /status\s+reviewed-hold|→/i);

  const evaluation = appSetFields({
    repoRoot,
    id: "app-non-interview",
    patch: {
      roleFit: { why: ["Strong platform fit"], risks: [] },
      compNote: "$190k-$220k base",
    },
  });
  assert.equal(evaluation.event.title, "Initech: Fit and compensation updated");
  assert.doesNotMatch(evaluation.event.title, /fields updated/i);

  const packet = appRegisterPacketArtifacts({
    repoRoot,
    id: "app-non-interview",
    artifacts: {
      resume: "workspace/tailored/initech-resume.md",
      coverLetter: "workspace/tailored/initech-cover-letter.md",
    },
    manifest: {
      applicationId: "app-non-interview",
      generatedAt: "2026-08-09T12:00:00.000Z",
      uploadReady: false,
      status: "reviewable",
      gapCount: 0,
      artifacts: {},
    },
  });
  assert.equal(packet.event.title, "Initech: Tailored application packet created");
  assert.equal(packet.event.summary, "Created tailored résumé and cover letter.");
  assert.doesNotMatch(packet.event.title, /registered/i);

  const jobDescription = appRegisterArtifact({
    repoRoot,
    id: "app-non-interview",
    kind: "jd",
    path: "workspace/jobs/initech.md",
  });
  assert.equal(jobDescription.event.title, "Initech: Job description captured");
  assert.doesNotMatch(jobDescription.event.title, /artifact registered/i);

  const sourced = sourcedSetStatus({
    repoRoot,
    id: "sourced-promote-me",
    to: "cut",
    note: "Outside the target role family.",
  });
  assert.equal(sourced.event.title, "Umbrella: Role skipped");
  assert.doesNotMatch(sourced.event.title, /sourced\s+sourced|→/i);
});

test("candidateEvidenceMerge replaces an existing explicit id even when the claim text changes", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });

  candidateEvidenceMerge({
    repoRoot,
    claims: [
      {
        id: "resume-001",
        claim: "Built the first version",
        evidence: "Resume",
      },
    ],
  });
  candidateEvidenceMerge({
    repoRoot,
    claims: [
      {
        id: "resume-001",
        claim: "Built the production version",
        evidence: "Resume v2",
      },
    ],
  });

  const config = candidateConfigGet({ repoRoot });
  assert.equal(config.evidence.claims.length, 1);
  assert.equal(config.evidence.claims[0].id, "resume-001");
  assert.equal(config.evidence.claims[0].claim, "Built the production version");
  assert.equal(config.evidence.claims[0].evidence, "Resume v2");
});

test("candidateEvidenceReplace atomically preserves edited ids and deletes unreferenced omissions", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  candidateEvidenceMerge({
    repoRoot,
    claims: [
      {
        id: "resume-001",
        claim: "Built the first version",
        evidence: "Resume",
      },
      {
        id: "project-001",
        claim: "Led the rollout",
        evidence: "Project notes",
      },
      { id: "omit-001", claim: "Old claim", evidence: "Old notes" },
    ],
  });
  appUpsert({
    repoRoot,
    row: {
      id: "app-evidence-ref",
      company: "Acme",
      role: "Staff Engineer",
      status: "drafted",
      packetManifest: {
        resume: {
          blocks: [{ text: "Grounded claim", evidenceIds: ["resume-001"] }],
        },
      },
    },
  });

  const result = candidateEvidenceReplace({
    repoRoot,
    claims: [
      {
        id: "resume-001",
        claim: "Built the production version",
        evidence: "Resume v2",
      },
      {
        id: "project-001",
        claim: "Led the rollout",
        evidence: "Project notes",
      },
    ],
  });

  assert.equal(result.replaced, 2);
  assert.equal(result.removed, 1);
  assert.deepEqual(
    candidateConfigGet({ repoRoot }).evidence.claims.map((claim) => claim.id),
    ["resume-001", "project-001"]
  );
  assert.equal(
    candidateConfigGet({ repoRoot }).evidence.claims[0].claim,
    "Built the production version"
  );
  const application = JSON.parse(
    openDb({ repoRoot })
      .prepare("SELECT data FROM applications WHERE id = ?")
      .get("app-evidence-ref").data
  );
  assert.deepEqual(application.packetManifest.resume.blocks[0].evidenceIds, ["resume-001"]);
});

test("candidateEvidenceReplace refuses to delete claims cited by application packets or stories", () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  candidateEvidenceMerge({
    repoRoot,
    claims: [
      {
        id: "keep-001",
        claim: "Built the production version",
        evidence: "Resume",
      },
      { id: "packet-001", claim: "Led the rollout", evidence: "Project notes" },
      {
        id: "story-001",
        claim: "Reduced latency",
        evidence: "Interview notes",
      },
    ],
  });
  appUpsert({
    repoRoot,
    row: {
      id: "app-evidence-in-use",
      company: "Acme",
      role: "Staff Engineer",
      status: "drafted",
      packetManifest: {
        resume: {
          blocks: [{ text: "Grounded claim", evidenceIds: ["packet-001"] }],
        },
      },
    },
  });
  db.prepare("INSERT INTO deep_ingest_story_bank (id, data) VALUES (?, ?)").run(
    "latency-story",
    JSON.stringify({
      id: "latency-story",
      status: "confirmed",
      title: "Latency reduction",
      evidence_ids: ["story-001"],
    })
  );
  const before = candidateConfigGet({ repoRoot }).evidence.claims;

  assert.throws(
    () =>
      candidateEvidenceReplace({
        repoRoot,
        claims: [
          {
            id: "keep-001",
            claim: "Built the production version",
            evidence: "Resume",
          },
        ],
      }),
    (error) => {
      assert.equal(error.code, "EVIDENCE_IN_USE");
      assert.deepEqual(error.claimIds, ["packet-001", "story-001"]);
      assert.deepEqual(error.references, [
        { claimId: "packet-001", owner: "application:app-evidence-in-use" },
        { claimId: "story-001", owner: "story:latency-story" },
      ]);
      return true;
    }
  );

  assert.deepEqual(candidateConfigGet({ repoRoot }).evidence.claims, before);
});

test("candidateEvidenceReplace rolls the entire replacement back when a later write fails", () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  candidateEvidenceMerge({
    repoRoot,
    claims: [
      { id: "resume-001", claim: "Original one", evidence: "Resume" },
      { id: "resume-002", claim: "Original two", evidence: "Resume" },
    ],
  });
  db.exec(`CREATE TRIGGER fail_evidence_replace
    BEFORE INSERT ON candidate_evidence_claims
    WHEN NEW.id = 'fail-write'
    BEGIN
      SELECT RAISE(ABORT, 'injected replacement failure');
    END`);

  assert.throws(
    () =>
      candidateEvidenceReplace({
        repoRoot,
        claims: [
          { id: "resume-001", claim: "Edited one", evidence: "Resume v2" },
          { id: "fail-write", claim: "Must fail", evidence: "Notes" },
        ],
      }),
    /injected replacement failure/
  );
  assert.deepEqual(candidateConfigGet({ repoRoot }).evidence.claims, [
    { id: "resume-001", claim: "Original one", evidence: "Resume" },
    { id: "resume-002", claim: "Original two", evidence: "Resume" },
  ]);
});

test("candidateEvidenceRemoveOne removes only the requested claim and rejects missing or unknown ids", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  candidateEvidenceMerge({
    repoRoot,
    claims: [
      {
        id: "resume-001",
        claim: "Built the first workflow",
        evidence: "Resume",
      },
      {
        id: "project-001",
        claim: "Led the second rollout",
        evidence: "Project notes",
      },
    ],
  });

  const removed = candidateEvidenceRemoveOne({ repoRoot, id: "resume-001" });

  assert.equal(removed.ok, true);
  assert.equal(removed.removed, "resume-001");
  assert.deepEqual(
    candidateConfigGet({ repoRoot }).evidence.claims.map((claim) => claim.id),
    ["project-001"]
  );
  assert.throws(
    () => candidateEvidenceRemoveOne({ repoRoot }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, "candidateEvidenceRemoveOne requires id");
      return true;
    }
  );
  assert.throws(
    () => candidateEvidenceRemoveOne({ repoRoot, id: "does-not-exist" }),
    (error) => {
      assert.equal(error.code, "NOT_FOUND");
      assert.equal(error.message, 'evidence claim not found: "does-not-exist"');
      return true;
    }
  );
});

test("candidateEvidenceMerge rejects residual placeholders and current_base tokens with structured guard errors", () => {
  for (const { claim, id, message } of [
    {
      id: "placeholder-claim",
      claim: "Built the [Company] migration workflow.",
      message: /unresolved placeholder \(bracket-token\).*\[Company\]/,
    },
    {
      id: "private-comp-claim",
      claim: "The current_base token must never enter evidence.",
      message: /contains the private current_base field/,
    },
  ]) {
    assert.throws(
      () => candidateEvidenceMerge({ claims: [{ id, claim, evidence: "Resume" }] }),
      (error) => {
        assert.equal(error.code, "EVIDENCE_GUARD_REJECTED");
        assert.equal(error.message, "evidence claim(s) refused by the honesty/privacy guard");
        assert.equal(Array.isArray(error.errors), true);
        assert.equal(error.errors.length, 1);
        assert.equal(error.errors[0].id, id);
        assert.match(error.errors[0].message, message);
        return true;
      }
    );
  }
});

test("candidateEvidenceMerge rejects a claim carrying an own current_base key and persists nothing", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });

  assert.throws(
    () =>
      candidateEvidenceMerge({
        repoRoot,
        claims: [
          {
            id: "comp-leak-claim",
            claim: "Negotiated a strong offer.",
            evidence: "Resume",
            current_base: 185000,
          },
        ],
      }),
    (error) => {
      assert.equal(error.code, "EVIDENCE_GUARD_REJECTED");
      assert.equal(error.message, "evidence claim(s) refused by the honesty/privacy guard");
      assert.equal(Array.isArray(error.errors), true);
      assert.equal(error.errors.length, 1);
      assert.equal(error.errors[0].id, "comp-leak-claim");
      assert.match(error.errors[0].message, /current_base key/);
      return true;
    }
  );

  const db = openDb({ repoRoot });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM candidate_evidence_claims").get().n, 0);
});

test("candidateEvidenceMerge rejects a malformed links/role_signals/forbidden_wording container (validation parity with evidence-writer)", () => {
  for (const field of ["links", "role_signals", "forbidden_wording"]) {
    assert.throws(
      () =>
        candidateEvidenceMerge({
          claims: [
            {
              id: "malformed-container",
              claim: "Shipped the onboarding flow",
              evidence: "Resume",
              [field]: "not-an-array",
            },
          ],
        }),
      (error) => {
        assert.equal(error.code, "EVIDENCE_GUARD_REJECTED");
        assert.equal(Array.isArray(error.errors), true);
        assert.ok(
          error.errors.some(
            (e) => e.message.includes(`"${field}"`) && e.message.includes("must be an array")
          ),
          `expected a container error for ${field}`
        );
        return true;
      }
    );
  }
});

test("candidateEvidenceMerge rejects non-string and empty/whitespace entries inside links/role_signals/forbidden_wording", () => {
  for (const field of ["links", "role_signals", "forbidden_wording"]) {
    assert.throws(
      () =>
        candidateEvidenceMerge({
          claims: [
            {
              id: "bad-entries",
              claim: "Shipped the onboarding flow",
              evidence: "Resume",
              [field]: [42],
            },
          ],
        }),
      (error) => {
        assert.equal(error.code, "EVIDENCE_GUARD_REJECTED");
        assert.ok(
          error.errors.some((e) => e.message.includes(`${field}[0]`)),
          `expected a non-string entry error for ${field}[0]`
        );
        return true;
      }
    );

    assert.throws(
      () =>
        candidateEvidenceMerge({
          claims: [
            {
              id: "blank-entry",
              claim: "Shipped the onboarding flow",
              evidence: "Resume",
              [field]: ["   "],
            },
          ],
        }),
      (error) => {
        assert.equal(error.code, "EVIDENCE_GUARD_REJECTED");
        assert.ok(
          error.errors.some((e) => e.message.includes(`${field}[0]`)),
          `expected an empty/whitespace entry error for ${field}[0]`
        );
        return true;
      }
    );
  }
});

test("candidateEvidenceMerge rejects placeholder residue inside links/role_signals/forbidden_wording", () => {
  for (const field of ["links", "role_signals", "forbidden_wording"]) {
    assert.throws(
      () =>
        candidateEvidenceMerge({
          claims: [
            {
              id: "placeholder-array-field",
              claim: "Shipped the onboarding flow",
              evidence: "Resume",
              [field]: ["Built [Company] integration"],
            },
          ],
        }),
      (error) => {
        assert.equal(error.code, "EVIDENCE_GUARD_REJECTED");
        assert.ok(
          error.errors.some((e) => e.message.includes("unresolved placeholder")),
          `expected a placeholder error for ${field}`
        );
        return true;
      }
    );
  }
});

test("candidateEvidenceMerge accepts a well-formed claim with links/role_signals/forbidden_wording and persists all three arrays", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });

  const result = candidateEvidenceMerge({
    repoRoot,
    claims: [
      {
        id: "well-formed-claim",
        claim: "Shipped the onboarding flow end to end",
        evidence: "Resume + project notes",
        links: ["https://example.com/case-study"],
        role_signals: ["self-serve onboarding"],
        forbidden_wording: ["invented the architecture solo"],
      },
    ],
  });

  assert.equal(result.added, 1);
  const config = candidateConfigGet({ repoRoot });
  const stored = config.evidence.claims.find((c) => c.id === "well-formed-claim");
  assert.ok(stored, "expected the well-formed claim to persist");
  assert.deepEqual(stored.links, ["https://example.com/case-study"]);
  assert.deepEqual(stored.role_signals, ["self-serve onboarding"]);
  assert.deepEqual(stored.forbidden_wording, ["invented the architecture solo"]);
});
