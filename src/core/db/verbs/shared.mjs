// verbs/shared.mjs — the common plumbing every domain-action verb uses, so
// decision 4 ("one BEGIN IMMEDIATE ... COMMIT per verb: state change + meta
// bump + activity event insert (+ analytics refresh for outcome-changing verbs
// only)") and decision 6 ("one shared write path: CLI verb and HTTP route call
// the IDENTICAL exported lib function") both hold by construction — every verb
// in app.mjs/sourced.mjs/comm.mjs/activity.mjs/analytics.mjs is built on
// runVerb() below, so there is exactly one INSERT/UPDATE call site per domain
// action, and CLI + HTTP always call that same function.
import { computeAppend } from "../../tracker/activity-log.mjs";
import { requireDb } from "../connection.mjs";
import { exportToTracker } from "../export-to-tracker.mjs";
import { withTransaction } from "../transaction.mjs";

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.code = "NOT_FOUND";
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function getRow(db, table, id) {
  const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(String(id));
  return row ? JSON.parse(row.data) : null;
}

export function requireRow(db, table, id, label) {
  const value = getRow(db, table, id);
  if (!value) throw new NotFoundError(`no ${label} with id "${id}"`);
  return value;
}

export function putRow(db, table, id, value, extraCols = {}) {
  const cols = ["id", "data", ...Object.keys(extraCols)];
  const placeholders = cols.map(() => "?").join(", ");
  const updates = cols
    .filter((c) => c !== "id")
    .map((c) => `${c}=excluded.${c}`)
    .join(", ");
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`;
  db.prepare(sql).run(String(id), JSON.stringify(value), ...Object.values(extraCols));
}

export function deleteRow(db, table, id) {
  return db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(String(id));
}

export function appIdExists(db, id) {
  if (!id) return false;
  return Boolean(db.prepare("SELECT 1 FROM applications WHERE id = ?").get(String(id)));
}

// Bump meta.version + meta.last_updated_at in the SAME write as the domain
// state change (AGENTS.md's Tracker Write Contract step 1). The meta row
// always exists (seeded by migration 001-init), but the INSERT fallback below
// keeps this safe even against a hand-built test db that skipped that seed.
//
// Also clears "version"/"lastUpdatedAt" out of import-from-tracker.mjs's
// __absentMetaKeys bookkeeping (see that file's ABSENT_META_KEYS_MARKER doc
// comment) — once a real write stamps them, they're genuinely present, not a
// legacy fixture's gap to preserve on the next export.
export function bumpMeta(db, at = nowIso()) {
  const current = db.prepare("SELECT extra FROM meta WHERE id = 1").get();
  const extra = current?.extra ? JSON.parse(current.extra) : {};
  if (Array.isArray(extra.__absentMetaKeys) && extra.__absentMetaKeys.length) {
    extra.__absentMetaKeys = extra.__absentMetaKeys.filter(
      (key) => key !== "version" && key !== "lastUpdatedAt"
    );
    if (!extra.__absentMetaKeys.length) delete extra.__absentMetaKeys;
  }
  const extraJson = Object.keys(extra).length ? JSON.stringify(extra) : null;

  const row = db
    .prepare(
      "UPDATE meta SET version = version + 1, last_updated_at = ?, extra = ? WHERE id = 1 RETURNING version, last_updated_at"
    )
    .get(at, extraJson);
  if (row) return { version: row.version, lastUpdatedAt: row.last_updated_at };
  db.prepare("INSERT INTO meta (id, version, last_updated_at, extra) VALUES (1, 1, ?, ?)").run(
    at,
    extraJson
  );
  return { version: 1, lastUpdatedAt: at };
}

// Canonicalize + validate + honesty/privacy-lint one activity event (reusing
// activity-log.mjs's pure computeAppend — decision: "reuse the
// canonicalization + content-hash id ... import it, don't duplicate") and
// insert it. PRIMARY KEY + ON CONFLICT DO NOTHING is the dedupe: re-logging
// the same logical event (same at/type/title/refs) collapses to one row.
export function logActivityEvent(db, input, { now = new Date() } = {}) {
  const plan = computeAppend({ event: input, now });
  if (!plan.ok) {
    const err = new Error(`activity event refused: ${plan.error}`);
    err.code = "ACTIVITY_REFUSED";
    throw err;
  }
  db.prepare(
    "INSERT INTO activity_events (id, at, type, actor, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING"
  ).run(plan.event.id, plan.event.at, plan.event.type, plan.event.actor, plan.line);
  return plan.event;
}

// Recompute + persist the analytics block against the CURRENT applications
// table, inside the caller's already-open transaction — does NOT bump meta
// (decision 4's "WITHOUT bumping the freshness stamp"). Exported separately
// (verbs/analytics.mjs) as its own standalone write verb for direct
// CLI/HTTP/test use; outcome-changing verbs (app.mjs/sourced.mjs) call this
// directly instead, so a single verb's analytics refresh is part of that
// verb's one transaction, not a second one.
export function refreshAnalyticsInDb(
  db,
  { buildReevaluationAnalytics, targeting, thresholds, now }
) {
  const apps = db
    .prepare("SELECT data FROM applications ORDER BY rowid ASC")
    .all()
    .map((row) => JSON.parse(row.data));
  const strategyReviewRow = db.prepare("SELECT data FROM kv WHERE key = 'strategyReview'").get();
  const strategyReview = strategyReviewRow ? JSON.parse(strategyReviewRow.data) : null;

  const analytics = buildReevaluationAnalytics({
    apps,
    targeting,
    strategyReview,
    thresholds,
    now,
  });

  db.prepare(
    `INSERT INTO analytics (id, updated_at, data) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data`
  ).run(analytics.updatedAt, JSON.stringify(analytics));

  return analytics;
}

// The one call site every verb funnels through: open the db (fail-closed —
// requireDb throws NoDatabaseError when no db file exists yet, decision 7),
// run `fn(db, pathCtx)` inside one BEGIN IMMEDIATE ... COMMIT, then — OUTSIDE
// and AFTER that transaction — regenerate tracker.json + activity.jsonl
// (decision 8) so the legacy dashboard render never goes stale.
export function runVerb({ repoRoot, env }, fn) {
  const pathCtx = { repoRoot, env };
  const db = requireDb(pathCtx);
  const result = withTransaction(db, () => fn(db, pathCtx));
  const exported = exportToTracker(pathCtx);
  return { ok: true, ...result, exported };
}

// Read-only lookup for a single top-level tracker key stored in `kv` (e.g.
// strategyReview, storyEnrichment) — no transaction needed. Mirrors the
// inline `SELECT data FROM kv WHERE key = ...` read in refreshAnalyticsInDb
// above, generalized so callers outside this module don't hand-roll it.
export function kvGet({ repoRoot, env, key } = {}) {
  if (!key) throw new Error("kvGet: key is required");
  const db = requireDb({ repoRoot, env });
  const row = db.prepare("SELECT data FROM kv WHERE key = ?").get(key);
  return row ? JSON.parse(row.data) : null;
}

// Generic top-level kv-key upsert verb — for tracker.json keys that already
// have a mechanical CLI writer on the JSON-mode path (whole-key replace, no
// domain merge/dedupe behavior of their own) and just need the SAME value
// persisted into the DB's kv table so DB-backed workspaces pick it up (e.g.
// `strategy-review stamp --write`, `stories sync-enrichment --write`). Keys
// with real domain behavior (dedupe, status transitions, linked-app CTA
// updates — calendarBusy/relationshipLeads) keep their own verb file instead
// of routing through this.
export function kvUpsert({ repoRoot, env, key, value } = {}) {
  if (!key) throw new Error("kvUpsert: key is required");
  return runVerb({ repoRoot, env }, (db) => {
    db.prepare(
      `INSERT INTO kv (key, data) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET data=excluded.data`
    ).run(key, JSON.stringify(value));
    const meta = bumpMeta(db);
    return { key, meta };
  });
}
