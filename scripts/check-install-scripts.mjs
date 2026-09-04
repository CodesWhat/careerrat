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
// repo has none).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));

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

// Walks package-lock.json's `packages` map and returns every installed
// dependency's name/version, plus which `name@version` pairs declare an
// install script. Workspace entries (the root `""` key and `apps/*`, which
// don't live under `node_modules/`) and workspace symlinks (`link: true`)
// are skipped: they're this repo's own packages, never something
// `allowScripts` needs to cover.
function collectInstalledPackages(lockPackages) {
  const installedVersions = new Map(); // name -> Set(version)
  const installedWithScripts = new Set(); // "name@version"

  for (const [pkgPath, pkg] of Object.entries(lockPackages ?? {})) {
    if (!pkgPath.startsWith("node_modules/") || pkg.link) continue;
    const version = pkg.version;
    if (!version) continue;
    const name =
      pkg.name ?? pkgPath.slice(pkgPath.lastIndexOf("node_modules/") + "node_modules/".length);

    if (!installedVersions.has(name)) installedVersions.set(name, new Set());
    installedVersions.get(name).add(version);
    if (pkg.hasInstallScript) installedWithScripts.add(`${name}@${version}`);
  }

  return { installedVersions, installedWithScripts };
}

// Core check: given the root package.json's `allowScripts` block and
// package-lock.json's `packages` map, reports (a) stale pinned keys that
// name a version no longer in the lockfile, and (b) installed packages with
// an install script that no allowScripts entry (pinned or bare-name) covers.
export function checkInstallScripts({ allowScripts, lockPackages }) {
  const allow = allowScripts ?? {};
  const { pinned, bareNames } = splitAllowScriptsKeys(allow);
  const { installedVersions, installedWithScripts } = collectInstalledPackages(lockPackages);

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
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

  const { staleKeys, uncovered, ok } = checkInstallScripts({
    allowScripts: pkg.allowScripts,
    lockPackages: lock.packages,
  });

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
