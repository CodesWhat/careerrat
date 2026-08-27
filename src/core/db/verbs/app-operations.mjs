import { randomUUID } from "node:crypto";
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";

export const APP_OPERATION_STATUSES = Object.freeze(["queued", "running", "completed", "failed"]);

export const APP_OPERATION_LIMITS = Object.freeze({
  request: 65_536,
  executionPlan: 16_384,
  progress: 8_192,
  resultRef: 8_192,
  error: 4_096,
});

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const DIGEST_RE = /^[a-f0-9]{64}$/;

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function required(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw makeError(`${field} is required`, "BAD_REQUEST");
  return normalized;
}

function positiveInteger(value, field) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw makeError(`${field} must be a positive integer`, "BAD_REQUEST");
  }
  return normalized;
}

function timestamp(value = new Date().toISOString()) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw makeError("now must be an ISO timestamp", "BAD_REQUEST");
  return new Date(parsed).toISOString();
}

function timestampAfter(value, previous) {
  const nextMs = Date.parse(timestamp(value));
  const previousMs = Date.parse(previous || "");
  return new Date(
    Number.isFinite(previousMs) && nextMs <= previousMs ? previousMs + 1 : nextMs
  ).toISOString();
}

function leaseExpiry(now, leaseMs) {
  const duration = Number(leaseMs ?? 90_000);
  if (!Number.isFinite(duration) || duration < 1) {
    throw makeError("leaseMs must be a positive number", "BAD_REQUEST");
  }
  return new Date(Date.parse(now) + duration).toISOString();
}

function jsonText(value, field, maxBytes, { nullable = false } = {}) {
  if (value == null) {
    if (nullable) return null;
    throw makeError(`${field} is required`, "BAD_REQUEST");
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw makeError(`${field} must be valid JSON`, "BAD_REQUEST");
  }
  if (serialized === undefined) throw makeError(`${field} must be valid JSON`, "BAD_REQUEST");
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw makeError(`${field} is too large`, "APP_OPERATION_PAYLOAD_TOO_LARGE");
  }
  return serialized;
}

function truncateUtf8(value, maxBytes) {
  let output = String(value || "");
  while (Buffer.byteLength(output, "utf8") > maxBytes) {
    const bytes = Buffer.byteLength(output, "utf8");
    const nextLength = Math.max(0, Math.floor((output.length * maxBytes) / bytes) - 1);
    output = output.slice(0, nextLength);
  }
  return output;
}

function parseJson(value) {
  return value == null ? null : JSON.parse(value);
}

