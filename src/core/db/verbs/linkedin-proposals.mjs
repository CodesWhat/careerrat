// verbs/linkedin-proposals.mjs — DB-owned LinkedIn optimize proposal batches.
//
// Mirrors company-discovery.mjs's posture: proposal generation is not a
// tracker-visible mutation, so batch put/get/latest never bumpMeta or
// refreshAnalytics (no export-to-tracker mirror for this table either) — the
// optimize-linkedin skill's confirm-first review lives entirely here until an
// approved edit is actually written back to LinkedIn.
import { randomUUID } from "node:crypto";
import { findCompLeak, findCurrentBaseToken } from "../../profile/comp-guard.mjs";
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";

const DECIDE_ACTIONS = new Set(["approve", "reject", "applied"]);

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

function nowIso() {
  return new Date().toISOString();
}

function readBatchById(db, id) {
  return parseJsonRow(
    db.prepare("SELECT data FROM linkedin_profile_proposals WHERE id = ?").get(String(id))
  );
}

// Every surface must carry a unique, non-empty surfaceId (decide() below
// matches the FIRST surface with a given surfaceId, so a duplicate makes the
// second one undecidable) plus non-empty surface/proposed/rationale/
// evidenceRef strings. `current` is required to be a string too, but may be
// empty — an empty profile field ("no current headline yet") is legitimate.
function assertSurfaces(surfaces) {
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    throw makeError("linkedin proposal batch requires a non-empty surfaces array", "BAD_REQUEST");
  }
  const seenSurfaceIds = new Set();
  for (const surface of surfaces) {
    if (!surface || typeof surface !== "object") {
      throw makeError("linkedin proposal batch surfaces must be objects", "BAD_REQUEST");
    }
    if (typeof surface.surfaceId !== "string" || !surface.surfaceId.trim()) {
      throw makeError("linkedin proposal batch surface requires surfaceId", "BAD_REQUEST");
    }
    if (seenSurfaceIds.has(surface.surfaceId)) {
      throw makeError("linkedin proposal batch surfaceIds must be unique", "BAD_REQUEST");
    }
    seenSurfaceIds.add(surface.surfaceId);
    for (const field of ["surface", "proposed", "rationale", "evidenceRef"]) {
      if (typeof surface[field] !== "string" || !surface[field].trim()) {
        throw makeError(`linkedin proposal batch surface requires ${field}`, "BAD_REQUEST");
      }
    }
    if (typeof surface.current !== "string") {
      throw makeError(
        "linkedin proposal batch surface requires current to be a string",
        "BAD_REQUEST"
      );
    }
  }
}

// Guard every surface's current, proposed, AND rationale text against the
// private current-comp leak backstop (comp-guard.mjs) before ANY of the batch
// is persisted — a hit anywhere refuses the whole batch (all-or-nothing), so a
// candidate never ends up with nine clean surfaces and one leaking one. The
// `current` field is included on purpose: it is composed by the same agent
// that writes proposed/rationale, from a context that also holds private
// comp, so it carries the same mis-paste risk as the other two.
function assertNoCompLeak(surfaces) {
  for (const surface of surfaces) {
    for (const field of ["current", "proposed", "rationale"]) {
      const text = String(surface[field] || "");
      const leak = findCurrentBaseToken(text) || findCompLeak(text);
      if (leak) {
        throw makeError(
          `linkedin proposal batch refused: private compensation input detected in surface "${surface.surfaceId}" ${field} (current-comp leak guard)`,
          "LINKEDIN_PROPOSAL_COMP_LEAK"
        );
      }
    }
  }
}

// scanForCompLeak(text) -> leak match | null. Thin wrapper so every
// whole-payload backstop scan below (preflight, batchPut, decide) runs the
// same two checks in the same order.
function scanForCompLeak(text) {
  return findCurrentBaseToken(text) || findCompLeak(text);
}

// Whole-payload backstop: assertNoCompLeak only reads the three NAMED fields
// (current/proposed/rationale). An agent can still smuggle a leak in through
// any OTHER surface property (a stray "note", "context", debug field, etc.)
// that a caller adds beyond the documented shape — this scans the entire
// serialized payload so nothing outside the three named fields is a blind
// spot.
function assertNoCompLeakInPayload(value, message) {
  if (scanForCompLeak(JSON.stringify(value))) {
    throw makeError(message, "LINKEDIN_PROPOSAL_COMP_LEAK");
  }
}

// linkedinProposalBatchPreflight({batch}) -> throws on a malformed batch or a
// comp leak, otherwise returns undefined. Runs the exact validation
// linkedinProposalBatchPut runs before it ever touches the DB, but with no
// repoRoot/env/transaction — this is what lets the CLI's dry-run preview
// (--data without --write) refuse a leaking payload BEFORE printing it,
// instead of only catching the leak once someone passes --write.
export function linkedinProposalBatchPreflight({ batch } = {}) {
  if (!batch || typeof batch !== "object") {
    throw makeError("linkedinProposalBatchPut requires a batch", "BAD_REQUEST");
  }
  assertSurfaces(batch.surfaces);
  assertNoCompLeak(batch.surfaces);
  assertNoCompLeakInPayload(
    batch.surfaces,
    "linkedin proposal batch refused: private compensation input detected in batch payload (current-comp leak guard)"
  );
}

