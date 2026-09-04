#!/usr/bin/env node
// Keeps root package.json's `allowScripts` block honest against
// package-lock.json without relying on a human running
// `npm install-scripts ls` by hand on every deps PR. Renovate bumps a
// dependency's version but never touches `allowScripts`, so an approval can
// silently stop matching (a stale policy key) while a newly-added package
// with its own install script goes unreviewed (uncovered).
//
// This is deliberately NOT a reimplementation of npm's allowScripts
// semantics. Three review passes (see /tmp/codex-305-r3.md) found real
// divergences between a hand-rolled matcher and npm's actual behavior:
// manifest-name spoofing, workspace glob edge cases, hosted-git
// canonicalization, gypfile:false, bundled/platform-inert deps, and more.
// Every one of those is npm's own decided semantics living in
// @npmcli/arborist, so this checker loads the real dependency tree with
// Arborist and reuses arborist's own identity matcher (script-allowed.js)
// and its own install-script enumeration/walk (unreviewed-scripts.js),
// the exact code `npm ci --strict-allow-scripts` and `npm rebuild
// --strict-allow-scripts` run internally. Only two small islands stay
// hand-written below: stale-key reporting (a workflow-hygiene feature, not
// something npm ships) and a platform-inert check for `--lock-only` mode
// (loadVirtual never computes `node.inert`, see comment below).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Arborist from "@npmcli/arborist";
// The same install-relevant-script enumerator `collectUnreviewedScripts`
// itself calls (explicit preinstall/install/postinstall, prepare on a
// non-registry source, and the synthetic node-gyp hook for an on-disk
// binding.gyp) — reused below to decide whether a policy key's matched node
// is still live, not just present. It reads `node.path` off the filesystem
// directly for the node-gyp check, so calling it on a *virtual*-tree node
// still finds a real on-disk binding.gyp when the package is actually
// installed (actual-tree implicit scripts), while a lockfile
// `hasInstallScript: true` flag with no script body on disk still resolves
// to a non-empty sentinel (see install-scripts.js's own fallback), which is
// what makes a virtual-tree-only platform-specific package still count as
// live.
import { getInstallScripts } from "@npmcli/arborist/lib/install-scripts.js";
// Deep imports into @npmcli/arborist's internals, not its public API
// (`lib/index.js` only exports the Arborist class). Both files are pure,
// dependency-free `module.exports` (no state tied to an Arborist instance),
// and are the literal modules `npm ci --strict-allow-scripts` and `npm
// rebuild --strict-allow-scripts` import from lib/utils/check-allow-scripts.js
// and lib/utils/strict-allow-scripts-preflight.js in the npm CLI itself.
// @npmcli/arborist's package.json has no "exports" map restricting subpath
// imports (verified against the installed 10.0.2: `main` only), so this is
// stable for as long as the file names are; the exact-pinned devDependency
// (not a range) is what makes a future rename a loud install-time surprise
// instead of a silent break.
import {
  getTrustedRegistryIdentity,
  isExactVersionDisjunction,
  matches,
  resolvedSourceSpecs,
} from "@npmcli/arborist/lib/script-allowed.js";
import { collectUnreviewedScripts } from "@npmcli/arborist/lib/unreviewed-scripts.js";
import npa from "npm-package-arg";
import semver from "semver";

const root = join(fileURLToPath(new URL("..", import.meta.url)));

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Human-readable description of a bad allowScripts value, for the throw
// message below.
function describeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
  return `the ${typeof value} ${JSON.stringify(value)}`;
}