function readOperation(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    requestDigest: row.request_digest,
    request: parseJson(row.request),
    status: row.status,
    ownerId: row.owner_id,
    fence: row.fence,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    executionPlan: parseJson(row.execution_plan),
    progress: parseJson(row.progress),
    resultRef: parseJson(row.result_ref),
    error: parseJson(row.error),
    retryOf: row.retry_of,
    attempt: row.attempt,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_OPERATION = `
  SELECT id, kind, request_digest, request, status, owner_id, fence,
         heartbeat_at, lease_expires_at, execution_plan, progress,
         result_ref, error, retry_of, attempt, created_at, started_at,
         completed_at, updated_at
  FROM app_operations`;

function operationById(db, id) {
  return readOperation(db.prepare(`${SELECT_OPERATION} WHERE id = ?`).get(id));
}

function latestByRequest(db, kind, requestDigest) {
  return readOperation(
    db
      .prepare(
        `${SELECT_OPERATION}
         WHERE kind = ? AND request_digest = ?
         ORDER BY attempt DESC, updated_at DESC, id DESC
         LIMIT 1`
      )
      .get(kind, requestDigest)
  );
}

function retryByParent(db, id) {
  return readOperation(
    db
      .prepare(
        `${SELECT_OPERATION}
         WHERE retry_of = ?
         ORDER BY attempt DESC, updated_at DESC, id DESC
         LIMIT 1`
      )
      .get(id)
  );
}

function insertOperation(db, operation) {
  db.prepare(
    `INSERT INTO app_operations (
       id, kind, request_digest, request, status, owner_id, fence,
       heartbeat_at, lease_expires_at, execution_plan, progress,
       result_ref, error, retry_of, attempt, created_at, started_at,
       completed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    operation.id,
    operation.kind,
    operation.requestDigest,
    jsonText(operation.request, "request", APP_OPERATION_LIMITS.request),
    operation.status,
    operation.ownerId,
    operation.fence,
    operation.heartbeatAt,
    operation.leaseExpiresAt,
    jsonText(operation.executionPlan, "executionPlan", APP_OPERATION_LIMITS.executionPlan, {
      nullable: true,
    }),
    jsonText(operation.progress, "progress", APP_OPERATION_LIMITS.progress, { nullable: true }),
    jsonText(operation.resultRef, "resultRef", APP_OPERATION_LIMITS.resultRef, { nullable: true }),
    jsonText(operation.error, "error", APP_OPERATION_LIMITS.error, { nullable: true }),
    operation.retryOf,
    operation.attempt,
    operation.createdAt,
    operation.startedAt,
    operation.completedAt,
    operation.updatedAt
  );
  return operationById(db, operation.id);
}

function updateOperation(db, operation) {
  db.prepare(
    `UPDATE app_operations
     SET status = ?, owner_id = ?, fence = ?, heartbeat_at = ?, lease_expires_at = ?,
         execution_plan = ?, progress = ?, result_ref = ?, error = ?, started_at = ?,
         completed_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    operation.status,
    operation.ownerId,
    operation.fence,
    operation.heartbeatAt,
    operation.leaseExpiresAt,
    jsonText(operation.executionPlan, "executionPlan", APP_OPERATION_LIMITS.executionPlan, {
      nullable: true,
    }),
    jsonText(operation.progress, "progress", APP_OPERATION_LIMITS.progress, { nullable: true }),
    jsonText(operation.resultRef, "resultRef", APP_OPERATION_LIMITS.resultRef, { nullable: true }),
    jsonText(operation.error, "error", APP_OPERATION_LIMITS.error, { nullable: true }),
    operation.startedAt,
    operation.completedAt,
    operation.updatedAt,
    operation.id
  );
  return operationById(db, operation.id);
}

function assertOwnedActive(db, { id, ownerId, fence }) {
  const operation = operationById(db, required(id, "id"));
  if (!operation) throw makeError(`app operation not found: ${id}`, "NOT_FOUND");
  if (!ACTIVE_STATUSES.has(operation.status)) {
    throw makeError(`app operation is no longer active: ${id}`, "APP_OPERATION_INACTIVE");
  }
  if (
    operation.ownerId !== required(ownerId, "ownerId") ||
    operation.fence !== positiveInteger(fence, "fence")
  ) {
    throw makeError(`app operation is owned by another worker: ${id}`, "STALE_WRITE");
  }
  return operation;
}

function queuedOperation({
  kind,
  requestDigest,
  request,
  executionPlan,
  ownerId,
  fence,
  retryOf,
  attempt,
  leaseMs,
  now,
}) {
  const createdAt = timestamp(now);
  return {
    id: `app-operation-${randomUUID()}`,
    kind,
    requestDigest,
    request,
    status: "queued",
    ownerId,
    fence,
    heartbeatAt: createdAt,
    leaseExpiresAt: leaseExpiry(createdAt, leaseMs),
    executionPlan,
    progress: { phase: "queued", message: "CareerRat queued this work." },
    resultRef: null,
    error: null,
    retryOf,
    attempt,
    createdAt,
    startedAt: null,
    completedAt: null,
    updatedAt: createdAt,
  };
}

export function appOperationStart({
  repoRoot,
  env,
  kind,
  requestDigest,
  request,
  executionPlan = null,
  ownerId,
  leaseMs = 90_000,
  now,
} = {}) {
  const normalizedKind = required(kind, "kind");
  const digest = required(requestDigest, "requestDigest").toLowerCase();
  if (!DIGEST_RE.test(digest)) {
    throw makeError("requestDigest must be a lowercase SHA-256 digest", "BAD_REQUEST");
  }
  const owner = required(ownerId, "ownerId");
  jsonText(request, "request", APP_OPERATION_LIMITS.request);
  jsonText(executionPlan, "executionPlan", APP_OPERATION_LIMITS.executionPlan, { nullable: true });
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const existing = latestByRequest(db, normalizedKind, digest);
    if (existing) return { ok: true, reused: true, operation: existing };
    const operation = queuedOperation({
      kind: normalizedKind,
      requestDigest: digest,
      request,
      executionPlan,
      ownerId: owner,
      fence: 1,
      retryOf: null,
      attempt: 1,
      leaseMs,
      now,
    });
    return { ok: true, reused: false, operation: insertOperation(db, operation) };
  });
}

export function appOperationRetryStart({
  repoRoot,
  env,
  id,
  ownerId,
  executionPlan,
  leaseMs = 90_000,
  now,
} = {}) {
  const operationId = required(id, "id");
  const owner = required(ownerId, "ownerId");
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const previous = operationById(db, operationId);
    if (!previous) throw makeError(`app operation not found: ${operationId}`, "NOT_FOUND");
    const existingRetry = retryByParent(db, operationId);
    if (existingRetry) return { ok: true, reused: true, operation: existingRetry };
    if (previous.status !== "failed" || previous.error?.retryable !== true) {
      throw makeError(
        "only retryable failed app operations can be retried",
        "APP_OPERATION_NOT_RETRYABLE"
      );
    }
    const retry = queuedOperation({
      kind: previous.kind,
      requestDigest: previous.requestDigest,
      request: previous.request,
      executionPlan: executionPlan === undefined ? previous.executionPlan : executionPlan,
      ownerId: owner,
      fence: previous.fence + 1,
      retryOf: previous.id,
      attempt: previous.attempt + 1,
      leaseMs,
      now,
    });
    return { ok: true, reused: false, operation: insertOperation(db, retry) };
  });
}

