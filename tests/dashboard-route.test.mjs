// tests/dashboard-route.test.mjs — M10's GET /api/data/dashboard
// (src/cli/dashboard-route.mjs), mounted the same way tests/data-route.test.mjs
// and tests/intake-route.test.mjs mount their routes: a bare addRoute Map
// wrapped in http.createServer.
//
// Non-negotiable coverage per the M10 decisions memo:
//   - fail-closed 409 when no db exists yet (same posture as every other
//     /api/data/* route)
//   - PARITY: the route's payload deep-equals a direct buildDashboardViewModel()
//     call over the same source data — this is the actual correctness bar,
//     since dashboard-data.js's buildDashboardViewModel is reused UNMODIFIED
//     and the only new code is assembleTrackerObject(db)'s DB->trackerData
//     shape-fidelity
//   - CTA self-clear regression: commMarkSent (via the EXISTING
//     POST /api/data/comm/send verb route) clears a job's "Ready to send"
//     drawer panel on the very next dashboard refetch
//   - the interview 3-hour grace window re-asserted through the DB-backed
//     route (not just the pure builder, which tests/dashboard-data.test.mjs
//     already covers directly)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mountDashboardRoutes } from "../src/cli/dashboard-route.mjs";
import { mountDataRoutes } from "../src/cli/data-route.mjs";
import { automationStatus } from "../src/core/automation/consent.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { candidateConfigPatch } from "../src/core/db/verbs/candidate.mjs";
import {
  chatFirstStateFromDb,
  jobThreadSetPinned,
  missionCreate,
  mockInterviewStart,
} from "../src/core/db/verbs.mjs";
import { loadModes } from "../src/core/profile/modes.mjs";
import { loadAgentGuidanceSnapshot } from "../src/core/tracker/agent-guidance-snapshot.mjs";
import { buildDashboardViewModel } from "../src/core/tracker/dashboard-data.js";
import { loadLibrarySnapshot } from "../src/core/tracker/library-snapshot.mjs";
import { loadSettingsSnapshot } from "../src/core/tracker/settings-snapshot.mjs";

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEMO_DIR = join(REAL_ROOT, "examples/demo-workspace");
const cleanupRoots = [];
const READINESS_KEYS = ["search_ready", "gate_ready", "apply_ready", "deep_ingest_complete"];

// A fresh repoRoot with just enough of the real tree for loadModes() to work
// (it unconditionally reads config/modes.schema.json regardless of whether
// candidate/modes.yml itself exists — same requirement any test of the real
// `careerrat tracker`/`careerrat doctor` CLI would have). No candidate/*.yml
// files are copied in, so settings/library/agentGuidance all degrade to their
// documented "not configured" defaults — exactly what buildDashboardViewModel
// tolerates by design (every buildXStatus() reader defaults its own input to
// {}/null).
function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-dashboard-route-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  writeFileSync(
    join(repoRoot, "config/modes.schema.json"),
    readFileSync(join(REAL_ROOT, "config/modes.schema.json"))
  );
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

function bootServer(repoRoot, { now, candidateConfigGet } = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountDashboardRoutes({
    addRoute,
    repoRoot,
    env: {},
    ...(now ? { now } : {}),
    ...(candidateConfigGet ? { candidateConfigGet } : {}),
  });
  mountDataRoutes({ addRoute, repoRoot, env: {} });
  return { routes };
}

function closeServer(_server) {
  return Promise.resolve();
}

async function invokeJson(server, method, path, payload) {
  const routePath = path.split("?")[0];
  const route = server.routes.get(`${method} ${routePath}`);
  if (!route) return { status: 404, body: {} };

  const bodyText = payload === undefined ? "" : JSON.stringify(payload ?? {});
  const req = Readable.from(bodyText ? [Buffer.from(bodyText)] : []);
  req.method = method;
  req.url = path;

  let status = 200;
  let responseText = "";
  const done = new Promise((resolve) => {
    const res = {
      writeHead(nextStatus) {
        status = nextStatus;
        return res;
      },
      end(chunk = "") {
        responseText = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        resolve();
      },
    };
    Promise.resolve(route(req, res)).catch((err) => {
      status = 500;
      responseText = JSON.stringify({ ok: false, error: err.message });
      resolve();
    });
  });
  await done;

  let body = {};
  try {
    body = responseText ? JSON.parse(responseText) : {};
  } catch {
    body = { raw: responseText };
  }
  return { status, body };
}

async function getJson(server, path) {
  return invokeJson(server, "GET", path);
}

async function postJson(server, path, payload) {
  return invokeJson(server, "POST", path, payload);
}

