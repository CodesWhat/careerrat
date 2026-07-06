import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { DEEP_INGEST_REPO_FILE_LIMIT, DEEP_INGEST_REPO_MAX_BYTES } from "./source-normalize.mjs";

const ALLOWED_ROOT_FILES = new Set([
  "readme.md",
  "readme.txt",
  "package.json",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
]);
const ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".json", ".toml"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next"]);

export function scanPublicRepoSource(
  repoPath,
  { maxFiles = DEEP_INGEST_REPO_FILE_LIMIT, maxBytes = DEEP_INGEST_REPO_MAX_BYTES } = {}
) {
  const root = String(repoPath || "");
  if (!root || !existsSync(root)) {
    return { ok: false, reason: "repo path is unreadable or missing", files: [] };
  }
  if (!statSync(root).isDirectory()) {
    return { ok: false, reason: "repo path is not a directory", files: [] };
  }

  const candidates = collectCandidates(root)
    .sort(
      (a, b) =>
        rankRepoFile(a.relativePath) - rankRepoFile(b.relativePath) ||
        a.relativePath.localeCompare(b.relativePath)
    )
    .slice(0, maxFiles);

  let bytes = 0;
  const files = [];
  for (const candidate of candidates) {
    const raw = readFileSync(candidate.fullPath);
    if (bytes + raw.length > maxBytes) break;
    bytes += raw.length;
    files.push({
      relativePath: candidate.relativePath,
      text: raw.toString("utf8"),
      bytes: raw.length,
    });
  }

  if (!files.length) {
    return { ok: false, reason: "no supported README, docs, or package metadata found", files: [] };
  }

  return {
    ok: true,
    files,
    text: files.map((file) => `# ${file.relativePath}\n${file.text}`).join("\n\n"),
    truncated: candidates.length > files.length,
  };
}

function collectCandidates(root, dir = root, depth = 0) {
  if (depth > 3) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (depth === 0 && entry.name !== "docs") continue;
      out.push(...collectCandidates(root, join(dir, entry.name), depth + 1));
      continue;
    }
    if (!entry.isFile()) continue;
    const fullPath = join(dir, entry.name);
    const relativePath = relative(root, fullPath).replaceAll("\\", "/");
    if (isSupportedRepoFile(relativePath)) out.push({ fullPath, relativePath });
  }
  return out;
}

function isSupportedRepoFile(relativePath) {
  const lower = relativePath.toLowerCase();
  if (relativePath.startsWith(".")) return false;
  if (ALLOWED_ROOT_FILES.has(lower)) return true;
  if (lower.startsWith("docs/")) {
    const name = basename(lower);
    if (name.startsWith(".")) return false;
    return [...ALLOWED_EXTENSIONS].some((ext) => lower.endsWith(ext));
  }
  return false;
}

function rankRepoFile(relativePath) {
  const lower = relativePath.toLowerCase();
  if (lower.startsWith("readme.")) return 0;
  if (lower === "package.json") return 1;
  if (lower.startsWith("docs/")) return 2;
  return 3;
}
