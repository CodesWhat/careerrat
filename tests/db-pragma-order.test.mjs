// tests/db-pragma-order.test.mjs: regression guard for issue #136's
// pragma-ordering bug. A fresh sqlite connection's busy handler is off (0ms
// retry) until PRAGMA busy_timeout runs, so any pragma issued before it has
// zero retry protection. connection.mjs's applyPragmas() used to set
// busy_timeout LAST, so "PRAGMA journal_mode = WAL" (its first call) could hit
// an unhandled SQLITE_BUSY_RECOVERY the instant two processes raced to open
// the same brand-new WAL db, before the retry handler that was supposed to
// absorb exactly that race had been installed. This does not replay the race
// itself (that is inherently timing-dependent; see db-concurrency.test.mjs).
// It pins down the one thing that actually prevents the bug: busy_timeout
// must be the FIRST pragma applyPragmas() sends to the real driver, on every
// call, not a text check on the source and not a substring that a comment
// could satisfy. It spies on the actual node:sqlite DatabaseSync.prototype.exec
// method that connection.mjs calls, through the real openDb() entry point, so
// a future reorder (alphabetizing, "tidying", or otherwise) trips this test
// even if nobody touches the comment explaining why the order matters.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";

const cleanupRoots = [];

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

test("openDb sets PRAGMA busy_timeout before any other pragma on a fresh connection", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-pragma-order-"));
  cleanupRoots.push(repoRoot);

  // Spy on the real driver method connection.mjs calls (db.exec), not on our
  // own code, so this observes what actually reaches sqlite, in the actual
  // order it is sent, on a genuinely fresh connection (a new temp repo root,
  // never opened before).
  const execCalls = [];
  const originalExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function patchedExec(sql, ...rest) {
    execCalls.push(sql);
    return originalExec.call(this, sql, ...rest);
  };

  try {
    openDb({ repoRoot });
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }

  const pragmaCalls = execCalls.filter((sql) => /^PRAGMA\s/i.test(sql));
  assert.ok(
    pragmaCalls.length > 0,
    "openDb must issue at least one PRAGMA through db.exec on a fresh connection (none were recorded; check that the exec spy is actually wired up)"
  );
  assert.match(
    pragmaCalls[0],
    /^PRAGMA\s+busy_timeout\s*=/i,
    "busy_timeout must be the FIRST pragma applyPragmas() sends to the driver. SQLite's busy handler defaults to 0ms (no retry), so any pragma issued before busy_timeout, especially journal_mode = WAL, runs with no retry protection: two processes racing to open/initialize the same brand-new WAL db can hit an unhandled SQLITE_BUSY_RECOVERY on that earlier statement (this is the exact failure behind issue #136, reproduced as 'database is locked', errcode 261, thrown from PRAGMA journal_mode = WAL). Fix: move the busy_timeout PRAGMA to the top of applyPragmas() in src/core/db/connection.mjs. " +
      `Actual pragma order sent to the driver: ${pragmaCalls.join(", ")}`
  );
});
