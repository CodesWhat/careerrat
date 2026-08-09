// import-from-tracker.mjs — migrate a legacy workspace/tracker.json (+
// activity.jsonl) into the sqlite db, verbatim.
//
// Every applications[]/sourced[]/communications[]/sources[] row lands as-is in
// its table's `data` blob column — upsert by id (ON CONFLICT DO UPDATE), so
// re-running the import is idempotent: same source, same DB, byte for byte.
// meta's three modeled fields (lastUpdatedAt/version/lastSweepAt) get their own
// columns; every OTHER meta key (e.g. demoAnchor) is preserved verbatim in
// meta.extra. Every top-level tracker.json key that isn't one of
// meta/applications/sources/communications/sourced/analytics (e.g.
// strategyReview, stages, relationshipLeads) is preserved verbatim, one row
// per key, in the `kv` table — see export-to-tracker.mjs for the inverse.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userPath } from "../paths/workspace.mjs";
import { loadLegacyCandidateConfig } from "../profile/config-store.mjs";
import { parseYaml } from "../profile/yaml.mjs";
import { rebaseTrackerData, shiftTreeByMs } from "../tracker/rebase-dates.mjs";
import { snapshotTracker } from "../tracker/tracker-snapshot.mjs";
import { openDb } from "./connection.mjs";
import { withTransaction } from "./transaction.mjs";
import {
  candidateArtifactExists,
  candidateArtifactPut,
  candidateConfigPatch,
  candidateEvidenceMerge,
  candidateSetupInitialize,
} from "./verbs/candidate.mjs";
import { sourceConfigPut } from "./verbs/source-config.mjs";

// Top-level tracker.json keys that already have a dedicated table/column home.
// Anything else goes into `kv` verbatim.
const MODELED_TOP_LEVEL_KEYS = new Set([
  "meta",
  "applications",
  "sources",
  "communications",
  "sourced",
  "analytics",
]);

// meta keys with a dedicated column; everything else on the meta object goes
// into meta.extra verbatim (e.g. demoAnchor, the legacy `updatedAt` alias).
const MODELED_META_KEYS = new Set(["lastUpdatedAt", "version", "lastSweepAt"]);

