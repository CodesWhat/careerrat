// Installed AI CLI registry shared by in-app sign-in and Electron.
// Discovery never executes a candidate binary. Readiness probes and requests
// spawn the resolved executable directly with fixed argv and shell:false.

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { fetchPublicHttpText, validatePublicHttpUrl } from "../net/public-http-fetch.mjs";
import { userPath } from "../paths/workspace.mjs";

const CLAUDE_BOUNDARY_MINIMUM_VERSION = "2.1.241";
const CODEX_COMPLETION_MINIMUM_VERSION = "0.149.1";
const UNSUPPORTED_CAPABILITY_REASON =
  "Detected, but this CLI cannot safely run CareerRat tools yet.";
const UNVERIFIED_COMPLETION_REASON =
  "Detected, but this CLI's isolated chat and drafting mode has not been verified yet.";
const PUBLIC_WEB_SERVER_NAME = "careerrat_public_web";
const PUBLIC_WEB_FETCH_TOOL = `mcp__${PUBLIC_WEB_SERVER_NAME}__fetch`;
const PUBLIC_WEB_SERVER_ARG = "--careerrat-public-web";
const INSTALLED_RUNTIME_MODULE_PATH = fileURLToPath(import.meta.url);
const EXACT_READ_ROOTS = Object.freeze({
  "intake-extract": ["workspace", "intake", "uploads"],
  "resume-extract": ["workspace", "intake", "resume-uploads"],
});

const INSTALLED_CHILD_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "CLAUDE_CONFIG_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
  "CAREERRAT_HOME",
  "CAREERRAT_INSTALLED_AI_MODEL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

export function buildInstalledRuntimeChildEnv({ env = process.env } = {}) {
  const childEnv = {};
  for (const key of INSTALLED_CHILD_ENV_KEYS) {
    if (env[key] !== undefined) childEnv[key] = env[key];
  }
  return childEnv;
}

export const INSTALLED_RUNTIME_DEFINITIONS = [
  {
    id: "claude",
    name: "Claude Code",
    binaries: ["claude"],
    commandShape: "claude -p --output-format json",
    authProbe: { args: ["auth", "status"] },
    installUrl: "https://code.claude.com/docs/en/quickstart",
    completionSupported: true,
    // The only installed runtime whose CLI actually has a tool-allowlist
    // mechanism (`--tools`/`--allowedTools`, wired in
    // buildInstalledRuntimeInvocation's "claude" branch below). Every other
    // runtime in this registry ignores the `tools` param entirely. The run
    // choke points fail closed for every tool-bearing skill/chat call rather
    // than silently granting an unscoped tool surface.
    // Absent on every other definition means "unsupported," deliberately —
    // do not add this key anywhere else without also verifying that CLI has
    // a real per-call tool restriction, the way this one was verified against
    // the real installed `claude` CLI (see the file header comment).
    toolExecutionSupported: true,
    minimumBoundaryVersion: CLAUDE_BOUNDARY_MINIMUM_VERSION,
    // The only installed runtime whose CLI has a documented NDJSON streaming
    // output mode (`--output-format stream-json --verbose`, wired in
    // buildInstalledRuntimeInvocation's "claude" branch below) that emits the
    // same system/assistant/user/result message shapes the Agent SDK's own
    // query() does — see runInstalledRuntimeStream. Absent on every other
    // definition means "no streaming path," deliberately: do not add this key
    // for another runtime without first verifying its CLI actually has an
    // equivalent structured incremental-output mode.
    streamingSupported: true,
  },
  {
    id: "codex",
    name: "Codex",
    binaries: ["codex"],
    commandShape: "codex exec --json -",
    authProbe: { args: ["login", "status"] },
    installUrl: "https://learn.chatgpt.com/docs/codex/cli",
    completionSupported: true,
    minimumCompletionVersion: CODEX_COMPLETION_MINIMUM_VERSION,
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    binaries: ["gemini"],
    commandShape: "gemini -p",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl: "https://github.com/google-gemini/gemini-cli",
  },
  {
    id: "opencode",
    name: "OpenCode",
    binaries: ["opencode"],
    commandShape: "opencode run -",
    authProbe: { args: ["auth", "list"] },
    installUrl: "https://opencode.ai/docs/",
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    binaries: ["copilot", "github-copilot"],
    commandShape: "copilot -p -",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl:
      "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
  },
  {
    id: "qwen",
    name: "Qwen Code",
    binaries: ["qwen"],
    commandShape: "qwen -p",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl: "https://github.com/QwenLM/qwen-code",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    binaries: ["antigravity", "antigravitycli"],
    commandShape: "antigravity -p",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl: "https://antigravity.google/docs/cli/install",
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    binaries: ["hermes"],
    commandShape: "hermes -z",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl: "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
  },
  {
    id: "amp",
    name: "Amp",
    binaries: ["amp"],
    commandShape: "amp -x",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl: "https://ampcode.com/manual",
  },
  {
    id: "goose",
    name: "Goose",
    binaries: ["goose"],
    commandShape: "goose run -i -",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl: "https://goose-docs.ai/docs/getting-started/installation/",
  },
  {
    id: "droid",
    name: "Droid",
    binaries: ["droid"],
    commandShape: "droid exec",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl: "https://docs.factory.ai/droid-cli/quickstart",
  },
];

