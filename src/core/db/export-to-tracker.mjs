// export-to-tracker.mjs — regenerate workspace/tracker.json + activity.jsonl
// from the db, keeping the legacy read pipeline alive (decision 8). The
// existing dashboard render (`rolester tracker`) keeps reading tracker.json
// unchanged; this is the db's half of that contract. Every write verb calls
// this once, OUTSIDE its own transaction, right after that transaction
// commits (see verbs/shared.mjs's runVerb()).
//
// Must round-trip: import → export → deep-equal (modulo key order) with the
// original tracker.json. Key ORDER on write mirrors the legacy shape (meta,
// applications, sources, communications, sourced, analytics, then any
// preserved extra top-level keys) purely for readability — the round-trip
// test compares by value, not by key order.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { userPath } from "../paths/workspace.mjs";
import { atomicWriteFile } from "../profile/gate-writer.mjs";
import { requireDb } from "./connection.mjs";
import { ABSENT_META_KEYS_MARKER } from "./import-from-tracker.mjs";

function rowsAsObjects(db, table) {
  return db
    .prepare(`SELECT data FROM ${table} ORDER BY rowid ASC`)
    .all()
    .map((row) => JSON.parse(row.data));
}

function buildMeta(db) {
  const row = db.prepare("SELECT * FROM meta WHERE id = 1").get();
  if (!row) return undefined;
  const extra = row.extra ? JSON.parse(row.extra) : {};
  const absent = new Set(extra[ABSENT_META_KEYS_MARKER] || []);
  delete extra[ABSENT_META_KEYS_MARKER];

  const out = { ...extra };
  if (!absent.has("lastUpdatedAt")) out.lastUpdatedAt = row.last_updated_at ?? null;
  if (!absent.has("version")) out.version = row.version ?? 0;
  if (!absent.has("lastSweepAt") && row.last_sweep_at != null) out.lastSweepAt = row.last_sweep_at;
  return out;
}

function buildAnalytics(db) {
  const row = db.prepare("SELECT data FROM analytics WHERE id = 1").get();
  // Distinguish "no analytics row" (key was absent on import) from "analytics
  // explicitly null" (key was present with a null value) — both are possible
  // per tracker.schema.json's `["object", "null"]` type, and only the former
  // should omit the key entirely on export.
  return row ? { present: true, value: JSON.parse(row.data) } : { present: false };
}

function buildActivityLines(db) {
  return db
    .prepare("SELECT data FROM activity_events ORDER BY at ASC, rowid ASC")
    .all()
    .map((row) => row.data);
}

export function exportToTracker({ repoRoot, env } = {}) {
  const pathCtx = { repoRoot, env };
  const db = requireDb({ repoRoot, env });

  const applications = rowsAsObjects(db, "applications");
  const sources = rowsAsObjects(db, "sources");
  const communications = rowsAsObjects(db, "communications");
  const sourced = rowsAsObjects(db, "sourced");
  const meta = buildMeta(db);
  const analytics = buildAnalytics(db);

  const output = {};
  if (meta !== undefined) output.meta = meta;
  output.applications = applications;
  output.sources = sources;
  output.communications = communications;
  output.sourced = sourced;
  if (analytics.present) output.analytics = analytics.value;

  const kvRows = db.prepare("SELECT key, data FROM kv ORDER BY key ASC").all();
  for (const row of kvRows) output[row.key] = JSON.parse(row.data);

  const trackerPath = userPath(pathCtx, "workspace/tracker.json");
  mkdirSync(dirname(trackerPath), { recursive: true });
  atomicWriteFile(trackerPath, `${JSON.stringify(output, null, 2)}\n`);

  const activityLines = buildActivityLines(db);
  const activityPath = userPath(pathCtx, "workspace/activity.jsonl");
  atomicWriteFile(activityPath, activityLines.length ? `${activityLines.join("\n")}\n` : "");

  return {
    ok: true,
    trackerPath,
    activityPath,
    counts: {
      applications: applications.length,
      sourced: sourced.length,
      sources: sources.length,
      communications: communications.length,
      activity: activityLines.length,
      kv: kvRows.length,
    },
  };
}
