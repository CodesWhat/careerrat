import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PRIVATE_DIR = ".careerrat";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// Exported so the update tarball guard rejects exactly the files the resolver
// treats as user-owned. Two hand-maintained copies of this list would drift.
export const GENERATED_CONFIG_FILES = [
  "search-sources.yml",
  "search-sources.json",
  "sourced-scan.json",
  "ai.json",
];
const WORKSPACE_RUNTIME_FILES = [
  "tracker.json",
  "tracker.html",
  "activity.jsonl",
  "dashboard-data.js",
  "modes.json",
  "settings.json",
  "library.json",
  "setup-state.json",
];
const WORKSPACE_PRIVATE_DIRS = [
  "jobs",
  "tailored",
  "intake",
  "scan-results",
  "comms",
  "interview-prep",
  "writing-samples",
  "research",
  "network-leads",
  "captures",
  "logos",
  "legacy",
  // tracker-snapshot.mjs writes rolling backups here (SNAPSHOT_SUBDIR =
  // "workspace/.snapshots"). It belongs in this list precisely because the case
  // that needs it is a workspace whose tracker.json is gone or corrupt: that
  // drops every WORKSPACE_RUNTIME_FILES hit, so without .snapshots the legacy
  // probe reads a real workspace as empty, repoints at the new data root, and
  // `careerrat restore` reports zero snapshots at the one moment it matters.
  ".snapshots",
];

function cleanRel(relPath) {
  return normalize(String(relPath || "")).replace(/^(\.\.[/\\])+/, "");
}

function envHome({ repoRoot, env = process.env } = {}) {
  const raw = String(env.CAREERRAT_HOME || "").trim();
  if (!raw) return null;
  return isAbsolute(raw) ? normalize(raw) : resolve(repoRoot, raw);
}

// True when repoRoot is an npm-installed package tree rather than a git checkout.
// Every real install shape (global, local/project dependency, npx cache, pnpm's
// virtual store after symlink resolution) places the package directory as an
// immediate child of a literal "node_modules" directory; a clone (including a
// `git worktree add` checkout) never is. Yarn PnP has no physical node_modules and
// defeats this check, not a currently supported distribution shape: flagged as a
// known gap rather than solved here.
export function isPackageInstall(repoRoot) {
  return basename(dirname(String(repoRoot))) === "node_modules";
}

// Where private user data anchors when CAREERRAT_HOME is unset: a git checkout keeps
// the pre-existing repoRoot/.careerrat default (a job search alongside the code being
// worked on), but an installed package anchors at ~/.careerrat instead. Anchoring an
// install at the package directory is what let `npm install -g careerrat` (no --force,
// same version) silently delete a user's tracker/profile/db on reinstall; anchoring at
// home also means N installs across N project folders share one job search rather than
// fragmenting into N silos.
// Prefers the injected env over the process's own home. Every other read in this
// module goes through `env`, so calling homedir() directly would silently ignore a
// caller that passed one, which is a footgun for tests and for any embedder that
// resolves paths for an env other than its own. Falls back to homedir() so the
// default (env === process.env) is unchanged, including on Windows where the
// variable is USERPROFILE.
function userHome(env = process.env) {
  const raw = String(env.HOME || env.USERPROFILE || "").trim();
  return raw || homedir();
}

export function privateDataRoot({ repoRoot = DEFAULT_REPO_ROOT, env = process.env } = {}) {
  const explicit = envHome({ repoRoot, env });
  if (explicit) return explicit;
  return isPackageInstall(repoRoot)
    ? join(userHome(env), DEFAULT_PRIVATE_DIR)
    : join(repoRoot, DEFAULT_PRIVATE_DIR);
}

function hasExplicitHome(env = process.env) {
  return !!String(env.CAREERRAT_HOME || "").trim();
}

function legacyGeneratedConfigExists(repoRoot) {
  return GENERATED_CONFIG_FILES.some((file) => existsSync(join(repoRoot, "config", file)));
}