function splitPaths(value, separator) {
  return String(value || "")
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function addUnique(target, values) {
  for (const value of values) {
    if (value && !target.includes(value)) target.push(value);
  }
}

export function runtimeSearchDirectories({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
} = {}) {
  const separator = platform === "win32" ? ";" : delimiter;
  const dirs = [];
  addUnique(dirs, splitPaths(env.PATH, separator));
  addUnique(dirs, splitPaths(env.CAREERRAT_RUNTIME_EXTRA_PATHS, separator));

  if (platform === "win32") {
    addUnique(dirs, [
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "nodejs"),
      env.APPDATA && join(env.APPDATA, "npm"),
      env.USERPROFILE && join(env.USERPROFILE, ".local", "bin"),
      env.USERPROFILE && join(env.USERPROFILE, ".bun", "bin"),
    ]);
    return dirs;
  }

  addUnique(dirs, [
    join(homeDir, ".local", "bin"),
    join(homeDir, ".npm-global", "bin"),
    join(homeDir, ".bun", "bin"),
    join(homeDir, ".volta", "bin"),
    env.NPM_CONFIG_PREFIX && join(env.NPM_CONFIG_PREFIX, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ]);
  return dirs;
}

function executableExtensions({ env, platform }) {
  if (platform !== "win32") return [""];
  return String(env.PATHEXT || ".EXE;.CMD;.BAT")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
}

export function findInstalledExecutable(
  binaries,
  { env = process.env, platform = process.platform, homeDir = homedir() } = {}
) {
  const dirs = runtimeSearchDirectories({ env, platform, homeDir });
  const extensions = executableExtensions({ env, platform });
  for (const dir of dirs) {
    for (const binary of binaries) {
      for (const extension of extensions) {
        const path = join(dir, `${binary}${extension}`);
        try {
          accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
          return path;
        } catch {
          // Continue through the bounded registry and search path.
        }
      }
    }
  }
  return null;
}

export function detectInstalledRuntimes(options = {}) {
  return INSTALLED_RUNTIME_DEFINITIONS.map((definition) => {
    const path = findInstalledExecutable(definition.binaries, options);
    const runtimeCapabilities = installedRuntimeCapabilities(definition.id, {
      available: Boolean(path),
    });
    return {
      id: definition.id,
      name: definition.name,
      commandShape: definition.commandShape,
      path,
      available: Boolean(path),
      warning: definition.warning || null,
      installUrl: definition.installUrl || null,
      toolExecutionSupported: definition.toolExecutionSupported === true,
      capabilities: runtimeCapabilities.capabilities,
      capabilityTier: runtimeCapabilities.capabilityTier,
      capabilityReason:
        definition.toolExecutionSupported === true
          ? null
          : definition.completionSupported === true
            ? "Ready for chat and drafting. Task tools and research are not verified for this CLI yet."
            : UNVERIFIED_COMPLETION_REASON,
    };
  });
}

export function installedRuntimeCapabilities(
  runtimeId,
  { available = true, completion = undefined, taskTools = undefined } = {}
) {
  const definition = INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === runtimeId);
  const completionSupported =
    completion === undefined
      ? definition?.completionSupported === true
      : definition?.completionSupported === true && completion === true;
  const declaredTaskTools = definition?.toolExecutionSupported === true;
  const verifiedTaskTools =
    taskTools === undefined ? declaredTaskTools : declaredTaskTools && taskTools === true;
  const capabilities = {
    completion: completionSupported,
    taskTools: verifiedTaskTools,
    research: verifiedTaskTools,
  };
  const capabilityTier = !available
    ? "unavailable"
    : verifiedTaskTools
      ? "task_tools"
      : completionSupported
        ? "chat_drafting"
        : "detected_unverified";
  return { capabilities, capabilityTier };
}

export function installedRuntimeToolExecutionCapability(runtimeId) {
  const definition = INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === runtimeId);
  return {
    supported: definition?.toolExecutionSupported === true,
    reason: definition?.toolExecutionSupported === true ? null : UNSUPPORTED_CAPABILITY_REASON,
    minimumVersion: definition?.minimumBoundaryVersion || null,
  };
}

