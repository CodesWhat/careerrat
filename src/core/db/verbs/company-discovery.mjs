// verbs/company-discovery.mjs — DB-owned company discovery cache/proposals.
//
// Proposal generation is not a tracker-visible mutation: it stores resolver
// cache and confirm-first review state only. Confirmed source-config and
// sourced-row writes live in later decision verbs.
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";

const RESOLUTION_CACHE_TTL_DAYS = 14;
const RESOLUTION_FAILURE_REFRESH_THRESHOLD = 2;
const ZERO_JOB_REFRESH_THRESHOLD = 2;

const SCAN_STATUS_REFRESH_REASONS = new Set([
  "http-403",
  "http-404",
  "failed-extraction",
  "provider-change",
  "redirect-provider-change",
]);

const DUE_REASON_PRIORITY = new Map([
  ["resolver-failure-threshold", 10],
  ["failed-extraction", 20],
  ["http-403", 30],
  ["http-404", 40],
  ["provider-change", 50],
  ["redirect-provider-change", 60],
  ["stale-ttl", 70],
  ["explicit-refresh", 80],
  ["zero-jobs-threshold", 90],
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseJsonRow(row) {
  return row ? JSON.parse(row.data) : null;
}

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertResolution(resolution) {
  if (!resolution || typeof resolution !== "object") {
    throw makeError("company board resolution is required", "BAD_REQUEST");
  }
  if (!String(resolution.company_key || "").trim()) {
    throw makeError("company board resolution requires company_key", "BAD_REQUEST");
  }
}

function assertBatch(batch) {
  if (!batch || typeof batch !== "object") {
    throw makeError("company proposal batch is required", "BAD_REQUEST");
  }
  if (!String(batch.batchId || "").trim()) {
    throw makeError("company proposal batch requires batchId", "BAD_REQUEST");
  }
}

function normalizeNow(now) {
  if (now instanceof Date) return now;
  if (typeof now === "string" || typeof now === "number") return new Date(now);
  return new Date();
}

function staleCutoffIso(now) {
  const cutoff = new Date(normalizeNow(now).getTime());
  cutoff.setUTCDate(cutoff.getUTCDate() - RESOLUTION_CACHE_TTL_DAYS);
  return cutoff.toISOString();
}

function scanRefreshReason(resolution) {
  const scanStatus = String(resolution?.last_scan_result?.status || resolution?.status || "");
  return SCAN_STATUS_REFRESH_REASONS.has(scanStatus) ? scanStatus : null;
}

function resolutionDueReason(resolution, now) {
  if (resolution.next_refresh_reason) return String(resolution.next_refresh_reason);
  if (Number(resolution.failure_count || 0) >= RESOLUTION_FAILURE_REFRESH_THRESHOLD) {
    return "resolver-failure-threshold";
  }
  const scanReason = scanRefreshReason(resolution);
  if (scanReason) return scanReason;
  if (String(resolution.last_verified_at || "") < staleCutoffIso(now)) return "stale-ttl";
  if (Number(resolution.zero_job_count || 0) >= ZERO_JOB_REFRESH_THRESHOLD) {
    return "zero-jobs-threshold";
  }
  return null;
}

function duePriority(resolution) {
  return DUE_REASON_PRIORITY.get(resolution.due_reason) ?? 1000;
}

function readResolutionByCompanyKey(db, companyKey) {
  return parseJsonRow(
    db
      .prepare("SELECT data FROM company_board_resolutions WHERE company_key = ?")
      .get(String(companyKey))
  );
}

function readBatchById(db, batchId) {
  return parseJsonRow(
    db.prepare("SELECT data FROM company_discovery_proposals WHERE id = ?").get(String(batchId))
  );
}

export function companyBoardResolutionUpsert({ repoRoot, env, resolution } = {}) {
  assertResolution(resolution);
  const db = requireDb({ repoRoot, env });
  const data = clone(resolution);
  return withTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO company_board_resolutions (id, data, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
    ).run(String(data.company_key), JSON.stringify(data), now);
    return { ok: true, resolution: readResolutionByCompanyKey(db, data.company_key) };
  });
}

