// Shared update plumbing for `careerrat update` (self-update) and
// scripts/update-live.mjs (operator updates an external live tree).
//
// Both refresh CODE ONLY from the published npm package — the package.json `files`
// whitelist excludes candidate/ and workspace/, so a user's real data is preserved
// by construction. A privacy guard refuses any tarball that carries user-data paths
// (which would mean the release itself leaked), so this also dogfoods every publish.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATED_CONFIG_FILES, resolveUserPaths } from "../paths/workspace.mjs";

// Lowercased to match findUserDataLeaks' normalized entries.
const GENERATED_CONFIG_LEAK_PATHS = new Set(
  GENERATED_CONFIG_FILES.map((file) => `config/${file}`.toLowerCase())
);

const UPDATE_CACHE_FILE = "update-check.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // re-check the registry at most once a day

export function readPkgVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

// Minimal semver compare for x.y.z and x.y.z-pre. Returns -1 / 0 / 1 (a vs b).
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v || "0.0.0").split("-");
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre || null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] || 0) - (pb.nums[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  // Same core: a release (no prerelease) outranks a prerelease.
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  return 0;
}

export function isNewer(current, candidate) {
  if (!current || !candidate) return false;
  return compareVersions(candidate, current) > 0;
}

// Resolve the published version for a dist-tag (or echo an explicit version). Returns
// null on any failure (offline, unknown tag) — callers treat null as "couldn't check".
export function latestVersion(tag = "latest") {
  const res = spawnSync("npm", ["view", `careerrat@${tag}`, "version"], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const v = (res.stdout || "").trim();
  return v || null;
}

// Download + unpack the published tarball for a spec (e.g. "careerrat@latest").
// Returns { tgz, entries, publishedVersion, cleanup }. Caller MUST call cleanup().
export function fetchTarball(spec) {
  const tmp = mkdtempSync(join(tmpdir(), "careerrat-update-"));
  const cleanup = () => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore temp cleanup failure */
    }
  };
  try {
    const pack = spawnSync("npm", ["pack", spec, "--pack-destination", tmp], { encoding: "utf8" });
    if (pack.status !== 0) throw new Error(`npm pack failed:\n${pack.stderr || pack.stdout}`);
    const tgzName = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (!tgzName) throw new Error("npm pack produced no tarball");
    const tgz = join(tmp, tgzName);

    const list = spawnSync("tar", ["tzf", tgz], { encoding: "utf8" });
    if (list.status !== 0) throw new Error(`could not read tarball: ${list.stderr}`);
    const entries = list.stdout
      .split("\n")
      .filter(Boolean)
      .map((p) => p.replace(/^package\//, ""));

    let publishedVersion = null;
    if (entries.includes("package.json")) {
      const show = spawnSync("tar", ["xzfO", tgz, "package/package.json"], { encoding: "utf8" });
      try {
        publishedVersion = JSON.parse(show.stdout).version || null;
      } catch {
        /* leave null */
      }
    }
    return { tgz, entries, publishedVersion, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// Privacy guard: tarball entries that carry user data (candidate/ or non-scaffold
// workspace/). A non-empty result means the published package leaked — refuse to install.
//
// The guard covers every path group resolveUserPaths() treats as user-owned, not
// just the two bare legacy prefixes. ".careerrat/" because the data root moved and
// candidate/, workspace/, config/, internal/ and the sqlite db now all nest under
// it. ".internal/" for the legacy top-level layout. And the four generated config
// files by exact name, since config/ also ships schemas and *.example.* that a
// prefix match would wrongly reject.
// Matching is case-insensitive and normalizes path separators/leading "./" before
// testing, because CareerRat ships on case-insensitive filesystems (APFS, NTFS) where
// "Candidate/x" and "candidate/x" are the same real path, and a case-sensitive or
// separator-sensitive regex would let a differently-cased or oddly-prefixed entry
// extract straight over the user's real candidate/ or workspace/ directory.
export function findUserDataLeaks(entries) {
  return entries.filter((p) => {
    const normalized = String(p || "")
      .replace(/\\/g, "/")
      .replace(/^(\.\/)+/, "")
      .toLowerCase();
    return (
      /^candidate\//.test(normalized) ||
      /^\.careerrat\//.test(normalized) ||
      /^\.internal\//.test(normalized) ||
      GENERATED_CONFIG_LEAK_PATHS.has(normalized) ||
      (/^workspace\//.test(normalized) && normalized !== "workspace/.gitkeep")
    );
  });
}

// Extract a tarball's code over targetDir. tar only writes archived (code) paths and
// never deletes unlisted files, so candidate/ and workspace/ in targetDir are untouched.
export function extractOver(tgz, targetDir) {
  const x = spawnSync("tar", ["xzf", tgz, "--strip-components=1", "-C", targetDir], {
    encoding: "utf8",
  });
  if (x.status !== 0) throw new Error(`extract failed: ${x.stderr}`);
}

// Runtime dependency reconciliation. extractOver only replaces package files, so a
// release that adds or bumps a runtime dependency leaves node_modules stale unless
// update re-runs npm install. Only `dependencies` and `optionalDependencies` matter:
// devDependencies never ship in a consumer install.
export const RUNTIME_DEPS_INSTALL_ARGS = [
  "install",
  "--omit=dev",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
];

export function readRuntimeDeps(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return {
      dependencies: pkg.dependencies || {},
      optionalDependencies: pkg.optionalDependencies || {},
    };
  } catch {
    return null;
  }
}

function sortedEntries(obj) {
  return JSON.stringify(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// True when the runtime dependency set differs, or either side is unreadable (an
// unreadable package.json can't prove the install is still consistent).
export function runtimeDepsChanged(before, after) {
  if (!before || !after) return true;
  return (
    sortedEntries(before.dependencies) !== sortedEntries(after.dependencies) ||
    sortedEntries(before.optionalDependencies) !== sortedEntries(after.optionalDependencies)
  );
}

// Scripts run only for packages the reviewed `allowScripts` policy in package.json
// approves (the same policy source CI's check-install-scripts.mjs enforces). A key is
// `name@version` or a bare `name`; `true` approves, `false` denies (never runs, never
// blocks), absent means unreviewed.
function scriptVerdict(allowScripts, name, version) {
  if (!allowScripts || typeof allowScripts !== "object") return undefined;
  for (const key of [`${name}@${version}`, name]) {
    if (Object.hasOwn(allowScripts, key) && typeof allowScripts[key] === "boolean") {
      return allowScripts[key];
    }
  }
  return undefined;
}

// Installed packages that declare an install script, read from npm's hidden lockfile.
// Returns null when it can't be read, so the caller fails closed.
function installedScriptPackages(dir) {
  try {
    const lock = JSON.parse(readFileSync(join(dir, "node_modules", ".package-lock.json"), "utf8"));
    const out = [];
    for (const [path, entry] of Object.entries(lock.packages || {})) {
      if (!entry?.hasInstallScript || entry.link || entry.inBundle) continue;
      const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      if (name) out.push({ name, version: entry.version });
    }
    return out;
  } catch {
    return null;
  }
}

// Reconciles runtime deps without letting a new transitive dependency's unreviewed
// postinstall run as the operator: install with --ignore-scripts (flag AND env, so a
// permissive user npmrc can't turn scripts back on), then `npm rebuild` only the
// packages the allowScripts policy approves (node-pty needs its install script).
// Returns { status, error, unreviewed }; `unreviewed` lists packages with an install
// script the policy doesn't cover, in which case nothing further runs.
export function installRuntimeDeps(dir) {
  const env = { ...process.env, npm_config_ignore_scripts: "true" };
  const res = spawnSync("npm", RUNTIME_DEPS_INSTALL_ARGS, { cwd: dir, stdio: "inherit", env });
  if (res.error) return { status: 1, error: res.error.message, unreviewed: [] };
  if (res.status !== 0) return { status: res.status ?? 1, error: null, unreviewed: [] };

  let allowScripts = null;
  try {
    allowScripts = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).allowScripts;
  } catch {
    /* no readable policy: nothing is approved */
  }
  const withScripts = installedScriptPackages(dir);
  if (withScripts === null) {
    return {
      status: 1,
      error: "couldn't read node_modules/.package-lock.json to check install scripts",
      unreviewed: [],
    };
  }
  const allowed = [];
  const unreviewed = [];
  for (const { name, version } of withScripts) {
    const verdict = scriptVerdict(allowScripts, name, version);
    if (verdict === true) allowed.push(name);
    else if (verdict !== false) unreviewed.push(`${name}@${version}`);
  }
  if (unreviewed.length > 0) return { status: 1, error: null, unreviewed };
  if (allowed.length === 0) return { status: 0, error: null, unreviewed: [] };

  const rebuild = spawnSync("npm", ["rebuild", ...new Set(allowed)], {
    cwd: dir,
    stdio: "inherit",
    env: { ...process.env, npm_config_ignore_scripts: "false" },
  });
  if (rebuild.error) return { status: 1, error: rebuild.error.message, unreviewed: [] };
  return { status: rebuild.status ?? 1, error: null, unreviewed: [] };
}

// ---------------------------------------------------------------------------
// update-notifier: a cached, never-blocking "newer version available" check.

function cacheFile(pathCtx) {
  return join(resolveUserPaths(pathCtx).internalDir, UPDATE_CACHE_FILE);
}

export function writeUpdateCache(pathCtx, data) {
  const dir = resolveUserPaths(pathCtx).internalDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(cacheFile(pathCtx), `${JSON.stringify({ ...data })}\n`);
}

function readUpdateCache(pathCtx) {
  try {
    return JSON.parse(readFileSync(cacheFile(pathCtx), "utf8"));
  } catch {
    return null;
  }
}

// Pure + synchronous: returns a one-line notice (or null) from the LAST cached check.
// Never hits the network, so it never slows a command down.
export function readUpdateNotice(pathCtx, currentVersion) {
  const cache = readUpdateCache(pathCtx);
  if (!cache?.latest || !currentVersion) return null;
  if (!isNewer(currentVersion, cache.latest)) return null;
  return `⬆ careerrat ${currentVersion} → ${cache.latest} available, run \`careerrat update\``;
}

// Refresh the cache in a detached child if it's missing or stale. Returns immediately;
// the result lands for the NEXT invocation (the standard update-notifier pattern).
//
// Opt-out via CAREERRAT_NO_UPDATE_CHECK: the detached child is a real npm-registry
// network call that writes into CAREERRAT_HOME on its own schedule, unsynchronized
// with the parent process's exit. Real installs want that (the cache lands before the
// user's next invocation); a test pointing CAREERRAT_HOME at a tempdir it deletes
// moments later does not — the write can land mid-delete and throw ENOTEMPTY on a
// directory that has nothing to do with the thing under test.
export function refreshUpdateCacheInBackground(pathCtx, root) {
  // Read the opt-out from the same place everything else in this function reads
  // its environment. readUpdateCache(pathCtx) resolves CAREERRAT_HOME through
  // pathCtx.env, so a guard that consulted process.env directly would disagree
  // with it whenever a caller passed an explicit env, which is exactly what the
  // tests do.
  const env = pathCtx?.env ?? process.env;
  if (String(env.CAREERRAT_NO_UPDATE_CHECK || "").trim()) return;
  const cache = readUpdateCache(pathCtx);
  const fresh = cache?.checkedAtMs && Date.now() - cache.checkedAtMs < CACHE_TTL_MS;
  if (fresh) return;
  const script = join(root, "scripts/update-check.mjs");
  if (!existsSync(script)) return;
  try {
    // ELECTRON_RUN_AS_NODE, scoped to this one child: under the desktop
    // shell process.execPath is the Electron binary — without it this
    // detached spawn left a headless GUI app instance in the dock on every
    // stale-cache boot. A plain node parent ignores the variable.
    const c = spawn(process.execPath, [script], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    c.unref();
  } catch {
    /* best-effort; a failed refresh just means no notice next run */
  }
}
