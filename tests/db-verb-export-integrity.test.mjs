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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import {
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
