// verbs/company-discovery.mjs — DB-owned pending company discovery proposals.
//
// Proposal generation is not a tracker-visible mutation: it stores confirm-first
// review state only. Confirmed source-config and sourced-row writes live in later
// decision verbs.
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";

function assertBatch(batch) {
  if (!batch || typeof batch !== "object") {
    const err = new Error("company proposal batch is required");
    err.code = "BAD_REQUEST";
    throw err;
  }
  if (!String(batch.batchId || "").trim()) {
    const err = new Error("company proposal batch requires batchId");
    err.code = "BAD_REQUEST";
    throw err;
  }
}

function readBatch(row) {
  return row ? JSON.parse(row.data) : null;
}

export function companyProposalBatchPut({ repoRoot, env, batch } = {}) {
  assertBatch(batch);
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO company_discovery_proposals (id, data, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
    ).run(String(batch.batchId), JSON.stringify(batch), now);
    return { ok: true, batch: readBatchById(db, batch.batchId) };
  });
}

export function companyProposalBatchLatest({ repoRoot, env, status = "pending" } = {}) {
  const db = requireDb({ repoRoot, env });
  const row = db
    .prepare(
      `SELECT data FROM company_discovery_proposals
       WHERE (? IS NULL OR status = ?)
       ORDER BY updated_at DESC
       LIMIT 1`
    )
    .get(status, status);
  return { ok: true, batch: readBatch(row) };
}

function readBatchById(db, batchId) {
  return readBatch(
    db.prepare("SELECT data FROM company_discovery_proposals WHERE id = ?").get(String(batchId))
  );
}