export function companyBoardResolutionGet({ repoRoot, env, companyKey, companyDomain } = {}) {
  const db = requireDb({ repoRoot, env });
  let row;
  if (String(companyKey || "").trim()) {
    row = db
      .prepare("SELECT data FROM company_board_resolutions WHERE company_key = ?")
      .get(String(companyKey));
  } else if (String(companyDomain || "").trim()) {
    row = db
      .prepare("SELECT data FROM company_board_resolutions WHERE company_domain = ?")
      .get(String(companyDomain));
  } else {
    throw makeError(
      "companyBoardResolutionGet requires companyKey or companyDomain",
      "BAD_REQUEST"
    );
  }
  return { ok: true, resolution: parseJsonRow(row) };
}

export function companyBoardResolutionListDue({ repoRoot, env, now = new Date() } = {}) {
  const db = requireDb({ repoRoot, env });
  const cutoff = staleCutoffIso(now);
  const rows = db
    .prepare(
      `SELECT data FROM company_board_resolutions
       WHERE next_refresh_reason IS NOT NULL
          OR failure_count >= ?
          OR zero_job_count >= ?
          OR status IN ('http-403', 'http-404', 'failed-extraction', 'provider-change', 'redirect-provider-change')
          OR json_extract(data, '$.last_scan_result.status') IN ('http-403', 'http-404', 'failed-extraction', 'provider-change', 'redirect-provider-change')
          OR last_verified_at < ?
       ORDER BY company_key COLLATE NOCASE ASC`
    )
    .all(RESOLUTION_FAILURE_REFRESH_THRESHOLD, ZERO_JOB_REFRESH_THRESHOLD, cutoff);
  const resolutions = rows
    .map(parseJsonRow)
    .map((resolution) => ({ ...resolution, due_reason: resolutionDueReason(resolution, now) }))
    .filter((resolution) => resolution.due_reason)
    .sort((a, b) => duePriority(a) - duePriority(b) || a.company_key.localeCompare(b.company_key));
  return { ok: true, resolutions };
}

export function companyProposalBatchPut({ repoRoot, env, batch } = {}) {
  assertBatch(batch);
  const db = requireDb({ repoRoot, env });
  const data = clone(batch);
  return withTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO company_discovery_proposals (id, data, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
    ).run(String(data.batchId), JSON.stringify(data), now);
    return { ok: true, batch: readBatchById(db, data.batchId) };
  });
}

export function companyProposalBatchGet({ repoRoot, env, batchId } = {}) {
  if (!String(batchId || "").trim()) {
    throw makeError("companyProposalBatchGet requires batchId", "BAD_REQUEST");
  }
  const db = requireDb({ repoRoot, env });
  return { ok: true, batch: readBatchById(db, batchId) };
}

export function companyProposalBatchLatest({ repoRoot, env, status = "pending" } = {}) {
  const db = requireDb({ repoRoot, env });
  const row = db
    .prepare(
      `SELECT data FROM company_discovery_proposals
       WHERE (? IS NULL OR status = ?)
       ORDER BY created_at DESC, updated_at DESC
       LIMIT 1`
    )
    .get(status, status);
  return { ok: true, batch: parseJsonRow(row) };
}

export function companyProposalBatchPatchState({
  repoRoot,
  env,
  batchId,
  expectedVersion,
  status,
  patch = {},
} = {}) {
  if (!String(batchId || "").trim()) {
    throw makeError("companyProposalBatchPatchState requires batchId", "BAD_REQUEST");
  }
  if (!Number.isInteger(Number(expectedVersion))) {
    throw makeError("companyProposalBatchPatchState requires expectedVersion", "BAD_REQUEST");
  }
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = readBatchById(db, batchId);
    if (!current) {
      throw makeError(`company proposal batch not found: ${batchId}`, "NOT_FOUND");
    }
    const currentVersion = Number(current.version || 0);
    if (currentVersion !== Number(expectedVersion)) {
      throw makeError(
        `company proposal batch version conflict: expected ${expectedVersion}, found ${currentVersion}`,
        "CONFLICT"
      );
    }
    const next = {
      ...clone(current),
      ...clone(patch),
      ...(status ? { status } : {}),
      version: currentVersion + 1,
    };
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE company_discovery_proposals
       SET data = ?, updated_at = ?
       WHERE id = ?`
    ).run(JSON.stringify(next), now, String(batchId));
    return { ok: true, batch: readBatchById(db, batchId) };
  });
}
