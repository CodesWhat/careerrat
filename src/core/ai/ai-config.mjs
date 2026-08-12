// ai-config.mjs — the no-code model-swap seam.
//
// Lets an operator point every skill run and callAI() call at a different
// model — a native Anthropic id or an upstream gateway slug (e.g.
// "anthropic/claude-sonnet-4.6" via Vercel AI Gateway) — without touching any
// source file. One precedence rule, shared by every consumer
// (skill-runtime.mjs's buildChildEnv, call-ai.mjs's callAI):
//
//   1. An explicit env var (ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL)
//      always wins — an operator who already set one gets exactly that.
//   2. Otherwise config/ai.json (gitignored, user-local; config/ai.example.json
//      is the tracked template — see config/ai.schema.json for the shape).
//   3. Otherwise DEFAULT_MODEL / DEFAULT_SMALL_FAST_MODEL below — the shipped
//      default, so a fresh BYOK install (key set, nothing else configured)
//      still sends a real model id instead of `model: null`.
//
// Reading config/ai.json is tolerant by design: a missing file, invalid JSON,
// or a shape that fails config/ai.schema.json is all treated as "no override"
// — a hand-edited, optional file must never crash a skill run over a typo.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { userPath } from "../paths/workspace.mjs";
import { formatErrors, validate } from "../profile/schema-validator.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export const AI_CONFIG_REL_PATH = "config/ai.json";
export const AI_CONFIG_SCHEMA_PATH = "config/ai.schema.json";

// Shipped defaults — the last fallback tier in resolveModelConfig(), used
// only when nothing else (explicit arg, env var, config/ai.json) sets a
// model. Bare aliases, not dated snapshots, so they auto-roll to the latest
// point release. One home for these ids — import them, never hardcode a
// model string elsewhere.
export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_SMALL_FAST_MODEL = "claude-haiku-4-5";

const EMPTY_CONFIG = Object.freeze({ model: null, smallFastModel: null });

export function loadAiConfigSchema({ root = DEFAULT_ROOT } = {}) {
  return JSON.parse(readFileSync(join(root, AI_CONFIG_SCHEMA_PATH), "utf8"));
}

// Pure: given a parsed JSON value (or null/undefined), returns
// { valid, errors, data: { model, smallFastModel } } — data always has both
// keys, defaulting to null, even on a validation failure (never throws).
export function normalizeAiConfig(input, { schema } = {}) {
  if (input == null) return { valid: true, errors: [], data: { ...EMPTY_CONFIG } };
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      valid: false,
      errors: [{ path: "", message: "ai config must be an object" }],
      data: { ...EMPTY_CONFIG },
    };
  }

  const s = schema || loadAiConfigSchema();
  const validation = validate(input, s);
  return {
    valid: validation.valid,
    errors: validation.errors,
    data: {
      model: trimmedOrNull(input.model),
      smallFastModel: trimmedOrNull(input.smallFastModel),
    },
  };
}

function trimmedOrNull(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

// fs touchpoint: read + parse config/ai.json (respects CAREERRAT_HOME, legacy
// ROLESTER_HOME still honored, via userPath, same generated-config redirect
// as config/sourced-scan.json).
// Missing file, invalid JSON, or a schema violation all silently fall back to
// { model: null, smallFastModel: null } — see the file-header note above.
export function loadAiConfigFile({ root = DEFAULT_ROOT } = {}) {
  const path = userPath({ repoRoot: root }, AI_CONFIG_REL_PATH);
  if (!existsSync(path)) return { ...EMPTY_CONFIG };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ...EMPTY_CONFIG };
  }

  const { data } = normalizeAiConfig(parsed);
  return data;
}

// The one precedence rule (env > config file > shipped default), resolved
// once so every consumer agrees. `env` is injected (defaults to process.env)
// for testability. The shipped default is the last fallback — a configured
// value (env or file) always wins over it.
export function resolveModelConfig({ root = DEFAULT_ROOT, env = process.env } = {}) {
  const fileConfig = loadAiConfigFile({ root });
  const envModel = trimmedOrNull(env.ANTHROPIC_MODEL);
  const envSmallFastModel = trimmedOrNull(env.ANTHROPIC_SMALL_FAST_MODEL);
  return {
    model: envModel || fileConfig.model || DEFAULT_MODEL,
    smallFastModel: envSmallFastModel || fileConfig.smallFastModel || DEFAULT_SMALL_FAST_MODEL,
  };
}

export { formatErrors };