function seedFixture(repoRoot, tracker) {
  const sourceDir = join(repoRoot, "fixture-source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "tracker.json"), JSON.stringify(tracker, null, 2));
  importFromTracker({ repoRoot, sourceDir });
}

test("loadAgentGuidanceSnapshot forces Electron's child into Node mode and preserves caller env", () => {
  const repoRoot = tempRepo();
  mkdirSync(join(repoRoot, "src/cli"), { recursive: true });
  writeFileSync(
    join(repoRoot, "src/cli/doctor.mjs"),
    `console.log(JSON.stringify({ agentGuidance: {
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
      callerEnv: process.env.CAREERRAT_TEST_CALLER_ENV,
    } }));\n`
  );

  const snapshot = loadAgentGuidanceSnapshot({
    root: repoRoot,
    env: { CAREERRAT_TEST_CALLER_ENV: "preserved" },
  });

  assert.deepEqual(snapshot, {
    electronRunAsNode: "1",
    callerEnv: "preserved",
  });
});

// ---------------------------------------------------------------------------
// Fail-closed
// ---------------------------------------------------------------------------

test("GET /api/data/dashboard: 409 with the fail-closed message when no db exists yet", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/data/dashboard");
    assert.equal(status, 409);
    assert.equal(body.setup, null);
    assert.match(body.error, /no database yet/);
    assert.match(body.error, /careerrat data import/);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// PARITY — the actual correctness bar: assembleTrackerObject(db) must be
// byte-shape-faithful to the source tracker.json, verified by feeding BOTH the
// route and a direct buildDashboardViewModel() call the exact same
// modes/settings/library/agentGuidance/activityEvents/now and deep-equaling
// the results.
// ---------------------------------------------------------------------------

test("GET /api/data/dashboard: the route's view model deep-equals a direct buildDashboardViewModel() call over the same demo-workspace tracker.json", async () => {
  const repoRoot = tempRepo();
  importFromTracker({ repoRoot, sourceDir: DEMO_DIR });

  const FIXED_NOW = new Date("2026-06-15T13:30:00.000Z");
  const server = await bootServer(repoRoot, { now: () => FIXED_NOW });
  try {
    const { status, body } = await getJson(server, "/api/data/dashboard");
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    // Independently assemble the SAME 4 config-file inputs the route computes
    // (the same loaders, not a re-derivation) plus the source tracker.json
    // read directly off disk (never round-tripped through the db) as
    // trackerData, and activityEvents:[] (examples/demo-workspace ships no
    // activity.jsonl, so the route's own assembleActivityEvents(db) is empty
    // too — see export-to-tracker.mjs).
    const source = JSON.parse(readFileSync(join(DEMO_DIR, "tracker.json"), "utf8"));
    const modes = loadModes({ root: repoRoot });
    const settings = loadSettingsSnapshot({ root: repoRoot });
    const library = loadLibrarySnapshot({ root: repoRoot });
    const agentGuidance = loadAgentGuidanceSnapshot({ root: repoRoot, env: {} });
    // The route's default automationStatusForRoute is the real automationStatus()
    // (src/core/automation/consent.mjs), reduced by readCalendarProviderStatus
    // (dashboard-route.mjs) into calendar_sync's per-platform {enabled, consent,
    // allowed}. A direct buildDashboardViewModel() call that omits this input
    // defaults to null ("Consent gated" for every provider), which disagreed with
    // the route's real (all-off, but non-null) calendarProviderStatus — mirror the
    // same reduction here so both sides compute the identical calendar.sync.providers.
    const rawAutomationStatus = automationStatus({ root: repoRoot });
    const calendarSync = rawAutomationStatus.capabilities.find(
      (capability) => capability.capability === "calendar_sync"
    );
    const calendarProviderStatus = calendarSync
      ? Object.fromEntries(
          calendarSync.platforms.map((platform) => [
            platform.platform,
            { enabled: platform.enabled, consent: platform.consent, allowed: platform.allowed },
          ])
        )
      : null;

    const direct = buildDashboardViewModel(source, {
      now: FIXED_NOW,
      activityEvents: [],
      modes,
      settings,
      library,
      agentGuidance,
      calendarProviderStatus,
    });
    direct.chatFirst = chatFirstStateFromDb(openDb({ repoRoot }), { now: FIXED_NOW });

    assert.deepEqual(body.data, direct);
    assert.equal(body.data.setup, undefined);
    assert.deepEqual(Object.keys(body.setup.readiness).sort(), READINESS_KEYS.slice().sort());
    assert.deepEqual(Object.keys(body.setup.missing).sort(), READINESS_KEYS.slice().sort());
  } finally {
    await closeServer(server);
  }
});

test("GET /api/data/dashboard: setup derivation errors degrade to setup null while the route still returns the dashboard", async () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot, {
    meta: {},
    applications: [
      { id: "app-1", company: "Aperture Science", role: "Test Engineer", status: "applied" },
    ],
    sourced: [],
    sources: [],
    communications: [],
  });

  const server = await bootServer(repoRoot, {
    candidateConfigGet: () => {
      throw new Error("setup unavailable");
    },
  });
  try {
    const { status, body } = await getJson(server, "/api/data/dashboard");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.setup, null);
    assert.equal(body.data.jobs.rows[0].company, "Aperture Science");
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// CTA self-clear regression — completing an action via the EXISTING
// POST /api/data/comm/send verb must clear the corresponding "Ready to send"
// drawer panel on the very next dashboard refetch (docs/activity-and-action-
// state.md's "completed-action clears its CTA" invariant).
// ---------------------------------------------------------------------------

test("GET /api/data/dashboard: commMarkSent (POST /api/data/comm/send) clears the job's Ready-to-send drawer panel on refetch", async () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot, {
    meta: {},
    applications: [
      { id: "app-1", company: "Aperture Science", role: "Test Engineer", status: "applied" },
    ],
    sourced: [],
    sources: [],
    communications: [
      {
        id: "comm-1",
        applicationId: "app-1",
        company: "Aperture Science",
        status: "needs-reply",
        channel: "email",
        draft: { subject: "Re: next steps", body: "Thanks for the update..." },
      },
    ],
  });

  const server = await bootServer(repoRoot);
  try {
    const before = await getJson(server, "/api/data/dashboard");
    assert.equal(before.status, 200);
    const draftsBefore = before.body.data.jobs.details["app-1"].drafts;
    assert.equal(draftsBefore.length, 1);
    assert.equal(draftsBefore[0].subject, "Re: next steps");

    const sent = await postJson(server, "/api/data/comm/send", { id: "comm-1" });
    assert.equal(sent.status, 200);

    const after = await getJson(server, "/api/data/dashboard");
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.data.jobs.details["app-1"].drafts, []);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Interview 3-hour grace window, re-asserted through the DB-backed route
// (INTERVIEW_FOCUS_GRACE_MS, dashboard-data.js:1297) — tests/dashboard-data.
// test.mjs already covers the pure builder directly; this proves the same
// behavior survives the DB round-trip.
// ---------------------------------------------------------------------------

test("GET /api/data/dashboard: focus card features the interview within the 3-hour grace window, and drops it just past the window", async () => {
  const repoRoot = tempRepo();
  const interviewAt = "2026-06-17T14:00:00.000Z";
  seedFixture(repoRoot, {
    meta: {},
    applications: [
      {
        id: "app-interview",
        company: "Aperture Science",
        role: "Forward Deployed Engineer",
        status: "interview",
        nextInterviewAt: interviewAt,
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  });

  const withinGrace = new Date(
    new Date(interviewAt).getTime() + 2 * 60 * 60 * 1000 + 59 * 60 * 1000
  );
  const pastGrace = new Date(new Date(interviewAt).getTime() + 3 * 60 * 60 * 1000 + 1 * 60 * 1000);

  const serverWithin = await bootServer(repoRoot, { now: () => withinGrace });
  try {
    const { body } = await getJson(serverWithin, "/api/data/dashboard");
    assert.equal(body.data.focus.kind, "interview");
    assert.equal(body.data.focus.company, "Aperture Science");
  } finally {
    await closeServer(serverWithin);
  }

  const serverPast = await bootServer(repoRoot, { now: () => pastGrace });
  try {
    const { body } = await getJson(serverPast, "/api/data/dashboard");
    assert.notEqual(body.data.focus.kind, "interview");
  } finally {
    await closeServer(serverPast);
  }
});

// ---------------------------------------------------------------------------
// calendar_sync provider status — the route reduces the real automationStatus()
// (candidate/automation.yml via the DB store) into calendar.sync.providers[].status
// (readCalendarProviderStatus -> buildCalendarSync's calendarProviderStatusLabel).
// ---------------------------------------------------------------------------

test("GET /api/data/dashboard: calendar sync providers reflect real automation consent — the granted platform reads Ready, every other platform does not", async () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot, {
    meta: {},
    applications: [],
    sourced: [],
    sources: [],
    communications: [],
  });
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

  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/data/dashboard");
    assert.equal(status, 200);
    const statusByKey = Object.fromEntries(
      body.data.calendar.sync.providers.map((provider) => [provider.key, provider.status])
    );
    assert.equal(statusByKey.google_calendar, "Ready");
    assert.notEqual(statusByKey.outlook_calendar, "Ready");
    assert.notEqual(statusByKey.apple_calendar, "Ready");
    assert.notEqual(statusByKey.automation_tools, "Ready");
  } finally {
    await closeServer(server);
  }
});

test("GET /api/data/dashboard includes the durable chat-first aggregate without replacing the established dashboard view model", async () => {
  const repoRoot = tempRepo();
  seedFixture(repoRoot, {
    meta: {},
    applications: [
      {
        id: "app-chat-first",
        company: "Cyberdyne Systems",
        role: "Staff Platform Engineer",
        status: "interview",
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  });
  jobThreadSetPinned({ repoRoot, applicationId: "app-chat-first" });
  missionCreate({
    repoRoot,
    id: "mission-chat-first",
    title: "Prepare one application",
    steps: [{ id: "packet", label: "Draft packet" }],
  });
  mockInterviewStart({
    repoRoot,
    id: "mock-chat-first",
    applicationId: "app-chat-first",
    questionTotal: 4,
  });

  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/data/dashboard");
    assert.equal(status, 200);
    assert.equal(body.data.jobs.rows[0].company, "Cyberdyne Systems");
    assert.equal(body.data.chatFirst.jobThreads[0].applicationId, "app-chat-first");
    assert.equal(body.data.chatFirst.missions[0].id, "mission-chat-first");
    assert.equal(body.data.chatFirst.mockSessions[0].id, "mock-chat-first");
  } finally {
    await closeServer(server);
  }
});
