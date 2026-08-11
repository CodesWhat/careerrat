// ai-env.mjs — local AI credential boot loader (M1: the non-AI onboarding
// wizard's one AI-adjacent surface).
//
// BYOK already works today via `ANTHROPIC_API_KEY` in the process
// environment (see call-ai.mjs's resolveAIRoute()). Before this file, that
// meant sourcing it into your shell profile every session — fine for a
// terminal-first user, but the onboarding wizard (src/cli/onboard-route.mjs +
// src/core/onboarding/onboard-page.mjs) needs a way to let someone paste a
// key once and have it survive a server restart without editing shell rc
// files. `.internal/ai.env` is the logical seam: in a legacy repo-root
// workspace it resolves to repo `.internal/ai.env`; with CAREERRAT_HOME (or
// the legacy ROLESTER_HOME) set it resolves to `<home>/internal/ai.env` (no
// dot) via userPath(). It is a
// file-mode-0600 dotenv this module reads at server boot and writes to when
// the wizard's BYOK step submits a key.
//
// Zero runtime deps: hand-rolled dotenv parsing (no `dotenv` package) — the
// subset used here is deliberately tiny: `KEY=value` lines, an optional
// leading `export ` prefix, `#` full-line comments, blank lines. No quoting,
// no multi-line values, no variable expansion — a single secret line is all
// this file will ever need to hold.
//
// ENV ALWAYS WINS: loadLocalAiEnv() only sets a key into `env` if that key is
// not already present. An operator who exports ANTHROPIC_API_KEY in their own
// shell (or CI) is never silently overridden by a stale stored file.
//
// SECURITY: never log, return, or otherwise surface the key VALUE anywhere in
// this module — only key NAMES ever leave loadLocalAiEnv(), and
// writeLocalAiKey() returns just `{ ok, path }`.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { userPath } from "../paths/workspace.mjs";

export const AI_ENV_RELPATH = ".internal/ai.env";

// ---------------------------------------------------------------------------
// Parsing — a tiny KEY=value subset, order-preserving.
// ---------------------------------------------------------------------------

// Parse the file's raw lines into an ordered list of entries. A recognized
// `KEY=value` line (optionally `export `-prefixed) becomes { key, value };
// anything else (comments, blank lines, malformed lines) is kept verbatim as
// { raw } so writeLocalAiKey() can round-trip unrelated content untouched.
function parseEnvLines(text) {
  const lines = text.split("\n");
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      entries.push({ raw: line });
      continue;
    }
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) {
      entries.push({ raw: line });
      continue;
    }
    const key = withoutExport.slice(0, eq).trim();
    const value = withoutExport.slice(eq + 1).trim();
    if (!key) {
      entries.push({ raw: line });
      continue;
    }
    // Keep the raw line too so writers can round-trip unrelated entries
    // byte-for-byte (export prefixes, spacing) instead of re-serializing.
    entries.push({ key, value, raw: line });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// loadLocalAiEnv
// ---------------------------------------------------------------------------

/**
 * Read the logical `.internal/ai.env` path (repo `.internal/ai.env` in legacy
 * mode, `<CAREERRAT_HOME>/internal/ai.env` with CAREERRAT_HOME, or the legacy
 * ROLESTER_HOME) and set any keys it defines into
 * `env` that are not already set there. Called once at server boot
 * (tracker-dev.mjs's createDevServer factory) so a stored key works without
 * shell sourcing.
 *
 * @param {{ repoRoot: string, env?: object }} options
 * @returns {{ loaded: string[], path: string }} `loaded` is key NAMES only —
 *   never values.
 */
export function loadLocalAiEnv({ repoRoot, env = process.env } = {}) {
  const path = userPath({ repoRoot, env }, AI_ENV_RELPATH);
  const loaded = [];
  if (!existsSync(path)) return { loaded, path };

  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Unreadable (permissions, race with a concurrent write) — treat as
    // "nothing to load" rather than crash server boot over a stored-key file.
    return { loaded, path };
  }

  for (const entry of parseEnvLines(text)) {
    if (!entry.key) continue;
    if (env[entry.key] !== undefined) continue; // env always wins
    env[entry.key] = entry.value;
    loaded.push(entry.key);
  }
  return { loaded, path };
}

// ---------------------------------------------------------------------------
// writeLocalAiKey
// ---------------------------------------------------------------------------

/**
 * Validate and persist an ANTHROPIC_API_KEY to the logical `.internal/ai.env`
 * path, chmod'd 0600, preserving any unrelated existing lines in the file. Sets
 * `env.ANTHROPIC_API_KEY` immediately so the current process picks it up
 * without a restart.
 *
 * @param {{ repoRoot: string, apiKey: string, env?: object }} options
 * @returns {{ ok: true, path: string }}
 * @throws {Error} if apiKey is empty or contains whitespace/newlines.
 */