function loadInstalledSkillInstructions({ repoRoot, skill } = {}) {
  if (!repoRoot || !skill) return null;
  try {
    return readFileSync(join(repoRoot, ".agents", "skills", skill, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

function promptWithInstalledSkill({ prompt, repoRoot, skill } = {}) {
  if (!skill) return String(prompt || "");
  const instructions = loadInstalledSkillInstructions({ repoRoot, skill });
  if (!instructions) {
    throw runtimeError(
      `Could not load the allowlisted CareerRat instructions for skill "${skill}".`,
      "RUNTIME_BOUNDARY_UNAVAILABLE"
    );
  }
  return [
    "CareerRat loaded the following allowlisted skill instructions. Follow them exactly. The " +
      "provider has no authority beyond the capabilities explicitly granted by this request.",
    "<careerrat-skill-instructions>",
    instructions.trim(),
    "</careerrat-skill-instructions>",
    String(prompt || ""),
  ].join("\n\n");
}

function parseVersion(value) {
  const match = String(value || "").match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(value, floor) {
  const actual = parseVersion(value);
  const minimum = parseVersion(floor);
  if (!actual || !minimum) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function assertInstalledRuntimeBoundaryVersion(
  runtime,
  { spawnSyncImpl = spawnSync, env = process.env, timeoutMs = 5000 } = {}
) {
  const definition = INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === runtime?.id);
  if (!definition?.minimumBoundaryVersion) return;
  let result;
  const childEnv = buildInstalledRuntimeChildEnv({ env });
  try {
    result = spawnSyncImpl(runtime.path, ["--version"], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: timeoutMs,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    result = null;
  }
  if (
    result?.status !== 0 ||
    !versionAtLeast(
      `${result?.stdout || ""}\n${result?.stderr || ""}`,
      definition.minimumBoundaryVersion
    )
  ) {
    throw runtimeError(
      `${definition.name} ${definition.minimumBoundaryVersion} or newer is required for secure CareerRat tool runs.`,
      RUNTIME_TOOL_PROFILE_UNSUPPORTED,
      { runtimeId: runtime.id }
    );
  }
}

export function probeInstalledRuntime(
  runtime,
  { spawnSyncImpl = spawnSync, env = process.env, timeoutMs = 5000 } = {}
) {
  if (!runtime?.available || !runtime.path) {
    return { status: "not_installed", ready: false, action: null };
  }
  const definition = INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === runtime.id);
  if (!definition) return { status: "unsupported", ready: false, action: null };
  const childEnv = buildInstalledRuntimeChildEnv({ env });

  if (definition.minimumCompletionVersion) {
    let versionResult;
    try {
      versionResult = spawnSyncImpl(runtime.path, ["--version"], {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: timeoutMs,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      versionResult = null;
    }
    if (
      versionResult?.status !== 0 ||
      !versionAtLeast(
        `${versionResult?.stdout || ""}\n${versionResult?.stderr || ""}`,
        definition.minimumCompletionVersion
      )
    ) {
      return {
        status: "unsupported_capability",
        ready: false,
        action: null,
        completionSupported: false,
        capabilityReason: `Update ${definition.name} to ${definition.minimumCompletionVersion} or newer for isolated chat and drafting.`,
      };
    }
  }

  if (definition.toolExecutionSupported === true && definition.minimumBoundaryVersion) {
    let versionResult;
    try {
      versionResult = spawnSyncImpl(runtime.path, ["--version"], {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: timeoutMs,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      versionResult = null;
    }
    if (
      versionResult?.status !== 0 ||
      !versionAtLeast(
        `${versionResult?.stdout || ""}\n${versionResult?.stderr || ""}`,
        definition.minimumBoundaryVersion
      )
    ) {
      return {
        status: "unsupported_capability",
        ready: false,
        action: null,
        toolExecutionSupported: false,
        capabilityReason: `Update ${definition.name} to ${definition.minimumBoundaryVersion} or newer for secure CareerRat tool runs.`,
      };
    }
  }

  let result;
  try {
    result = spawnSyncImpl(runtime.path, definition.authProbe.args, {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: timeoutMs,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return { status: "probe_failed", ready: false, action: "retry" };
  }
  if (result?.error?.code === "ETIMEDOUT" || result?.signal === "SIGTERM") {
    return { status: "probe_failed", ready: false, action: "retry" };
  }
  if (result?.status === 0) {
    return {
      status: definition.authProbe.launchOnly ? "ready_unverified" : "ready",
      ready: true,
      action: null,
      completionSupported: definition.completionSupported === true,
      toolExecutionSupported: definition.toolExecutionSupported === true,
      capabilityReason:
        definition.toolExecutionSupported === true
          ? null
          : definition.completionSupported === true
            ? "Ready for chat and drafting. Task tools and research are not verified for this CLI yet."
            : UNVERIFIED_COMPLETION_REASON,
    };
  }
  return {
    status: "authentication_required",
    ready: false,
    action: "start_sign_in",
  };
}

function existingCanonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

const RUNTIME_READ_BOUNDARY_INVALID = "RUNTIME_READ_BOUNDARY_INVALID";

function isWithin(root, candidate) {
  const remainder = relative(root, candidate);
  return (
    remainder === "" ||
    (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !isAbsolute(remainder))
  );
}

function exactApprovedReadPaths({ repoRoot, env, skill, approvedReadPaths } = {}) {
  const rootSegments = EXACT_READ_ROOTS[skill];
  if (
    !repoRoot ||
    !rootSegments ||
    !Array.isArray(approvedReadPaths) ||
    approvedReadPaths.length !== 1
  ) {
    throw runtimeError(
      `Skill "${skill || "unknown"}" requires one explicit saved-upload read path.`,
      RUNTIME_READ_BOUNDARY_INVALID,
      { runtimeId: "claude", skill: skill || null }
    );
  }

  const lexicalAllowedRoot = resolve(userPath({ repoRoot, env }, join(...rootSegments)));
  const canonicalAllowedRoot = existingCanonicalPath(lexicalAllowedRoot);
  if (!canonicalAllowedRoot) {
    throw runtimeError(
      `Skill "${skill}" cannot resolve its saved-upload boundary.`,
      RUNTIME_READ_BOUNDARY_INVALID,
      { runtimeId: "claude", skill }
    );
  }

  const approved = approvedReadPaths.map((candidate) => {
    const lexical = resolve(String(candidate || ""));
    const canonical = existingCanonicalPath(lexical);
    const expectedCanonical = resolve(canonicalAllowedRoot, relative(lexicalAllowedRoot, lexical));
    const isFile = canonical ? statSync(canonical).isFile() : false;
    if (
      !canonical ||
      !isFile ||
      !isWithin(lexicalAllowedRoot, lexical) ||
      !isWithin(canonicalAllowedRoot, canonical) ||
      canonical !== expectedCanonical
    ) {
      throw runtimeError(
        `Skill "${skill}" received a read path outside its exact saved-upload boundary.`,
        RUNTIME_READ_BOUNDARY_INVALID,
        { runtimeId: "claude", skill }
      );
    }
    return canonical;
  });
  return [...new Set(approved)];
}

function approvedInstalledRuntimeReadPaths({
  repoRoot,
  env,
  skill,
  isolatedCwd,
  approvedReadPaths,
} = {}) {
  return [
    ...exactApprovedReadPaths({ repoRoot, env, skill, approvedReadPaths }),
    existingCanonicalPath(isolatedCwd),
  ].filter(Boolean);
}

function permissionAbsolutePath(path) {
  const normalized = resolve(path).split(sep).join("/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `//${normalized[0].toLowerCase()}${normalized.slice(2)}`;
  }
  return `//${normalized.replace(/^\/+/, "")}`;
}

function scopedReadRule(path) {
  const absolute = permissionAbsolutePath(path);
  try {
    return statSync(path).isDirectory() ? `Read(${absolute}/**)` : `Read(${absolute})`;
  } catch {
    return `Read(${absolute})`;
  }
}

function publicWebMcpConfig({ runtimeHostPath = process.execPath } = {}) {
  return {
    mcpServers: {
      [PUBLIC_WEB_SERVER_NAME]: {
        command: runtimeHostPath,
        args: [INSTALLED_RUNTIME_MODULE_PATH, PUBLIC_WEB_SERVER_ARG],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  };
}

function emptyMcpConfig() {
  return { mcpServers: {} };
}

function claudeRuntimeBoundary({
  repoRoot,
  env,
  skill,
  tools,
  isolatedCwd,
  approvedReadPaths,
  runtimeHostPath,
} = {}) {
  const requested = new Set(Array.isArray(tools) ? tools.filter(Boolean) : []);
  const usesFiles = ["Read", "Glob", "Grep"].some((tool) => requested.has(tool));
  if (requested.has("Glob") || requested.has("Grep")) {
    throw runtimeError(
      "Installed CareerRat skills do not expose broad file discovery tools.",
      RUNTIME_READ_BOUNDARY_INVALID,
      { runtimeId: "claude" }
    );
  }
  const readPaths = usesFiles
    ? approvedInstalledRuntimeReadPaths({
        repoRoot,
        env,
        skill,
        isolatedCwd,
        approvedReadPaths,
      })
    : [existingCanonicalPath(isolatedCwd)].filter(Boolean);

  const usesPublicWeb = requested.has("WebSearch") || requested.has("WebFetch");
  const visibleTools = [...requested].filter((tool) => tool !== "WebFetch");
  const allowedTools = [];
  if (usesFiles) allowedTools.push(...readPaths.map(scopedReadRule));
  if (requested.has("Skill") && skill) allowedTools.push(`Skill(${skill})`);
  if (requested.has("WebSearch")) allowedTools.push("WebSearch");
  if (usesPublicWeb) allowedTools.push(PUBLIC_WEB_FETCH_TOOL);

  return {
    visibleTools,
    allowedTools,
    settings: {
      permissions: {
        defaultMode: "dontAsk",
        deny: ["Bash", "Edit", "Write", "NotebookEdit", "Agent", "WebFetch"],
      },
      sandbox: {
        allowUnsandboxedCommands: false,
        filesystem: {
          denyRead: ["//**"],
          allowRead: usesFiles ? readPaths : isolatedCwd ? [isolatedCwd] : [],
        },
        network: {
          allowLocalBinding: false,
          allowAllUnixSockets: false,
          deniedDomains: ["localhost", "*.localhost", "0.0.0.0", "127.0.0.1", "169.254.169.254"],
        },
      },
    },
    mcpConfig: usesPublicWeb ? publicWebMcpConfig({ runtimeHostPath }) : emptyMcpConfig(),
  };
}

export function buildInstalledRuntimeInvocation({
  runtimeId,
  executablePath,
  schema,
  schemaPath,
  model,
  tools = [],
  // Set by runInstalledRuntime only once it has actually materialized an
  // isolated cwd for this skill (see materializeIsolatedSkillCwd below) —
  // never trust a bare skill *name* here, since --setting-sources project
  // is only safe when the spawn's cwd is guaranteed to contain nothing but
  // that one skill.
  skill,
  repoRoot,
  env = process.env,
  isolatedCwd,
  approvedReadPaths,
  runtimeHostPath,
  // Only meaningful for runtimeId === "claude" (the only definition with
  // streamingSupported: true — see the registry above). Swaps
  // `--output-format json` for `--output-format stream-json --verbose`:
  // stream-json requires --verbose in print mode, per the CLI's own --help.
  // Ignored for every other runtime; runInstalledRuntimeStream is the only
  // caller that ever sets this true, and it already gates on
  // streamingSupported before getting here.
  streaming = false,
} = {}) {
  const common = {
    command: executablePath,
    stdin: true,
    options: { shell: false, windowsHide: true },
  };
  if (runtimeId === "claude") {
    const boundary = claudeRuntimeBoundary({
      repoRoot,
      env,
      skill,
      tools,
      isolatedCwd,
      approvedReadPaths,
      runtimeHostPath,
    });
    const args = [
      "-p",
      "--setting-sources",
      skill ? "project" : "",
      "--settings",
      JSON.stringify(boundary.settings),
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify(boundary.mcpConfig),
      "--no-chrome",
      "--output-format",
      streaming ? "stream-json" : "json",
      ...(streaming ? ["--verbose"] : []),
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
    ];
    args.push("--tools", boundary.visibleTools.join(","));
    if (boundary.allowedTools.length) {
      args.push("--allowedTools", boundary.allowedTools.join(","));
    }
    if (model) args.push("--model", model);
    if (schema) args.push("--json-schema", JSON.stringify(sanitizeInstalledOutputSchema(schema)));
    return { ...common, args };
  }
  if (runtimeId === "codex") {
    const disabledFeatures = [
      "shell_tool",
      "unified_exec",
      "apps",
      "browser_use",
      "browser_use_external",
      "browser_use_full_cdp_access",
      "computer_use",
      "image_generation",
      "multi_agent",
      "multi_agent_v2",
      "plugins",
      "skill_search",
      "view_image",
    ];
    const args = [
      "exec",
      "--json",
      // CareerRat supplies the whole bounded task. Keep Codex account auth,
      // but do not load unrelated global MCP servers, hooks, or defaults
      // from ~/.codex/config.toml into an app-owned completion call.
      "--ignore-user-config",
      "--ignore-rules",
      ...disabledFeatures.flatMap((feature) => ["--disable", feature]),
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--skip-git-repo-check",
    ];
    if (model) args.push("--model", model);
    if (schemaPath) args.push("--output-schema", schemaPath);
    args.push("-");
    return { ...common, args };
  }
  if (runtimeId === "opencode") {
    return { ...common, args: ["run", "-"] };
  }
  if (runtimeId === "copilot") {
    return { ...common, args: ["-p", "-"] };
  }
  if (["gemini", "qwen", "antigravity"].includes(runtimeId)) {
    return { ...common, args: ["-p", ""] };
  }
  if (runtimeId === "hermes") {
    return { ...common, args: ["-z"] };
  }
  if (runtimeId === "amp") {
    return { ...common, args: ["-x"] };
  }
  if (runtimeId === "goose") {
    return { ...common, args: ["run", "-i", "-"] };
  }
  if (runtimeId === "droid") {
    return { ...common, args: ["exec"] };
  }
  const error = new Error(`unsupported installed AI runtime: ${runtimeId}`);
  error.code = "RUNTIME_UNSUPPORTED";
  throw error;
}

function sanitizeInstalledOutputSchema(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeInstalledOutputSchema(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$schema" && key !== "$id")
      .map(([key, entry]) => [key, sanitizeInstalledOutputSchema(entry)])
  );
}

function sanitizeCodexOutputSchema(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeCodexOutputSchema(entry));
  if (!value || typeof value !== "object") return value;
  const sanitized = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$schema" && key !== "$id")
      .map(([key, entry]) => [key, sanitizeCodexOutputSchema(entry)])
  );
  if (sanitized.properties && typeof sanitized.properties === "object") {
    // Codex/OpenAI strict structured outputs require every declared object
    // property in `required` and forbid undeclared properties. CareerRat's
    // canonical schemas intentionally allow some optional fields, so the
    // CLI receives a stricter projection while the bounded runner still
    // validates the returned data against the original schema afterward.
    sanitized.required = Object.keys(sanitized.properties);
    sanitized.additionalProperties = false;
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// Isolated skill cwd. Builds an app-owned, ephemeral cwd containing nothing but
// `.claude/skills/<skill>/`, copied from the repo's own
// `.agents/skills/<skill>`. A copy keeps the project-settings loader inside
// the isolated tree instead of following a skill symlink back toward the real
// checkout. The caller treats a null result as a hard boundary failure, never
// as permission to fall back to the repo cwd.
// ---------------------------------------------------------------------------

function copySkillTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copySkillTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

export function materializeIsolatedSkillCwd({ repoRoot, skill } = {}) {
  if (!repoRoot || !skill) return null;
  const sourceDir = join(repoRoot, ".agents", "skills", skill);
  if (!existsSync(join(sourceDir, "SKILL.md"))) return null;

  let tempDir;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "careerrat-skill-cwd-"));
    chmodSync(tempDir, 0o700);
    const skillsDir = join(tempDir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const dest = join(skillsDir, skill);
    copySkillTree(sourceDir, dest);
    return tempDir;
  } catch {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup only
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Custom command runtime — W4 onboarding's 3d/3f "Custom command" + Test.
// Any text-in/text-out command works: the probe writes a short prompt to
// stdin and reads stdout back, exactly like the fixed registry's own
// runInstalledRuntime() stdin/stdout contract above, just without a fixed
// argv. shell:false is preserved (same security posture as the rest of this
// file) — the command string is split into argv ourselves rather than handed
// to a shell.
// ---------------------------------------------------------------------------

const CUSTOM_RUNTIME_TEST_PROMPT = "Reply with a single short sentence to confirm you can respond.";

// A minimal argv splitter: whitespace-separated, with single/double-quoted
// segments kept intact (so `~/bin/my-agent --name "my agent"` splits into
// three argv entries, not four). Not a full shell grammar (no backslash
// escapes, no nesting) — custom commands are simple CLI invocations, and a
// user who needs more than this can wrap it in a small shell script instead.
export function parseCustomCommandString(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const parts = [];
  for (;;) {
    const match = pattern.exec(raw);
    if (!match) break;
    parts.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]);
  }
  return parts;
}

// Runs the custom command once with a small stdin prompt and measures
// latency. 15s timeout per the W4 spec (server scope item 4) — a stuck
// custom command must not hang the Settings/onboarding UI. Never throws:
// every failure path (bad command, spawn error, timeout, non-zero exit)
// resolves to { ok: false, error }.
export async function probeCustomRuntimeCommand({
  command,
  prompt = CUSTOM_RUNTIME_TEST_PROMPT,
  timeoutMs = 15000,
  spawnImpl = spawn,
  env = process.env,
  cwd,
} = {}) {
  const argv = parseCustomCommandString(command);
  if (!argv.length) {
    return { ok: false, error: "Enter a command to test." };
  }
  const startedAt = Date.now();
  const [bin, ...args] = argv;
  const childEnv = buildInstalledRuntimeChildEnv({ env });

  let child;
  try {
    child = spawnImpl(bin, args, {
      shell: false,
      windowsHide: true,
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return { ok: false, error: `Could not start "${bin}": ${error.message}`, elapsedMs: null };
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // best-effort only
        }
        resolve({ ok: false, error: "Timed out after 15s.", elapsedMs: Date.now() - startedAt });
      },
      Math.max(1, timeoutMs)
    );
    timer.unref?.();

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: safeRuntimeDiagnostic(error.message), elapsedMs: null });
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsedMs = Date.now() - startedAt;
      if (status !== 0) {
        resolve({
          ok: false,
          error: safeRuntimeDiagnostic(stderr) || `Exited with status ${status}.`,
          elapsedMs,
        });
        return;
      }
      resolve({ ok: true, elapsedMs, output: safeRuntimeDiagnostic(stdout) });
    });

    child.stdin?.on("error", () => {
      // A fast process can close stdin before the write completes.
    });
    child.stdin?.end(prompt);
  });
}

export function installedRuntimeSignInCommand(runtimeId) {
  if (runtimeId === "claude") return "claude auth login";
  if (runtimeId === "codex") return "codex login";
  if (runtimeId === "opencode") return "opencode auth login";
  if (runtimeId === "goose") return "goose configure";
  if (["gemini", "copilot", "qwen", "antigravity", "hermes", "amp", "droid"].includes(runtimeId)) {
    return `${runtimeId} --help`;
  }
  return null;
}

const ACTIVE_RUNTIME_SIGN_INS = new Map();
const RUNTIME_SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

function installedRuntimeSignInArgs(runtimeId) {
  if (runtimeId === "claude") return ["auth", "login"];
  if (runtimeId === "codex") return ["login"];
  if (runtimeId === "opencode") return ["auth", "login"];
  if (runtimeId === "goose") return ["configure"];
  return null;
}

export function startInstalledRuntimeSignIn(
  runtime,
  { spawnImpl = spawn, timeoutMs = RUNTIME_SIGN_IN_TIMEOUT_MS } = {}
) {
  const signInCommand = installedRuntimeSignInCommand(runtime?.id);
  const args = installedRuntimeSignInArgs(runtime?.id);
  if (!signInCommand || !args || !runtime?.path) {
    throw runtimeError("Unsupported installed AI runtime.", "RUNTIME_UNSUPPORTED");
  }

  const existing = ACTIVE_RUNTIME_SIGN_INS.get(runtime.id);
  if (existing) {
    return { ok: true, runtimeId: runtime.id, signInCommand, reused: true };
  }

  const child = spawnImpl(runtime.path, args, {
    shell: false,
    detached: false,
    stdio: "ignore",
    windowsHide: true,
  });
  const timer = setTimeout(() => child.kill?.("SIGTERM"), timeoutMs);
  timer.unref?.();
  const clear = () => {
    clearTimeout(timer);
    if (ACTIVE_RUNTIME_SIGN_INS.get(runtime.id)?.child === child) {
      ACTIVE_RUNTIME_SIGN_INS.delete(runtime.id);
    }
  };
  child.once?.("exit", clear);
  child.once?.("error", clear);
  ACTIVE_RUNTIME_SIGN_INS.set(runtime.id, { child, timer });
  child.unref?.();
  return { ok: true, runtimeId: runtime.id, signInCommand, reused: false };
}

export function stopInstalledRuntimeSignIns() {
  for (const { child, timer } of ACTIVE_RUNTIME_SIGN_INS.values()) {
    clearTimeout(timer);
    child.kill?.("SIGTERM");
  }
  ACTIVE_RUNTIME_SIGN_INS.clear();
}

const MAX_RUNTIME_OUTPUT_BYTES = 10 * 1024 * 1024;
const ANSI_COLOR_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// runInstalledRuntime's `timeoutMs` has two tiers, both exported so callers
// pick the right one instead of re-deriving a magic number:
//   - ONE_SHOT_RUNTIME_TIMEOUT_MS (the default below): sized for bounded,
//     single-turn calls with no live web research, e.g. evaluate-job,
//     tailor-application, resume-extract, and every other call-ai.mjs /
//     skill-runtime.mjs route. 120s comfortably covers one model completion.
//   - CHAT_SESSION_RUNTIME_TIMEOUT_MS: opted into per-call by
//     chat-runtime.mjs's runInstalledTurn for interactive chat-session turns
//     over the Read-less CHAT_RUNTIME_TOOLS profile (research-company,
//     research-comp, company-health, ...). Those turns do live WebSearch/
//     WebFetch research and, per wave-4 packaged QA, reliably run past 120s
//     (two consecutive SSE-confirmed "Installed AI request timed out."
//     failures on research-company and research-comp). Raising the shared
//     default would have papered over that instead of fixing it, so this is
//     a second, wider tier a caller must opt into instead.
export const ONE_SHOT_RUNTIME_TIMEOUT_MS = 120000;
export const CHAT_SESSION_RUNTIME_TIMEOUT_MS = 9 * 60 * 1000;

function safeRuntimeDiagnostic(value) {
  return String(value || "")
    .replace(ANSI_COLOR_SEQUENCE, "")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/rlp_[0-9a-f]{16,}/gi, "[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[redacted]")
    .trim()
    .slice(0, 4000);
}

function claudeFailureDiagnostic(value) {
  let envelope = value;
  if (typeof value === "string") {
    const source = value.replace(ANSI_COLOR_SEQUENCE, "").trim();
    if (!source || source.length > 64 * 1024) return "";
    try {
      envelope = JSON.parse(source);
    } catch {
      return "";
    }
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return "";
  const candidates = [
    envelope.result,
    envelope.error?.message,
    envelope.message,
    ...(Array.isArray(envelope.errors) ? envelope.errors : []),
  ];
  for (const candidate of candidates) {
    const message =
      typeof candidate === "string"
        ? candidate
        : candidate && typeof candidate === "object"
          ? candidate.message
          : "";
    if (typeof message === "string" && message.trim()) return safeRuntimeDiagnostic(message);
  }
  return "";
}

function runtimeError(message, code, fields = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, fields);
  return error;
}

// Distinguishes runInstalledRuntime's chat-tool-profile guard (below) from a
// generic RUNTIME_* failure, the same way "RUNTIME_TOOL_PROFILE_INVALID" lets
// runtime-tools.mjs's own callers tell a bad profile name apart from a spawn
// failure.
export const RUNTIME_TOOL_PROFILE_UNSUPPORTED = "RUNTIME_TOOL_PROFILE_UNSUPPORTED";

function parseClaudeResult(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { text: stdout.trim(), usage: null, model: null };
  }
  if (envelope?.is_error === true || envelope?.subtype === "error") {
    throw runtimeError(
      safeRuntimeDiagnostic(envelope?.result) || "Claude CLI reported an unsuccessful result.",
      "RUNTIME_RESULT_ERROR"
    );
  }
  const structured = envelope?.structured_output;
  return {
    text:
      structured === undefined ? String(envelope?.result || "").trim() : JSON.stringify(structured),
    usage: envelope?.usage || null,
    model: envelope?.model || null,
  };
}

function parseCodexResult(stdout) {
  let text = "";
  let usage = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "item.completed" && event?.item?.type === "agent_message") {
      text = String(event.item.text || "").trim();
    }
    if (event?.type === "turn.completed" && event?.usage) usage = event.usage;
    if (event?.type === "turn.failed") {
      throw runtimeError(
        safeRuntimeDiagnostic(event?.error?.message) || "Codex CLI reported an unsuccessful turn.",
        "RUNTIME_RESULT_ERROR"
      );
    }
  }
  return { text: text || stdout.trim(), usage, model: null };
}

function parseRuntimeResult(runtimeId, stdout) {
  if (runtimeId === "claude") return parseClaudeResult(stdout);
  if (runtimeId === "codex") return parseCodexResult(stdout);
  return { text: stdout.trim(), usage: null, model: null };
}

function killRuntimeProcess(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process already exited between the state check and kill.
    }
  }
}

