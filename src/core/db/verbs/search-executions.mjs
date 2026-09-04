import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";

const EXECUTION_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const LANE_STATUSES = new Set(["queued", "running", "completed", "failed", "skipped", "cancelled"]);
const TERMINAL = new Set(["completed", "failed", "skipped", "cancelled"]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function executionId(value) {
  const id = String(value || "").trim();
  if (!EXECUTION_ID_RE.test(id)) {
    throw makeError("search execution id must be a short identifier", "BAD_REQUEST");
  }
  return id;
}

function timestamp(value = new Date().toISOString()) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw makeError("now must be an ISO timestamp", "BAD_REQUEST");
  return new Date(parsed).toISOString();
}

function timestampAfter(value, previous) {
  const next = Date.parse(timestamp(value));
  const prior = Date.parse(previous || "");
  return new Date(Number.isFinite(prior) && next <= prior ? prior + 1 : next).toISOString();
}

function parse(row) {
  return row ? JSON.parse(row.data) : null;
}

function byId(db, id) {
  return parse(db.prepare("SELECT data FROM search_executions WHERE id = ?").get(id));
}

function normalizedIdList(value) {
  return Array.isArray(value) ? value.slice(0, 50).map((id) => String(id)) : undefined;
}

function normalizedError(error) {
  if (!error) return null;
  const failedIds = normalizedIdList(error.failedIds);
  const failedOffers = Array.isArray(error.failedOffers)
    ? error.failedOffers.slice(0, 50).map((offer) => ({
        id: offer?.id != null ? String(offer.id) : null,
        url: offer?.url ? String(offer.url).slice(0, 500) : null,
      }))
    : undefined;
  return {
    ...(error.code ? { code: String(error.code).slice(0, 120) } : {}),
    message: String(error.message || error).slice(0, 1000),
    // Bounded failed-offer recovery detail (CR-29 round 8): kept through
    // this normalization the same way sourcing-runs.mjs's own
    // normalizeError already keeps `failedIds`/`failedOffers` on the child
    // run, so a reload of the durable PARENT search execution can still
    // name which postings never made it into the DB after a failed lane.
    ...(failedIds ? { failedIds } : {}),
    ...(failedOffers ? { failedOffers } : {}),
  };
}

function derive(execution) {
  const lanes = Object.values(execution.lanes);
  const active = lanes.some((lane) => lane.status === "queued" || lane.status === "running");
  const completed = lanes.filter((lane) => lane.status === "completed").length;
  const failed = lanes.some((lane) => lane.status === "failed");
  const cancelled = lanes.some((lane) => lane.status === "cancelled");
  let status = "running";
  if (!active) {
    if (completed > 0) status = "completed";
    else if (failed) status = "failed";
    else status = "cancelled";
  }
  return {
    ...execution,
    status,
    partial: completed > 0 && (failed || cancelled),
    completedAt: active ? null : execution.completedAt || execution.updatedAt,
  };
}

function write(db, execution) {
  const data = JSON.stringify(execution);
  if (Buffer.byteLength(data, "utf8") > 65_536) {
    throw makeError("search execution status is too large", "SEARCH_EXECUTION_TOO_LARGE");
  }
  db.prepare(
    `INSERT INTO search_executions (id, data) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data`
  ).run(execution.id, data);
  return byId(db, execution.id);
}

export function searchExecutionEnsure({ repoRoot, env, id, deterministicRunId, now } = {}) {
  const normalizedId = executionId(id);
  const runId = String(deterministicRunId || "").trim();
  if (!runId) throw makeError("deterministicRunId is required", "BAD_REQUEST");
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const existing = byId(db, normalizedId);
    if (existing) return { ok: true, created: false, execution: existing };
    const at = timestamp(now);
    const execution = derive({
      id: normalizedId,
      kind: "manual-search",
      status: "running",
      partial: false,
      startedAt: at,
      updatedAt: at,
      completedAt: null,
      lanes: {
        deterministic: {
          status: "running",
          runId,
          summary: null,
          error: null,
        },
        aiWeb: {
          status: "queued",
          runId: null,
          summary: null,
          error: null,
        },
      },
    });
    return { ok: true, created: true, execution: write(db, execution) };
  });
}

export function searchExecutionGet({ repoRoot, env, id } = {}) {
  const normalizedId = executionId(id);
  const db = requireDb({ repoRoot, env });
  const execution = byId(db, normalizedId);
  if (!execution) throw makeError(`search execution not found: ${normalizedId}`, "NOT_FOUND");
  return { ok: true, execution };
}

export function searchExecutionSetLane({
  repoRoot,
  env,
  id,
  lane,
  status,
  runId,
  summary,
  error,
  reason,
  now,
} = {}) {
  const normalizedId = executionId(id);
  if (!new Set(["deterministic", "aiWeb"]).has(lane)) {
    throw makeError("lane must be deterministic or aiWeb", "BAD_REQUEST");
  }
  if (!LANE_STATUSES.has(status)) throw makeError("invalid search lane status", "BAD_REQUEST");
  if (lane === "deterministic" && status === "skipped") {
    throw makeError("deterministic search cannot be skipped", "BAD_REQUEST");
  }
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = byId(db, normalizedId);
    if (!current) throw makeError(`search execution not found: ${normalizedId}`, "NOT_FOUND");
    const previous = current.lanes[lane];
    if (TERMINAL.has(previous.status)) {
      if (previous.status === status) return { ok: true, execution: current };
      throw makeError(`search lane is already ${previous.status}: ${normalizedId}`, "CONFLICT");
    }
    const updatedAt = timestampAfter(now, current.updatedAt);
    const nextLane = {
      status,
      runId: String(runId || previous.runId || "").trim() || null,
      summary: summary == null ? previous.summary || null : clone(summary),
      error: normalizedError(error),
      ...(reason ? { reason: String(reason).slice(0, 120) } : {}),
    };
    const next = derive({
      ...clone(current),
      updatedAt,
      lanes: { ...clone(current.lanes), [lane]: nextLane },
    });
    if (!next.completedAt && next.status !== "running") next.completedAt = updatedAt;
    return { ok: true, execution: write(db, next) };
  });
}

export function searchExecutionListRecoverable({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  const rows = db
    .prepare(
      `SELECT data FROM search_executions
       WHERE status = 'running'
         AND ai_status IN ('queued', 'running')
       ORDER BY updated_at ASC, id ASC`
    )
    .all();
  return { ok: true, executions: rows.map(parse) };
}