function upsert(db, table, id, dataObj, extraCols = {}) {
  const cols = ["id", "data", ...Object.keys(extraCols)];
  const placeholders = cols.map(() => "?").join(", ");
  const updates = cols
    .filter((c) => c !== "id")
    .map((c) => `${c}=excluded.${c}`)
    .join(", ");
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`;
  db.prepare(sql).run(String(id), JSON.stringify(dataObj), ...Object.values(extraCols));
}

// tracker.schema.json marks lastUpdatedAt/version/lastSweepAt all optional/
// nullable, but the `meta` table models version as NOT NULL DEFAULT 0 (per the
// spec's literal DDL) so there's always a value to bump. That means "absent
// from the source" and "present as 0/null" collapse to the same stored value
// unless we track presence separately — needed for a byte-for-byte (modulo key
// order) export round-trip against a legacy file that never had one of these
// keys (e.g. examples/demo-workspace/tracker.json has no meta.version).
// Recorded as a reserved bookkeeping key inside `extra` itself (stripped back
// out before it's ever spread into an exported meta object — see
// export-to-tracker.mjs's buildMeta()); bumpMeta() clears version/
// lastUpdatedAt out of this list the first time a real write stamps them.
export const ABSENT_META_KEYS_MARKER = "__absentMetaKeys";

function importMeta(db, meta) {
  if (!meta || typeof meta !== "object") return false;
  const extra = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!MODELED_META_KEYS.has(key)) extra[key] = value;
  }
  const absent = [...MODELED_META_KEYS].filter((key) => !Object.hasOwn(meta, key));
  if (absent.length) extra[ABSENT_META_KEYS_MARKER] = absent;

  db.prepare(
    `INSERT INTO meta (id, last_updated_at, version, last_sweep_at, extra) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_updated_at=excluded.last_updated_at, version=excluded.version,
       last_sweep_at=excluded.last_sweep_at, extra=excluded.extra`
  ).run(
    meta.lastUpdatedAt ?? null,
    Number.isInteger(meta.version) ? meta.version : 0,
    meta.lastSweepAt ?? null,
    Object.keys(extra).length ? JSON.stringify(extra) : null
  );
  return true;
}

function importAnalytics(db, data) {
  if (!Object.hasOwn(data, "analytics")) return false;
  db.prepare(
    `INSERT INTO analytics (id, updated_at, data) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data`
  ).run(data.analytics?.updatedAt ?? null, JSON.stringify(data.analytics ?? null));
  return true;
}

function importKv(db, data) {
  let count = 0;
  for (const [key, value] of Object.entries(data)) {
    if (MODELED_TOP_LEVEL_KEYS.has(key)) continue;
    db.prepare(
      `INSERT INTO kv (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data=excluded.data`
    ).run(key, JSON.stringify(value));
    count++;
  }
  return count;
}

function importApplications(db, applications) {
  let count = 0;
  for (const app of applications) {
    if (!app?.id) continue; // id is the primary key; skip rows that can't be addressed
    upsert(db, "applications", app.id, app);
    count++;
  }
  return count;
}

function importSourced(db, sourced) {
  let count = 0;
  for (const row of sourced) {
    if (!row?.id) continue;
    upsert(db, "sourced", row.id, row);
    count++;
  }
  return count;
}

function importSources(db, sources) {
  let count = 0;
  for (const row of sources) {
    if (!row?.id) continue;
    upsert(db, "sources", row.id, row);
    count++;
  }
  return count;
}

// Communications carry a real `application_id` FK column, separate from
// (though usually mirroring) the blob's own `applicationId` field. We only
// ever set it when it resolves to a row that actually exists in
// `applications` — foreign_keys=ON means anything else would raise a
// constraint violation, and the spec is explicit: "if there's no reliable app
// linkage today, leave NULL, do not invent one."
function importCommunications(db, communications, knownAppIds) {
  let count = 0;
  for (const comm of communications) {
    if (!comm?.id) continue;
    const applicationId =
      comm.applicationId && knownAppIds.has(comm.applicationId) ? comm.applicationId : null;
    upsert(db, "communications", comm.id, comm, { application_id: applicationId });
    count++;
  }
  return count;
}

// activity.jsonl lines are already fully canonicalized events (id/at/type/
// actor/... — see activity-log.mjs's canonicalizeEvent). We reuse the id
// verbatim rather than re-deriving it, and rely on the PRIMARY KEY + ON
// CONFLICT DO NOTHING for the "re-importing the same file never double-
// inserts" guarantee (decision: "PK conflict = dedupe").
function importActivity(db, events) {
  let count = 0;
  for (const event of events) {
    if (!event?.id || !event.at || !event.type) continue;
    const res = db
      .prepare(
        `INSERT INTO activity_events (id, at, type, actor, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(event.id, event.at, event.type, event.actor || "agent", JSON.stringify(event));
    if (res.changes) count++;
  }
  return count;
}

function readActivityLines(path) {
  if (!existsSync(path)) return [];
  const events = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip a malformed/partial line, same tolerant behavior as activity-log.mjs's readActivity()
    }
  }
  return events;
}

function importLegacyCandidateSetup(pathCtx) {
  const legacy = loadLegacyCandidateConfig(pathCtx);
  const counts = {
    profile: false,
    targeting: false,
    honesty: false,
    "form-defaults": false,
    modes: false,
    automation: false,
    "application-limits": false,
    evidence: 0,
  };
  if (Object.keys(legacy).length === 0) return counts;

  candidateSetupInitialize(pathCtx);
  for (const name of [
    "profile",
    "targeting",
    "honesty",
    "form-defaults",
    "modes",
    "automation",
    "application-limits",
  ]) {
    if (!legacy[name]) continue;
    candidateConfigPatch({ ...pathCtx, name, patch: legacy[name], recordActivity: false });
    counts[name] = true;
  }
  const claims = Array.isArray(legacy.evidence?.claims) ? legacy.evidence.claims : [];
  if (claims.length) {
    const result = candidateEvidenceMerge({ ...pathCtx, claims, recordActivity: false });
    counts.evidence = result.added;
  }

  // The source résumé is a copy-only candidate file, not a schema-validated
  // config, so the loop above never touches it — but the search-readiness
  // gate (computeCandidateSetup) keys on the source-resume ARTIFACT row.
  // Without this, a legacy workspace imported with a perfectly good
  // candidate/SOURCE_RESUME.md still read "not search-ready". Existing
  // artifact rows win (an onboarding upload has richer data than this seed).
  counts["source-resume"] = importLegacySourceResume(pathCtx);
  return counts;
}

