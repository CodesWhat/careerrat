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
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import {
  activityAppend,
  analyticsRefresh,
  appRegisterArtifact,
  appScheduleInterview,
  appSetFields,
  appSetStatus,
  appUpsert,
  calendarBusyUpsert,
  candidateApplicationLimitUpsert,
  candidateArtifactPut,
  candidateConfigGet,
  candidateConfigPatch,
  candidateEvidenceMerge,
  candidateSetupInitialize,
  commAppendMessage,
  commMarkSent,
  commUpsert,
  sourcedPromote,
  sourcedUpsertBatch,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-db-verbs-"));
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
    { id: "sourced-promote-me", company: "Umbrella", role: "Coordinator", fitScore: 82 },
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

  appSetStatus({ repoRoot, id: "app-next-round-booked", to: "interview", clearInterview: true });

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

  const appRow = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-with-draft");
  const app = JSON.parse(appRow.data);
  assert.equal(app.followUp.draft, null);
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
      row: { id: "app-new-upsert", company: "NewCo", role: "Eng", status: "sourced" },
    })
  );
  expectOneBump("appSetFields", () =>
    appSetFields({ repoRoot, id: "app-non-interview", patch: { statusNote: "note added" } })
  );
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
  expectOneBump("commUpsert", () =>
    commUpsert({
      repoRoot,
      row: { id: "comm-new", company: "NewCo", channel: "email", status: "waiting" },
    })
  );
  expectOneBump("commAppendMessage", () =>
    commAppendMessage({
      repoRoot,
      id: "comm-new",
      message: { direction: "outbound-sent", at: "2030-01-01T00:00:00.000Z" },
    })
  );
  expectOneBump("sourcedUpsertBatch", () =>
    sourcedUpsertBatch({
      repoRoot,
      rows: [{ id: "sourced-batch-1", company: "BatchCo", fitScore: 60 }],
    })
  );
  expectOneBump("sourcedPromote", () => sourcedPromote({ repoRoot, id: "sourced-promote-me" }));
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
  assert.equal(JSON.parse(promoted.data).status, "reviewed-hold");
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
      candidate: { full_name: "Ada Lovelace", email: "ada@example.com", location: "London" },
      location: { home: "London", remote: true, hybrid: false, onsite: false, relocation: [] },
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
      compensation: { minimum_base: 190000 },
      authorization: { work_authorized: true, requires_sponsorship: false },
    },
  });

  config = candidateConfigGet({ repoRoot });
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
    patch: { candidate: { full_name: "Katherine Johnson", email: "kj@example.com" } },
  });

  candidateSetupInitialize({ repoRoot });
  const config = candidateConfigGet({ repoRoot });
  assert.equal(config.profile.candidate.full_name, "Katherine Johnson");
  assert.equal(config.profile.candidate.email, "kj@example.com");
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/profile.yml")), false);
});

test("candidateEvidenceMerge replaces an existing explicit id even when the claim text changes", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });

  candidateEvidenceMerge({
    repoRoot,
    claims: [{ id: "resume-001", claim: "Built the first version", evidence: "Resume" }],
  });
  candidateEvidenceMerge({
    repoRoot,
    claims: [{ id: "resume-001", claim: "Built the production version", evidence: "Resume v2" }],
  });

  const config = candidateConfigGet({ repoRoot });
  assert.equal(config.evidence.claims.length, 1);
  assert.equal(config.evidence.claims[0].id, "resume-001");
  assert.equal(config.evidence.claims[0].claim, "Built the production version");
  assert.equal(config.evidence.claims[0].evidence, "Resume v2");
});
