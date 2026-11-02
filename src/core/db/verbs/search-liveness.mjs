// verbs/search-liveness.mjs — dead-board memory (scan) and the last-check
// ledger for saved-job links (check:jobs). Tables: migration 020.
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";

// A board is confirmed dead after this many consecutive dead answers.
const DEAD_BOARD_STRIKES = 2;
// A confirmed-dead board is probed again after this long.
const DEAD_BOARD_RECHECK_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

export function deadBoardList({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  return db.prepare("SELECT * FROM dead_boards ORDER BY label COLLATE NOCASE").all();
}

// outcome: "dead" (HTTP 404/410 from the board) | "alive" (answered fine).
// A transient failure is not an outcome; callers simply don't record it.
// Returns the row after the write, or null when the board is alive.
export function deadBoardRecord({
  repoRoot,
  env,
  sourceKey,
  kind,
  label,
  outcome,
  error = null,
  now = new Date(),
} = {}) {
  if (!sourceKey) throw new Error("deadBoardRecord requires sourceKey");
  if (outcome !== "dead" && outcome !== "alive") throw new Error("deadBoardRecord: bad outcome");
  const db = requireDb({ repoRoot, env });
  const at = iso(now);
  return withTransaction(db, () => {
    if (outcome === "alive") {
      db.prepare("DELETE FROM dead_boards WHERE source_key = ?").run(sourceKey);
      return null;
    }
    const existing = db.prepare("SELECT * FROM dead_boards WHERE source_key = ?").get(sourceKey);
    const strikes = (existing?.strikes || 0) + 1;
    const deadSince = existing?.dead_since || (strikes >= DEAD_BOARD_STRIKES ? at : null);
    db.prepare(
      `INSERT INTO dead_boards
         (source_key, kind, label, strikes, first_dead_at, dead_since, last_checked_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_key) DO UPDATE SET
         kind = excluded.kind, label = excluded.label, strikes = excluded.strikes,
         dead_since = excluded.dead_since, last_checked_at = excluded.last_checked_at,
         last_error = excluded.last_error`
    ).run(
      sourceKey,
      String(kind || "company"),
      String(label || sourceKey).slice(0, 160),
      strikes,
      existing?.first_dead_at || at,
      deadSince,
      at,
      error ? String(error).slice(0, 300) : null
    );
    return db.prepare("SELECT * FROM dead_boards WHERE source_key = ?").get(sourceKey);
  });
}

// Drop rows for sources that are no longer configured, so removing a source
// and adding it back starts clean (an immediate re-check).
export function deadBoardPrune({ repoRoot, env, keepKeys } = {}) {
  const keep = new Set(keepKeys || []);
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    let removed = 0;
    for (const row of db.prepare("SELECT source_key FROM dead_boards").all()) {
      if (keep.has(row.source_key)) continue;
      db.prepare("DELETE FROM dead_boards WHERE source_key = ?").run(row.source_key);
      removed += 1;
    }
    return removed;
  });
}

// Confirmed-dead rows that scans should skip right now (not yet due a re-check).
export function isDeadBoardSkipped(row, now = new Date()) {
  if (!row?.dead_since) return false;
  const last = Date.parse(row.last_checked_at);
  if (!Number.isFinite(last)) return false;
  return new Date(now).getTime() - last < DEAD_BOARD_RECHECK_DAYS * DAY_MS;
}

export function jobLinkCheckLast({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  return new Map(
    db
      .prepare("SELECT url, result, code, checked_at FROM job_link_checks")
      .all()
      .map((row) => [row.url, row])
  );
}

export function jobLinkCheckRecord({ repoRoot, env, entries, now = new Date() } = {}) {
  const db = requireDb({ repoRoot, env });
  const at = iso(now);
  withTransaction(db, () => {
    const stmt = db.prepare(
      `INSERT INTO job_link_checks (url, result, code, checked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         result = excluded.result, code = excluded.code, checked_at = excluded.checked_at`
    );
    for (const entry of entries || []) {
      stmt.run(String(entry.url), String(entry.result), entry.code ? String(entry.code) : null, at);
    }
  });
}
