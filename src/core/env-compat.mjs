// env-compat.mjs — the single chokepoint for reading CAREERRAT_* env vars
// with a fallback to their retired ROLESTER_* names.
//
// The product was renamed Rolester -> CareerRat, but operators may already
// have ROLESTER_* exported in a shell profile, CI config, or .env file.
// Breaking those silently buys nothing, so every env-var read in this repo
// goes through here rather than scattering `env.CAREERRAT_X ?? env.ROLESTER_X`
// chains: the new name always wins when both are set, the old name still
// works when only it is set, and this file is the only place that needs to
// know the old prefix ever existed.
//
// New code should only ever read/write CAREERRAT_* — never introduce a new
// ROLESTER_*-named var.

const NEW_PREFIX = "CAREERRAT_";
const LEGACY_PREFIX = "ROLESTER_";

function legacyName(name) {
  return name.startsWith(NEW_PREFIX) ? LEGACY_PREFIX + name.slice(NEW_PREFIX.length) : null;
}

/**
 * Read a CAREERRAT_* env var, falling back to its retired ROLESTER_* name
 * when the new name is unset. The new name always wins when both are present.
 *
 * @param {string} name - must start with "CAREERRAT_"
 * @param {{ env?: object }} [options]
 * @returns {string | undefined}
 */
export function readEnv(name, { env = process.env } = {}) {
  if (env[name] !== undefined) return env[name];
  const legacy = legacyName(name);
  return legacy ? env[legacy] : undefined;
}

/**
 * True when either the CAREERRAT_* var or its legacy ROLESTER_* fallback is
 * set to a non-empty (after trim) string.
 *
 * @param {string} name - must start with "CAREERRAT_"
 * @param {{ env?: object }} [options]
 */
export function hasEnv(name, { env = process.env } = {}) {
  return String(readEnv(name, { env }) ?? "").trim() !== "";
}
