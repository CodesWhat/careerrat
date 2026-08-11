// evidence-writer.mjs — the safe add/validate primitive for the evidence truth bank.
//
// candidate/evidence.yml is the highest-stakes file in CareerRat: every résumé,
// cover letter, interview packet, and STAR+R story draws its claims from here, and
// nothing outbound may assert a fact that isn't in it. Until now evidence was only
// written by hand-edit (ingest-profile) or résumé parse — there was no guarded
// programmatic write path, so a flow that ORIGINATES evidence (e.g. scanning a
// projects folder and proposing claims) had nowhere safe to land them.
//
// This module is that path, mirroring gate-writer / learnings / research / stories:
//
//   - **One slug rule.** slugifyClaimId() makes ids filename/ref-safe and idempotent
//     so the story bank's evidence_ids and this writer always agree on an id.
//   - **Honesty backstop.** A claim that carries placeholder residue (shared
//     lintArtifact) or the private `current_base` field token (findCurrentBaseToken —
//     the tight guard, since accomplishment claims legitimately say "currently
//     processing N/day") is refused before it can enter the truth bank.
//   - **Schema-true + round-trip-safe.** A proposed write is validated against
//     evidence.schema.json AND must survive a stringify→parse round-trip unchanged
//     before it is committed — a serialization quirk can never silently corrupt the
//     file every artifact depends on. Writes are atomic.
//   - **Append-or-upsert by id.** New claims append; a claim re-added under an
//     existing id replaces that claim (so a re-scan refines rather than duplicates).
//
// The text/logic ops are pure (unit-testable); the fs touchpoints are thin and
// isolated at the bottom.

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lintArtifact } from "../documents/placeholder-lint.mjs";
import { displayPath, userPath } from "../paths/workspace.mjs";
import { findCurrentBaseToken } from "./comp-guard.mjs";
import { loadCandidateDoc } from "./config-store.mjs";
import { atomicWriteFile } from "./gate-writer.mjs";
import { validate } from "./schema-validator.mjs";
import { parseYaml, stringifyYaml } from "./yaml.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export const EVIDENCE_REL_PATH = "candidate/evidence.yml";

// The claim fields evidence.schema.json knows about (used to drop unknown keys a
// caller might pass and to order the serialized output predictably).
export const CLAIM_FIELDS = [
  "id",
  "claim",
  "evidence",
  "metrics",
  "links",
  "role_signals",
  "allowed_wording",
  "forbidden_wording",
];

export function evidenceAbsPath(root = DEFAULT_ROOT) {
  return userPath({ repoRoot: root }, EVIDENCE_REL_PATH);
}

// Filename/ref-safe, idempotent — same rule as slugifyStoryId / slugifyFamily.
export function slugifyClaimId(name) {
  const s = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "claim";
}

// ---------------------------------------------------------------------------
// Parse / load
// ---------------------------------------------------------------------------

export function parseEvidence(text) {
  const data = parseYaml(text) || {};
  const claims = Array.isArray(data.claims) ? data.claims : [];
  return { claims, data };
}

export function loadEvidence({ root = DEFAULT_ROOT } = {}) {
  const data = loadCandidateDoc("evidence", { repoRoot: root });
  if (!data) return { exists: false, claims: [] };
  return { exists: true, data, claims: Array.isArray(data.claims) ? data.claims : [] };
}

// ---------------------------------------------------------------------------
// Validation — the honesty firewall (pure)
// ---------------------------------------------------------------------------

// Validate claims structurally (id/claim/evidence required, unique ids) plus the
// honesty backstops (no placeholder residue, no private current_base token).
// Returns { ok, errors[] } where each error is { id, message }.
export function validateClaims(claims) {
  if (!Array.isArray(claims)) {
    return { ok: false, errors: [{ id: null, message: "claims must be an array" }] };
  }
  const errors = [];
  const seen = new Set();

  claims.forEach((c, i) => {
    const where = c?.id ? `claim "${c.id}"` : `claims[${i}]`;
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      errors.push({ id: null, message: `${where} is not an object` });
      return;
    }
    if (!c.id || !String(c.id).trim()) {
      errors.push({ id: null, message: `${where} is missing id` });
    } else {
      const id = String(c.id);
      if (seen.has(id)) errors.push({ id, message: `duplicate claim id "${id}"` });
      seen.add(id);
    }
    if (!c.claim || !String(c.claim).trim()) {
      errors.push({ id: c.id ?? null, message: `${where} is missing claim text` });
    }
    if (!c.evidence || !String(c.evidence).trim()) {
      errors.push({ id: c.id ?? null, message: `${where} is missing evidence` });
    }

    const probe = [
      c.claim,
      c.evidence,
      ...(Array.isArray(c.metrics) ? c.metrics : []),
      ...(Array.isArray(c.allowed_wording) ? c.allowed_wording : []),
    ]
      .filter(Boolean)
      .join("\n");
    const lint = lintArtifact(probe);
    if (!lint.clean) {
      const f = lint.findings[0];
      errors.push({
        id: c.id ?? null,
        message: `${where} has unresolved placeholder (${f.pattern}): "${f.text}"`,
      });
    }
    const leak = findCurrentBaseToken(probe);
    if (leak) {
      errors.push({
        id: c.id ?? null,
        message: `${where} contains the private current_base field — evidence must never carry it`,
      });
    }
  });

  return { ok: errors.length === 0, errors };
}

