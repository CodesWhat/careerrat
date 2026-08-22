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
import { resolveUserPaths } from "../paths/workspace.mjs";

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
      (/^workspace\//.test(normalized) && !/\.gitkeep$/.test(normalized))
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