// npm's own allowScripts matcher (@npmcli/arborist's script-allowed.js)
// recognizes only a literal `true` or `false` as a reviewed decision;
// anything else is ignored by npm entirely (`value === true` /
// `value === false` are the only branches that set anyAllow/anyDeny). npm's
// own `resolveAllowScripts` is more lenient: it warns and silently drops a
// bad entry rather than failing the install. This checker fails closed
// instead, since the whole point of running it in CI is to catch the cases
// a human reviewer would miss, not to match npm's leniency for a one-off
// `npm install`.
function validateAllowScripts(allowScripts) {
  if (allowScripts === undefined) return {};
  if (!isPlainObject(allowScripts)) {
    throw new Error(
      `root package.json's allowScripts must be a plain object mapping policy keys to true/false; got ${describeType(
        allowScripts
      )}`
    );
  }
  for (const [key, value] of Object.entries(allowScripts)) {
    if (value !== true && value !== false) {
      throw new Error(
        `root package.json's allowScripts["${key}"] must be strictly true or false (npm only recognizes ` +
          `a literal boolean as a reviewed decision); got ${describeType(value)}`
      );
    }
  }
  return allowScripts;
}

// Explains, when possible, WHY a stale key (one npm's own `matches` never
// matches against anything currently installed) is stale. Mirrors the npm
// CLI's own `resolveAllowScripts`'s `validatePolicy`
// (lib/utils/resolve-allow-scripts.js:36-79 in the installed npm 11.19.0,
// not part of @npmcli/arborist so it can't be imported, ported here): npm
// silently drops a policy key shaped as a dist-tag (`pkg@latest`) or a
// semver range (`pkg@^1.0.0`) rather than ever matching it against
// anything, the same outcome as a key for a dependency that was removed,
// but a different root cause worth telling a human apart from the other
// one. Returns `null` when the key's shape isn't the reason it's stale (a
// well-formed key for a dependency that's genuinely gone, or a non-registry
// key, which this shape check doesn't apply to).
function describeStaleKeyShapeProblem(key) {
  let parsed;
  try {
    parsed = npa(key);
  } catch (err) {
    return `not a spec npm-package-arg can parse (${err.message})`;
  }
  if (parsed.type === "tag") {
    return "a dist-tag spec (@latest, @next, ...); npm never matches a policy key against a moving tag, use an exact version or the bare package name";
  }
  if (parsed.type === "version" && semver.valid(parsed.fetchSpec) === null) {
    return `pinned to "${parsed.fetchSpec}", which semver doesn't recognize as a version`;
  }
  if (parsed.type === "range") {
    const isNameOnly = parsed.fetchSpec === "*" || parsed.rawSpec === "" || parsed.rawSpec === "*";
    if (!isNameOnly && !isExactVersionDisjunction(parsed.fetchSpec)) {
      return 'a semver range (^, ~, >=, <, ...); npm only matches an exact version, exact versions joined by "||", or the bare name';
    }
  }
  return null;
}

// A resolved value already carrying a scheme prefix (`file:`, `git:`,
// `git+ssh:`, `https:`, ...) is displayed as-is; arborist's own
// `consistentResolve` guarantees a file/directory node's own resolved value
// is always `file:<path>` already (script-allowed.js's matchFileOrDir relies
// on the same guarantee). Only arborist's raw filesystem-path fallbacks
// (`node.realpath`/`node.path`, used when no resolved value exists at all)
// have no scheme, so those get a synthesized `file:` prefix. This is purely
// cosmetic. Matching is entirely npm's own (`matches`/`isScriptAllowed`
// below), this only decides how an already-classified result is printed.
const SCHEME_PREFIX_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

// Human-readable identity for one arborist Node with an unreviewed install
// script, for the CI report. Registry packages report as `name@version`
// using npm's own trusted identity (the resolved tarball URL, never the
// tarball's self-reported package.json, see script-allowed.js's
// getTrustedRegistryIdentity); everything else reports its resolved source
// (a git/remote URL, or a file/directory dependency's `file:<path>`, as-is),
// via arborist's own `resolvedSourceSpecs`, which also recovers a file
// dependency's spec from its incoming Link when the target node's own
// `resolved` is null.
function describeUnreviewedNode(node) {
  if (node.isRegistryDependency) {
    const trusted = getTrustedRegistryIdentity(node);
    const name = trusted?.name ?? node.packageName ?? node.name;
    const version = trusted?.version ?? (node.version || null);
    return version ? `${name}@${version}` : name;
  }
  const [primary] = resolvedSourceSpecs(node);
  if (!primary) return node.name ?? "(unknown package)";
  return SCHEME_PREFIX_PATTERN.test(primary) ? primary : `file:${primary}`;
}

