// npm-cli-definitions.mjs — the real loader for npm's own @npmcli/config
// option and shorthand definitions, plus parseNpmArgv, which hands them
// straight to npm's own argument parser (`nopt`) instead of re-deriving
// npm's option-classification rules by hand. Extracted out of
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
import nopt from "nopt";

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

// Codex review /tmp/codex-305-r13.md (findings 3 and 4): the hand-rolled
// value-taking-option classifier this file used to export
// (isPureBooleanOptionType / computeNpmValueOptions) reduced every npm
// option's `type` to a binary "always consumes a following token" versus
// "never does", then had its own caller re-derive grouped-short expansion
// and shorthand precedence on top of that binary set by hand. Real npm
// options don't fit a binary split: `foreground-scripts` is `type:
// Boolean` but still consumes an explicit `true`/`false` token when one is
// given (`npm --foreground-scripts true ci`), and `-ca cert.pem` /
// `-call x` are exact, multi-letter option names of their own (`-c`
// doesn't exist standalone the way the old grouped-short expander assumed
// every multi-letter dash token must be one-character-per-flag), so the
// hand-rolled classifier either ate the wrong token or expanded the wrong
// thing and walked straight past the `ci` that followed. npm's own CLI
// resolves every one of these correctly because it never classifies
// options itself at all — it hands the exact same `types`/`shorthands`
// definitions this module already loads straight to `nopt`, npm's own
// parser (`nopt` is already in the lockfile as @npmcli/config's own
// parser dependency; pinned here as a direct, exact devDependency at the
// same version, see package.json). Fix: stop re-deriving option
// classification by hand and call the real parser with the real
// definitions instead.
//
// `nopt(types, shorthands, argv, 0)` parses `argv` (the tokens after the
// leading `npm` token itself, not including it — the `0` means "don't
// slice off a node/script-path prefix, `argv` is already just the
// arguments") against `types` (each definition's own `type` shape, keyed
// by long option name, exactly as npm's own CLI builds it from these same
// definitions) and `shorthands` (@npmcli/config's own standalone alias
// table, loaded alongside `definitions` above). `parsed.argv.remain` is
// whatever positional
// (non-option) tokens are left once every recognized option and its value
// (if any) have been consumed — for an npm invocation, `remain[0]` is the
// command word, exactly as npm's own CLI reads it off its own parsed argv
// before resolving it through cmd-list.js's `deref` (see
// tests/release-gating-ci.test.mjs's derefNpmCommand for that half).
export function buildNpmOptionTypes(definitions) {
  const types = {};
  for (const [key, def] of Object.entries(definitions)) {
    types[key] = def.type;
  }
  return types;
}

export function parseNpmArgv(argv) {
  const { definitions, shorthands } = loadNpmConfigDefinitions();
  return nopt(buildNpmOptionTypes(definitions), shorthands, argv, 0);
}
