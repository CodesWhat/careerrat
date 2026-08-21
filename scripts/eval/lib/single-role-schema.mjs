// scripts/eval/lib/single-role-schema.mjs — a single-item subset of
// config/ai-web-search.schema.json's roles[].items, used to constrain the
// Phase 2 installed-CLI call to emit one triage result per posting instead
// of the full { roles, queries_run } envelope (queries_run doesn't apply —
// Phase 2 skips the live WebSearch/WebFetch step and hands the posting to
// the model directly). Field names and the fit_bucket enum are copied
// verbatim from the real schema so the model's output is graded on the same
// contract the AI Web Search lane actually uses in production.
export const SINGLE_ROLE_SCHEMA = Object.freeze({
  type: "object",
  required: ["fit_score", "fit_bucket", "fit_basis", "rule_flags", "source_evidence"],
  additionalProperties: false,
  properties: {
    fit_score: { type: "integer", minimum: 0, maximum: 100 },
    fit_bucket: { type: "string", enum: ["high", "med", "stretch"] },
    fit_basis: { type: "string" },
    rule_flags: { type: "array", items: { type: "string" } },
    source_evidence: { type: "string" },
  },
});