export async function runInstalledRuntime({
  runtime,
  prompt,
  outputSchema,
  model,
  tools = [],
  cwd,
  env = process.env,
  signal,
  timeoutMs = ONE_SHOT_RUNTIME_TIMEOUT_MS,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  onEvent,
  // A named skill always runs in materializeIsolatedSkillCwd()'s single-skill
  // project. Exact-read tool runs must also supply one canonical saved upload
  // through approvedReadPaths; broad repo reads fail closed.
  skill = null,
  repoRoot = null,
  approvedReadPaths = [],
} = {}) {
  if (!runtime?.id || !runtime?.path) {
    throw runtimeError("No installed AI runtime is selected.", "RUNTIME_NOT_SELECTED");
  }
  if (signal?.aborted) {
    throw runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED");
  }
  const definition = INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === runtime.id);
  const providerTools = Array.isArray(tools)
    ? tools.filter((tool) => tool && tool !== "Skill")
    : [];
  const toolBearing = providerTools.length > 0;
  const runtimeCapabilities = installedRuntimeCapabilities(runtime.id).capabilities;
  if (!toolBearing && runtimeCapabilities.completion !== true) {
    throw runtimeError(
      `${definition?.name || runtime.id} is detected, but its isolated chat and drafting mode ` +
        "has not been verified yet.",
      "RUNTIME_COMPLETION_UNSUPPORTED",
      { runtimeId: runtime.id }
    );
  }
  if (toolBearing && definition?.toolExecutionSupported !== true) {
    throw runtimeError(
      `${definition?.name || runtime.id} is detected, but it cannot safely run CareerRat tools. ` +
        "Choose Claude Code 2.1.241 or newer, or use the explicit provider fallback.",
      RUNTIME_TOOL_PROFILE_UNSUPPORTED,
      { runtimeId: runtime.id }
    );
  }
  const childEnv = buildInstalledRuntimeChildEnv({ env });
  if (toolBearing) assertInstalledRuntimeBoundaryVersion(runtime, { spawnSyncImpl, env: childEnv });
  const installedPrompt = promptWithInstalledSkill({ prompt, repoRoot, skill });

  let tempDir = null;
  let skillCwd = null;
  let taskCwd = null;
  try {
    let schemaPath = null;
    if (runtime.id === "codex" && outputSchema) {
      tempDir = mkdtempSync(join(tmpdir(), "careerrat-runtime-schema-"));
      chmodSync(tempDir, 0o700);
      schemaPath = join(tempDir, "output-schema.json");
      writeFileSync(schemaPath, `${JSON.stringify(sanitizeCodexOutputSchema(outputSchema))}\n`, {
        mode: 0o600,
      });
    }
    if (skill) {
      skillCwd = materializeIsolatedSkillCwd({ repoRoot, skill });
      if (!skillCwd) {
        throw runtimeError(
          `Could not create the isolated CareerRat runtime for skill "${skill}".`,
          "RUNTIME_BOUNDARY_UNAVAILABLE",
          { runtimeId: runtime.id }
        );
      }
    } else if (!toolBearing) {
      taskCwd = mkdtempSync(join(tmpdir(), "careerrat-task-cwd-"));
      chmodSync(taskCwd, 0o700);
    }
    const invocation = buildInstalledRuntimeInvocation({
      runtimeId: runtime.id,
      executablePath: runtime.path,
      schema: outputSchema,
      schemaPath,
      model,
      tools: providerTools,
      // Only tell the arg-builder a skill is "ready" once isolation actually
      // succeeded — never claim --setting-sources project against a plain
      // repoRoot cwd, which would reintroduce the full checkout context and
      // defeat the per-call filesystem boundary.
      skill: runtime.id === "claude" && skillCwd ? skill : undefined,
      repoRoot,
      env,
      isolatedCwd: skillCwd,
      approvedReadPaths,
    });

    const result = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(invocation.command, invocation.args, {
          ...invocation.options,
          cwd: skillCwd || taskCwd || cwd,
          env: childEnv,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(
          runtimeError("Could not start the selected AI CLI.", "RUNTIME_SPAWN", { cause: error })
        );
        return;
      }

      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      let timedOut = false;
      let cancelled = false;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        callback();
      };
      const abort = () => {
        cancelled = true;
        killRuntimeProcess(child);
      };
      const timer = setTimeout(
        () => {
          timedOut = true;
          killRuntimeProcess(child);
        },
        Math.max(1, timeoutMs)
      );
      timer.unref?.();
      signal?.addEventListener("abort", abort, { once: true });

      child.stdout?.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_RUNTIME_OUTPUT_BYTES) {
          killRuntimeProcess(child);
          return;
        }
        const text = chunk.toString("utf8");
        stdout += text;
        onEvent?.({ type: "output", stream: "stdout", bytes: chunk.length });
      });
      child.stderr?.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_RUNTIME_OUTPUT_BYTES) {
          killRuntimeProcess(child);
          return;
        }
        stderr += chunk.toString("utf8");
        onEvent?.({ type: "output", stream: "stderr", bytes: chunk.length });
      });
      child.on("error", (error) => {
        finish(() =>
          reject(
            runtimeError("Could not start the selected AI CLI.", "RUNTIME_SPAWN", { cause: error })
          )
        );
      });
      child.on("close", (status, closeSignal) => {
        finish(() => {
          if (cancelled) {
            reject(runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED"));
            return;
          }
          if (timedOut) {
            reject(runtimeError("Installed AI request timed out.", "RUNTIME_TIMEOUT"));
            return;
          }
          if (outputBytes > MAX_RUNTIME_OUTPUT_BYTES) {
            reject(
              runtimeError(
                "Installed AI output exceeded the 10MB safety limit.",
                "RUNTIME_OUTPUT_LIMIT"
              )
            );
            return;
          }
          if (status !== 0) {
            const diagnostic =
              (runtime.id === "claude" ? claudeFailureDiagnostic(stdout) : "") ||
              safeRuntimeDiagnostic(stderr);
            reject(
              runtimeError(
                `Installed AI CLI exited with status ${status}${diagnostic ? `: ${diagnostic}` : "."}`,
                "RUNTIME_EXIT",
                { exitStatus: status, signal: closeSignal || null }
              )
            );
            return;
          }
          try {
            resolve(parseRuntimeResult(runtime.id, stdout));
          } catch (error) {
            reject(error);
          }
        });
      });

      child.stdin?.on("error", () => {
        // A fast process can close stdin before the write completes; close/error
        // handling above owns the final outcome.
      });
      child.stdin?.end(installedPrompt);
    });

    return { ...result, runtimeId: runtime.id };
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    if (skillCwd) rmSync(skillCwd, { recursive: true, force: true });
    if (taskCwd) rmSync(taskCwd, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// runInstalledRuntimeStream — the streaming sibling of runInstalledRuntime,
// added so a chat turn over the installed "claude" runtime can surface real
// tool_use/tool_result activity while the turn is still running instead of
// going dark until process exit (the bug this fix closes: startInstalledSession
// never called loadSdk, so chat-runtime.mjs's own runInstalledTurn only ever
// had ONE json envelope to work with, at the very end).
//
// Capability-gated: only a runtime with streamingSupported: true in the
// registry above (today, only "claude") may call this. Every other installed
// runtime (codex, gemini, opencode, ...) keeps going through the single-shot
// runInstalledRuntime unchanged — this function throws RUNTIME_STREAMING_UNSUPPORTED
// before spawning anything if asked to run one of them.
//
// Deliberately does NOT import or duplicate skill-runtime.mjs's mapSdkMessage:
// installed-runtimes.mjs sits below skill-runtime.mjs in the dependency graph
// (skill-runtime.mjs already imports runInstalledRuntime from here), so
// importing the other direction would be a cycle. Instead this function is a
// pure NDJSON-line-to-raw-message pump — one parsed JSON object per `onMessage`
// call, in arrival order, using the exact same message shapes (`type`:
// system/assistant/user/result, snake_case fields) the claude CLI's
// stream-json output shares with the Agent SDK's own query() messages (both
// are produced by the same underlying engine). Callers (chat-runtime.mjs)
// already import mapSdkMessage for the SDK path and can feed each raw message
// through the identical mapper here, so the two routes can never drift on
// frame shape.
//
// Malformed lines are skipped, never thrown — a single corrupted NDJSON line
// must not crash an otherwise-healthy chat turn. Partial lines (a chunk
// boundary landing mid-JSON-object) are buffered and only parsed once a
// trailing newline completes them.
// ---------------------------------------------------------------------------

export function supportsInstalledRuntimeStreaming(runtimeId) {
  const definition = INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === runtimeId);
  return Boolean(definition?.streamingSupported);
}