// Keep only schema-known fields, dropping empties, so serialized claims stay clean.
function normalizeClaim(claim) {
  const out = {};
  for (const f of CLAIM_FIELDS) {
    if (claim[f] === undefined || claim[f] === null) continue;
    if (Array.isArray(claim[f]) && claim[f].length === 0) continue;
    out[f] = claim[f];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Write plan (pure) — append or upsert by id
// ---------------------------------------------------------------------------

// Compute the next claim set after adding/replacing one claim. Validates the new
// claim (firewall), then upserts by slugified id. Returns
// { ok, claim, nextClaims, replaced } or { ok:false, error, errors }.
export function computeEvidenceWrite({ newClaim, currentClaims = [] }) {
  if (!newClaim || typeof newClaim !== "object" || Array.isArray(newClaim)) {
    return { ok: false, error: "no claim object provided" };
  }
  // Resolve the id BEFORE normalizing field order, so a derived id still leads the
  // serialized claim (CLAIM_FIELDS puts id first) instead of trailing it.
  const raw = { ...newClaim };
  if ((!raw.id || !String(raw.id).trim()) && raw.claim) {
    raw.id = slugifyClaimId(raw.claim);
  }
  if (!raw.id || !String(raw.id).trim()) {
    return { ok: false, error: "claim needs an id or claim text to derive one from" };
  }
  raw.id = slugifyClaimId(raw.id);
  const claim = normalizeClaim(raw);

  const v = validateClaims([claim]);
  if (!v.ok) {
    return { ok: false, error: v.errors.map((e) => e.message).join("; "), errors: v.errors };
  }

  const existing = Array.isArray(currentClaims) ? currentClaims.slice() : [];
  const idx = existing.findIndex((c) => slugifyClaimId(c?.id) === claim.id);
  let replaced = false;
  if (idx >= 0) {
    existing[idx] = claim;
    replaced = true;
  } else {
    existing.push(claim);
  }
  return { ok: true, claim, nextClaims: existing, replaced };
}

// ---------------------------------------------------------------------------
// fs touchpoints
// ---------------------------------------------------------------------------

export function evidenceExists(root = DEFAULT_ROOT) {
  return existsSync(evidenceAbsPath(root));
}

// Atomically write the whole evidence bank. Guards against truth-bank corruption:
// the serialized text must (1) validate against evidence.schema.json when a schema
// is provided and (2) survive a stringify→parse round-trip unchanged. On any guard
// failure it refuses (returns { ok:false }) rather than writing — the file every
// outbound artifact depends on is never left in a worse state.
export function writeEvidence({ claims, root = DEFAULT_ROOT, schema = null }) {
  const list = Array.isArray(claims) ? claims : [];
  const body = stringifyYaml({ claims: list });
  const text = body.endsWith("\n") ? body : `${body}\n`;

  // (1) round-trip integrity — reparse must reproduce the exact claim set.
  const reparsed = parseEvidence(text).claims;
  if (JSON.stringify(reparsed) !== JSON.stringify(list)) {
    return {
      ok: false,
      error:
        "serialization round-trip mismatch — refusing to rewrite evidence.yml; edit it manually",
    };
  }
  // (2) schema validity (when a schema is supplied by the caller).
  if (schema) {
    const res = validate({ claims: list }, schema);
    if (!res.valid) {
      return {
        ok: false,
        error: `result would violate evidence.schema.json: ${res.errors.map((e) => e.message).join("; ")}`,
      };
    }
  }

  const path = evidenceAbsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, text);
  return {
    ok: true,
    path,
    relPath: displayPath({ repoRoot: root }, EVIDENCE_REL_PATH),
    count: list.length,
  };
}