function hasNonPlaceholderPayload(dir) {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => {
      if (entry.name === ".gitkeep" || entry.name === ".DS_Store") return false;
      return true;
    });
  } catch {
    return false;
  }
}

function legacyWorkspaceExists(repoRoot) {
  const workspace = join(repoRoot, "workspace");
  if (WORKSPACE_RUNTIME_FILES.some((file) => existsSync(join(workspace, file)))) return true;
  return WORKSPACE_PRIVATE_DIRS.some((dir) => hasNonPlaceholderPayload(join(workspace, dir)));
}

export function resolveUserPaths({ repoRoot = DEFAULT_REPO_ROOT, env = process.env } = {}) {
  const dataRoot = privateDataRoot({ repoRoot, env });
  const explicit = hasExplicitHome(env);
  const legacyCandidate = !explicit && existsSync(join(repoRoot, "candidate"));
  const legacyWorkspace = !explicit && legacyWorkspaceExists(repoRoot);
  const legacyInternal = !explicit && existsSync(join(repoRoot, ".internal"));
  const legacyConfig = !explicit && legacyGeneratedConfigExists(repoRoot);

  return {
    repoRoot,
    dataRoot,
    candidateDir: legacyCandidate ? join(repoRoot, "candidate") : join(dataRoot, "candidate"),
    workspaceDir: legacyWorkspace ? join(repoRoot, "workspace") : join(dataRoot, "workspace"),
    generatedConfigDir: legacyConfig ? join(repoRoot, "config") : join(dataRoot, "config"),
    internalDir: legacyInternal ? join(repoRoot, ".internal") : join(dataRoot, "internal"),
    usingLegacy: legacyCandidate || legacyWorkspace || legacyInternal || legacyConfig,
  };
}

// Detects data left behind inside the package directory by a prior run under the
// OLD broken default (privateDataRoot() used to fall back to repoRoot/.careerrat
// unconditionally, even for an installed package). This is separate from the legacy
// top-level probe above: that probe looks for pre-.careerrat/ data shapes that are
// still the correct place to read from; this looks for the wrong-root .careerrat/
// itself, which the CLI should surface and never move automatically, since an
// automatic move could clobber different or newer data already at the real root.
export function strandedPackageDataDir({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  if (!isPackageInstall(repoRoot)) return null;
  const dir = join(repoRoot, DEFAULT_PRIVATE_DIR);
  return hasNonPlaceholderPayload(dir) ? dir : null;
}

export function dataPath(options = {}, relPath = "") {
  return join(privateDataRoot(options), cleanRel(relPath));
}

export function dataRel(relPath = "") {
  return [DEFAULT_PRIVATE_DIR, cleanRel(relPath)].join("/");
}

function underPrefix(relPath, prefix) {
  return relPath === prefix || relPath.startsWith(`${prefix}${sep}`);
}

export function userPath(options = {}, relPath = "") {
  const normalized = cleanRel(relPath);
  const paths = resolveUserPaths(options);

  if (underPrefix(normalized, "candidate")) {
    return join(paths.candidateDir, relative("candidate", normalized));
  }
  if (underPrefix(normalized, "workspace")) {
    return join(paths.workspaceDir, relative("workspace", normalized));
  }
  if (underPrefix(normalized, ".internal")) {
    return join(paths.internalDir, relative(".internal", normalized));
  }
  if (underPrefix(normalized, "config")) {
    const sub = relative("config", normalized);
    if (GENERATED_CONFIG_FILES.includes(sub)) return join(paths.generatedConfigDir, sub);
  }

  return join(paths.repoRoot, normalized);
}

export function displayPath(options = {}, relPath = "") {
  const abs = userPath(options, relPath);
  const rel = relative(options.repoRoot || DEFAULT_REPO_ROOT, abs);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replaceAll(sep, "/") : abs;
}