export const RUNTIME_STREAMING_UNSUPPORTED = "RUNTIME_STREAMING_UNSUPPORTED";

export async function runInstalledRuntimeStream({
  runtime,
  prompt,
  model,
  tools = [],
  cwd,
  env = process.env,
  signal,
  timeoutMs = ONE_SHOT_RUNTIME_TIMEOUT_MS,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  // Skill this call is running — same isolated-cwd semantics as
  // runInstalledRuntime's own skill/repoRoot params (see
  // materializeIsolatedSkillCwd and buildInstalledRuntimeInvocation above).
  skill = null,
  repoRoot = null,
  approvedReadPaths = [],
  // Called once per raw NDJSON message, in stream order, as soon as it's
  // fully parsed — including the terminal "result" message. A throwing
  // callback must never break the pump; caught and dropped.
  onMessage,
} = {}) {
  if (!runtime?.id || !runtime?.path) {
    throw runtimeError("No installed AI runtime is selected.", "RUNTIME_NOT_SELECTED");
  }
  if (!supportsInstalledRuntimeStreaming(runtime.id)) {
    throw runtimeError(
      `${runtime.name || runtime.id} has no streaming output mode, so it cannot run a streaming ` +
        "installed turn.",
      RUNTIME_STREAMING_UNSUPPORTED,
      { runtimeId: runtime.id }
    );
  }
  if (signal?.aborted) {
    throw runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED");
  }
  const definition = INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === runtime.id);
  if ((Boolean(skill) || tools.length > 0) && definition?.toolExecutionSupported !== true) {
    throw runtimeError(
      `${definition?.name || runtime.id} is detected, but it cannot safely run CareerRat tools. ` +
        "Choose Claude Code 2.1.241 or newer, or use the explicit provider fallback.",
      RUNTIME_TOOL_PROFILE_UNSUPPORTED,
      { runtimeId: runtime.id }
    );
  }
  const childEnv = buildInstalledRuntimeChildEnv({ env });
  if (skill || tools.length > 0) {
    assertInstalledRuntimeBoundaryVersion(runtime, { spawnSyncImpl, env: childEnv });
  }

  let skillCwd = null;
  try {
    if (runtime.id === "claude" && skill) {
      skillCwd = materializeIsolatedSkillCwd({ repoRoot, skill });
      if (!skillCwd) {
        throw runtimeError(
          `Could not create the isolated CareerRat runtime for skill "${skill}".`,
          "RUNTIME_BOUNDARY_UNAVAILABLE",
          { runtimeId: runtime.id }
        );
      }
    }
    const invocation = buildInstalledRuntimeInvocation({
      runtimeId: runtime.id,
      executablePath: runtime.path,
      model,
      tools,
      skill: skillCwd ? skill : undefined,
      repoRoot,
      env,
      isolatedCwd: skillCwd,
      approvedReadPaths,
      streaming: true,
    });

    const result = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(invocation.command, invocation.args, {
          ...invocation.options,
          cwd: skillCwd || cwd,
          env: childEnv,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(
          runtimeError("Could not start the selected AI CLI.", "RUNTIME_SPAWN", { cause: error })
        );
        return;
      }

      let lineBuffer = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let finalResult = null;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        callback();
      };
      const abort = () => {
        cancelled = true;
        killRuntimeProcess(child);
      };
      const timer = setTimeout(
        () => {
          timedOut = true;
          killRuntimeProcess(child);
        },
        Math.max(1, timeoutMs)
      );
      timer.unref?.();
      signal?.addEventListener("abort", abort, { once: true });

      // One NDJSON line -> one parsed message -> one onMessage call. A line
      // that fails to parse (a chunk boundary that split mid-object and never
      // recombines cleanly, or genuinely corrupt output) is skipped rather
      // than thrown — this pump must survive a single bad line.
      function handleLine(line) {
        const trimmed = line.trim();
        if (!trimmed) return;
        let message;
        try {
          message = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (message?.type === "result") finalResult = message;
        try {
          onMessage?.(message);
        } catch {
          // a caller's own mapping/dispatch error must never break the pump
        }
      }

      child.stdout?.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_RUNTIME_OUTPUT_BYTES) {
          killRuntimeProcess(child);
          return;
        }
        lineBuffer += chunk.toString("utf8");
        const lines = lineBuffer.split("\n");
        // The last element is either "" (the chunk ended exactly on a
        // newline) or a partial line still waiting for more data — either
        // way it's not yet a complete line, so it goes back into the buffer
        // rather than through handleLine.
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });
      child.stderr?.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_RUNTIME_OUTPUT_BYTES) {
          killRuntimeProcess(child);
          return;
        }
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        finish(() =>
          reject(
            runtimeError("Could not start the selected AI CLI.", "RUNTIME_SPAWN", { cause: error })
          )
        );
      });
      child.on("close", (status, closeSignal) => {
        finish(() => {
          // Flush a final complete-but-unterminated line (a process that
          // exits without a trailing newline after its last NDJSON object).
          if (lineBuffer.trim()) handleLine(lineBuffer);
          if (cancelled) {
            reject(runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED"));
            return;
          }
          if (timedOut) {
            reject(runtimeError("Installed AI request timed out.", "RUNTIME_TIMEOUT"));
            return;
          }
          if (outputBytes > MAX_RUNTIME_OUTPUT_BYTES) {
            reject(
              runtimeError(
                "Installed AI output exceeded the 10MB safety limit.",
                "RUNTIME_OUTPUT_LIMIT"
              )
            );
            return;
          }
          if (status !== 0) {
            const diagnostic =
              (runtime.id === "claude" ? claudeFailureDiagnostic(finalResult) : "") ||
              safeRuntimeDiagnostic(stderr);
            reject(
              runtimeError(
                `Installed AI CLI exited with status ${status}${diagnostic ? `: ${diagnostic}` : "."}`,
                "RUNTIME_EXIT",
                { exitStatus: status, signal: closeSignal || null }
              )
            );
            return;
          }
          if (!finalResult) {
            reject(
              runtimeError(
                "Installed AI CLI exited without a result event.",
                "RUNTIME_RESULT_MISSING"
              )
            );
            return;
          }
          if (finalResult.is_error === true || finalResult.subtype === "error") {
            reject(
              runtimeError(
                safeRuntimeDiagnostic(finalResult.result) ||
                  "Claude CLI reported an unsuccessful result.",
                "RUNTIME_RESULT_ERROR"
              )
            );
            return;
          }
          const structured = finalResult.structured_output;
          resolve({
            text:
              structured === undefined
                ? String(finalResult.result || "").trim()
                : JSON.stringify(structured),
            usage: finalResult.usage || null,
            model: finalResult.model || null,
            sessionId: finalResult.session_id || null,
          });
        });
      });

      child.stdin?.on("error", () => {
        // A fast process can close stdin before the write completes; close/error
        // handling above owns the final outcome.
      });
      child.stdin?.end(String(prompt || ""));
    });

    return { ...result, runtimeId: runtime.id };
  } finally {
    if (skillCwd) rmSync(skillCwd, { recursive: true, force: true });
  }
}

