// gate-apply.mjs — the DB-native gate-write primitive shared by every Ask-bar
// surface that writes a single gate value: strategy.apply's per-recommendation
// dispatch (src/core/strategy/review.mjs) and settings.apply's gate-kind
// change (src/core/agent/workspace-agent.mjs). Reused rather than re-derived
// so a "keep-signal" or "comp-floor" write means the same thing everywhere it
// is triggered from.
//
// DB-native sibling of gate.mjs's computeDbGateEdit + candidateConfigPatch
// (the CLI's own "DB gate write" branch) — reused here rather than
// computeGateEdit (gate-writer.mjs's YAML-text pure function), since every
// caller of this module is DB-only, with no legacy-YAML-file fallback.
//
// applyGateWrite throws PLAIN Error objects (no `.code` it attaches itself —
// resolveRoute/assertNoPrivateLeak/coerceValue already throw plain errors,
// and a candidateConfigPatch failure is left exactly as candidateConfigPatch
// threw it, `.code` and all) so each caller can translate the failure into
// its own error vocabulary (STRATEGY_APPLY_INVALID/VALIDATION_FAILED,
// SETTINGS_CHANGE_INVALID, ...) instead of inheriting a code that belongs to
// a different HTTP surface.

import { candidateConfigGet, candidateConfigPatch } from "../db/verbs/candidate.mjs";
import { assertNoPrivateLeak, coerceValue, resolveRoute } from "./gate-writer.mjs";

export const GATE_APPLY_SUMMARIES = {
  "keep-signal": (value) => `Added "${value}" to your keep signals.`,
  "cut-signal": (value) => `Added "${value}" to your cut signals.`,
  "exclude-company": (value) => `Added "${value}" to your excluded companies.`,
  "comp-target": (value) => `Target base is now ${value}.`,
  "comp-floor": (value) => `Minimum base is now ${value}.`,
  "comp-annual-floor": (value) => `Minimum annual cash earnings are now ${value}.`,
  "comp-expected": (value) => `Expected base is now ${value}.`,
  "do-not-claim": (value) => `Added "${value}" to your do-not-claim list.`,
  "do-not-fabricate": (value) => `Added "${value}" to your do-not-fabricate list.`,
};

const ALREADY_SAVED_SUMMARY = "Already saved. Nothing changed.";

// applyGateWrite({repoRoot, env, type, value}) — resolve the gate type to its
// route, coerce the incoming value, read only the ONE field the route points
// at (never the whole config doc — see the return comment below), patch it
// through candidateConfigPatch, and hand back a scoped result the caller can
// safely surface in an artifact, an HTTP response, or the durable thread.
export function applyGateWrite({ repoRoot, env, type, value }) {
  const route = resolveRoute(type);
  assertNoPrivateLeak(route.file, route.path);
  const coerced = coerceValue(route, value);
  const config = candidateConfigGet({ repoRoot, env });
  const doc = config[route.file] || {};
  const parts = route.path.split(".");
  let cursor = doc;
  for (const part of parts)
    cursor = cursor && typeof cursor === "object" ? cursor[part] : undefined;

  let patchValue = coerced;
  if (route.op === "append") {
    const current = Array.isArray(cursor) ? cursor : [];
    if (current.some((item) => String(item) === String(coerced))) {
      return {
        changed: false,
        field: route.path,
        from: cursor,
        value: coerced,
        summary: ALREADY_SAVED_SUMMARY,
      };
    }
    patchValue = [...current, coerced];
  } else if (cursor === coerced) {
    return {
      changed: false,
      field: route.path,
      from: cursor,
      value: coerced,
      summary: ALREADY_SAVED_SUMMARY,
    };
  }

  let patch = patchValue;
  for (let i = parts.length - 1; i >= 0; i--) patch = { [parts[i]]: patch };

  candidateConfigPatch({ repoRoot, env, name: route.file, patch });

  // candidateConfigPatch's return carries the full merged doc as `data`; for
  // the profile-routed types that includes compensation.current_base, and
  // this function's return can land verbatim in an artifact, an HTTP
  // response, or the durable thread. Only the scoped field read above may
  // leave here — current_base is never read in this module.
  return {
    changed: true,
    field: route.path,
    from: cursor,
    value: coerced,
    summary: GATE_APPLY_SUMMARIES[type](coerced),
  };
}
