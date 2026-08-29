// tests/db-verb-export-integrity.test.mjs — verbs/shared.mjs's runVerb() is
// the one call site every write verb funnels through: BEGIN IMMEDIATE ...
// COMMIT, then (outside that transaction) exportToTracker(). Those are two
// separate failure domains — a thrown error from the transaction means
// nothing was written, but a thrown error from the export means the db write
// already committed and only tracker.json/activity.jsonl regeneration
// failed. Before this fix both looked like the same generic Error to a
// caller, so a caller couldn't tell "safe to retry" from "already happened,
// don't retry the write, just fix the export."
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  activityAppend,
  candidateSetupInitialize,
  ExportFailedError,
  kvGet,
  kvUpsert,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-verb-export-"));
  cleanupRoots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runVerb reports a truthy exported result on the normal path", () => {
  const repoRoot = tempRepo();
  const result = kvUpsert({
    repoRoot,
    key: "strategyReview",
    value: { snapshot: { rejected: 0 } },
  });
  assert.equal(result.ok, true);
  assert.ok(result.exported, "a successful write must report a truthy exported result");
});

test("activity-only writes update the watched activity export without rebuilding tracker.json", () => {
  const repoRoot = tempRepo();
  kvUpsert({ repoRoot, key: "strategyReview", value: { snapshot: { rejected: 0 } } });

  const trackerPath = userPath({ repoRoot }, "workspace/tracker.json");
  const activityPath = userPath({ repoRoot }, "workspace/activity.jsonl");
  const trackerBefore = `${readFileSync(trackerPath, "utf8")}\n`;
  writeFileSync(trackerPath, trackerBefore);

  const result = activityAppend({
    repoRoot,
    event: {
      at: "2026-08-27T18:00:00.000Z",
      type: "system",
      title: "Activity-only compatibility signal",
    },
  });

  assert.equal(readFileSync(trackerPath, "utf8"), trackerBefore);
  assert.match(readFileSync(activityPath, "utf8"), /Activity-only compatibility signal/);
  assert.deepEqual(result.exported.wrote, { tracker: false, activity: true });
});

test("runVerb applies the configured activity retention bound to canonical DB and export state", () => {
  const repoRoot = tempRepo();
  const env = { ...process.env, CAREERRAT_ACTIVITY_MAX: "3" };

  for (let index = 1; index <= 5; index += 1) {
    activityAppend({
      repoRoot,
      env,
      event: {
        at: `2026-08-27T18:00:0${index}.000Z`,
        type: "system",
        title: `Bounded activity ${index}`,
      },
    });
  }

  const db = openDb({ repoRoot, env });
  const stored = db
    .prepare("SELECT data FROM activity_events ORDER BY rowid ASC")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.deepEqual(
    stored.map((event) => event.title),
    ["Bounded activity 3", "Bounded activity 4", "Bounded activity 5"]
  );

  const exported = readFileSync(userPath({ repoRoot, env }, "workspace/activity.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    exported.map((event) => event.title),
    ["Bounded activity 3", "Bounded activity 4", "Bounded activity 5"]
  );
});

test("runVerb surfaces an export failure distinctly from a write failure, without losing the commit", () => {
  const repoRoot = tempRepo();
  // Force exportToTracker to fail: atomicWriteFile's rename/write onto an
  // existing DIRECTORY at the tracker.json path throws EISDIR.
  mkdirSync(userPath({ repoRoot }, "workspace/tracker.json"), { recursive: true });

  let caught;
  try {
    kvUpsert({ repoRoot, key: "strategyReview", value: { forced: "export-failure" } });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, "an export failure must not be swallowed as a silent success");
  assert.ok(caught instanceof ExportFailedError);
  assert.equal(caught.code, "EXPORT_FAILED");
  assert.equal(caught.committed, true, "the db write already committed before export ran");
  assert.ok(caught.cause, "the original export error must be preserved for diagnosis");
  assert.equal(caught.cause.code, "EISDIR");
  assert.equal(caught.result.ok, true, "the write's own result is still attached to the error");

  // Prove the write itself was NOT lost: kvGet reads straight from the
  // already-committed db row, independent of the broken export step.
  const stored = kvGet({ repoRoot, key: "strategyReview" });
  assert.deepEqual(stored, { forced: "export-failure" });
});