export function appOperationGet({ repoRoot, env, id } = {}) {
  const operationId = required(id, "id");
  const operation = operationById(requireDb({ repoRoot, env }), operationId);
  if (!operation) throw makeError(`app operation not found: ${operationId}`, "NOT_FOUND");
  return { ok: true, operation };
}

export function appOperationProgress({
  repoRoot,
  env,
  id,
  ownerId,
  fence,
  progress,
  leaseMs = 90_000,
  now,
} = {}) {
  jsonText(progress, "progress", APP_OPERATION_LIMITS.progress);
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = assertOwnedActive(db, { id, ownerId, fence });
    const updatedAt = timestampAfter(now, current.updatedAt);
    return {
      ok: true,
      operation: updateOperation(db, {
        ...current,
        status: "running",
        heartbeatAt: updatedAt,
        leaseExpiresAt: leaseExpiry(updatedAt, leaseMs),
        progress,
        startedAt: current.startedAt || updatedAt,
        updatedAt,
      }),
    };
  });
}

export function appOperationHeartbeat({
  repoRoot,
  env,
  id,
  ownerId,
  fence,
  leaseMs = 90_000,
  now,
} = {}) {
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = assertOwnedActive(db, { id, ownerId, fence });
    const updatedAt = timestampAfter(now, current.updatedAt);
    return {
      ok: true,
      operation: updateOperation(db, {
        ...current,
        status: "running",
        heartbeatAt: updatedAt,
        leaseExpiresAt: leaseExpiry(updatedAt, leaseMs),
        startedAt: current.startedAt || updatedAt,
        updatedAt,
      }),
    };
  });
}

export function appOperationComplete({
  repoRoot,
  env,
  id,
  ownerId,
  fence,
  resultRef = null,
  now,
} = {}) {
  jsonText(resultRef, "resultRef", APP_OPERATION_LIMITS.resultRef, { nullable: true });
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const existing = operationById(db, required(id, "id"));
    if (!existing) throw makeError(`app operation not found: ${id}`, "NOT_FOUND");
    if (existing.status === "completed") return { ok: true, reused: true, operation: existing };
    const current = assertOwnedActive(db, { id, ownerId, fence });
    const completedAt = timestampAfter(now, current.updatedAt);
    return {
      ok: true,
      reused: false,
      operation: updateOperation(db, {
        ...current,
        status: "completed",
        heartbeatAt: completedAt,
        leaseExpiresAt: completedAt,
        progress: { phase: "completed", message: "CareerRat finished this work." },
        resultRef,
        error: null,
        completedAt,
        updatedAt: completedAt,
      }),
    };
  });
}

export function appOperationFail({ repoRoot, env, id, ownerId, fence, error, now } = {}) {
  const safeError = {
    code: truncateUtf8(required(error?.code || "APP_OPERATION_FAILED", "error.code"), 128),
    message: truncateUtf8(
      required(
        error?.message || "CareerRat couldn't finish this work. Try it again.",
        "error.message"
      ),
      3_500
    ),
    retryable: error?.retryable !== false,
  };
  jsonText(safeError, "error", APP_OPERATION_LIMITS.error);
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const existing = operationById(db, required(id, "id"));
    if (!existing) throw makeError(`app operation not found: ${id}`, "NOT_FOUND");
    if (!ACTIVE_STATUSES.has(existing.status)) {
      return { ok: true, reused: true, operation: existing };
    }
    const current = assertOwnedActive(db, { id, ownerId, fence });
    const completedAt = timestampAfter(now, current.updatedAt);
    return {
      ok: true,
      reused: false,
      operation: updateOperation(db, {
        ...current,
        status: "failed",
        heartbeatAt: completedAt,
        leaseExpiresAt: completedAt,
        progress: { phase: "failed", message: "CareerRat stopped before this work finished." },
        resultRef: null,
        error: safeError,
        completedAt,
        updatedAt: completedAt,
      }),
    };
  });
}

export function appOperationRecoverOrphans({ repoRoot, env, ownerId, now } = {}) {
  const owner = required(ownerId, "ownerId");
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const rows = db
      .prepare(`${SELECT_OPERATION} WHERE status IN ('queued', 'running') AND owner_id <> ?`)
      .all(owner)
      .map(readOperation);
    const recovered = [];
    for (const current of rows) {
      const completedAt = timestampAfter(now, current.updatedAt);
      recovered.push(
        updateOperation(db, {
          ...current,
          status: "failed",
          heartbeatAt: completedAt,
          leaseExpiresAt: completedAt,
          progress: {
            phase: "failed",
            message: "CareerRat restarted before this work finished.",
          },
          resultRef: null,
          error: {
            code: "APP_OPERATION_SERVER_RESTARTED",
            message: "CareerRat restarted before this work finished. Try it again.",
            retryable: true,
          },
          completedAt,
          updatedAt: completedAt,
        })
      );
    }
    return { ok: true, recovered };
  });
}
