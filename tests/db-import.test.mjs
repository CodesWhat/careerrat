// tests/db-import.test.mjs — importFromTracker: idempotent re-import, unknown/
// extra field + extra top-level key preservation, and activity id parity with
// activity-log.mjs's own content-hash eventId (so re-importing the same
// activity.jsonl never double-inserts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { canonicalizeEvent, eventId } from "../src/core/tracker/activity-log.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-db-import-"));
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

// A synthetic source fixture (distinct from examples/demo-workspace — this one
// is purpose-built to carry unknown/extra fields, an extra top-level key, and
// hand-built activity events) written to its own directory, used via
// importFromTracker's `sourceDir` option.
function writeSourceFixture(sourceDir) {
  mkdirSync(sourceDir, { recursive: true });

  const applications = [
    {
      id: "app-extra-1",
      company: "Acme",
      role: "Staff Engineer",
      status: "interview",
      fitScore: 91,
      // unknown/future field the schema doesn't model today — must survive verbatim.
      customField: "keep-me",
      nested: { future: { deeply: "nested-value" }, list: [1, 2, 3] },
    },
    {
      id: "app-extra-2",
      company: "Globex",
      role: "PM",
      status: "awaiting",
      fitScore: 70,
    },
  ];
  const sourced = [{ id: "sourced-1", company: "Initech", fitScore: 55, fitBucket: "maybe" }];
  const sources = [{ id: "source-1", provider: "HiringCafe" }];
  const communications = [
    {
      id: "comm-1",
      applicationId: "app-extra-1",
      company: "Acme",
      channel: "email",
      status: "waiting",
    },
  ];
  const meta = {
    lastUpdatedAt: "2026-01-01T00:00:00.000Z",
    version: 3,
    lastSweepAt: "2026-01-01T00:00:00.000Z",
    demoAnchor: "2026-01-02",
  };
  const strategyReview = {
    note: "extra top-level key that isn't one of the modeled tables",
    flag: true,
  };

  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify(
      { meta, applications, sourced, sources, communications, strategyReview },
      null,
      2
    )
  );

  const now = new Date("2026-01-01T12:00:00.000Z");
  const events = [
    canonicalizeEvent(
      {
        type: "applied",
        title: "Acme — Staff Engineer captured",
        refs: { applicationId: "app-extra-1" },
      },
      { now }
    ),
    canonicalizeEvent(
      {
        type: "status_change",
        title: "Acme — status applied → interview",
        refs: { applicationId: "app-extra-1" },
      },
      { now }
    ),
  ];
  writeFileSync(
    join(sourceDir, "activity.jsonl"),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`
  );
  return { applications, sourced, sources, communications, meta, strategyReview, events };
}

function dumpDb(db) {
  const table = (name) =>
    db
      .prepare(`SELECT id, data FROM ${name} ORDER BY id ASC`)
      .all()
      .map((r) => ({ id: r.id, data: JSON.parse(r.data) }));
  const metaRow = db.prepare("SELECT * FROM meta WHERE id = 1").get();
  const kvRows = db
    .prepare("SELECT key, data FROM kv ORDER BY key ASC")
    .all()
    .map((r) => ({ key: r.key, data: JSON.parse(r.data) }));
  const activity = db
    .prepare("SELECT id, at, type, actor, data FROM activity_events ORDER BY id ASC")
    .all();
  return {
    applications: table("applications"),
    sourced: table("sourced"),
    sources: table("sources"),
    communications: table("communications"),
    meta: metaRow,
    kv: kvRows,
    activity,
  };
}

test("importFromTracker preserves unknown/extra fields on application rows verbatim", () => {
  const repoRoot = tempRepo();
  const sourceDir = join(repoRoot, "fixture-source");
  const fixture = writeSourceFixture(sourceDir);

  const result = importFromTracker({ repoRoot, sourceDir });
  assert.equal(result.counts.applications, 2);

  const db = openDb({ repoRoot });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-extra-1");
  const stored = JSON.parse(row.data);
  assert.deepEqual(stored, fixture.applications[0]);
  assert.equal(stored.customField, "keep-me");
  assert.deepEqual(stored.nested, { future: { deeply: "nested-value" }, list: [1, 2, 3] });
});

test("importFromTracker preserves an extra top-level key (not one of the modeled tables) into kv", () => {
  const repoRoot = tempRepo();
  const sourceDir = join(repoRoot, "fixture-source");
  const fixture = writeSourceFixture(sourceDir);
  importFromTracker({ repoRoot, sourceDir });

  const db = openDb({ repoRoot });
  const row = db.prepare("SELECT data FROM kv WHERE key = 'strategyReview'").get();
  assert.ok(row, "strategyReview must land in the kv table");
  assert.deepEqual(JSON.parse(row.data), fixture.strategyReview);
});

test("importFromTracker's activity ids match activity-log.mjs's own content-hash eventId()", () => {
  const repoRoot = tempRepo();
  const sourceDir = join(repoRoot, "fixture-source");
  const fixture = writeSourceFixture(sourceDir);
  const result = importFromTracker({ repoRoot, sourceDir });
  assert.equal(result.counts.activity, 2);

  const db = openDb({ repoRoot });
  const rows = db.prepare("SELECT id FROM activity_events ORDER BY id ASC").all();
  const storedIds = rows.map((r) => r.id).sort();
  const expectedIds = fixture.events
    .map((e) => eventId({ at: e.at, type: e.type, title: e.title, refs: e.refs }))
    .sort();
  assert.deepEqual(storedIds, expectedIds);
});

test("re-importing the same source is idempotent: identical DB dump, no duplicate activity rows", () => {
  const repoRoot = tempRepo();
  const sourceDir = join(repoRoot, "fixture-source");
  writeSourceFixture(sourceDir);

  importFromTracker({ repoRoot, sourceDir });
  const db = openDb({ repoRoot });
  const firstDump = dumpDb(db);

  const secondResult = importFromTracker({ repoRoot, sourceDir });
  const secondDump = dumpDb(db);

  assert.deepEqual(
    secondDump,
    firstDump,
    "re-running the same import must produce an identical DB"
  );
  // Re-import counts still report what it upserted/considered — but the
  // activity_events table itself must not have grown (PK conflict = dedupe).
  assert.equal(secondResult.counts.activity <= 2, true);
  const activityCount = db.prepare("SELECT COUNT(*) AS n FROM activity_events").get().n;
  assert.equal(activityCount, 2, "no double-insert on re-import");
});

test("examples/demo-workspace imports cleanly and twice produces an identical DB", () => {
  const repoRoot = tempRepo();
  const demoDir = join(new URL("../examples/demo-workspace", import.meta.url).pathname);

  const first = importFromTracker({ repoRoot, sourceDir: demoDir });
  assert.equal(first.counts.applications, 29);
  assert.equal(first.counts.sourced, 2);
  assert.equal(first.counts.sources, 1);
  assert.equal(first.counts.communications, 10);

  const db = openDb({ repoRoot });
  const firstDump = dumpDb(db);

  importFromTracker({ repoRoot, sourceDir: demoDir });
  const secondDump = dumpDb(db);

  assert.deepEqual(
    secondDump,
    firstDump,
    "re-importing the demo workspace must be a no-op on the DB contents"
  );
});
