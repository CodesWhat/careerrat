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
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));

// A resolved value starting with this is how npm/arborist always records a
// git dependency's lockfile URL (git://, git+ssh://, git+https://,
// git+file://): see @npmcli/arborist's script-allowed.js matchGit, which
// compares against exactly this shape.
const GIT_RESOLVED_PATTERN = /^git(\+[a-z]+)?:\/\//i;

// Registry tarballs live at `<host>/<pkg-name>/-/<pkg-name>-<version>.tgz`;
// requiring a path segment before `/-/` is the same guard
// @npmcli/arborist's script-allowed.js isRegistryNode uses so a hostile
// `https://evil.com/-/trusted-1.0.0.tgz` can't be lifted into a
// registry-style match. Anything `https?://` that fails this is a remote
// (arbitrary tarball URL) dependency, not a registry one.
const REGISTRY_TARBALL_PATTERN = /^https?:\/\/[^/]+\/.+\/-\/[^/]+-\d/;

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
// `value === false` are the only branches that set anyAllow/anyDeny). This
// checker's `splitAllowScriptsKeys`/`splitNonRegistryPolicyKeys` only look
// at key *presence*, so a non-boolean value (null, a string, a number, a
// nested object) would still silently count as "reviewed" here even though
// npm never treats it as one, so fail closed instead of matching npm's
// leniency, since the whole point of this checker is to catch the cases a
// human reviewer would miss.
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

// Strips a `file:` prefix (defensive; lockfile-recorded link targets never
// carry one) and normalizes the path the way npm-package-arg's `saveSpec`
// does for a file/directory spec: no leading `./`, `..` segments kept as-is,
// no trailing slash. Used on both sides of a file-dependency identity
// comparison so equivalent forms (`file:./pkg`, `file:pkg`, `pkg/`) agree.
function normalizeFileSpecPath(rawPath) {
  const withoutPrefix = rawPath.startsWith("file:") ? rawPath.slice("file:".length) : rawPath;
  return posix.normalize(withoutPrefix).replace(/\/+$/, "");
}

// Which of npm's allowScripts key shapes a policy key or a dependency's
// lockfile `resolved` value is. Mirrors @npmcli/arborist's script-allowed.js
// `matches()` switch: registry deps match by name(@version), non-registry
// sources (file/directory, git, remote tarball) match by resolved source
// identity instead, never by name.
function classifySpecType(spec) {
  if (spec.startsWith("file:")) return "file";
  if (GIT_RESOLVED_PATTERN.test(spec)) return "git";
  if (/^https?:\/\//i.test(spec) && !REGISTRY_TARBALL_PATTERN.test(spec)) return "remote";
  return "registry";
}

// Splits an `allowScripts` object into the two key shapes npm's own
// `install-scripts approve|deny` writes for a registry dependency: a pinned
// `name@version` key (covers that exact version only) and a bare `name` key
// (covers every version, `true` to allow or `false` to record a reviewed
// denial). Non-registry-shaped keys (`file:...`, a git URL, a remote tarball
// URL) are handled separately by `splitNonRegistryPolicyKeys`.
function splitAllowScriptsKeys(allowScripts) {
  const pinned = new Set();
  const bareNames = new Set();
  for (const key of Object.keys(allowScripts)) {
    if (classifySpecType(key) !== "registry") continue;
    const at = key.lastIndexOf("@");
    if (at > 0) {
      pinned.add(key);
    } else {
      bareNames.add(key);
    }
  }
  return { pinned, bareNames };
}

// Splits a git resolved URL (or a git-shaped policy key) into the URL
// without its trailing `#<committish>` and the committish itself (`""` when
// absent), the same way @npmcli/arborist's script-allowed.js matchGit reads
// `node.resolved` / a parsed policy key.
function splitGitCommittish(spec) {
  const hashIdx = spec.lastIndexOf("#");
  return hashIdx === -1
    ? { url: spec, committish: "" }
    : { url: spec.slice(0, hashIdx), committish: spec.slice(hashIdx + 1) };
}

// The non-registry counterpart of `splitAllowScriptsKeys`: pulls out
// `file:`, git, and remote-tarball policy keys into the shapes their
// respective coverage checks need. A file key is normalized so formatting
// variance (`file:./pkg` vs `file:pkg`) doesn't cause a false "uncovered".
function splitNonRegistryPolicyKeys(allowScripts) {
  const fileKeys = new Set();
  const remoteKeys = new Set();
  const gitKeys = [];
  for (const key of Object.keys(allowScripts)) {
    switch (classifySpecType(key)) {
      case "file":
        fileKeys.add(normalizeFileSpecPath(key));
        break;
      case "git":
        gitKeys.push(splitGitCommittish(key));
        break;
      case "remote":
        remoteKeys.add(key);
        break;
      default:
        break;
    }
  }
  return { fileKeys, remoteKeys, gitKeys };
}

// True when `dep`'s git identity (url + full resolved committish) is
// matched by at least one git policy key. A key with no committish covers
// every commit of that repo; a key with one covers only commits whose full
// resolved SHA starts with it (lockfile SHAs are full-length, policy keys
// are typically a short prefix), same asymmetry as
// @npmcli/arborist's script-allowed.js matchGit.
function gitKeyCovers(dep, gitKeys) {
  return gitKeys.some(({ url, committish }) => {
    if (url !== dep.url) return false;
    if (!committish) return true;
    return dep.committish.startsWith(committish);
  });
}

// Turns one root package.json `workspaces` glob segment (npm only ever uses
// simple segments and `*`/`**`, never full minimatch) into a RegExp. Any
// leading `!` (negation) is stripped by the caller before this runs.
function globToRegExp(glob) {
  const pattern = glob
    .split("/")
    .map((segment) =>
      segment === "**" ? ".*" : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")
    )
    .join("/");
  return new RegExp(`^${pattern}$`);
}

// This checker's supported glob subset: literal path segments plus `*`/`**`.
// Anything else (brace expansion, character classes, extglobs, `?`) is
// syntax `globToRegExp` can't match the way npm's real workspace resolution
// (@npmcli/map-workspaces, backed by minimatch/glob) would, so fail closed
// rather than silently mismatching which paths are workspaces.
function isSupportedGlobSyntax(pattern) {
  return /^[A-Za-z0-9_./*-]+$/.test(pattern);
}

// Parses one root package.json `workspaces` entry into its match sense
// (negated or not) and compiled pattern, following @npmcli/map-workspaces'
// own negation rule: a run of leading `!` negates when its length is odd
// (`!!foo` cancels back out to a positive match for `foo`), and a leading
// `./` or `/` is stripped before the pattern is compiled.
function classifyWorkspacePattern(rawGlob) {
  const exclMatch = rawGlob.match(/^!+/);
  const negate = Boolean(exclMatch) && exclMatch[0].length % 2 === 1;
  const stripped = exclMatch ? rawGlob.slice(exclMatch[0].length) : rawGlob;
  const pattern = stripped.replace(/^\.?\/+/, "");
  if (!isSupportedGlobSyntax(pattern)) {
    throw new Error(
      `workspaces glob "${rawGlob}" uses syntax this checker can't match faithfully against npm's own ` +
        "workspace resolution (only literal path segments and */** are supported); simplify the glob or " +
        "extend this checker before relying on it."
    );
  }
  return { negate, regExp: globToRegExp(pattern) };
}

