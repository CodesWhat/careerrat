// tests/db-intake-verbs.test.mjs — src/core/db/verbs/intake.mjs's queue-state
// verbs. Unlike every verb in tests/db-verbs.test.mjs, these must NEVER bump
// meta.version/last_updated_at and must NEVER touch workspace/tracker.json —
// intake_items is queue/workflow bookkeeping, not tracker-visible domain data
// (see that file's own header comment). Only intakeDecide's "confirm" path
// logs an activity event.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  InvalidTransitionError,
  intakeCapture,
  intakeDecide,
  intakeList,
  intakeOne,
  intakeUpdate,
} from "../src/core/db/verbs/intake.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-intake-verbs-"));
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

function readMeta(db) {
  return db.prepare("SELECT version, last_updated_at FROM meta WHERE id = 1").get();
}

// ---------------------------------------------------------------------------
// intakeCapture
// ---------------------------------------------------------------------------

test("intakeCapture: writes a row at status 'captured', never bumps meta, writes a recovery file", () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  const before = readMeta(db);

  const result = intakeCapture({ repoRoot, rawInput: "Some pasted JD text", inputKind: "text" });
  assert.ok(result.id.startsWith("intake_"));
  assert.equal(result.item.status, "captured");
  assert.equal(result.item.kind, null);
  assert.equal(result.item.rawInput, "Some pasted JD text");
  assert.equal(result.item.inputKind, "text");

  const after1 = readMeta(db);
  assert.deepEqual(after1, before, "intakeCapture must never bump meta.version/last_updated_at");

  const row = db.prepare("SELECT status, kind FROM intake_items WHERE id = ?").get(result.id);
  assert.equal(row.status, "captured");
  assert.equal(row.kind, null);

  const capturePath = userPath({ repoRoot }, result.item.capturedPath);
  assert.ok(existsSync(capturePath), "raw capture must be written to workspace/intake/pastes/*.md");
  const contents = readFileSync(capturePath, "utf8");
  assert.match(contents, /Some pasted JD text/);
  assert.match(contents, /inputKind: text/);
});

test("intakeCapture: file inputKind never writes a recovery file", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const result = intakeCapture({
    repoRoot,
    rawInput: null,
    inputKind: "file",
    sourceFilePath: "x.pdf",
  });
  assert.equal(result.item.capturedPath, null);
  assert.equal(result.item.sourceFilePath, "x.pdf");
});

test("intakeCapture: requires inputKind, and rawInput for non-file kinds", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  assert.throws(() => intakeCapture({ repoRoot, rawInput: "x" }), /inputKind is required/);
  assert.throws(
    () => intakeCapture({ repoRoot, rawInput: "   ", inputKind: "text" }),
    /rawInput is required/
  );
});

test("intakeCapture: 409s (NoDatabaseError) when no db exists yet", () => {
  const repoRoot = tempRepo(); // no openDb() call — no db file
  assert.throws(
    () => intakeCapture({ repoRoot, rawInput: "x", inputKind: "text" }),
    (err) => err.code === "NO_DATABASE"
  );
});

// ---------------------------------------------------------------------------
// intakeUpdate
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("intakeUpdate: shallow-merges the patch, never bumps meta, preserves createdAt", async () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "hello", inputKind: "text" });
  // Read createdAt back via intakeOne (the same `created_at` DB column
  // intakeUpdate itself reads) rather than intakeCapture's own return value
  // (a separately JS-clock-stamped field) — the two are independent clock
  // reads a fraction of a millisecond apart and aren't guaranteed byte-equal.
  const capturedFromDb = intakeOne({ repoRoot, id });
  const before = readMeta(db);
  await sleep(5); // ensure the update's timestamp lands in a different millisecond

  const updated = intakeUpdate({ repoRoot, id, patch: { status: "classifying" } });
  assert.equal(updated.item.status, "classifying");
  assert.equal(updated.item.rawInput, "hello", "unpatched fields survive the shallow merge");
  assert.equal(updated.item.createdAt, capturedFromDb.createdAt);
  assert.notEqual(updated.item.updatedAt, capturedFromDb.updatedAt);

  assert.deepEqual(readMeta(db), before, "intakeUpdate must never bump meta");
});

test("intakeUpdate: 404s (NotFoundError) for an unknown id", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  assert.throws(
    () => intakeUpdate({ repoRoot, id: "nope", patch: { status: "done" } }),
    (err) => err.code === "NOT_FOUND"
  );
});

