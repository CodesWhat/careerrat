// verbs/source.mjs — tracker sources[] watermark actions.
//
// Inbound sweeps (mail and in-platform messages) must record that a source was
// scanned without resetting the dashboard's user-visible freshness pill when
// no data changed. This verb updates sources[] and meta.lastSweepAt, exports the
// generated tracker files, but deliberately does NOT bump meta.version /
// meta.lastUpdatedAt and does NOT log activity.
import { requireDb } from "../connection.mjs";
import { exportToTracker } from "../export-to-tracker.mjs";
import { ABSENT_META_KEYS_MARKER } from "../import-from-tracker.mjs";
import { withTransaction } from "../transaction.mjs";

function trimOrNull(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function assertIso(label, value) {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new Error(`sourceWatermarkUpsert: ${label} must be an ISO datetime`);
  }
}

function normalizeSource(source, at) {
  if (!source || typeof source !== "object") {
    throw new Error("sourceWatermarkUpsert: every source must be an object");
  }
  const id = trimOrNull(source.id);
  if (!id) throw new Error("sourceWatermarkUpsert: source.id is required");
  const lastRunAt = trimOrNull(source.lastRunAt) || at;
  assertIso("lastRunAt", lastRunAt);
  return {
    ...source,
    id,
    kind: trimOrNull(source.kind) || id,
    name: trimOrNull(source.name) || id,
    lastRunAt,
  };
}

function putSource(db, source) {
  db.prepare(
    `INSERT INTO sources (id, data) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET data=excluded.data`
  ).run(source.id, JSON.stringify(source));
}

function readMeta(db) {
  const row = db
    .prepare("SELECT version, last_updated_at, last_sweep_at FROM meta WHERE id = 1")
    .get();
  return {
    version: row?.version ?? 0,
    lastUpdatedAt: row?.last_updated_at ?? null,
    lastSweepAt: row?.last_sweep_at ?? null,
  };
}

function stampLastSweepAt(db, at) {
  const current = db.prepare("SELECT extra FROM meta WHERE id = 1").get();
  const extra = current?.extra ? JSON.parse(current.extra) : {};
  if (Array.isArray(extra[ABSENT_META_KEYS_MARKER])) {
    extra[ABSENT_META_KEYS_MARKER] = extra[ABSENT_META_KEYS_MARKER].filter(
      (key) => key !== "lastSweepAt"
    );
    if (extra[ABSENT_META_KEYS_MARKER].length === 0) delete extra[ABSENT_META_KEYS_MARKER];
  }
  const extraJson = Object.keys(extra).length ? JSON.stringify(extra) : null;
  db.prepare("UPDATE meta SET last_sweep_at = ?, extra = ? WHERE id = 1").run(at, extraJson);
}

export function sourceWatermarkUpsert({ repoRoot, env, source, sources, at } = {}) {
  const rows = sources ?? source;
  const input = Array.isArray(rows) ? rows : rows ? [rows] : [];
  if (input.length === 0) {
    throw new Error("sourceWatermarkUpsert: source or sources is required");
  }

  const pathCtx = { repoRoot, env };
  const db = requireDb(pathCtx);
  const sweepAt = at || new Date().toISOString();
  assertIso("at", sweepAt);

  const result = withTransaction(db, () => {
    const normalized = input.map((row) => normalizeSource(row, sweepAt));
    for (const row of normalized) putSource(db, row);
    stampLastSweepAt(db, sweepAt);
    return {
      ok: true,
      count: normalized.length,
      sources: normalized,
      meta: readMeta(db),
    };
  });

  const exported = exportToTracker(pathCtx);
  return { ...result, exported };
}
