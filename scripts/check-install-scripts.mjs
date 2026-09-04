#!/usr/bin/env node
// Keeps root package.json's `allowScripts` block honest against
// package-lock.json without relying on a human running
// `npm install-scripts ls` by hand on every deps PR. Renovate bumps a
// dependency's version but never touches `allowScripts`, so an approval can
// silently stop matching (a stale `name@version` key) while a newly-added
// package with its own install script goes unreviewed (uncovered).
//
// "Has install scripts" is decided the same way npm's own `install-scripts`
// command decides it for a registry dependency: package-lock.json's
// `hasInstallScript` flag, which npm sets from preinstall/install/postinstall
// (verified against this tree: `npm install-scripts ls` and the lockfile's
// flag agree on every registry package here; the extra `prepare`-script
// entries `ls` also reports only matter for non-registry sources, and this
// repo has none), OR'd with an on-disk `binding.gyp` check: npm synthesizes
// `node-gyp rebuild` for a package that ships `binding.gyp` with no explicit
// install script, and the lockfile has no flag for that. The disk check needs
// `npm ci` to have already run, so it fails closed (non-zero exit) when
// `node_modules` is missing unless `--lock-only` is passed; the CI step never
// passes that flag.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));

// Falls back to the installed path when a lockfile entry omits `name` (the
// common case for an unaliased registry dependency, where npm leaves it
// implicit because it matches the directory). Under a `node_modules/`
// segment this recovers the real (possibly scoped) name the way npm's own
// directory layout does; outside one (a workspace-like file-link target)
// it's just the last path segment.
function deriveNameFromPath(path) {
  const nodeModulesAt = path.lastIndexOf("node_modules/");
  if (nodeModulesAt !== -1) return path.slice(nodeModulesAt + "node_modules/".length);
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? path : path.slice(lastSlash + 1);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Splits an `allowScripts` object into the two key shapes npm's own
// `install-scripts approve|deny` writes: a pinned `name@version` key (covers
// that exact version only) and a bare `name` key (covers every version,
// `true` to allow or `false` to record a reviewed denial).
function splitAllowScriptsKeys(allowScripts) {
  const pinned = new Set();
  const bareNames = new Set();
  for (const key of Object.keys(allowScripts)) {
    const at = key.lastIndexOf("@");
    if (at > 0) {
      pinned.add(key);
    } else {
      bareNames.add(key);
    }
  }
  return { pinned, bareNames };
}

// Turns one root package.json `workspaces` glob (npm only ever uses simple
// segments and `*`/`**`, never full minimatch) into a RegExp.
function globToRegExp(glob) {
  const pattern = glob
    .split("/")
    .map((segment) =>
      segment === "**" ? ".*" : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")
    )
    .join("/");
  return new RegExp(`^${pattern}$`);
}

// A lockfile path counts as a real workspace member only when it matches
// root package.json's `workspaces` globs (or is the root package itself,
// `""`). That distinction matters because a `link: true` node can also point
// at a plain `file:` dependency living outside `node_modules/` (e.g. a path
// under `packages/` that isn't declared as a workspace), that target is an
// installed dependency this check still needs to inspect, not a workspace to
// skip.
function collectWorkspacePaths(lockPackages, workspaces) {
  const patterns = (workspaces ?? []).map(globToRegExp);
  const set = new Set([""]);
  for (const pkgPath of Object.keys(lockPackages)) {
    if (pkgPath === "" || pkgPath.includes("node_modules/")) continue;
    if (patterns.some((re) => re.test(pkgPath))) set.add(pkgPath);
  }
  return set;
}

// Walks package-lock.json's `packages` map and returns every installed
// dependency's name/version, plus which `name@version` pairs declare an
// install script (from the lockfile's `hasInstallScript` flag, or a
// `binding.gyp` found on disk). Any path with a `node_modules/` segment
// counts as installed, whether that's directly under the repo root, nested
// under another dependency, or nested under a workspace member (e.g.
// `apps/website/node_modules/@types/node`), only the bare workspace paths
// themselves (`""`, `apps/*`, ...) are this repo's own packages and skipped.
// A `link: true` node that resolves to a real workspace is skipped the same
// way; a `link: true` node that resolves anywhere else (a `file:` dependency)
// is followed to its target and that target is inspected instead.
function collectInstalledPackages(lockPackages, { workspacePaths, checkBindingGyp }) {
  const installedVersions = new Map(); // name -> Set(version)
  const installedWithScripts = new Set(); // "name@version"

  for (const [pkgPath, pkg] of Object.entries(lockPackages)) {
    if (!pkgPath.includes("node_modules/")) continue;

    let inspectPath = pkgPath;
    let inspectPkg = pkg;

    if (pkg.link) {
      const target = pkg.resolved;
      if (target && workspacePaths.has(target)) continue;
      if (!target || !lockPackages[target]) continue; // dangling or unresolved link
      inspectPath = target;
      inspectPkg = lockPackages[target];
    }

    const version = inspectPkg.version;
    if (!version) continue;
    const name = inspectPkg.name ?? deriveNameFromPath(inspectPath);

    if (!installedVersions.has(name)) installedVersions.set(name, new Set());
    installedVersions.get(name).add(version);

    const hasScript = Boolean(inspectPkg.hasInstallScript) || checkBindingGyp(inspectPath);
    if (hasScript) installedWithScripts.add(`${name}@${version}`);
  }

  return { installedVersions, installedWithScripts };
}

// Core check: given the root package.json's `allowScripts` block and
// package-lock.json's `packages` map, reports (a) stale pinned keys that
// name a version no longer in the lockfile, and (b) installed packages with
// an install script that no allowScripts entry (pinned or bare-name) covers.
//
// `root` and `workspaces` are optional and enable the on-disk checks: when
// `root` is given, this also rejects a competing npm-shrinkwrap.json and, on
// a present `node_modules`, folds in the binding.gyp scan; when `node_modules`
// is absent it fails closed unless `lockOnly` is set. Callers that only want
// the pure lockfile-vs-allowScripts comparison (tests, mainly) can omit
// `root` entirely and none of that runs.
export function checkInstallScripts({
  allowScripts,
  lockPackages,
  root,
  workspaces,
  lockOnly = false,
}) {
  if (!isPlainObject(lockPackages)) {
    throw new Error(
      "package-lock.json has no packages map to check (lockfileVersion 1, or a malformed lockfile); " +
        "this checker requires lockfileVersion >= 2. Regenerate the lockfile with a current npm."
    );
  }

  if (root && existsSync(join(root, "npm-shrinkwrap.json"))) {
    throw new Error(
      "npm-shrinkwrap.json is present at the repo root; npm prefers it over package-lock.json during " +
        "install, so this checker's package-lock.json read would validate a different graph than npm " +
        "actually installs. It is not a canonical lockfile here, remove it, or fold its contents back " +
        "into package-lock.json."
    );
  }

  let checkBindingGyp = () => false;
  if (root) {
    const nodeModulesPresent = existsSync(join(root, "node_modules"));
    if (!nodeModulesPresent && !lockOnly) {
      throw new Error(
        "node_modules is missing; this checker inspects installed packages on disk for implicit " +
          "node-gyp scripts (binding.gyp) that package-lock.json can't show, so it must run after " +
          "npm ci. Pass --lock-only to check the lockfile alone (not used in CI)."
      );
    }
    if (nodeModulesPresent && !lockOnly) {
      checkBindingGyp = (pkgPath) => existsSync(join(root, pkgPath, "binding.gyp"));
    }
  }

  const allow = allowScripts ?? {};
  const { pinned, bareNames } = splitAllowScriptsKeys(allow);
  const workspacePaths = collectWorkspacePaths(lockPackages, workspaces);
  const { installedVersions, installedWithScripts } = collectInstalledPackages(lockPackages, {
    workspacePaths,
    checkBindingGyp,
  });

  const staleKeys = [];
  for (const key of pinned) {
    const at = key.lastIndexOf("@");
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (!installedVersions.get(name)?.has(version)) staleKeys.push(key);
  }
  staleKeys.sort();

  const uncovered = [];
  for (const nameVersion of installedWithScripts) {
    const at = nameVersion.lastIndexOf("@");
    const name = nameVersion.slice(0, at);
    if (pinned.has(nameVersion) || bareNames.has(name)) continue;
    uncovered.push(nameVersion);
  }
  uncovered.sort();

  return { staleKeys, uncovered, ok: staleKeys.length === 0 && uncovered.length === 0 };
}

function main() {
  const lockOnly = process.argv.slice(2).includes("--lock-only");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

  let result;
  try {
    result = checkInstallScripts({
      allowScripts: pkg.allowScripts,
      lockPackages: lock.packages,
      workspaces: pkg.workspaces,
      root,
      lockOnly,
    });
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
      "Stale keys (no matching name@version in package-lock.json; the dependency moved, so prune or update the key):"
    );
    for (const key of staleKeys) console.error(`  - ${key}`);
  }
  if (uncovered.length > 0) {
    console.error("");
    console.error(
      "Uncovered packages (install script found in package-lock.json, no allowScripts entry; review with npm install-scripts ls):"
    );
    for (const entry of uncovered) console.error(`  - ${entry}`);
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