// Ported from npm-install-checks@9.0.0's checkPlatform/checkList
// (node_modules/npm-install-checks/lib/index.js:23-79): os/cpu matching
// only, libc intentionally omitted (low incidence here, and correct libc
// detection needs reading /etc/os-release, not worth the added surface for
// this checker). Not imported directly because npm-install-checks is only a
// transitive dependency of @npmcli/arborist, not one of the three pinned
// here; its API is small and stable enough to port faithfully instead.
//
// Needed only for `--lock-only` (loadVirtual): a virtual tree never computes
// arborist's own `node.inert` flag (that only happens while building an
// ideal tree, i.e. during real dependency resolution), so a win32-only
// optional dependency shows up as a normal node even on Linux. `loadActual`
// doesn't need this at all. A platform-incompatible optional dependency is
// simply never written to node_modules by a real `npm ci`, so it's already
// absent from the actual tree this checker walks in CI.
function platformListMatches(current, list) {
  const entries = Array.isArray(list) ? list : [list];
  if (entries.length === 1 && entries[0] === "any") return true;
  let negated = 0;
  let match = false;
  for (const entry of entries) {
    const negate = entry.charAt(0) === "!";
    const test = negate ? entry.slice(1) : entry;
    if (negate) {
      negated++;
      if (current === test) return false;
    } else {
      match = match || current === test;
    }
  }
  return match || negated === entries.length;
}

function isPlatformInert(node) {
  if (!node.optional) return false;
  const pkg = node.package || {};
  const osOk = pkg.os ? platformListMatches(process.platform, pkg.os) : true;
  const cpuOk = pkg.cpu ? platformListMatches(process.arch, pkg.cpu) : true;
  return !(osOk && cpuOk);
}