export function writeLocalAiKey({ repoRoot, apiKey, env = process.env } = {}) {
  const key = typeof apiKey === "string" ? apiKey : "";
  if (!key.trim() || /\s/.test(key)) {
    throw new Error("apiKey must be a non-empty string with no whitespace or newlines");
  }

  const path = userPath({ repoRoot, env }, AI_ENV_RELPATH);
  mkdirSync(dirname(path), { recursive: true });

  const existingText = existsSync(path) ? readFileSync(path, "utf8") : "";
  // An absent or empty file parses to one empty line — start from nothing
  // instead so a fresh write doesn't lead with a blank line.
  const entries = existingText ? parseEnvLines(existingText) : [];

  let replaced = false;
  const nextLines = entries.map((entry) => {
    if (entry.key === "ANTHROPIC_API_KEY") {
      replaced = true;
      return `ANTHROPIC_API_KEY=${key}`;
    }
    return entry.raw !== undefined ? entry.raw : `${entry.key}=${entry.value}`;
  });
  if (!replaced) nextLines.push(`ANTHROPIC_API_KEY=${key}`);

  // Trim trailing blank lines from the round-tripped content, then end with
  // exactly one newline.
  while (nextLines.length > 0 && nextLines[nextLines.length - 1] === "") {
    nextLines.pop();
  }
  const text = `${nextLines.join("\n")}\n`;

  writeFileSync(path, text, "utf8");
  chmodSync(path, 0o600);

  env.ANTHROPIC_API_KEY = key;
  return { ok: true, path };
}

// ---------------------------------------------------------------------------
// writeManagedProxyEnv
// ---------------------------------------------------------------------------

// https, or an explicit loopback override for local dev against a
// non-deployed proxy (e.g. `vercel dev` on a plain :3000 http:// origin).
const MANAGED_PROXY_URL_RE = /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$))/i;

/**
 * Validate and persist the desktop app's automatically-provisioned managed-AI
 * proxy credentials (CAREERRAT_AI_PROXY_URL + CAREERRAT_AI_PROXY_TOKEN — a
 * legacy ROLESTER_AI_PROXY_URL/TOKEN line already on disk is migrated to the
 * new key name in place rather than left to accumulate a second, stale line)
 * to the logical `.internal/ai.env` path, chmod'd 0600, preserving any unrelated
 * existing lines in the file — same round-trip discipline as
 * writeLocalAiKey() above, applied to two keys instead of one. Sets both onto
 * `env` immediately so the current process's resolveAIRoute() (call-ai.mjs)
 * picks up the managed route without a restart.
 *
 * Called by a managed-AI provisioning route once it has exchanged a session
 * for a minted proxy token server-to-server — this function itself never
 * sees the session credential, only the already-minted `token`.
 *
 * NEVER touches ANTHROPIC_API_KEY: an existing BYOK line is round-tripped
 * verbatim (untouched, unreordered) exactly like any other unrelated line —
 * see loadLocalAiEnv's own "env always wins" comment for why BYOK and managed
 * proxy creds are meant to coexist in this same file without one clobbering
 * the other's line.
 *
 * @param {{ repoRoot: string, proxyUrl: string, token: string, env?: object }} options
 * @returns {{ ok: true, path: string }}
 * @throws {Error} if proxyUrl isn't https (or a loopback dev override), or if
 *   token is empty/not a string.
 */
export function writeManagedProxyEnv({ repoRoot, proxyUrl, token, env = process.env } = {}) {
  const url = typeof proxyUrl === "string" ? proxyUrl.trim() : "";
  if (!MANAGED_PROXY_URL_RE.test(url)) {
    throw new Error("proxyUrl must be https, or http://127.0.0.1/localhost for local dev");
  }
  const tok = typeof token === "string" ? token.trim() : "";
  if (!tok) {
    throw new Error("token must be a non-empty string");
  }

  const path = userPath({ repoRoot, env }, AI_ENV_RELPATH);
  mkdirSync(dirname(path), { recursive: true });

  const existingText = existsSync(path) ? readFileSync(path, "utf8") : "";
  // An absent or empty file parses to one empty line — start from nothing
  // instead so a fresh write doesn't lead with a blank line.
  const entries = existingText ? parseEnvLines(existingText) : [];

  let urlReplaced = false;
  let tokenReplaced = false;
  const nextLines = entries.map((entry) => {
    if (entry.key === "CAREERRAT_AI_PROXY_URL" || entry.key === "ROLESTER_AI_PROXY_URL") {
      urlReplaced = true;
      return `CAREERRAT_AI_PROXY_URL=${url}`;
    }
    if (entry.key === "CAREERRAT_AI_PROXY_TOKEN" || entry.key === "ROLESTER_AI_PROXY_TOKEN") {
      tokenReplaced = true;
      return `CAREERRAT_AI_PROXY_TOKEN=${tok}`;
    }
    return entry.raw !== undefined ? entry.raw : `${entry.key}=${entry.value}`;
  });
  if (!urlReplaced) nextLines.push(`CAREERRAT_AI_PROXY_URL=${url}`);
  if (!tokenReplaced) nextLines.push(`CAREERRAT_AI_PROXY_TOKEN=${tok}`);

  // Trim trailing blank lines from the round-tripped content, then end with
  // exactly one newline.
  while (nextLines.length > 0 && nextLines[nextLines.length - 1] === "") {
    nextLines.pop();
  }
  const text = `${nextLines.join("\n")}\n`;

  writeFileSync(path, text, "utf8");
  chmodSync(path, 0o600);

  env.CAREERRAT_AI_PROXY_URL = url;
  env.CAREERRAT_AI_PROXY_TOKEN = tok;
  return { ok: true, path };
}
