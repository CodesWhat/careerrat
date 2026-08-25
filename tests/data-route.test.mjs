// tests/data-route.test.mjs — the HTTP surface for M6's sqlite data layer
// (src/cli/data-route.mjs), mounted on a bare addRoute Map wrapped in
// http.createServer, mirroring tests/packet-route.test.mjs's bootServer() and
// tests/skill-run-route.test.mjs's POST-body pattern. Covers: happy-path reads
// + writes, fail-closed 409 when no db exists yet, and 400/404 validation.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { mountDataRoutes } from "../src/cli/data-route.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { dispatchHttpRoute } from "../src/core/tracker/route-dispatch.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-data-route-"));
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

function bootServer(repoRoot) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountDataRoutes({ addRoute, repoRoot, env: {} });

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    dispatchHttpRoute(route, req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function getJson(server, path) {
  const res = await fetch(`${baseUrl(server)}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function postJson(server, path, payload) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function seedDb(repoRoot) {
  const sourceDir = join(repoRoot, "fixture-source");
  const applications = [
    {
      id: "app-1",
      company: "Acme",
      role: "Staff Engineer",
      status: "reviewed-hold",
      nextAction: "Find recruiter contact",
      nextActionDue: "2030-01-01",
    },
    { id: "app-2", company: "Globex", role: "PM", status: "interview" },
  ];
  const communications = [
    { id: "comm-1", applicationId: "app-1", company: "Acme", channel: "email", status: "waiting" },
  ];
  const sourced = [{ id: "sourced-1", company: "Initech", fitScore: 60 }];
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify({ meta: {}, applications, sourced, sources: [], communications }, null, 2)
  );
  importFromTracker({ repoRoot, sourceDir });
}

function readKv(db, key) {
  const row = db.prepare("SELECT data FROM kv WHERE key = ?").get(key);
  return row ? JSON.parse(row.data) : null;
}

// ---------------------------------------------------------------------------
// Fail-closed: no db file yet -> 409 on every route, per decision 7.
// ---------------------------------------------------------------------------

test("GET /api/data/snapshot: 409 with the exact fail-closed message when no db exists yet", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/data/snapshot");
    assert.equal(status, 409);
    assert.match(body.error, /no database yet/);
    assert.match(body.error, /careerrat data import/);
    assert.match(body.error, /careerrat data init/);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/data/candidate/config: 409 until candidate setup is explicitly initialized", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/data/candidate/config");
    assert.equal(status, 409);
    assert.match(body.error, /no database yet/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/app/status: 409 when no db exists yet", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/data/app/status", {
      id: "app-1",
      to: "offer",
    });
    assert.equal(status, 409);
    assert.match(body.error, /no database yet/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/sourced/upsert-batch: 409 when no db exists yet", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/data/sourced/upsert-batch", {
      rows: [{ id: "sourced-new", company: "Initrode", role: "Platform Engineer" }],
    });
    assert.equal(status, 409);
    assert.match(body.error, /no database yet/);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Reads — happy path
// ---------------------------------------------------------------------------

test("GET /api/data/snapshot: counts + meta once a db exists", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/data/snapshot");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.data.counts, {
      applications: 2,
      sourced: 1,
      sources: 0,
      communications: 1,
      activity: 0,
    });
  } finally {
    await closeServer(server);
  }
});

test("GET /api/data/applications: optional status/company filters", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const all = await getJson(server, "/api/data/applications");
    assert.equal(all.status, 200);
    assert.equal(all.body.data.length, 2);

    const filtered = await getJson(server, "/api/data/applications?status=interview");
    assert.equal(filtered.body.data.length, 1);
    assert.equal(filtered.body.data[0].id, "app-2");

    const byCompany = await getJson(server, "/api/data/applications?company=Acme");
    assert.equal(byCompany.body.data.length, 1);
    assert.equal(byCompany.body.data[0].id, "app-1");
  } finally {
    await closeServer(server);
  }
});

test("GET /api/data/applications/one?id=: 400 without ?id=, 404 for an unknown id, 200 for a known one", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const missingParam = await getJson(server, "/api/data/applications/one");
    assert.equal(missingParam.status, 400);

    const notFound = await getJson(server, "/api/data/applications/one?id=does-not-exist");
    assert.equal(notFound.status, 404);

    const found = await getJson(server, "/api/data/applications/one?id=app-1");
    assert.equal(found.status, 200);
    assert.equal(found.body.data.company, "Acme");
  } finally {
    await closeServer(server);
  }
});

test("GET /api/data/sourced and /api/data/communications: 200 with the seeded rows", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const sourced = await getJson(server, "/api/data/sourced");
    assert.equal(sourced.status, 200);
    assert.equal(sourced.body.data.length, 1);

    const comms = await getJson(server, "/api/data/communications");
    assert.equal(comms.status, 200);
    assert.equal(comms.body.data.length, 1);
    assert.equal(comms.body.data[0].id, "comm-1");
  } finally {
    await closeServer(server);
  }
});

test("candidate setup routes initialize neutral DB config without writing candidate YAML", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const init = await postJson(server, "/api/data/candidate/init", {});
    assert.equal(init.status, 200);
    assert.equal(init.body.ok, true);

    const read = await getJson(server, "/api/data/candidate/config");
    assert.equal(read.status, 200);
    assert.equal(read.body.data.profile.candidate.full_name, "");
    assert.deepEqual(read.body.data.targeting.role_buckets, []);
    assert.deepEqual(read.body.data.evidence.claims, []);
    assert.equal(read.body.data.setup.readiness.search_ready, false);

    assert.equal(existsSync(userPath({ repoRoot }, "candidate/profile.yml")), false);
    assert.equal(existsSync(userPath({ repoRoot }, "candidate/targeting.yml")), false);
  } finally {
    await closeServer(server);
  }
});

test("candidate setup routes patch profile/targeting and merge evidence in SQLite", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    await postJson(server, "/api/data/candidate/init", {});

    const profile = await postJson(server, "/api/data/candidate/config", {
      name: "profile",
      patch: {
        candidate: { full_name: "Grace Hopper", email: "grace@example.com" },
        compensation: { minimum_base: 190000 },
        authorization: { work_authorized: true },
      },
    });
    assert.equal(profile.status, 200);

    const targeting = await postJson(server, "/api/data/candidate/config", {
      name: "targeting",
      patch: {
        role_buckets: [{ name: "AI Platform", titles: ["AI Platform Engineer"] }],
        tracked_companies: ["OpenAI", "Anthropic"],
        excluded_companies: ["Nope Inc"],
      },
    });
    assert.equal(targeting.status, 200);

    const evidence = await postJson(server, "/api/data/candidate/evidence", {
      claims: [{ claim: "Led a database migration", evidence: "Resume" }],
    });
    assert.equal(evidence.status, 200);

    const read = await getJson(server, "/api/data/candidate/config");
    assert.equal(read.body.data.profile.candidate.full_name, "Grace Hopper");
    assert.equal(read.body.data.profile.compensation.minimum_base, 190000);
    assert.equal(read.body.data.targeting.role_buckets[0].titles[0], "AI Platform Engineer");
    assert.deepEqual(read.body.data.targeting.tracked_companies, ["OpenAI", "Anthropic"]);
    assert.equal(read.body.data.evidence.claims[0].id, "seed-001");

    const db = openDb({ repoRoot });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM candidate_search_tracks").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM candidate_evidence_claims").get().n, 1);
    assert.equal(existsSync(userPath({ repoRoot }, "candidate/profile.yml")), false);
  } finally {
    await closeServer(server);
  }
});

test("candidate application-limit route upserts limits and exposes them in config", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    await postJson(server, "/api/data/candidate/init", {});

    const upsert = await postJson(server, "/api/data/candidate/application-limit", {
      row: {
        company: "OpenAI",
        cap: { max: 4, window_days: 180 },
        status: "caution",
        source: "careers FAQ",
      },
    });
    assert.equal(upsert.status, 200);
    assert.equal(upsert.body.data.data.companies[0].scope, "all-roles");

    const read = await getJson(server, "/api/data/candidate/config");
    assert.equal(read.body.data["application-limits"].companies[0].company, "OpenAI");
    assert.deepEqual(read.body.data["application-limits"].companies[0].cap, {
      max: 4,
      window_days: 180,
    });
    assert.equal(existsSync(userPath({ repoRoot }, "candidate/application-limits.yml")), false);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Writes — happy path, thin shims over the same verbs the CLI calls
// ---------------------------------------------------------------------------

test("POST /api/data/app/status: 400 when body.to is missing, 200 + persisted change otherwise", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const missingTo = await postJson(server, "/api/data/app/status", { id: "app-1" });
    assert.equal(missingTo.status, 400);

    const ok = await postJson(server, "/api/data/app/status", { id: "app-1", to: "offer" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.data.to, "offer");
    assert.equal(typeof ok.body.meta.version, "number");

    const db = openDb({ repoRoot });
    const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-1");
    assert.equal(JSON.parse(row.data).status, "offer");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/app/fields: 400 without body.patch, 200 + merged fields otherwise", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const missingPatch = await postJson(server, "/api/data/app/fields", { id: "app-1" });
    assert.equal(missingPatch.status, 400);

    const ok = await postJson(server, "/api/data/app/fields", {
      id: "app-1",
      patch: { statusNote: "hi" },
    });
    assert.equal(ok.status, 200);

    const db = openDb({ repoRoot });
    const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-1");
    assert.equal(JSON.parse(row.data).statusNote, "hi");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/app/fields: cannot forge an evaluation gate", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const forged = await postJson(server, "/api/data/app/fields", {
      id: "app-1",
      patch: { evaluation: { gate: "keep", fitScore: 100 } },
    });
    assert.equal(forged.status, 400);
    assert.match(forged.body.error, /evaluation/);

    const db = openDb({ repoRoot });
    const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-1");
    assert.equal(JSON.parse(row.data).evaluation, undefined);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/sourced/promote: 404 for an unknown sourced id, 200 for a known one", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const notFound = await postJson(server, "/api/data/sourced/promote", { id: "does-not-exist" });
    assert.equal(notFound.status, 404);

    const ok = await postJson(server, "/api/data/sourced/promote", { id: "sourced-1" });
    assert.equal(ok.status, 200);

    const db = openDb({ repoRoot });
    const stillSourced = db.prepare("SELECT 1 FROM sourced WHERE id = ?").get("sourced-1");
    assert.equal(stillSourced, undefined);
    const promoted = db.prepare("SELECT data FROM applications WHERE id = ?").get("sourced-1");
    assert.ok(promoted);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/sourced/upsert-batch: 400 without rows, 200 + persisted created/updated rows otherwise", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const missingRows = await postJson(server, "/api/data/sourced/upsert-batch", {});
    assert.equal(missingRows.status, 400);

    const ok = await postJson(server, "/api/data/sourced/upsert-batch", {
      rows: [
        {
          id: "sourced-1",
          company: "Initech",
          role: "Senior Staff Engineer",
          fitScore: 78,
        },
        {
          id: "sourced-2",
          company: "Initrode",
          role: "Platform Engineer",
          fitScore: 73,
        },
      ],
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.data.created, 1);
    assert.equal(ok.body.data.updated, 1);
    assert.equal(typeof ok.body.meta.version, "number");

    const read = await getJson(server, "/api/data/sourced");
    assert.equal(read.status, 200);
    assert.deepEqual(
      read.body.data.map((row) => [row.id, row.role, row.fitScore]),
      [
        ["sourced-1", "Senior Staff Engineer", 78],
        ["sourced-2", "Platform Engineer", 73],
      ]
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/sourced/status: validates input, patches the row, and returns 404 for unknown ids", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    for (const payload of [{}, { id: "sourced-1" }, { to: "cut" }]) {
      const invalid = await postJson(server, "/api/data/sourced/status", payload);
      assert.equal(invalid.status, 400);
    }

    const missing = await postJson(server, "/api/data/sourced/status", {
      id: "does-not-exist",
      to: "cut",
    });
    assert.equal(missing.status, 404);

    const db = openDb({ repoRoot });
    const beforeMeta = db.prepare("SELECT version FROM meta WHERE id = 1").get();
    const beforeActivity = db.prepare("SELECT COUNT(*) AS n FROM activity_events").get().n;
    const ok = await postJson(server, "/api/data/sourced/status", {
      id: "sourced-1",
      to: "cut",
      note: "Not aligned with the target scope.",
    });

    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.from, "sourced");
    assert.equal(ok.body.data.to, "cut");
    assert.ok(ok.body.data.analytics);
    assert.equal(ok.body.meta.version, beforeMeta.version + 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM activity_events").get().n,
      beforeActivity + 1
    );
    const row = db.prepare("SELECT data FROM sourced WHERE id = ?").get("sourced-1");
    assert.deepEqual(
      { status: JSON.parse(row.data).status, note: JSON.parse(row.data).note },
      { status: "cut", note: "Not aligned with the target scope." }
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/comm/send: sent-clears-draft, 404 for an unknown comm id", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const notFound = await postJson(server, "/api/data/comm/send", { id: "does-not-exist" });
    assert.equal(notFound.status, 404);

    const ok = await postJson(server, "/api/data/comm/send", { id: "comm-1" });
    assert.equal(ok.status, 200);

    const db = openDb({ repoRoot });
    const row = db.prepare("SELECT data FROM communications WHERE id = ?").get("comm-1");
    const comm = JSON.parse(row.data);
    assert.equal(comm.status, "waiting");
    assert.equal(comm.draft, null);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/comm/send: public callers cannot self-assert verified delivery", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const result = await postJson(server, "/api/data/comm/send", {
      id: "comm-1",
      verification: "verified",
      deliveryEvidence: "caller-supplied-proof",
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.verification, "user_report");

    const db = openDb({ repoRoot });
    const row = db.prepare("SELECT data FROM communications WHERE id = ?").get("comm-1");
    const message = JSON.parse(row.data).messages.at(-1);
    assert.equal(message.deliveryEvidence, undefined);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/calendar/busy: 400 without blocks, 200 + persisted opaque busy blocks", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const missingBlocks = await postJson(server, "/api/data/calendar/busy", {});
    assert.equal(missingBlocks.status, 400);

    const ok = await postJson(server, "/api/data/calendar/busy", {
      blocks: [
        {
          provider: "work_calendar",
          startIso: "2030-01-02T14:00:00.000Z",
          endIso: "2030-01-02T15:00:00.000Z",
          label: "Private meeting",
        },
      ],
      source: "calendar_read",
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.data.count, 1);
    assert.equal(typeof ok.body.meta.version, "number");

    const db = openDb({ repoRoot });
    const busy = readKv(db, "calendarBusy");
    assert.equal(busy.length, 1);
    assert.equal(busy[0].label, "Busy");
    assert.equal(busy[0].source, "calendar_read");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/calendar/write: 400 without record, 200 + persisted calendarWrites row", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const missingRecord = await postJson(server, "/api/data/calendar/write", {});
    assert.equal(missingRecord.status, 400);

    const ok = await postJson(server, "/api/data/calendar/write", {
      record: {
        provider: "google_calendar",
        eventId: "evt-1",
        title: "Interview hold",
        eventIso: "2030-01-02T14:00:00.000Z",
      },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.data.count, 1);

    const db = openDb({ repoRoot });
    const writes = readKv(db, "calendarWrites");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].provider, "google_calendar");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/source/watermark: updates sources[] and lastSweepAt without bumping version", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const missingSource = await postJson(server, "/api/data/source/watermark", {});
    assert.equal(missingSource.status, 400);

    const db = openDb({ repoRoot });
    const before = db.prepare("SELECT version FROM meta WHERE id = 1").get().version;
    const ok = await postJson(server, "/api/data/source/watermark", {
      at: "2030-01-02T00:00:00.000Z",
      source: {
        id: "linkedin-messages",
        kind: "linkedin-messages",
        name: "LinkedIn Messages",
        lastRunAt: "2030-01-02T00:00:00.000Z",
      },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.meta.version, before);
    assert.equal(ok.body.meta.lastSweepAt, "2030-01-02T00:00:00.000Z");

    const source = db.prepare("SELECT data FROM sources WHERE id = ?").get("linkedin-messages");
    assert.equal(JSON.parse(source.data).lastRunAt, "2030-01-02T00:00:00.000Z");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/data/relationship/leads and /api/data/relationship/lead-status persist Network lead state", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const missingLeads = await postJson(server, "/api/data/relationship/leads", {});
    assert.equal(missingLeads.status, 400);

    const upsert = await postJson(server, "/api/data/relationship/leads", {
      leads: [
        {
          applicationId: "app-1",
          company: "Acme",
          role: "Staff Engineer",
          name: "Jordan Lee",
          type: "Recruiter",
          platform: "linkedin",
        },
      ],
    });
    assert.equal(upsert.status, 200);
    assert.equal(upsert.body.data.count, 1);

    const db = openDb({ repoRoot });
    let leads = readKv(db, "relationshipLeads");
    assert.equal(leads[0].status, "review");
    let app = JSON.parse(
      db.prepare("SELECT data FROM applications WHERE id = ?").get("app-1").data
    );
    assert.equal(app.nextActionDue, null);

    const missingStatus = await postJson(server, "/api/data/relationship/lead-status", {
      id: "lead-acme-jordan-lee-linkedin",
    });
    assert.equal(missingStatus.status, 400);

    const approved = await postJson(server, "/api/data/relationship/lead-status", {
      id: "lead-acme-jordan-lee-linkedin",
      status: "approved",
      at: "2030-01-03T00:00:00.000Z",
      dueAt: "2030-01-06",
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.data.lead.status, "approved");

    leads = readKv(db, "relationshipLeads");
    assert.equal(leads[0].status, "approved");
    app = JSON.parse(db.prepare("SELECT data FROM applications WHERE id = ?").get("app-1").data);
    assert.equal(app.nextAction, "Send outreach to Jordan Lee via email-comms");
    assert.equal(app.nextActionDue, "2030-01-06");
  } finally {
    await closeServer(server);
  }
});

test("malformed JSON body: 400, not a 500", async () => {
  const repoRoot = tempRepo();
  seedDb(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(server)}/api/data/app/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  } finally {
    await closeServer(server);
  }
});