// Core check: loads the real dependency tree with Arborist and reports (a)
// stale policy keys that npm's own matcher (`matches`) doesn't match against
// anything currently in the tree, and (b) installed packages with an
// install-relevant script that npm's own walk (`collectUnreviewedScripts`)
// finds isn't covered (or explicitly denied) by `allowScripts`.
//
// `root` is required: this reads package.json and package-lock.json from
// disk and, for `loadActual`, walks the real node_modules tree. When
// node_modules is present (and `lockOnly` isn't set), this inspects the
// actual installed tree, matching what `npm ci`/`npm rebuild` actually see,
// including binding.gyp, prepare scripts on non-registry deps, and workspace
// resolution, all via arborist itself. Without node_modules, this fails
// closed unless `lockOnly` is set, in which case it falls back to the
// lockfile-only virtual tree (`loadVirtual`), which can't see an on-disk
// binding.gyp or read an installed non-registry dependency's real
// scripts.prepare body (arborist gracefully degrades to a "scripts present"
// sentinel there, same as npm's own `install-scripts ls` does).
export async function checkInstallScripts({ allowScripts, root, lockOnly = false }) {
  const allow = validateAllowScripts(allowScripts);

  if (existsSync(join(root, "npm-shrinkwrap.json"))) {
    throw new Error(
      "npm-shrinkwrap.json is present at the repo root; npm prefers it over package-lock.json during " +
        "install, so this checker's package-lock.json read would validate a different graph than npm " +
        "actually installs. It is not a canonical lockfile here, remove it, or fold its contents back " +
        "into package-lock.json."
    );
  }

  const nodeModulesPresent = existsSync(join(root, "node_modules"));
  if (!nodeModulesPresent && !lockOnly) {
    throw new Error(
      "node_modules is missing; this checker inspects the real installed dependency tree (via " +
        "@npmcli/arborist) for scripts a lockfile-only read can't see, such as an implicit node-gyp " +
        "build or a non-registry dependency's real prepare script body, so it must run after npm ci. " +
        "Pass --lock-only to check the lockfile alone (not used in CI)."
    );
  }

  const arb = new Arborist({ path: root });
  let tree;
  let staleKeyTree;
  try {
    const actualMode = nodeModulesPresent && !lockOnly;
    tree = actualMode ? await arb.loadActual() : await arb.loadVirtual();
    // Stale-key matching always runs against the lockfile's virtual tree, not
    // whichever tree `tree` above ended up being. In actual mode, `loadActual`
    // only reflects what's really on disk, and a platform-specific optional
    // dependency (e.g. macOS-only fsevents) is legitimately absent from
    // node_modules on a Linux or Windows CI runner. Matching stale keys
    // against that tree would report every approved platform-only key as
    // stale on every job that isn't the matching platform. `loadVirtual`
    // reflects every package the lockfile records regardless of platform, so
    // an approved key that's genuinely gone from the dependency graph (not
    // just absent from this OS's install) is still correctly flagged.
    // Arborist caches loadActual/loadVirtual separately on the instance
    // (this.actualTree / this.virtualTree), so calling both is safe and
    // doesn't re-walk or invalidate the first.
    staleKeyTree = actualMode ? await arb.loadVirtual() : tree;
  } catch (err) {
    throw new Error(
      `could not load the dependency tree from ${root} (${err.message}); this checker requires a valid ` +
        "package-lock.json (lockfileVersion >= 2, produced by a current npm). Regenerate the lockfile " +
        "with a current npm."
    );
  }
  // Re-derived (not read off the try block above, which scopes its own
  // `const`): needed again below to decide where stale-key liveness reads
  // its scripts from.
  const actualMode = nodeModulesPresent && !lockOnly;

  // Same eligibility filter collectUnreviewedScripts applies below (project
  // root, workspaces, and linked workspace deps are managed by the workspace
  // owner, not allowScripts) plus its bundled-node exclusion: npm never runs
  // a bundled dependency's own install scripts and it can't be allowlisted
  // (unreviewed-scripts.js), so a bundled package's script can't make a
  // policy key "live" either. Without this, a broad approval that only
  // happens to match a bundled scripted dependency (e.g. `foo: true` where
  // `foo` ships bundled inside another package) stayed non-stale forever,
  // even though npm's own strict-allow-scripts never consults it, and a
  // future standalone `foo` with the same script would be silently
  // pre-authorized by the retained approval.
  const staleKeyNodes = [...staleKeyTree.inventory.values()].filter(
    (node) => !node.isProjectRoot && !node.isWorkspace && !node.isLink && !node.inBundle
  );

  // A policy key is only "matched" (not stale) by a node that currently
  // carries an install-relevant script. Matching on presence alone let a
  // broad approval (`foo: true`) survive after `foo` dropped its script,
  // silently pre-authorizing whatever lifecycle code a future version of
  // `foo` reintroduces. getInstallScripts is the same enumerator
  // collectUnreviewedScripts uses below for the uncovered check, so "live"
  // here means the same thing npm's own `--strict-allow-scripts` would run.
  //
  // Codex review /tmp/codex-305-r9.md (finding 2): identity still comes from
  // the virtual-tree node above (staleKeyNodes) so a platform-pruned
  // dependency (e.g. macOS-only fsevents, absent from node_modules on this
  // CI runner) is still checked against the full lockfile graph. But
  // liveness must not be read off that same virtual node ALONE in actual
  // mode: the lockfile's `hasInstallScript` flag never covers `prepare`
  // (only preinstall/install/postinstall set it), and lock metadata carries
  // no script bodies at all, so a Git dependency whose only
  // install-relevant script is `prepare` reads as scriptless on its virtual
  // node even though the real, installed package on disk genuinely has one.
  // That falsely stales its approval and fails every gated CI job for a
  // legitimately reviewed prepare-only Git dependency.
  //
  // This is a union, not a swap: the corresponding installed (actual) node
  // is checked ONLY when the virtual node itself reports no scripts, and
  // the virtual node's own result is kept if it already found something.
  // A straight swap to "always prefer the actual node in actual mode" was
  // tried and reverted — this repo's own node_modules/.package-lock.json
  // (npm's "hidden lockfile") makes arborist's loadActual() rebuild the
  // installed tree from that hidden lockfile rather than genuinely
  // rescanning disk, and the hidden lockfile does not carry
  // `hasInstallScript` at all. A straight swap read that missing flag off
  // the actual node for fsevents (a real, currently-approved dependency in
  // this repo's own package.json) and wrongly staled it, even though the
  // package is genuinely installed with its script intact. Checking the
  // actual node only as a fallback keeps that existing, disk-verified
  // virtual-node path (and its own node.path-based disk fallback below)
  // working exactly as before, while still catching the prepare-only case
  // the virtual node alone cannot see.
  const liveStaleKeyNodes = [];
  for (const node of staleKeyNodes) {
    let scripts = await getInstallScripts(node);
    if (Object.keys(scripts).length === 0 && actualMode) {
      const liveNode = tree.inventory.get(node.location);
      if (liveNode) scripts = await getInstallScripts(liveNode);
    }
    if (Object.keys(scripts).length > 0) liveStaleKeyNodes.push(node);
  }

  const staleKeys = [];
  for (const [key, value] of Object.entries(allow)) {
    // Pass deny intent so matchRegistry can fail closed on an unverifiable
    // version (omit-lockfile-registry-resolved): a deny entry with no
    // trusted version still counts as matched, mirroring npm's own
    // isScriptAllowed semantics in script-allowed.js. Matching an allow
    // entry (value === true) always fails open here, same as npm.
    const matchedAny = liveStaleKeyNodes.some((node) => matches(node, key, value === false));
    if (!matchedAny) staleKeys.push(key);
  }
  staleKeys.sort();

  const unreviewed = await collectUnreviewedScripts({ tree, policy: allow });
  const uncovered = unreviewed
    .filter(({ node }) => !isPlatformInert(node))
    .map(({ node }) => describeUnreviewedNode(node));
  uncovered.sort();

  return { staleKeys, uncovered, ok: staleKeys.length === 0 && uncovered.length === 0 };
}

