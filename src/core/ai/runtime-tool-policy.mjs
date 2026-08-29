import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { validatePublicHttpUrl } from "../deep-ingest/source-fetch.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";

const FILE_TOOLS = new Set(["Read", "Glob", "Grep"]);
// ".careerrat" is deliberately NOT here: it's the real data root on both the
// legacy checkout layout and the home-anchored installed layout, so blocking
// the segment outright would block the user's own candidate/workspace files.
// internal/ and db/ under it are still denied below, by resolved root
// containment rather than by segment name, because the resolver's fallback
// (workspace.mjs's privateDataRoot) can now point outside repoRoot entirely.
const BLOCKED_SEGMENTS = new Set([".git", ".internal", "node_modules"]);

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

function pathDecision({ repoRoot, env, skill, toolName, input }) {
  const rawPath = requestedFilePath(toolName, input);
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return deny(`${toolName} requires an explicit path inside an approved CareerRat data root`);
  }

  const canonicalRepo = nearestCanonicalPath(resolve(repoRoot));
  const target = nearestCanonicalPath(resolve(repoRoot, rawPath));
  const leaf = basename(target).toLowerCase();
  if (leaf === ".env" || leaf.startsWith(".env.")) {
    return deny(
      `${toolName} cannot access credentials, internal state, or paths outside CareerRat`
    );
  }

  // Same anchor resolution every other caller of userPath/dataPath goes
  // through (workspace.mjs's resolveUserPaths), so the allowlist tracks
  // wherever privateDataRoot() actually put the data — legacy top-level,
  // repoRoot/.careerrat, or (installed package) ~/.careerrat — instead of a
  // hardcoded join(canonicalRepo, ...) that only ever matched the legacy
  // shape.
  const paths = resolveUserPaths({ repoRoot, env });
  const candidateRoot = nearestCanonicalPath(resolve(paths.candidateDir));
  const workspaceRoot = nearestCanonicalPath(resolve(paths.workspaceDir));
  const configRoot = nearestCanonicalPath(resolve(paths.generatedConfigDir));
  const internalRoot = nearestCanonicalPath(resolve(paths.internalDir));
  const dbRoot = nearestCanonicalPath(resolve(join(paths.dataRoot, "db")));
  const privateFormDefaults = join(candidateRoot, "form-defaults.yml");

  // internal/ and the sqlite db/ never leave this check to the resolver's
  // legacy/installed branching above: dataRoot can now sit outside
  // canonicalRepo entirely (~/.careerrat), and the installed layout's
  // internal dir is named "internal" (no dot), which the bare ".internal"
  // entry in BLOCKED_SEGMENTS never matched anyway. Denying by resolved
  // root containment catches both shapes the same way.
  if (isWithin(internalRoot, target) || isWithin(dbRoot, target)) {
    return deny(
      `${toolName} cannot access credentials, internal state, or paths outside CareerRat`
    );
  }

  if (
    target === privateFormDefaults ||
    (toolName === "Grep" &&
      (isWithin(target, privateFormDefaults) || isWithin(privateFormDefaults, target)))
  ) {
    return deny(
      `${toolName} cannot access raw application defaults; use CareerRat's sanitized candidate context`
    );
  }

  const allowedRoots = [
    // Shipped assets: always anchored to the install root, never the data
    // root, so these stay reachable regardless of where user data resolves.
    join(canonicalRepo, ".agents", "skills", skill),
    join(canonicalRepo, "templates"),
    join(canonicalRepo, "config"),
    // User data: wherever the resolver actually put it.
    candidateRoot,
    workspaceRoot,
    configRoot,
  ];
  const allowedFiles = new Set([
    join(canonicalRepo, "AGENTS.md"),
    join(canonicalRepo, "README.md"),
    join(canonicalRepo, "package.json"),
  ]);
  const matchedRoot = allowedRoots.find((root) => isWithin(root, target));
  if (!allowedFiles.has(target) && !matchedRoot) {
    return deny(`${toolName} path is outside the approved CareerRat runtime roots`);
  }

  // Defense in depth against a stray .git/.internal/node_modules nested
  // *inside* an otherwise-approved root (e.g. workspaceDir/foo/node_modules).
  // Scoped to the suffix under the matched root rather than the full
  // absolute path: an installed package's own repoRoot sits under a literal
  // node_modules ancestor by construction, so scanning the whole path would
  // deny every read of the package's own shipped skills/templates/config.
  if (matchedRoot) {
    const suffix = relative(matchedRoot, target);
    const segments = suffix.split(/[\\/]+/).filter(Boolean);
    if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment))) {
      return deny(
        `${toolName} cannot access credentials, internal state, or paths outside CareerRat`
      );
    }
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

export function createRuntimeToolPolicy({ repoRoot, skill, tools = [], env = process.env } = {}) {
  const allowedTools = new Set(tools);

  function evaluate(toolName, input = {}) {
    if (!allowedTools.has(toolName))
      return deny(`tool "${toolName}" is not in this runtime profile`);
    if (FILE_TOOLS.has(toolName)) return pathDecision({ repoRoot, env, skill, toolName, input });
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
