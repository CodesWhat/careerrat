import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { validatePublicHttpUrl } from "../deep-ingest/source-fetch.mjs";

const FILE_TOOLS = new Set(["Read", "Glob", "Grep"]);
const BLOCKED_SEGMENTS = new Set([".git", ".internal", ".rolester", "node_modules"]);

function deny(message) {
  return { behavior: "deny", message, interrupt: false };
}

function nearestCanonicalPath(path) {
  let probe = path;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return path;
    probe = parent;
  }
  const canonicalBase = realpathSync(probe);
  const suffix = relative(probe, path);
  return resolve(canonicalBase, suffix);
}

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function requestedFilePath(toolName, input) {
  if (toolName === "Read") return input?.file_path;
  if (toolName === "Glob" || toolName === "Grep") return input?.path;
  return null;
}

function pathDecision({ repoRoot, skill, toolName, input }) {
  const rawPath = requestedFilePath(toolName, input);
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return deny(`${toolName} requires an explicit path inside an approved CareerRat data root`);
  }

  const canonicalRepo = nearestCanonicalPath(resolve(repoRoot));
  const target = nearestCanonicalPath(resolve(repoRoot, rawPath));
  const rel = relative(canonicalRepo, target);
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  const leaf = basename(target).toLowerCase();
  if (
    rel.startsWith("..") ||
    isAbsolute(rel) ||
    segments.some((segment) => BLOCKED_SEGMENTS.has(segment)) ||
    leaf === ".env" ||
    leaf.startsWith(".env.")
  ) {
    return deny(`${toolName} cannot access credentials, internal state, or paths outside CareerRat`);
  }

  const allowedRoots = [
    join(canonicalRepo, ".agents", "skills", skill),
    join(canonicalRepo, "candidate"),
    join(canonicalRepo, "workspace"),
    join(canonicalRepo, "config"),
    join(canonicalRepo, "templates"),
  ];
  const allowedFiles = new Set([
    join(canonicalRepo, "AGENTS.md"),
    join(canonicalRepo, "README.md"),
    join(canonicalRepo, "package.json"),
  ]);
  if (!allowedFiles.has(target) && !allowedRoots.some((root) => isWithin(root, target))) {
    return deny(`${toolName} path is outside the approved CareerRat runtime roots`);
  }
  return { behavior: "allow" };
}

function webFetchDecision(input) {
  const checked = validatePublicHttpUrl(input?.url);
  return checked.ok
    ? { behavior: "allow" }
    : deny(`WebFetch URL rejected by the public-network policy: ${checked.reason}`);
}

function skillDecision(skill, input) {
  const requested = String(input?.skill || input?.name || "").trim();
  return !requested || requested === skill
    ? { behavior: "allow" }
    : deny(`only the selected skill "${skill}" may run in this session`);
}

export function createRuntimeToolPolicy({ repoRoot, skill, tools = [] } = {}) {
  const allowedTools = new Set(tools);

  function evaluate(toolName, input = {}) {
    if (!allowedTools.has(toolName))
      return deny(`tool "${toolName}" is not in this runtime profile`);
    if (FILE_TOOLS.has(toolName)) return pathDecision({ repoRoot, skill, toolName, input });
    if (toolName === "WebFetch") return webFetchDecision(input);
    if (toolName === "WebSearch") return { behavior: "allow" };
    if (toolName === "Skill") return skillDecision(skill, input);
    return deny(`tool "${toolName}" has no runtime security policy`);
  }

  async function canUseTool(toolName, input) {
    return evaluate(toolName, input);
  }

  async function preToolUse(input) {
    const result = evaluate(input?.tool_name, input?.tool_input);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: result.behavior,
        permissionDecisionReason: result.behavior === "deny" ? result.message : undefined,
      },
    };
  }

  return {
    canUseTool,
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
  };
}
