// confirmBlocks.js — pure parser for the interview's fenced confirm blocks
// (Lane A / R1-R4). Mirrors the exact fence syntax and closed `kind` enum
// src/core/ai/skill-runtime.mjs's CONFIRM_BLOCK_GUIDANCE documents to the
// model: a ```careerrat:confirm (or bare ```confirm) fence containing one
// JSON object with a `kind`, an optional `summary` (the model's own words —
// NEVER used as a pill's label, only ever shown alongside a code-owned label
// for the single-click kinds, per R4), and a `patch` or `payload` depending
// on kind.
//
// Every matched fence — valid or not — is stripped from the returned display
// text: raw JSON must never leak into the transcript, and an invalid block
// (bad JSON, unknown kind, missing required payload key) is silently
// dropped rather than rendered, so a pill is the ONLY way any of these
// writes can happen.

const FENCE_RE = /```(?:careerrat:confirm|confirm)\n([\s\S]*?)\n```/g;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

const KIND_VALIDATORS = {
  authorization: (block) =>
    block?.patch &&
    typeof block.patch === "object" &&
    typeof block.patch.work_authorized === "boolean" &&
    typeof block.patch.requires_sponsorship === "boolean",
  consent_mode: (block) => block?.payload === "basic" || block?.payload === "advanced",
  consent_capability: (block) =>
    block?.payload &&
    typeof block.payload === "object" &&
    isNonEmptyString(block.payload.capability) &&
    isNonEmptyString(block.payload.platform),
  companies_suggest: () => true,
  company_add: (block) =>
    block?.payload && typeof block.payload === "object" && isNonEmptyString(block.payload.name),
};

export const CONFIRM_KINDS = Object.keys(KIND_VALIDATORS);

// Kinds that are actionable with a single click (the model's own summary MAY
// render alongside a code-owned kind label). consent_mode/consent_capability
// are deliberately excluded — R4 requires a distinct second confirmation
// dialog with code-owned copy for those two.
export const SINGLE_CLICK_KINDS = new Set(["authorization", "company_add", "companies_suggest"]);

// Parses every confirm fence out of `text`. Returns { text, blocks } — `text`
// is the original string with every matched fence (valid or not) removed and
// trimmed; `blocks` is the ordered list of validated confirm blocks, each
// shaped { kind, summary, patch, payload }.
export function parseConfirmBlocks(text) {
  const raw = typeof text === "string" ? text : "";
  const blocks = [];
  FENCE_RE.lastIndex = 0;
  let match = FENCE_RE.exec(raw);
  while (match) {
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      parsed = null;
    }
    const kind = parsed?.kind;
    const validator = kind ? KIND_VALIDATORS[kind] : null;
    if (parsed && validator?.(parsed)) {
      blocks.push({
        kind,
        summary: isNonEmptyString(parsed.summary) ? parsed.summary.trim() : "",
        patch: parsed.patch && typeof parsed.patch === "object" ? parsed.patch : null,
        payload: parsed.payload ?? null,
      });
    }
    match = FENCE_RE.exec(raw);
  }
  return { text: raw.replace(FENCE_RE, "").trim(), blocks };
}
