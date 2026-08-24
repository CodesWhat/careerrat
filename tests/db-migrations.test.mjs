// tests/db-migrations.test.mjs — the migration runner (M6 decision 5):
// PRAGMA user_version as the gate, _migrations as the audit log, ascending
// application each in its own transaction, gaps/out-of-order rejected.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ALL_MIGRATIONS, runMigrations } from "../src/core/db/migrations.mjs";

function freshDb() {
  return new DatabaseSync(":memory:");
}

// Real migration 1 (001-init.mjs) creates `_migrations` itself as part of its
// schema — the runner has no independent bootstrap for it. Custom test
// migration lists below stand in for that with their own minimal id-1 step.
const CREATE_MIGRATIONS_TABLE =
  "CREATE TABLE _migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, name TEXT NOT NULL)";

test("empty db -> latest: applies every migration ascending, sets user_version, logs _migrations", () => {
  const db = freshDb();
  const result = runMigrations(db);
  assert.equal(result.from, 0);
  assert.equal(result.to, ALL_MIGRATIONS.at(-1).id);
  assert.deepEqual(
    result.applied,
    ALL_MIGRATIONS.map((m) => m.id)
  );

  const userVersion = db.prepare("PRAGMA user_version").get().user_version;
  assert.equal(userVersion, ALL_MIGRATIONS.at(-1).id);

  const logged = db.prepare("SELECT id, name FROM _migrations ORDER BY id ASC").all();
  assert.deepEqual(
    logged.map((r) => r.id),
    ALL_MIGRATIONS.map((m) => m.id)
  );
  assert.deepEqual(
    logged.map((r) => r.name),
    ALL_MIGRATIONS.map((m) => m.name)
  );
});

test("re-running against a db already at the latest version is a no-op", () => {
  const db = freshDb();
  runMigrations(db);
  const before = db.prepare("SELECT COUNT(*) AS n FROM _migrations").get().n;

  const second = runMigrations(db);
  assert.deepEqual(second.applied, []);
  assert.equal(second.from, ALL_MIGRATIONS.at(-1).id);
  assert.equal(second.to, ALL_MIGRATIONS.at(-1).id);

  const after = db.prepare("SELECT COUNT(*) AS n FROM _migrations").get().n;
  assert.equal(after, before, "no new _migrations rows on a no-op re-run");
});

test("migration 009-014 preserve public intel, agent, proposal, workspace, chat, then preferences order", () => {
  assert.deepEqual(
    ALL_MIGRATIONS.slice(-6).map((migration) => [migration.id, migration.name]),
    [
      [9, "public-intel"],
      [10, "workspace-agent"],
      [11, "linkedin-profile-proposals"],
      [12, "chat-first-workspace"],
      [13, "durable-skill-chat"],
      [14, "chat-first-preferences"],
    ]
  );
});

test("migration 014 creates JSON-backed chat-first preferences", () => {
  const db = freshDb();
  runMigrations(db);

  const sql = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_first_preferences'"
    )
    .get()?.sql;
  assert.ok(sql, "expected chat_first_preferences table");
  assert.match(sql, /json_valid\(data\)/);
});

test("migration 007 creates durable sourcing_runs state table and lookup indexes", () => {
  const db = freshDb();
  runMigrations(db);

  const columns = db.prepare("PRAGMA table_xinfo('sourcing_runs')").all();
  const columnByName = new Map(columns.map((column) => [column.name, column]));
  assert.equal(columnByName.get("id")?.type, "TEXT");
  assert.equal(columnByName.get("data")?.type, "TEXT");
  for (const generated of ["purpose", "status", "started_at", "completed_at", "updated_at"]) {
    assert.ok(columnByName.has(generated), `expected generated column ${generated}`);
    assert.notEqual(columnByName.get(generated).hidden, 0, `${generated} must be generated`);
  }

  const createSql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sourcing_runs'")
    .get()?.sql;
  assert.match(createSql || "", /json_valid\(data\)/);
  assert.match(createSql || "", /json_extract\(data,\s*'\$\.purpose'\)/);
  assert.match(createSql || "", /json_extract\(data,\s*'\$\.status'\)/);

  const indexes = db
    .prepare("PRAGMA index_list('sourcing_runs')")
    .all()
    .map((row) => row.name);
  assert.ok(indexes.includes("idx_sourcing_runs_latest_purpose"));
  assert.ok(indexes.includes("idx_sourcing_runs_running_status"));
});

