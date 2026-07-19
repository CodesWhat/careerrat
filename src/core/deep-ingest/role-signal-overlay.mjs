// role-signal-overlay.mjs — pure ephemeral merge of confirmed Library
// role-signal rows into a role's effective targeting (promotion-pipeline-
// design-2026-07-19.md "Overlay" contract, Decision 7). Never persisted,
// never schema-validated as candidate targeting: callers (gate.mjs,
// sourced-scanner.mjs) resolve this fresh per posting/offer and read the
// result, they never write it back to candidate_targeting.

import { classifyRoleFamily } from "../tracker/outcome-analysis.mjs";

const UNRESOLVABLE_ROLE_FAMILIES = new Set(["other", "uncategorized"]);

function normalizeFamily(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function dedupeCaseInsensitive(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const text = String(item || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

// Classifies roleTitle into a family via classifyRoleFamily() (same
// exact-normalized-match rule the rest of the codebase uses) and treats
// "other"/"uncategorized"/unresolvable results as no family at all — the
// only shared piece of family-resolution logic role-signal-overlay.mjs and
// its callers need, so context.mjs (packet/context.mjs) can resolve the
// same family this module would without duplicating the rule.
export function resolveRoleFamily({ roleTitle = "", targeting = {} } = {}) {
  const family = classifyRoleFamily(roleTitle || "", targeting);
  if (!family || UNRESOLVABLE_ROLE_FAMILIES.has(family)) return null;
  return family;
}

export function effectiveTargetingForRole({
  roleTitle = "",
  targeting = {},
  roleSignals = [],
} = {}) {
  const baseTargeting = targeting && typeof targeting === "object" ? targeting : {};
  const family = resolveRoleFamily({ roleTitle, targeting: baseTargeting });

  if (!family) {
    return { targeting: baseTargeting, applied: { family: null, keep: [], cut: [] } };
  }

  const normalizedFamily = normalizeFamily(family);
  const keep = [];
  const cut = [];
  for (const row of Array.isArray(roleSignals) ? roleSignals : []) {
    if (!row || typeof row !== "object") continue;
    if (normalizeFamily(row.roleFamily) !== normalizedFamily) continue;
    if (row.signalType !== "keep" && row.signalType !== "cut") continue;
    const text = String(row.text || "").trim();
    if (!text) continue;
    const entry = { id: row.id, text };
    (row.signalType === "keep" ? keep : cut).push(entry);
  }

  // Base arrays first and authoritative: dedupeCaseInsensitive keeps the
  // first (base) spelling on a case-insensitive collision with an applied
  // signal.
  const baseKeep = Array.isArray(baseTargeting.keep_signals) ? baseTargeting.keep_signals : [];
  const baseCut = Array.isArray(baseTargeting.cut_signals) ? baseTargeting.cut_signals : [];

  return {
    targeting: {
      ...baseTargeting,
      keep_signals: dedupeCaseInsensitive([...baseKeep, ...keep.map((row) => row.text)]),
      cut_signals: dedupeCaseInsensitive([...baseCut, ...cut.map((row) => row.text)]),
    },
    applied: { family, keep, cut },
  };
}