// linkedinProposalBatchPut({repoRoot, env, batch}) -> {id, meta}. Assigns an
// id when missing, stores a fresh review-state batch (status "pending",
// version 1, every surface's decision reset to null) — this is always a
// whole-batch CREATE, never a partial patch (decide() below owns per-surface
// state transitions on an already-stored batch). Real callers never supply
// batch.id (the id is server-generated); a caller-supplied id (test seeds)
// upserts and deliberately resets any prior decisions to the fresh state.
export function linkedinProposalBatchPut({ repoRoot, env, batch } = {}) {
  linkedinProposalBatchPreflight({ batch });

  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const id = String(batch.id || `linkedin_proposal_${randomUUID()}`);
    const createdAt = nowIso();
    const data = {
      id,
      status: "pending",
      createdAt,
      version: 1,
      surfaces: clone(batch.surfaces).map((surface) => ({ ...surface, decision: null })),
    };
    // Second backstop pass over the actual row shape (id/status/createdAt
    // included, not just batch.surfaces) — cheap, runs once per write, right
    // before the INSERT lands inside the transaction so a hit here rolls
    // back cleanly.
    assertNoCompLeakInPayload(
      data,
      "linkedin proposal batch refused: private compensation input detected in batch payload (current-comp leak guard)"
    );
    db.prepare(
      `INSERT INTO linkedin_profile_proposals (id, data, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
    ).run(id, JSON.stringify(data), createdAt);
    return { id, meta: { version: data.version, createdAt } };
  });
}

// linkedinProposalBatchGet({repoRoot, env, id}) -> batch | null
export function linkedinProposalBatchGet({ repoRoot, env, id } = {}) {
  if (!String(id || "").trim()) {
    throw makeError("linkedinProposalBatchGet requires id", "BAD_REQUEST");
  }
  const db = requireDb({ repoRoot, env });
  return readBatchById(db, id);
}

// linkedinProposalBatchLatest({repoRoot, env, status = "pending"}) -> newest
// batch with that status, or null. `status: null` matches any status, same
// as companyProposalBatchLatest's IS NULL escape hatch.
export function linkedinProposalBatchLatest({ repoRoot, env, status = "pending" } = {}) {
  const db = requireDb({ repoRoot, env });
  const row = db
    .prepare(
      `SELECT data FROM linkedin_profile_proposals
       WHERE (? IS NULL OR status = ?)
       ORDER BY created_at DESC, updated_at DESC
       LIMIT 1`
    )
    .get(status, status);
  return parseJsonRow(row);
}

// linkedinProposalDecide({repoRoot, env, batchId, surfaceId, action, version, reason})
// -> updated batch. Optimistic concurrency on `version` (the whole batch's
// version, not a per-surface one — every decide() call bumps it). A surface
// that already has a decision refuses a second one, EXCEPT approve -> applied,
// which the optimize-linkedin skill uses to mark an approved field applied
// after its own verified LinkedIn write.
export function linkedinProposalDecide({
  repoRoot,
  env,
  batchId,
  surfaceId,
  action,
  version,
  reason,
} = {}) {
  if (!String(batchId || "").trim()) {
    throw makeError("linkedinProposalDecide requires batchId", "BAD_REQUEST");
  }
  if (!String(surfaceId || "").trim()) {
    throw makeError("linkedinProposalDecide requires surfaceId", "BAD_REQUEST");
  }
  if (!DECIDE_ACTIONS.has(action)) {
    throw makeError(
      `linkedinProposalDecide: action must be one of ${[...DECIDE_ACTIONS].join(", ")} (got ${JSON.stringify(action)})`,
      "BAD_REQUEST"
    );
  }
  if (version == null || version === "" || !Number.isInteger(Number(version))) {
    throw makeError("linkedinProposalDecide requires version", "BAD_REQUEST");
  }

  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const batch = readBatchById(db, batchId);
    if (!batch) {
      throw makeError(`linkedin proposal batch not found: ${batchId}`, "CONFLICT");
    }
    if (Number(batch.version) !== Number(version)) {
      throw makeError(
        `linkedin proposal batch version conflict: expected ${version}, found ${batch.version}`,
        "CONFLICT"
      );
    }
    const surfaceIndex = batch.surfaces.findIndex((s) => s.surfaceId === surfaceId);
    if (surfaceIndex === -1) {
      throw makeError(
        `linkedin proposal surface not found: ${surfaceId} in batch ${batchId}`,
        "CONFLICT"
      );
    }
    const surface = batch.surfaces[surfaceIndex];
    const priorAction = surface.decision?.action;
    if (action === "applied") {
      // "applied" asserts a verified LinkedIn write of an approved field — it
      // is never a first decision, so an undecided or rejected surface refuses.
      if (priorAction !== "approve") {
        throw makeError(
          `linkedin proposal surface must be approved before it can be marked applied: ${surfaceId}`,
          "CONFLICT"
        );
      }
    } else if (priorAction) {
      throw makeError(
        `linkedin proposal surface already decided: ${surfaceId} (${priorAction})`,
        "CONFLICT"
      );
    }

    const surfaces = clone(batch.surfaces);
    surfaces[surfaceIndex] = {
      ...surfaces[surfaceIndex],
      decision: {
        action,
        decidedAt: nowIso(),
        ...(reason ? { reason } : {}),
      },
    };
    const status = surfaces.every((s) => s.decision) ? "reviewed" : "pending";
    const next = {
      ...clone(batch),
      surfaces,
      status,
      version: Number(batch.version) + 1,
    };
    // Whole-payload backstop: decide()'s only free-text input is `reason`,
    // which isn't covered by assertSurfaces/assertNoCompLeak (those only run
    // on batchPut's original surfaces) — scan the full updated batch so a
    // leak smuggled in via `reason` is refused before the UPDATE lands. The
    // throw here happens inside withTransaction, so the batch is left
    // unmodified.
    assertNoCompLeakInPayload(
      next,
      `linkedin proposal decide refused: private compensation input detected in decision payload for surface "${surfaceId}" (current-comp leak guard)`
    );
    db.prepare(`UPDATE linkedin_profile_proposals SET data = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(next),
      nowIso(),
      String(batchId)
    );
    return readBatchById(db, batchId);
  });
}
