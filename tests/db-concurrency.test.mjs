// tests/db-concurrency.test.mjs — two SEPARATE OS processes writing
// overlapping appUpsert() calls against the same sqlite db file. Proves WAL +
// busy_timeout=5000 (M6 decision 3) actually holds under real multi-process
// contention: no SQLITE_BUSY escapes to either worker, and no lost version
// increments (every write is its own BEGIN IMMEDIATE ... COMMIT, so the final
// meta.version must equal the total number of writes across both processes).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const WORKER_SCRIPT = join(REPO_ROOT, "tests/fixtures/db-concurrency-worker.mjs");

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-db-concurrency-"));
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

function runWorker(repoRoot, count, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_SCRIPT, repoRoot, String(count), label], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("two concurrent processes writing the same db: no SQLITE_BUSY escapes, no lost version increments", async () => {
  const repoRoot = tempRepo();
  // Create + migrate the db up front (in the parent process), then release the
  // parent's own handle before spawning workers, so the two child processes
  // are the only writers contending for the file.
  openDb({ repoRoot });
  closeAll();

  const PER_WORKER = 20;
  const [a, b] = await Promise.all([
    runWorker(repoRoot, PER_WORKER, "worker-a"),
    runWorker(repoRoot, PER_WORKER, "worker-b"),
  ]);

  for (const [label, result] of [
    ["worker-a", a],
    ["worker-b", b],
  ]) {
    assert.equal(result.code, 0, `${label} must exit 0 (stderr: ${result.stderr})`);
    assert.doesNotMatch(
      result.stderr,
      /SQLITE_BUSY/,
      `${label} must never surface an unhandled SQLITE_BUSY (stderr: ${result.stderr})`
    );
  }

  const db = openDb({ repoRoot });
  const meta = db.prepare("SELECT version FROM meta WHERE id = 1").get();
  assert.equal(
    meta.version,
    PER_WORKER * 2,
    "every write across both processes must land exactly one version bump"
  );

  // NOTE: activity_events count is NOT asserted to equal PER_WORKER * 2 here.
  // logActivityEvent's id is a content hash of {at, type, title, refs} (see
  // activity-log.mjs's eventId / PK-conflict-=-dedupe decision), and this
  // stress workload repeatedly upserts the SAME row (same title/type/refs
  // after the first call) fast enough that many calls land in the same
  // millisecond — those legitimately collapse to one row by design, so a
  // lower count here reflects correct dedup, not a lost write. What must
  // never be lost is meta.version (asserted above), since that bump has no
  // dedup key — it's a plain `version = version + 1` inside every write's own
  // transaction.
  const activityCount = db.prepare("SELECT COUNT(*) AS n FROM activity_events").get().n;
  assert.ok(
    activityCount >= 1 && activityCount <= PER_WORKER * 2,
    "activity_events count must be sane"
  );

  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-concurrent");
  assert.ok(row, "the contended row must exist after both workers finish");
});