export async function fetchInstalledRuntimePublicUrl(
  url,
  { fetchPublicHttpTextImpl = fetchPublicHttpText } = {}
) {
  const checked = validatePublicHttpUrl(url);
  if (!checked.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `Public URL rejected: ${checked.reason}` }],
    };
  }
  const result = await fetchPublicHttpTextImpl(checked.url, {
    timeoutMs: 15000,
    maxBytes: 512 * 1024,
    maxRedirects: 4,
  });
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `Public fetch failed: ${result.reason}` }],
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          url: result.finalUrl || checked.url,
          status: result.status,
          contentType: result.contentType || null,
          text: result.rawText,
        }),
      },
    ],
  };
}

function writeMcpMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handlePublicWebMcpRequest(message) {
  if (!message || message.id === undefined) return;
  const base = { jsonrpc: "2.0", id: message.id };
  if (message.method === "initialize") {
    writeMcpMessage({
      ...base,
      result: {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: PUBLIC_WEB_SERVER_NAME, version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "ping") {
    writeMcpMessage({ ...base, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    writeMcpMessage({
      ...base,
      result: {
        tools: [
          {
            name: "fetch",
            description:
              "Fetch one public HTTP(S) page through CareerRat's DNS-pinned private-network guard.",
            inputSchema: {
              type: "object",
              properties: { url: { type: "string", format: "uri" } },
              required: ["url"],
              additionalProperties: false,
            },
          },
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call" && message.params?.name === "fetch") {
    writeMcpMessage({
      ...base,
      result: await fetchInstalledRuntimePublicUrl(message.params?.arguments?.url),
    });
    return;
  }
  writeMcpMessage({
    ...base,
    error: { code: -32601, message: "Method not found" },
  });
}

function startPublicWebMcpServer() {
  const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  input.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    Promise.resolve(handlePublicWebMcpRequest(message)).catch((error) => {
      if (message?.id === undefined) return;
      writeMcpMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: safeRuntimeDiagnostic(error?.message) || "Internal error" },
      });
    });
  });
}

if (process.argv.includes(PUBLIC_WEB_SERVER_ARG)) startPublicWebMcpServer();
