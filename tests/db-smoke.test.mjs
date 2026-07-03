// tests/db-smoke.test.mjs — the one unverified technical assumption in the M6
// spec: do node:sqlite's GENERATED ALWAYS AS (json_extract(...)) STORED
// columns, WAL journal mode, and busy_timeout actually work on this Node?
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, dbExists, dbFilePath, openDb } from "../src/core/db/connection.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-db-smoke-"));
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

test("dbExists is false before openDb, true after", () => {
  const repoRoot = tempRepo();
  assert.equal(dbExists({ repoRoot }), false);
  openDb({ repoRoot });
  assert.equal(dbExists({ repoRoot }), true);
});

test("dbFilePath resolves under <dataRoot>/db/rolester.db, never a hardcoded path", () => {
  const repoRoot = tempRepo();
  const path = dbFilePath({ repoRoot });
  assert.match(path, /\.rolester[/\\]db[/\\]rolester\.db$/);
  assert.ok(path.startsWith(repoRoot), "db path must live under the resolved data root");
});

test("per-connection PRAGMAs actually took: WAL, foreign_keys, busy_timeout", () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  assert.equal(String(db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase(), "wal");
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
});

test("GENERATED ALWAYS AS (json_extract(...)) STORED columns populate on insert", () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  db.prepare("INSERT INTO applications (id, data) VALUES (?, ?)").run(
    "app-1",
    JSON.stringify({
      company: "Acme",
      role: "Staff Engineer",
      status: "interview",
      fitScore: 88,
      appliedAt: "2026-01-01",
      interviewAt: "2026-02-01T10:00:00.000Z",
      nextInterviewAt: null,
      followUp: { dueAt: "2026-02-05" },
      channel: "referral",
      demo: true,
    })
  );
  const row = db
    .prepare(
      `SELECT company, role, status, fit_score, applied_at, interview_at, next_interview_at,
              follow_up_due_at, channel, demo
       FROM applications WHERE id = ?`
    )
    .get("app-1");

  assert.equal(row.company, "Acme");
  assert.equal(row.status, "interview");
  assert.equal(row.fit_score, 88);
  assert.equal(row.applied_at, "2026-01-01");
  assert.equal(row.interview_at, "2026-02-01T10:00:00.000Z");
  assert.equal(row.next_interview_at, null);
  assert.equal(row.follow_up_due_at, "2026-02-05");
  assert.equal(row.channel, "referral");
  assert.equal(row.demo, 1); // SQLite JSON booleans extract as integer 0/1
});

test("json_valid CHECK constraint rejects malformed JSON in the blob column", () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  assert.throws(() => {
    db.prepare("INSERT INTO applications (id, data) VALUES (?, ?)").run("bad-1", "{not json");
  });
});

test("indexes exist for the hot/queried generated columns", () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((r) => r.name);
  for (const expected of [
    "idx_apps_status",
    "idx_apps_company",
    "idx_apps_interview",
    "idx_apps_followup",
    "idx_sourced_status",
    "idx_sourced_fit",
    "idx_comms_app",
    "idx_comms_status",
    "idx_comms_next_due",
    "idx_activity_at",
  ]) {
    assert.ok(names.includes(expected), `expected index ${expected} to exist`);
  }
});

test("meta(id=1) is seeded on migration so a bare UPDATE always has a row", () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  const row = db.prepare("SELECT * FROM meta WHERE id = 1").get();
  assert.ok(row, "meta row must exist immediately after openDb()");
  assert.equal(row.version, 0);
});

test("openDb() returns the same cached connection for the same data root", () => {
  const repoRoot = tempRepo();
  const a = openDb({ repoRoot });
  const b = openDb({ repoRoot });
  assert.equal(a, b);
});
