// verbs/sourcing-runs.mjs — durable state for deterministic sourcing/search runs.
import { randomUUID } from "node:crypto";
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";

export const SOURCING_RUN_STATUSES = Object.freeze({
  NOT_STARTED: "not_started",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
});

const PURPOSES = new Set(["first-search", "manual-search", "ai-web-search"]);
const TERMINAL_STATUSES = new Set([SOURCING_RUN_STATUSES.COMPLETED, SOURCING_RUN_STATUSES.FAILED]);
const SOURCING_RUN_LEASE_MS = 10 * 60 * 1000;

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertPurpose(purpose) {
  const normalized = String(purpose || "").trim();
  if (!PURPOSES.has(normalized)) {
    throw makeError(
      'sourcing run purpose must be "first-search", "manual-search", or "ai-web-search"',
      "BAD_REQUEST"
    );
  }
  return normalized;
}

function assertRunId(id, caller) {
  const normalized = String(id || "").trim();
  if (!normalized) {
    throw makeError(`${caller} requires id`, "BAD_REQUEST");
  }
  return normalized;
}

function parseStoredRow(row) {
  if (!row) return null;
  return JSON.parse(row.data);
}

function parseJsonRow(row) {
  return normalizeRun(parseStoredRow(row));
}

function normalizeRun(data) {
  if (!data) return null;
  const run = clone(data);
  return {
    ...run,
    startedAt: run.started_at ?? null,
    completedAt: run.completed_at ?? null,
    updatedAt: run.updated_at ?? null,
  };
}

function latestRunForPurpose(db, purpose) {
  return parseJsonRow(
    db
      .prepare(
        `SELECT data FROM sourcing_runs
         WHERE purpose = ?
         ORDER BY updated_at DESC, started_at DESC, id DESC
         LIMIT 1`
      )
      .get(purpose)
  );
}

function runById(db, id) {
  return parseJsonRow(db.prepare("SELECT data FROM sourcing_runs WHERE id = ?").get(id));
}

function storedRunById(db, id) {
  return parseStoredRow(db.prepare("SELECT data FROM sourcing_runs WHERE id = ?").get(id));
}