test("migration 008 creates Deep ingest source, proposal, lane, and confirmed-output tables", () => {
  const db = freshDb();
  runMigrations(db);

  const expectedTables = [
    "deep_ingest_sources",
    "deep_ingest_source_chunks",
    "deep_ingest_proposals",
    "deep_ingest_lane_states",
    "deep_ingest_story_bank",
    "deep_ingest_writing_voice",
    "deep_ingest_honesty_boundaries",
    "deep_ingest_role_signals",
  ];

  for (const table of expectedTables) {
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)?.sql;
    assert.ok(sql, `expected ${table} table`);
    assert.match(sql, /json_valid\(data\)/);
  }

  const sourceColumns = new Map(
    db
      .prepare("PRAGMA table_xinfo('deep_ingest_sources')")
      .all()
      .map((column) => [column.name, column])
  );
  for (const generated of ["target_shape", "status", "source_kind"]) {
    assert.ok(sourceColumns.has(generated), `expected generated column ${generated}`);
    assert.notEqual(sourceColumns.get(generated).hidden, 0, `${generated} must be generated`);
  }

  const proposalColumns = new Map(
    db
      .prepare("PRAGMA table_xinfo('deep_ingest_proposals')")
      .all()
      .map((column) => [column.name, column])
  );
  for (const generated of ["source_id", "target_shape", "status", "lane"]) {
    assert.ok(proposalColumns.has(generated), `expected generated column ${generated}`);
    assert.notEqual(proposalColumns.get(generated).hidden, 0, `${generated} must be generated`);
  }
});

test("a gap in the migration id sequence is rejected", () => {
  const db = freshDb();
  const gappy = [
    { id: 1, name: "init", up: (d) => d.exec("CREATE TABLE t1 (id INTEGER PRIMARY KEY)") },
    { id: 3, name: "skip-two", up: (d) => d.exec("CREATE TABLE t3 (id INTEGER PRIMARY KEY)") },
  ];
  assert.throws(() => runMigrations(db, gappy), /not sequential/);
});

test("an out-of-order migration list is rejected even without a numeric gap", () => {
  const db = freshDb();
  const outOfOrder = [
    { id: 2, name: "second", up: (d) => d.exec("CREATE TABLE t2 (id INTEGER PRIMARY KEY)") },
    { id: 1, name: "first", up: (d) => d.exec("CREATE TABLE t1 (id INTEGER PRIMARY KEY)") },
  ];
  assert.throws(() => runMigrations(db, outOfOrder), /not sequential/);
});

test("only migrations with id > current user_version are applied (partial catch-up)", () => {
  const db = freshDb();
  const stepOne = [
    {
      id: 1,
      name: "init",
      up: (d) => d.exec(`${CREATE_MIGRATIONS_TABLE}; CREATE TABLE t1 (id INTEGER PRIMARY KEY)`),
    },
  ];
  runMigrations(db, stepOne);

  const stepTwo = [
    ...stepOne,
    { id: 2, name: "second", up: (d) => d.exec("CREATE TABLE t2 (id INTEGER PRIMARY KEY)") },
  ];
  const result = runMigrations(db, stepTwo);
  assert.equal(result.from, 1);
  assert.equal(result.to, 2);
  assert.deepEqual(result.applied, [2]);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes("t1"));
  assert.ok(tables.includes("t2"));
});

test("a failing migration rolls back and leaves user_version at the last fully-applied id", () => {
  const db = freshDb();
  const stepOne = [
    {
      id: 1,
      name: "init",
      up: (d) => d.exec(`${CREATE_MIGRATIONS_TABLE}; CREATE TABLE t1 (id INTEGER PRIMARY KEY)`),
    },
  ];
  runMigrations(db, stepOne);

  const withBadStep = [
    ...stepOne,
    { id: 2, name: "broken", up: (d) => d.exec("THIS IS NOT VALID SQL") },
  ];
  assert.throws(() => runMigrations(db, withBadStep));

  const userVersion = db.prepare("PRAGMA user_version").get().user_version;
  assert.equal(userVersion, 1, "user_version must not advance past the last successful migration");
  const logged = db.prepare("SELECT id FROM _migrations ORDER BY id ASC").all();
  assert.deepEqual(
    logged.map((r) => r.id),
    [1]
  );
});
