// evidence-validation.mjs — pure claim field-shape + honesty/privacy checks
// shared by evidence-writer.mjs's validateClaims (the CLI/file-mode firewall)
// and db/verbs/candidate.mjs's candidateEvidenceMerge (the DB-mode firewall).
//
// This lives in its own file, split out of evidence-writer.mjs, to break an
// import cycle: evidence-writer.mjs pulls in config-store.mjs, which pulls in
// db/verbs.mjs (for candidateConfigGet), which barrels db/verbs/index.mjs —
// the same file that exports db/verbs/candidate.mjs. candidate.mjs importing
// evidence-writer.mjs directly would close that cycle back on itself. This
// module has zero dependency on config-store.mjs or anything under core/db,
// so both sides can import it safely.
import { lintArtifact } from "../documents/placeholder-lint.mjs";
import { findCurrentBaseToken } from "./comp-guard.mjs";

// The claim fields that must be arrays of non-empty strings when present.
// metrics/allowed_wording are deliberately excluded — evidence-writer.mjs
// has never shape-checked them, only linted their text, and this helper
// keeps parity with that existing behavior rather than tightening it here.
export const EVIDENCE_ARRAY_FIELDS = ["links", "role_signals", "forbidden_wording"];

// Validate one claim's optional array fields (links/role_signals/forbidden_wording)
// plus placeholder residue / current_base leaks across every text field the
// claim carries. Returns an array of { id, message } errors (empty when
// clean). Does NOT check id/claim/evidence presence or cross-claim
// invariants like duplicate ids — those require the full claim set and stay
// the caller's responsibility (see evidence-writer.mjs's validateClaims).
export function validateClaimFields(c, where) {
  const errors = [];

  for (const field of EVIDENCE_ARRAY_FIELDS) {
    const value = c?.[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) {
      errors.push({ id: c?.id ?? null, message: `${where} field "${field}" must be an array` });
      continue;
    }
    value.forEach((entry, j) => {
      if (typeof entry !== "string" || !entry.trim()) {
        errors.push({
          id: c?.id ?? null,
          message: `${where} field "${field}[${j}]" must be a non-empty string`,
        });
      }
    });
  }

  const probe = [
    c?.claim,
    c?.evidence,
    ...(Array.isArray(c?.metrics) ? c.metrics : []),
    ...(Array.isArray(c?.links) ? c.links : []),
    ...(Array.isArray(c?.role_signals) ? c.role_signals : []),
    ...(Array.isArray(c?.allowed_wording) ? c.allowed_wording : []),
    ...(Array.isArray(c?.forbidden_wording) ? c.forbidden_wording : []),
  ]
    .filter(Boolean)
    .join("\n");
  const lint = lintArtifact(probe);
  if (!lint.clean) {
    const f = lint.findings[0];
    errors.push({
      id: c?.id ?? null,
      message: `${where} has unresolved placeholder (${f.pattern}): "${f.text}"`,
    });
  }
  const leak = findCurrentBaseToken(probe);
  if (leak) {
    errors.push({
      id: c?.id ?? null,
      message: `${where} contains the private current_base field: evidence must never carry it`,
    });
  }

  return errors;
}
