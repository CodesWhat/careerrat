// npm-cli-definitions.mjs — the real loader for npm's own @npmcli/config
// option and shorthand definitions, plus the classification helpers that
// turn them into a value-taking-flag set. Extracted out of
// release-gating-ci.test.mjs (Codex review /tmp/codex-305-r12.md, finding
// 2) so the empty-COREPACK_HOME regression there can spawn a fresh node
// process that imports and calls this ACTUAL module, instead of a
// hardcoded `require()` of the same path duplicated inline in the child
// script. Before this split, a future regression that reintroduced a
// Corepack-cache probe into the real loader could still pass that
// regression, because the spawned child never touched this function at
// all — it re-required the definitions module directly and proved
// nothing about loadNpmConfigDefinitions itself.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Codex review /tmp/codex-305-r11.md (finding 1): this used to require
// either a hoisted node_modules/@npmcli/config or Corepack's own install
// cache for the pinned npm release. The CI verification job happens to seed
// that cache (it runs `npm --version` through Corepack before this suite
// runs), but the macOS desktop-release job runs bundled `npm ci` followed
// directly by `release:pretag` without ever invoking Corepack, and a fresh
// developer machine using bundled npm has neither — both threw before this
// suite ever registered a single test. Fix: @npmcli/config is now a plain,
// exact-pinned devDependency (see package.json), so this is a normal
// `require`, no filesystem probing or Corepack cache needed at all.
const NPM_CONFIG_DEFINITIONS_SPECIFIER = "@npmcli/config/lib/definitions/index.js";

export function loadNpmConfigDefinitions() {
  return require(NPM_CONFIG_DEFINITIONS_SPECIFIER);
}

// The absolute on-disk path the loader above actually resolved. Exists so
// the empty-COREPACK_HOME regression can assert the real loader landed
// inside this project's own node_modules/@npmcli/config — the exact
// failure mode it exists to catch is a probe silently falling back to
// Corepack's separate install cache instead.
export function resolveNpmConfigDefinitionsPath() {
  return require.resolve(NPM_CONFIG_DEFINITIONS_SPECIFIER);
}

// The installed @npmcli/config package's own version, read off its
// package.json the same way its identity would actually be verified,
// rather than trusting the "^" range in this project's own package.json.
export function installedNpmConfigVersion() {
  return require("@npmcli/config/package.json").version;
}

// npm's own boolean-flag type shapes (@npmcli/config's Definition.type):
// either the bare `Boolean` constructor, or an array whose only non-`null`
// member is `Boolean` (npm uses `null` in a type array to mean "also
// accepts being unset", e.g. `workspaces`'s `[null, Boolean]` — still a
// standalone flag, not a value-taking one). Anything else in the type
// (String, Number, Array, an enumerated set of string literals like
// `install-strategy`'s `['hoisted', 'nested', 'shallow', 'linked']`, ...)
// means the option consumes a value. Verified against the pinned npm
// 12.0.2's own node_modules/@npmcli/config/lib/definitions/definitions.js:
// `foreground-scripts: { type: Boolean }` (pure), `workspaces: { type:
// [null, Boolean] }` (pure, confirmed boolean-only in practice: `npm test
// --workspaces` never consumes a following token as its value), `omit:
// { type: [Array, 'dev', 'optional', 'peer'] }` (value-taking).
export function isPureBooleanOptionType(type) {
  if (type === Boolean || type === null) return true;
  if (Array.isArray(type)) return type.every((t) => t === Boolean || t === null);
  return false;
}

// Codex review /tmp/codex-305-r10.md (finding 2): the nine-entry hand list
// that used to live here only covered the options this repo's workflow
// happened to use. Any other npm 12 global option that takes a
// separate-token value hid an unguarded `npm ci` just as completely. Fix:
// load the *real* value-taking option set from the pinned npm's own
// @npmcli/config definitions (npm's own source of truth for which options
// take a value, `type` !== a purely-boolean shape) instead of
// hand-listing it, so a future npm option is covered automatically the
// next time the pin moves.
export function computeNpmValueOptions(definitions) {
  const flags = new Set();
  for (const [key, def] of Object.entries(definitions)) {
    if (isPureBooleanOptionType(def.type)) continue;
    flags.add(`--${key}`);
    for (const short of [].concat(def.short ?? [])) {
      flags.add(`-${short}`);
    }
  }
  if (flags.size === 0) {
    throw new Error(
      "npm-cli-definitions.mjs: @npmcli/config's definitions loaded but produced no " +
        "value-taking options"
    );
  }
  return flags;
}
