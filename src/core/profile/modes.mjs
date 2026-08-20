// modes.mjs - optional mode switches for compute scope and pursuit posture.
//
// `usage_mode` controls how much discretionary work CareerRat does. It never
// lowers the quality of core gate/tailor/track/comms work.
//
// `application_mode` controls what happens after discovery. Discovery should stay
// recall-oriented; this mode affects promotion/review/apply posture, not whether
// plausible roles are intentionally hidden.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { displayPath } from "../paths/workspace.mjs";
import { candidateConfigSource, loadCandidateDoc } from "./config-store.mjs";
import { setScalar, validateText } from "./gate-writer.mjs";
import { formatErrors, validate } from "./schema-validator.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export const MODES_REL_PATH = "candidate/modes.yml";
export const MODES_TEMPLATE_PATH = "templates/modes.example.yml";
const MODES_SCHEMA_PATH = "config/modes.schema.json";

const USAGE_MODES = ["lean", "standard", "full"];
const APPLICATION_MODES = ["selective", "balanced", "high-volume"];

export const DEFAULT_MODES = Object.freeze({
  usage_mode: "standard",
  application_mode: "balanced",
});

export const MODE_ROUTES = {
  usage: { path: "usage_mode", values: USAGE_MODES, label: "usage mode" },
  usage_mode: { path: "usage_mode", values: USAGE_MODES, label: "usage mode" },
  application: {
    path: "application_mode",
    values: APPLICATION_MODES,
    label: "application mode",
  },
  application_mode: {
    path: "application_mode",
    values: APPLICATION_MODES,
    label: "application mode",
  },
};

export const USAGE_OPERATIONS = {
  "core:evaluate": { lean: "run", standard: "run", full: "run" },
  "core:tailor": { lean: "run", standard: "run", full: "run" },
  "core:track": { lean: "run", standard: "run", full: "run" },
  "core:comms": { lean: "run", standard: "run", full: "run" },
  "research:company": { lean: "skip", standard: "run", full: "run" },
  "research:comp": { lean: "downshift", standard: "run", full: "run" },
  "research:boards": { lean: "skip", standard: "run", full: "run" },
  "research:companies": { lean: "skip", standard: "run", full: "run" },
  "interview:packet:deep": { lean: "downshift", standard: "run", full: "run" },
  "search:sweep:broad": { lean: "downshift", standard: "run", full: "run" },
  "search:ai-web": { lean: "downshift", standard: "run", full: "run" },
  "agent:fanout": { lean: "downshift", standard: "run", full: "run" },
};

const APPLICATION_MODE_POLICY = {
  selective: {
    scannerLikelyKeepMin: 88,
    reviewMediumBodyReadFits: true,
  },
  balanced: {
    scannerLikelyKeepMin: 82,
    reviewMediumBodyReadFits: false,
  },
  "high-volume": {
    scannerLikelyKeepMin: 65,
    reviewMediumBodyReadFits: false,
  },
};

export function loadModesSchema({ root = DEFAULT_ROOT } = {}) {
  return JSON.parse(readFileSync(join(root, MODES_SCHEMA_PATH), "utf8"));
}

export function normalizeModes(input, { schema } = {}) {
  if (input == null) return { valid: true, errors: [], data: { ...DEFAULT_MODES } };
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      valid: false,
      errors: [{ path: "", message: "modes config must be an object" }],
      data: { ...DEFAULT_MODES },
    };
  }

  const s = schema || loadModesSchema();
  const validation = validate(input, s);
  const data = {
    ...DEFAULT_MODES,
    ...(typeof input.usage_mode === "string" ? { usage_mode: input.usage_mode } : {}),
    ...(typeof input.application_mode === "string"
      ? { application_mode: input.application_mode }
      : {}),
  };
  return { valid: validation.valid, errors: validation.errors, data };
}

export function loadModes({ root = DEFAULT_ROOT } = {}) {
  const display = displayPath({ repoRoot: root }, MODES_REL_PATH);
  const schema = loadModesSchema({ root });
  const source = candidateConfigSource({ repoRoot: root });
  let parsed;
  try {
    parsed = loadCandidateDoc("modes", { repoRoot: root });
  } catch (err) {
    return {
      exists: true,
      valid: false,
      errors: [{ path: "", message: `config parse error: ${err.message}` }],
      data: { ...DEFAULT_MODES },
      path: display,
      source,
    };
  }
  if (parsed == null) {
    return {
      exists: false,
      valid: true,
      errors: [],
      data: { ...DEFAULT_MODES },
      path: display,
      source,
    };
  }

  const normalized = normalizeModes(parsed, { schema });
  return {
    exists: true,
    valid: normalized.valid,
    errors: normalized.errors,
    data: normalized.data,
    path: display,
    source,
  };
}

export function computeAllows(operation, modes = {}) {
  const normalized = normalizeModes(modes);
  const usageMode = normalized.data.usage_mode;
  const policy = USAGE_OPERATIONS[operation];
  const decision = policy ? policy[usageMode] || "run" : "run";
  return {
    operation,
    usage_mode: usageMode,
    decision,
    allowed: decision !== "skip",
    reason:
      decision === "run"
        ? `${operation} runs in ${usageMode} mode`
        : decision === "downshift"
          ? `${operation} should use its lighter path in ${usageMode} mode`
          : `${operation} is discretionary and skipped in ${usageMode} mode`,
  };
}

function applicationPolicy(modes = {}) {
  const normalized = normalizeModes(modes);
  return (
    APPLICATION_MODE_POLICY[normalized.data.application_mode] || APPLICATION_MODE_POLICY.balanced
  );
}

export function scannerLikelyKeepThreshold(modes = {}) {
  return applicationPolicy(modes).scannerLikelyKeepMin;
}

export function shouldReviewMediumBodyReadFits(modes = {}) {
  return applicationPolicy(modes).reviewMediumBodyReadFits;
}

export function computeModeEdit({ type, value, currentText, schema }) {
  const route = MODE_ROUTES[type];
  if (!route) {
    return {
      ok: false,
      error: `unknown mode type "${type}". Known: usage, application`,
    };
  }
  if (!route.values.includes(value)) {
    return {
      ok: false,
      error: `"${value}" is not valid for ${route.label}. Allowed: ${route.values.join(", ")}`,
    };
  }

  const patch = setScalar(currentText, [route.path], value);
  if (!patch.ok) return { ok: false, error: patch.error, route, value };

  const validation = patch.changed ? validateText(patch.text, schema) : { valid: true, errors: [] };
  return {
    ok: true,
    route,
    path: route.path,
    value,
    changed: patch.changed,
    previous: patch.previous,
    nextText: patch.text,
    valid: validation.valid,
    errors: validation.errors,
  };
}

export { formatErrors };
