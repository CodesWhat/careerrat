// export-to-tracker.mjs — regenerate workspace/tracker.json + activity.jsonl
// from the db, keeping the legacy read pipeline alive (decision 8). The
// existing dashboard render (`careerrat tracker`) keeps reading tracker.json
// unchanged; this is the db's half of that contract. Every write verb calls
// this once, OUTSIDE its own transaction, right after that transaction
// commits (see verbs/shared.mjs's runVerb()). That shared path writes only the
// surface whose canonical DB state changed. Explicit recovery exports keep the
// default below and regenerate both files.
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

// assembleTrackerObject — the pure, in-memory half of the export: reads
// applications/sources/communications/sourced/meta/analytics/kv straight off
// the db and reassembles the exact legacy tracker.json shape, WITHOUT writing
// anything to disk. Extracted (M10) so a request-time consumer — the new
// GET /api/data/dashboard route (src/cli/dashboard-route.mjs) — can build the
// same trackerData object exportToTracker() writes to disk, in-process, with
// no round-trip through the filesystem. exportToTracker() below is now just
// this function + the atomic file write; no behavior change.
export function assembleTrackerObject(db) {
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

  return output;
}

// assembleActivityEvents — the activity.jsonl feed as parsed objects (not raw
// JSONL lines) for an in-process consumer. Reuses the same table read
// exportToTracker's own buildActivityLines() draws from; order doesn't matter
// to callers (dashboard-data.js's buildActivityPulse/buildJobActivityTimeline
// both sort internally), so this is just the plain rowid-ordered read
// rowsAsObjects() already gives every other table.
export function assembleActivityEvents(db) {
  return rowsAsObjects(db, "activity_events");
}

export function exportToTracker({ repoRoot, env } = {}, { tracker = true, activity = true } = {}) {
  const pathCtx = { repoRoot, env };
  const db = requireDb({ repoRoot, env });

  const output = tracker ? assembleTrackerObject(db) : null;
  const kvCount = db.prepare("SELECT COUNT(*) AS n FROM kv").get().n;

  const trackerPath = userPath(pathCtx, "workspace/tracker.json");
  if (tracker) {
    mkdirSync(dirname(trackerPath), { recursive: true });
    atomicWriteFile(trackerPath, `${JSON.stringify(output, null, 2)}\n`);
  }

  const activityPath = userPath(pathCtx, "workspace/activity.jsonl");
  const activityLines = activity ? buildActivityLines(db) : null;
  if (activity) {
    mkdirSync(dirname(activityPath), { recursive: true });
    atomicWriteFile(activityPath, activityLines.length ? `${activityLines.join("\n")}\n` : "");
  }

  const tableCount = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

  return {
    ok: true,
    trackerPath,
    activityPath,
    wrote: { tracker, activity },
    counts: {
      applications: output?.applications.length ?? tableCount("applications"),
      sourced: output?.sourced.length ?? tableCount("sourced"),
      sources: output?.sources.length ?? tableCount("sources"),
      communications: output?.communications.length ?? tableCount("communications"),
      activity: activityLines?.length ?? tableCount("activity_events"),
      kv: kvCount,
    },
  };
}
