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