function importLegacySourceResume(pathCtx) {
  if (candidateArtifactExists({ ...pathCtx, id: "source-resume" })) return false;
  const resumePath = userPath(pathCtx, "candidate/SOURCE_RESUME.md");
  if (!existsSync(resumePath)) return false;
  const text = readFileSync(resumePath, "utf8");
  if (!text.trim()) return false;
  candidateArtifactPut({
    ...pathCtx,
    id: "source-resume",
    kind: "source-resume",
    data: { text, savedAt: new Date().toISOString(), source: "legacy-import" },
  });
  return true;
}

function importLegacySourceConfigs(pathCtx) {
  const counts = {
    "search-sources": false,
    "sourced-scan": false,
  };

  const searchSourcesPath = userPath(pathCtx, "config/search-sources.yml");
  if (existsSync(searchSourcesPath)) {
    sourceConfigPut({
      ...pathCtx,
      name: "search-sources",
      data: parseYaml(readFileSync(searchSourcesPath, "utf8")) || {},
    });
    counts["search-sources"] = true;
  }

  const sourcedScanPath = userPath(pathCtx, "config/sourced-scan.json");
  if (existsSync(sourcedScanPath)) {
    sourceConfigPut({
      ...pathCtx,
      name: "sourced-scan",
      data: JSON.parse(readFileSync(sourcedScanPath, "utf8")),
    });
    counts["sourced-scan"] = true;
  }

  return counts;
}

// importFromTracker({repoRoot, env, sourceDir?}) — reads
// <sourceDir||workspace>/tracker.json (+ activity.jsonl if present) and
// upserts every row into the db. Idempotent: running it twice against the
// same source produces an identical db.
export function importFromTracker({ repoRoot, env, sourceDir, rebaseToday } = {}) {
  const pathCtx = { repoRoot, env };
  const trackerPath = sourceDir
    ? join(sourceDir, "tracker.json")
    : userPath(pathCtx, "workspace/tracker.json");
  const activityPath = sourceDir
    ? join(sourceDir, "activity.jsonl")
    : userPath(pathCtx, "workspace/activity.jsonl");

  if (!existsSync(trackerPath)) {
    throw new Error(`importFromTracker: no tracker.json at ${trackerPath}`);
  }

  // Snapshot the target workspace's legacy tracker.json before its first
  // migration into the db (reuses the existing rolling-snapshot mechanism —
  // it's already a safe no-op when tracker.json is missing or unchanged since
  // the newest snapshot, so it's safe to call on every import, not just the
  // very first one).
  snapshotTracker(pathCtx);

  const data = JSON.parse(readFileSync(trackerPath, "utf8"));
  // Demo seed only: shift the fixture's evergreen dates to real-today so the live
  // dashboard reads as current (interviews upcoming, applications in the past). No-op
  // for real workspaces — they carry no meta.demoAnchor — and whenever rebaseToday is
  // unset, which is every non-demo caller.
  const rebase = rebaseToday ? rebaseTrackerData(data, rebaseToday) : null;
  const applications = Array.isArray(data.applications) ? data.applications : [];
  const sourced = Array.isArray(data.sourced) ? data.sourced : [];
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const communications = Array.isArray(data.communications) ? data.communications : [];
  const activityEvents = shiftTreeByMs(readActivityLines(activityPath), rebase?.deltaMs || 0);

  const db = openDb({ repoRoot, env });

  const counts = withTransaction(db, () => {
    const appCount = importApplications(db, applications);
    const knownAppIds = new Set(applications.filter((a) => a?.id).map((a) => a.id));
    return {
      applications: appCount,
      sourced: importSourced(db, sourced),
      sources: importSources(db, sources),
      communications: importCommunications(db, communications, knownAppIds),
      activity: importActivity(db, activityEvents),
      meta: importMeta(db, data.meta),
      analytics: importAnalytics(db, data),
      kv: importKv(db, data),
    };
  });

  counts.candidate = importLegacyCandidateSetup(pathCtx);
  counts.sourceConfigs = importLegacySourceConfigs(pathCtx);

  return { ok: true, sourcePath: trackerPath, activityPath, counts };
}