// A lockfile path counts as a real workspace member only when it matches
// root package.json's `workspaces` globs (or is the root package itself,
// `""`). That distinction matters because a `link: true` node can also point
// at a plain `file:` dependency living outside `node_modules/` (e.g. a path
// under `packages/` that isn't declared as a workspace), that target is an
// installed dependency this check still needs to inspect, not a workspace to
// skip.
//
// Patterns are evaluated in declaration order and the last matching pattern
// wins, the same as @npmcli/map-workspaces: `["packages/*",
// "!packages/vendor-*"]` excludes `packages/vendor-native` even though the
// first pattern matches it, and a later positive pattern can re-include a
// path an earlier `!` pattern excluded.
function collectWorkspacePaths(lockPackages, workspaces) {
  const patterns = (workspaces ?? []).map(classifyWorkspacePattern);
  const set = new Set([""]);
  for (const pkgPath of Object.keys(lockPackages)) {
    if (pkgPath === "" || pkgPath.includes("node_modules/")) continue;
    let included = false;
    for (const { negate, regExp } of patterns) {
      if (regExp.test(pkgPath)) included = !negate;
    }
    if (included) set.add(pkgPath);
  }
  return set;
}

// Walks package-lock.json's `packages` map and buckets every installed
// dependency by source type, since npm's allowScripts identity rules differ
// per type (@npmcli/arborist's script-allowed.js `matches()`): a registry
// dependency is keyed by name(@version); file/directory, git, and remote
// (arbitrary tarball URL) dependencies are keyed by their resolved source
// identity instead: a stale or coincidentally-matching `name@version` entry
// must never count as reviewing one of those.
//
// "Has install scripts" for every type starts from the lockfile's
// `hasInstallScript` flag, OR'd with an on-disk `binding.gyp` check (npm
// synthesizes `node-gyp rebuild` for a package that ships one with no
// explicit install script). Non-registry sources add a third source: npm
// also runs `scripts.prepare` for file/directory, git, and remote
// dependencies specifically (unlike a registry install, where the published
// tarball is already "prepared"), and Arborist's own `hasInstallScript` flag
// excludes `prepare` entirely, so it has to be read from the installed
// package.json instead.
//
// Any path with a `node_modules/` segment counts as installed, whether
// that's directly under the repo root, nested under another dependency, or
// nested under a workspace member (e.g. `apps/website/node_modules/@types/node`),
// only the bare workspace paths themselves (`""`, `apps/*`, ...) are this
// repo's own packages and skipped. A `link: true` node that resolves to a
// real workspace is skipped the same way; a `link: true` node that resolves
// anywhere else (a `file:`/`directory:` dependency) is followed to its
// target and that target is inspected instead; its identity for coverage
// purposes is the link's own resolved path, never the target's name/version,
// and an unresolvable link (no target, or a target missing from the
// lockfile) fails closed rather than silently going unchecked.
function collectInstalledPackages(
  lockPackages,
  { workspacePaths, checkBindingGyp, checkPrepareScript }
) {
  const installedVersions = new Map(); // name -> Set(version), registry only
  const installedWithScripts = new Set(); // "name@version", registry only
  const fileWithScripts = new Set(); // normalized link-resolved path
  const remoteWithScripts = new Set(); // resolved tarball URL
  const gitDepsWithScripts = []; // { resolved, url, committish }

  for (const [pkgPath, pkg] of Object.entries(lockPackages)) {
    if (!pkgPath.includes("node_modules/")) continue;

    let inspectPath = pkgPath;
    let inspectPkg = pkg;
    let sourceType = "registry";
    let fileIdentity = null;

    if (pkg.link) {
      const target = pkg.resolved;
      if (target && workspacePaths.has(target)) continue;
      if (!target || !lockPackages[target]) {
        throw new Error(
          `${pkgPath} is a link with no resolvable target in package-lock.json; this checker can't ` +
            "determine its npm-compatible source identity (a file/directory dependency is matched by " +
            "resolved path, never by name), so it can't be checked for install scripts. Regenerate the " +
            "lockfile with a current npm."
        );
      }
      inspectPath = target;
      inspectPkg = lockPackages[target];
      sourceType = "file";
      fileIdentity = normalizeFileSpecPath(target);
    } else if (typeof pkg.resolved === "string" && GIT_RESOLVED_PATTERN.test(pkg.resolved)) {
      sourceType = "git";
    } else if (
      typeof pkg.resolved === "string" &&
      /^https?:\/\//i.test(pkg.resolved) &&
      !REGISTRY_TARBALL_PATTERN.test(pkg.resolved)
    ) {
      sourceType = "remote";
    }

    const hasScript =
      Boolean(inspectPkg.hasInstallScript) ||
      checkBindingGyp(inspectPath) ||
      (sourceType !== "registry" && checkPrepareScript(inspectPath));

    if (sourceType === "file") {
      if (hasScript) fileWithScripts.add(fileIdentity);
      continue;
    }
    if (sourceType === "git") {
      if (hasScript)
        gitDepsWithScripts.push({
          resolved: inspectPkg.resolved,
          ...splitGitCommittish(inspectPkg.resolved),
        });
      continue;
    }
    if (sourceType === "remote") {
      if (hasScript) remoteWithScripts.add(inspectPkg.resolved);
      continue;
    }

    const version = inspectPkg.version;
    if (!version) continue;
    const name = inspectPkg.name ?? deriveNameFromPath(inspectPath);

    if (!installedVersions.has(name)) installedVersions.set(name, new Set());
    installedVersions.get(name).add(version);

    if (hasScript) installedWithScripts.add(`${name}@${version}`);
  }

  return {
    installedVersions,
    installedWithScripts,
    fileWithScripts,
    remoteWithScripts,
    gitDepsWithScripts,
  };
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
  let checkPrepareScript = () => false;
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
      checkPrepareScript = (pkgPath) => {
        const manifestPath = join(root, pkgPath, "package.json");
        if (!existsSync(manifestPath)) {
          throw new Error(
            `could not find an installed package.json at ${pkgPath} to check for a prepare script; npm ` +
              "treats scripts.prepare as install-relevant for file/directory, git, and remote dependencies " +
              "(unlike a registry install), so this checker must be able to inspect the installed target. " +
              "Run npm ci first."
          );
        }
        let manifest;
        try {
          manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        } catch (err) {
          throw new Error(
            `could not parse the installed package.json at ${pkgPath} (${err.message}); this checker must ` +
              "be able to inspect non-registry install targets for a prepare script."
          );
        }
        return (
          isPlainObject(manifest.scripts) &&
          typeof manifest.scripts.prepare === "string" &&
          manifest.scripts.prepare.trim() !== ""
        );
      };
    }
  }

  const allow = validateAllowScripts(allowScripts);
  const { pinned, bareNames } = splitAllowScriptsKeys(allow);
  const { fileKeys, remoteKeys, gitKeys } = splitNonRegistryPolicyKeys(allow);
  const workspacePaths = collectWorkspacePaths(lockPackages, workspaces);
  const {
    installedVersions,
    installedWithScripts,
    fileWithScripts,
    remoteWithScripts,
    gitDepsWithScripts,
  } = collectInstalledPackages(lockPackages, {
    workspacePaths,
    checkBindingGyp,
    checkPrepareScript,
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
  for (const path of fileWithScripts) {
    if (fileKeys.has(path)) continue;
    uncovered.push(`file:${path}`);
  }
  for (const url of remoteWithScripts) {
    if (remoteKeys.has(url)) continue;
    uncovered.push(url);
  }
  for (const dep of gitDepsWithScripts) {
    if (gitKeyCovers(dep, gitKeys)) continue;
    uncovered.push(dep.resolved);
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
