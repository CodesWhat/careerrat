import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PRIVATE_DIR = ".careerrat";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GENERATED_CONFIG_FILES = [
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
];

function cleanRel(relPath) {
  return normalize(String(relPath || "")).replace(/^(\.\.[/\\])+/, "");
}

function envHome({ repoRoot, env = process.env } = {}) {
  const raw = String(env.CAREERRAT_HOME || "").trim();
  if (!raw) return null;
  return isAbsolute(raw) ? normalize(raw) : resolve(repoRoot, raw);
}

export function privateDataRoot({ repoRoot = DEFAULT_REPO_ROOT, env = process.env } = {}) {
  return envHome({ repoRoot, env }) || join(repoRoot, DEFAULT_PRIVATE_DIR);
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