test("intakeUpdate: requires a patch object", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "x", inputKind: "text" });
  assert.throws(() => intakeUpdate({ repoRoot, id }), /patch is required/);
});

// ---------------------------------------------------------------------------
// intakeDecide
// ---------------------------------------------------------------------------

test("intakeDecide confirm: only valid from 'proposed', logs exactly one activity event (type: system)", () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "x", inputKind: "text" });
  intakeUpdate({ repoRoot, id, patch: { status: "proposed", kind: "jd-text" } });
  const before = readMeta(db);
  const activityBefore = db.prepare("SELECT COUNT(*) AS n FROM activity_events").get().n;

  const decided = intakeDecide({
    repoRoot,
    id,
    decision: "confirm",
    dispatchSummary: "run evaluate-job",
  });
  assert.equal(decided.item.status, "confirmed");
  assert.equal(decided.item.decision, "confirm");
  assert.ok(decided.item.decidedAt);
  assert.ok(decided.event, "confirm must log an activity event");
  assert.equal(decided.event.type, "system");
  assert.match(decided.event.title, /confirmed/);
  assert.match(decided.event.title, /run evaluate-job/);

  assert.deepEqual(readMeta(db), before, "intakeDecide must never bump meta");
  const activityAfter = db.prepare("SELECT COUNT(*) AS n FROM activity_events").get().n;
  assert.equal(activityAfter, activityBefore + 1);
});

test("intakeDecide confirm: rejects a 'needs_you' item (InvalidTransitionError)", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "x", inputKind: "text" });
  intakeUpdate({ repoRoot, id, patch: { status: "needs_you" } });
  assert.throws(
    () => intakeDecide({ repoRoot, id, decision: "confirm" }),
    (err) => err instanceof InvalidTransitionError && err.code === "INVALID_TRANSITION"
  );
});

test("intakeDecide dismiss: allowed from proposed/needs_you/error, never deletes the row, logs no activity event", () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  for (const status of ["proposed", "needs_you", "error"]) {
    const { id } = intakeCapture({ repoRoot, rawInput: `text-${status}`, inputKind: "text" });
    intakeUpdate({ repoRoot, id, patch: { status } });
    const activityBefore = db.prepare("SELECT COUNT(*) AS n FROM activity_events").get().n;

    const decided = intakeDecide({ repoRoot, id, decision: "dismiss" });
    assert.equal(decided.item.status, "dismissed");
    assert.equal(decided.event, null, "dismiss never logs an activity event");

    const activityAfter = db.prepare("SELECT COUNT(*) AS n FROM activity_events").get().n;
    assert.equal(activityAfter, activityBefore);

    const stillThere = db.prepare("SELECT id FROM intake_items WHERE id = ?").get(id);
    assert.ok(stillThere, "dismiss must never delete the row");
  }
});

test("intakeDecide: rejects an unknown decision value", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "x", inputKind: "text" });
  assert.throws(
    () => intakeDecide({ repoRoot, id, decision: "yolo" }),
    /decision must be "confirm" or "dismiss"/
  );
});

// ---------------------------------------------------------------------------
// intakeList / intakeOne
// ---------------------------------------------------------------------------

test("intakeList: newest-first, filters by status, respects limit", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const a = intakeCapture({ repoRoot, rawInput: "first", inputKind: "text" });
  await sleep(5); // guarantee b's created_at lands in a strictly later millisecond than a's
  const b = intakeCapture({ repoRoot, rawInput: "second", inputKind: "text" });
  intakeUpdate({ repoRoot, id: b.id, patch: { status: "proposed" } });

  const all = intakeList({ repoRoot });
  assert.equal(all.length, 2);
  assert.equal(all[0].id, b.id, "newest-first ordering");
  assert.equal(all[1].id, a.id);

  const proposedOnly = intakeList({ repoRoot, status: "proposed" });
  assert.deepEqual(
    proposedOnly.map((i) => i.id),
    [b.id]
  );

  const limited = intakeList({ repoRoot, limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].id, b.id);
});

test("intakeOne: returns the full row shape, or null for an unknown id", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "hello", inputKind: "text" });
  const item = intakeOne({ repoRoot, id });
  assert.equal(item.id, id);
  assert.equal(item.status, "captured");
  assert.equal(item.rawInput, "hello");
  assert.ok(item.createdAt);
  assert.ok(item.updatedAt);

  assert.equal(intakeOne({ repoRoot, id: "does-not-exist" }), null);
});
