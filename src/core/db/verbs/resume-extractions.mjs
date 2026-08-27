import { randomUUID } from "node:crypto";
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";
import { applyCandidateResumeSeedInDb } from "./candidate.mjs";
import { runVerb } from "./shared.mjs";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

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

function parseRow(row) {
  return row ? JSON.parse(row.data) : null;
}

function operationById(db, id) {
  return parseRow(db.prepare("SELECT data FROM resume_extractions WHERE id = ?").get(id));
}

function latestByDigest(db, uploadDigest) {
  return parseRow(
    db
      .prepare(
        `SELECT data FROM resume_extractions
         WHERE upload_digest = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`
      )
      .get(uploadDigest)
  );
}

function latest(db) {
  return parseRow(
    db
      .prepare(
        `SELECT data FROM resume_extractions
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`
      )
      .get()
  );
}

function put(db, operation) {
  db.prepare(
    `INSERT INTO resume_extractions (id, data) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET data=excluded.data`
  ).run(operation.id, JSON.stringify(operation));
  return operationById(db, operation.id);
}

function nowAfter(previous) {
  const now = Date.now();
  const previousMs = Date.parse(previous || "");
  return new Date(
    Number.isFinite(previousMs) && now <= previousMs ? previousMs + 1 : now
  ).toISOString();
}

function assertOwnedActive(db, id, ownerId) {
  const operation = operationById(db, required(id, "id"));
  if (!operation) throw makeError(`resume extraction not found: ${id}`, "NOT_FOUND");
  if (!ACTIVE_STATUSES.has(operation.status)) {
    throw makeError(`resume extraction is no longer active: ${id}`, "RESUME_EXTRACTION_INACTIVE");
  }
  if (operation.ownerId !== required(ownerId, "ownerId")) {
    throw makeError(`resume extraction is owned by another app process: ${id}`, "STALE_WRITE");
  }
  return operation;
}

export function resumeExtractionStart({
  repoRoot,
  env,
  uploadDigest,
  uploadPath,
  filename,
  executionPlan,
  ownerId,
} = {}) {
  const digest = required(uploadDigest, "uploadDigest");
  const path = required(uploadPath, "uploadPath");
  const owner = required(ownerId, "ownerId");
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const previous = latestByDigest(db, digest);
    if (
      previous?.status === "completed" ||
      (ACTIVE_STATUSES.has(previous?.status) && previous.ownerId === owner)
    ) {
      return { ok: true, reused: true, operation: previous };
    }
    const now = new Date().toISOString();
    const operation = put(db, {
      id: `resume-extraction-${randomUUID()}`,
      uploadDigest: digest,
      uploadPath: path,
      filename: required(filename, "filename"),
      status: "queued",
      ownerId: owner,
      executionPlan: clone(previous?.executionPlan || executionPlan),
      progress: { phase: "queued", message: "Resume saved. Waiting to read it." },
      lease: { heartbeatAt: now },
      result: null,
      error: null,
      retryOf: previous?.id || null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    });
    return { ok: true, reused: false, operation };
  });
}

export function resumeExtractionGet({ repoRoot, env, id, uploadDigest } = {}) {
  const db = requireDb({ repoRoot, env });
  const operation = id
    ? operationById(db, required(id, "id"))
    : uploadDigest
      ? latestByDigest(db, required(uploadDigest, "uploadDigest"))
      : latest(db);
  if (!operation && id) throw makeError(`resume extraction not found: ${id}`, "NOT_FOUND");
  return { ok: true, operation };
}

export function resumeExtractionProgress({ repoRoot, env, id, ownerId, progress } = {}) {
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = assertOwnedActive(db, id, ownerId);
    const now = nowAfter(current.updatedAt);
    const operation = put(db, {
      ...current,
      status: "running",
      startedAt: current.startedAt || now,
      progress: { ...(current.progress || {}), ...(clone(progress) || {}) },
      lease: { heartbeatAt: now },
      updatedAt: now,
    });
    return { ok: true, operation };
  });
}

export function resumeExtractionComplete({
  repoRoot,
  env,
  id,
  ownerId,
  artifact,
  result,
  ai,
  manual,
} = {}) {
  return runVerb(
    { repoRoot, env },
    (db) => {
      const current = operationById(db, required(id, "id"));
      if (current?.status === "completed") return { operation: current, reused: true };
      assertOwnedActive(db, id, ownerId);
      const savedResult = clone(result) || {};
      db.prepare(
        `INSERT INTO candidate_artifacts (id, kind, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, data=excluded.data, updated_at=excluded.updated_at`
      ).run(
        "source-resume",
        "source-resume",
        JSON.stringify(artifact || {}),
        new Date().toISOString()
      );
      const candidate = applyCandidateResumeSeedInDb(db, savedResult);
      const now = nowAfter(current.updatedAt);
      const operation = put(db, {
        ...current,
        status: "completed",
        progress: { phase: "completed", message: "Resume added to your profile." },
        lease: { heartbeatAt: now },
        result: savedResult,
        ai: clone(ai),
        manual: clone(manual),
        error: null,
        completedAt: now,
        updatedAt: now,
      });
      return { operation, candidate, reused: false };
    },
    { requireExistingTracker: true }
  );
}

export function resumeExtractionFail({ repoRoot, env, id, ownerId, error } = {}) {
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = operationById(db, required(id, "id"));
    if (!current) throw makeError(`resume extraction not found: ${id}`, "NOT_FOUND");
    if (TERMINAL_STATUSES.has(current.status))
      return { ok: true, operation: current, reused: true };
    assertOwnedActive(db, id, ownerId);
    const now = nowAfter(current.updatedAt);
    const operation = put(db, {
      ...current,
      status: "failed",
      progress: { phase: "failed", message: "CareerRat stopped reading this resume." },
      lease: { heartbeatAt: now },
      result: null,
      error: {
        code: String(error?.code || "RESUME_EXTRACTION_FAILED"),
        message: String(error?.message || "CareerRat couldn't read that resume. Try again."),
        retryable: error?.retryable !== false,
      },
      completedAt: now,
      updatedAt: now,
    });
    return { ok: true, operation, reused: false };
  });
}

export function resumeExtractionRecoverOrphans({ repoRoot, env, ownerId } = {}) {
  const owner = required(ownerId, "ownerId");
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const rows = db
      .prepare("SELECT data FROM resume_extractions WHERE status IN ('queued', 'running')")
      .all();
    const recovered = [];
    for (const row of rows) {
      const current = parseRow(row);
      if (current.ownerId === owner) continue;
      const now = nowAfter(current.updatedAt);
      recovered.push(
        put(db, {
          ...current,
          status: "failed",
          progress: {
            phase: "failed",
            message: "CareerRat stopped before it finished reading this resume.",
          },
          error: {
            code: "RESUME_EXTRACTION_SERVER_STOPPED",
            message: "CareerRat stopped before it finished reading this resume. Try it again.",
            retryable: true,
          },
          completedAt: now,
          updatedAt: now,
        })
      );
    }
    return { ok: true, recovered };
  });
}
