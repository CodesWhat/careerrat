// tests/db-migration-002-intake.test.mjs — M9's migration 002 (intake_items):
// verifies the runner actually applies 001 -> 002 against an existing M6-era
// db (one that only ever saw migration001), not just against a brand-new
// empty db, plus the schema shape itself (generated kind/status columns, the
// status CHECK enum, the json_valid guard, and the three indexes).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migration001 } from "../src/core/db/migrations/001-init.mjs";
import { ALL_MIGRATIONS, runMigrations } from "../src/core/db/migrations.mjs";

function freshDb() {
  return new DatabaseSync(":memory:");
}

test("an existing M6 db (migration001 only, user_version 1) upgrades through the current migrations", () => {
  const db = freshDb();
  // Simulate "an existing M6 db" — exactly what a pre-M9 install looks like:
  // only migration001 has ever run.
  const first = runMigrations(db, [migration001]);
  assert.equal(first.to, 1);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='intake_items'")
      .get().n,
    0,
    "intake_items must not exist yet on the M6-era db"
  );

  // Now run the REAL, full migration list (as connection.mjs's openDb() would
  // on next launch) — every migration after 001 should apply.
  const second = runMigrations(db, ALL_MIGRATIONS);
  assert.equal(second.from, 1);
  assert.equal(second.to, ALL_MIGRATIONS.at(-1).id);
  assert.deepEqual(
    second.applied,
    ALL_MIGRATIONS.filter((migration) => migration.id > 1).map((migration) => migration.id)
  );
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, ALL_MIGRATIONS.at(-1).id);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes("intake_items"));
  assert.ok(
    tables.includes("applications"),
    "the M6-era tables must survive the upgrade untouched"
  );

  const logged = db.prepare("SELECT id, name FROM _migrations ORDER BY id ASC").all();
  assert.deepEqual(
    logged.map((r) => r.id),
    ALL_MIGRATIONS.map((migration) => migration.id)
  );
  assert.equal(logged[1].name, "intake");
});

test("a fresh (empty) db reaches intake_items in one pass via the full ALL_MIGRATIONS list", () => {
  const db = freshDb();
  const result = runMigrations(db);
  assert.equal(result.to, ALL_MIGRATIONS.at(-1).id);
  assert.ok(result.applied.includes(2));
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='intake_items'")
      .get().n,
    1
  );
});

test("intake_items: generated kind/status columns extract from the data blob", () => {
  const db = freshDb();
  runMigrations(db);
  db.prepare("INSERT INTO intake_items (id, data) VALUES (?, ?)").run(
    "intake_1",
    JSON.stringify({ id: "intake_1", status: "captured", kind: null })
  );
  const row = db.prepare("SELECT id, kind, status FROM intake_items WHERE id = ?").get("intake_1");
  assert.equal(row.status, "captured");
  assert.equal(row.kind, null);

  db.prepare("UPDATE intake_items SET data = ? WHERE id = ?").run(
    JSON.stringify({ id: "intake_1", status: "proposed", kind: "job-url" }),
    "intake_1"
  );
  const updated = db.prepare("SELECT kind, status FROM intake_items WHERE id = ?").get("intake_1");
  assert.equal(updated.status, "proposed");
  assert.equal(updated.kind, "job-url");
});

test("intake_items: json_valid CHECK rejects a non-JSON data blob", () => {
  const db = freshDb();
  runMigrations(db);
  // The kind/status GENERATED columns call json_extract() at insert time,
  // before the json_valid CHECK would otherwise reject it — sqlite surfaces
  // that as "malformed JSON" rather than a CHECK-constraint message, but the
  // net effect is the same: a non-JSON blob is rejected, full stop.
  assert.throws(() => {
    db.prepare("INSERT INTO intake_items (id, data) VALUES (?, ?)").run("bad", "not json at all");
  }, /CHECK constraint failed|json_valid|malformed JSON/);
});

test("intake_items: status CHECK rejects a value outside the fixed enum", () => {
  const db = freshDb();
  runMigrations(db);
  assert.throws(() => {
    db.prepare("INSERT INTO intake_items (id, data) VALUES (?, ?)").run(
      "bad-status",
      JSON.stringify({ id: "bad-status", status: "not-a-real-status", kind: null })
    );
  }, /CHECK constraint failed/);
});

test("intake_items: the three documented indexes exist", () => {
  const db = freshDb();
  runMigrations(db);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'intake_items'")
    .all()
    .map((r) => r.name);
  assert.ok(indexes.includes("idx_intake_status"));
  assert.ok(indexes.includes("idx_intake_kind"));
  assert.ok(indexes.includes("idx_intake_created"));
});