async function main() {
  const lockOnly = process.argv.slice(2).includes("--lock-only");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  let result;
  try {
    result = await checkInstallScripts({ allowScripts: pkg.allowScripts, root, lockOnly });
  } catch (err) {
    console.error(`check:install-scripts: ${err.message}`);
    process.exit(1);
  }

  const { staleKeys, uncovered, ok } = result;

  if (ok) {
    console.log(
      "check:install-scripts: allowScripts matches package-lock.json, nothing stale or uncovered"
    );
    process.exit(0);
  }

  console.error(
    "check:install-scripts: root package.json's allowScripts is out of sync with package-lock.json"
  );
  if (staleKeys.length > 0) {
    console.error("");
    console.error(
      "Stale keys (npm's own matcher doesn't match anything currently installed; the dependency moved or was removed, so prune or update the key):"
    );
    for (const key of staleKeys) {
      const shapeProblem = describeStaleKeyShapeProblem(key);
      console.error(
        shapeProblem ? `  - ${key} (npm ignores this key: ${shapeProblem})` : `  - ${key}`
      );
    }
  }
  if (uncovered.length > 0) {
    console.error("");
    console.error(
      "Uncovered packages (install script found, no allowScripts entry; review with npm install-scripts ls):"
    );
    for (const entry of uncovered) console.error(`  - ${entry}`);
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