function makeRunId(purpose) {
  return `${purpose}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function nextTimestampIso(afterIso) {
  const nowMs = Date.now();
  const afterMs = Date.parse(afterIso || "");
  const chosenMs = Number.isFinite(afterMs) && nowMs <= afterMs ? afterMs + 1 : nowMs;
  return new Date(chosenMs).toISOString();
}

function normalizeMetadata({ metadata, trigger, retryOf, recoveredFrom, inputFingerprint } = {}) {
  const data =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? clone(metadata) : {};
  if (typeof trigger === "string" && trigger.trim()) {
    data.trigger = trigger.trim();
  }
  if (retryOf) {
    data.retryOf = String(retryOf);
  }
  if (recoveredFrom) {
    data.recoveredFrom = String(recoveredFrom);
  }
  if (inputFingerprint) {
    data.inputFingerprint = String(inputFingerprint);
  }
  return data;
}

function normalizeError(error) {
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const result = {
      code: String(error.code || "SOURCING_RUN_FAILED"),
      message: String(error.message || "Sourcing run failed."),
    };
    if (typeof error.action === "string" && error.action.trim()) {
      result.action = error.action.trim();
    }
    for (const key of ["failedPromptIds", "failedIds", "queryResults", "sources", "errors"]) {
      if (Array.isArray(error[key])) result[key] = clone(error[key]);
    }
    return result;
  }
  return {
    code: "SOURCING_RUN_FAILED",
    message: String(error || "Sourcing run failed."),
  };
}

function insertRun(db, run) {
  db.prepare("INSERT INTO sourcing_runs (id, data) VALUES (?, ?)").run(run.id, JSON.stringify(run));
  return runById(db, run.id);
}

function updateRun(db, run) {
  db.prepare("UPDATE sourcing_runs SET data = ? WHERE id = ?").run(JSON.stringify(run), run.id);
  return runById(db, run.id);
}

export function assertSourcingRunActiveInDb(db, id) {
  const runId = assertRunId(id, "assertSourcingRunActiveInDb");
  const current = storedRunById(db, runId);
  if (!current) {
    throw makeError(`sourcing run not found: ${runId}`, "NOT_FOUND");
  }
  const latest = latestRunForPurpose(db, current.purpose);
  if (current.status !== SOURCING_RUN_STATUSES.RUNNING || latest?.id !== runId) {
    const code =
      current.error?.code === "SOURCING_RUN_SUPERSEDED"
        ? "SOURCING_RUN_SUPERSEDED"
        : "SOURCING_RUN_INACTIVE";
    throw makeError(`sourcing run is no longer active: ${runId}`, code);
  }
  return current;
}

export function sourcingRunAssertActive({ repoRoot, env, id } = {}) {
  const db = requireDb({ repoRoot, env });
  return { ok: true, run: clone(assertSourcingRunActiveInDb(db, id)) };
}

function inputFingerprint(run) {
  return String(run?.metadata?.inputFingerprint || "").trim();
}

function sameInputs(run, requestedFingerprint) {
  const requested = String(requestedFingerprint || "").trim();
  if (!requested) return true;
  return inputFingerprint(run) === requested;
}

function runningLeaseExpired(run, nowMs = Date.now()) {
  const updatedMs = Date.parse(run?.updated_at || "");
  return Number.isFinite(updatedMs) && nowMs - updatedMs > SOURCING_RUN_LEASE_MS;
}

function failRun(db, current, error, { preserveUpdatedAt = false } = {}) {
  const now = nextTimestampIso(current.updated_at);
  return updateRun(db, {
    ...clone(current),
    status: SOURCING_RUN_STATUSES.FAILED,
    completed_at: now,
    updated_at: preserveUpdatedAt ? current.updated_at : now,
    summary: null,
    error: normalizeError(error),
  });
}

function recoverExpiredRunForRead(db, run) {
  if (run?.status !== SOURCING_RUN_STATUSES.RUNNING || !runningLeaseExpired(run)) return run;
  return failRun(
    db,
    run,
    {
      code: "SOURCING_RUN_LEASE_EXPIRED",
      message: "The previous sourcing run stopped reporting progress and was recovered.",
    },
    { preserveUpdatedAt: true }
  );
}

export function sourcingRunLatest({ repoRoot, env, purpose = "first-search" } = {}) {
  const normalizedPurpose = assertPurpose(purpose);
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const run = recoverExpiredRunForRead(db, latestRunForPurpose(db, normalizedPurpose));
    return {
      ok: true,
      purpose: normalizedPurpose,
      status: run?.status || SOURCING_RUN_STATUSES.NOT_STARTED,
      run,
    };
  });
}

export function sourcingRunRecoverRunning({ repoRoot, env, purpose = "first-search" } = {}) {
  const normalizedPurpose = assertPurpose(purpose);
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const run = latestRunForPurpose(db, normalizedPurpose);
    if (run?.status !== SOURCING_RUN_STATUSES.RUNNING) {
      return { ok: true, recovered: false, run };
    }
    const now = nextTimestampIso(run.updated_at);
    const recovered = updateRun(db, {
      ...clone(run),
      updated_at: now,
      metadata: {
        ...(run.metadata && typeof run.metadata === "object" ? clone(run.metadata) : {}),
        recoveredAt: now,
        recoveryCount: Number(run.metadata?.recoveryCount || 0) + 1,
      },
    });
    return { ok: true, recovered: true, run: recovered };
  });
}

export function sourcingRunGet({ repoRoot, env, id, purpose } = {}) {
  const runId = assertRunId(id, "sourcingRunGet");
  const normalizedPurpose = purpose == null ? null : assertPurpose(purpose);
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    let run = runById(db, runId);
    if (!run) {
      throw makeError(`sourcing run not found: ${runId}`, "NOT_FOUND");
    }
    if (normalizedPurpose && run.purpose !== normalizedPurpose) {
      throw makeError(
        `sourcing run ${runId} does not belong to ${normalizedPurpose}`,
        "BAD_REQUEST"
      );
    }
    run = recoverExpiredRunForRead(db, run);
    return {
      ok: true,
      purpose: run.purpose,
      status: run.status,
      run,
    };
  });
}

export function sourcingRunStart({
  repoRoot,
  env,
  purpose = "first-search",
  id,
  metadata,
  inputFingerprint,
  retryFailed = false,
  trigger,
} = {}) {
  const normalizedPurpose = assertPurpose(purpose);
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    let latest = latestRunForPurpose(db, normalizedPurpose);
    let recoveredFrom = null;
    if (latest?.status === SOURCING_RUN_STATUSES.RUNNING) {
      if (runningLeaseExpired(latest)) {
        recoveredFrom = latest.id;
        latest = failRun(db, latest, {
          code: "SOURCING_RUN_LEASE_EXPIRED",
          message: "The previous sourcing run stopped reporting progress and was recovered.",
        });
      } else if (sameInputs(latest, inputFingerprint)) {
        return { ok: true, reused: true, run: latest };
      } else {
        latest = failRun(db, latest, {
          code: "SOURCING_RUN_SUPERSEDED",
          message: "The sourcing inputs changed while this run was active.",
        });
      }
    }
    if (normalizedPurpose === "first-search") {
      if (
        latest?.status === SOURCING_RUN_STATUSES.COMPLETED &&
        sameInputs(latest, inputFingerprint)
      ) {
        return { ok: true, reused: true, run: latest };
      }
      if (
        latest?.status === SOURCING_RUN_STATUSES.FAILED &&
        retryFailed !== true &&
        sameInputs(latest, inputFingerprint) &&
        latest.id !== recoveredFrom
      ) {
        return { ok: true, reused: true, run: latest };
      }
    }

    const runId = id == null ? makeRunId(normalizedPurpose) : assertRunId(id, "sourcingRunStart");
    if (storedRunById(db, runId)) {
      throw makeError(`sourcing run id already exists: ${runId}`, "CONFLICT");
    }
    const now = nextTimestampIso(latest?.updated_at);
    const run = {
      id: runId,
      purpose: normalizedPurpose,
      status: SOURCING_RUN_STATUSES.RUNNING,
      started_at: now,
      completed_at: null,
      updated_at: now,
      metadata: normalizeMetadata({
        metadata,
        trigger,
        inputFingerprint,
        recoveredFrom,
        retryOf:
          normalizedPurpose === "first-search" &&
          retryFailed === true &&
          latest?.status === SOURCING_RUN_STATUSES.FAILED
            ? latest.id
            : null,
      }),
      summary: null,
      error: null,
    };
    return { ok: true, reused: false, run: insertRun(db, run) };
  });
}

export function sourcingRunComplete({ repoRoot, env, id, summary } = {}) {
  const runId = assertRunId(id, "sourcingRunComplete");
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = storedRunById(db, runId);
    if (!current) {
      throw makeError(`sourcing run not found: ${runId}`, "NOT_FOUND");
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      throw makeError(`sourcing run is already ${current.status}: ${runId}`, "CONFLICT");
    }
    const now = nextTimestampIso(current.updated_at);
    const next = {
      ...clone(current),
      status: SOURCING_RUN_STATUSES.COMPLETED,
      completed_at: now,
      updated_at: now,
      summary: clone(summary || {}),
      error: null,
    };
    return { ok: true, run: updateRun(db, next) };
  });
}

export function sourcingRunProgress({ repoRoot, env, id, progress } = {}) {
  const runId = assertRunId(id, "sourcingRunProgress");
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) {
    throw makeError("sourcingRunProgress requires a progress object", "BAD_REQUEST");
  }
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = storedRunById(db, runId);
    if (!current) {
      throw makeError(`sourcing run not found: ${runId}`, "NOT_FOUND");
    }
    if (current.status !== SOURCING_RUN_STATUSES.RUNNING) {
      throw makeError(`sourcing run is already ${current.status}: ${runId}`, "CONFLICT");
    }
    const now = nextTimestampIso(current.updated_at);
    const next = {
      ...clone(current),
      updated_at: now,
      progress: {
        ...(current.progress && typeof current.progress === "object"
          ? clone(current.progress)
          : {}),
        ...clone(progress),
      },
    };
    return { ok: true, run: updateRun(db, next) };
  });
}

export function sourcingRunFail({ repoRoot, env, id, error } = {}) {
  const runId = assertRunId(id, "sourcingRunFail");
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = storedRunById(db, runId);
    if (!current) {
      throw makeError(`sourcing run not found: ${runId}`, "NOT_FOUND");
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      throw makeError(`sourcing run is already ${current.status}: ${runId}`, "CONFLICT");
    }
    return { ok: true, run: failRun(db, current, error) };
  });
}
