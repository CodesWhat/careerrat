// schemas.mjs — the coach-gaps skill's AI-facing output contract.
//
// Same capped-list discipline as src/core/packet/schemas/packet-schemas.mjs'
// packetGateAiVerdictSchema: additionalProperties false at every level, a
// hard cap on how many gaps a single plan can carry (mirrors fitRisks'
// maxItems 3 on the evaluation that seeds this), and a maxLength on every
// free-text field the model produces.
//
// gapText here is a SAFETY/ALIGNMENT field only — it lets the model confirm
// which numbered risk a suggestion addresses, capped at 80 chars exactly like
// fitRisks' own item maxLength (packetGateAiVerdictSchema). The persisted
// plan (src/core/coaching/plan.mjs#normalizeGaps) NEVER uses the model's
// copy: gapText in the final output is always the verbatim source fitRisks
// string, never a model restatement.
export const coachingPlanSchema = {
  type: "object",
  required: ["gaps"],
  additionalProperties: false,
  properties: {
    gaps: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        required: ["gapText", "suggestion"],
        additionalProperties: false,
        properties: {
          gapText: { type: "string", maxLength: 80 },
          suggestion: {
            type: "object",
            required: ["kind", "rationale"],
            additionalProperties: false,
            properties: {
              kind: { type: "string", enum: ["evidence-claim", "no-close-path"] },
              // Required only in shape (nullable) — a no-close-path suggestion
              // carries null here; plan.mjs enforces the kind/draftClaim pairing
              // the schema alone can't express (JSON Schema draft 2020-12 has no
              // portable "required iff sibling equals X" without oneOf branches
              // heavier than this narrow AI contract needs).
              draftClaim: {
                type: ["object", "null"],
                additionalProperties: false,
                properties: {
                  claim: { type: "string", maxLength: 200 },
                  evidence: { type: "string", maxLength: 300 },
                },
              },
              rationale: { type: "string", maxLength: 160 },
            },
          },
        },
      },
    },
  },
};
