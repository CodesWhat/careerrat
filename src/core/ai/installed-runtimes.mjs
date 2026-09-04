// Installed AI CLI registry shared by in-app sign-in and Electron.
// Discovery never executes a candidate binary. Readiness probes and requests
// spawn the resolved executable directly with fixed argv and shell:false.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchPublicHttpText, validatePublicHttpUrl } from "../net/public-http-fetch.mjs";
import { userPath } from "../paths/workspace.mjs";
import { probeAcpRuntime, runAcpRuntime } from "./acp-runtime.mjs";
import { isWithinRuntimePath } from "./runtime-path-policy.mjs";
import {
  runtimeProcessIdentityFiles,
  runtimeProcessInvocation,
  scheduleRuntimeProcessKill,
} from "./runtime-process.mjs";

const CLAUDE_BOUNDARY_MINIMUM_VERSION = "2.1.241";
const UNVERIFIED_COMPLETION_REASON =
  "Detected, but this CLI has not passed the complete CareerRat workflow yet.";
const SCOPED_TOOLS_SERVER_NAME = "careerrat_scoped_tools";
const PUBLIC_WEB_FETCH_TOOL = `mcp__${SCOPED_TOOLS_SERVER_NAME}__fetch`;
const SCOPED_TOOLS_SERVER_ARG = "--careerrat-scoped-tools";
const SCOPED_PUBLIC_WEB_ARG = "--allow-public-web";
const SCOPED_READ_FILE_ARG = "--approved-read-file";
const MAX_SCOPED_READ_BYTES = 20 * 1024 * 1024;
const INSTALLED_RUNTIME_MODULE_PATH = fileURLToPath(import.meta.url);
const EXACT_READ_ROOTS = Object.freeze({
  "intake-extract": ["workspace", "intake", "uploads"],
  "resume-extract": ["workspace", "intake", "resume-uploads"],
});

const FULL_WORKFLOW_ACCEPTED_CAPABILITIES = Object.freeze({
  completion: true,
  structuredOutput: true,
  appWorkflows: true,
  exactRead: true,
  publicWeb: true,
  liveActivity: true,
  resumable: true,
});
const NO_WORKFLOW_ACCEPTED_CAPABILITIES = Object.freeze(
  Object.fromEntries(
    Object.keys(FULL_WORKFLOW_ACCEPTED_CAPABILITIES).map((capability) => [capability, false])
  )
);

export function isSupportedInstalledRuntime(runtimeId) {
  return installedRuntimeDefinition(runtimeId)?.supported === true;
}

export function hasInstalledRuntimeCompletion(capabilities, runtimeId) {
  return isSupportedInstalledRuntime(runtimeId) && capabilities?.completion === true;
}

export function hasCompleteCareerRatCapabilities(capabilities, runtimeId) {
  const definition = installedRuntimeDefinition(runtimeId);
  if (runtimeId && definition?.supported !== true) return false;
  const acceptedCapabilities =
    definition?.acceptedCapabilities ||
    (runtimeId ? NO_WORKFLOW_ACCEPTED_CAPABILITIES : FULL_WORKFLOW_ACCEPTED_CAPABILITIES);
  return Object.entries(acceptedCapabilities).every(
    ([capability, accepted]) => accepted === true && capabilities?.[capability] === true
  );
}

export function sanitizeInstalledRuntimeCapabilityEvidence(runtimeId, capabilities) {
  const acceptedCapabilities = installedRuntimeDefinition(runtimeId)?.capabilities || {};
  return Object.fromEntries(
    Object.keys(acceptedCapabilities).map((capability) => [
      capability,
      capabilities?.[capability] === true,
    ])
  );
}

const INSTALLED_CHILD_ENV_KEYS = Object.freeze([
  "PATH",
  "Path",
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
  "ComSpec",
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
    supported: true,
    protocol: "claude-json",
    binaries: ["claude"],
    commandShape: "claude -p --output-format json",
    authProbe: { args: ["auth", "status"] },
    signInArgs: Object.freeze(["auth", "login"]),
    modelEnvKeys: Object.freeze(["CAREERRAT_INSTALLED_AI_MODEL", "ANTHROPIC_MODEL"]),
    installUrl: "https://code.claude.com/docs/en/quickstart",
    capabilities: FULL_WORKFLOW_ACCEPTED_CAPABILITIES,
    acceptedCapabilities: FULL_WORKFLOW_ACCEPTED_CAPABILITIES,
    minimumBoundaryVersion: CLAUDE_BOUNDARY_MINIMUM_VERSION,
  },
  {
    id: "codex",
    name: "Codex",
    supported: true,
    protocol: "codex-jsonl",
    binaries: ["codex"],
    commandShape: "codex exec --json -",
    authProbe: { args: ["login", "status"] },
    signInArgs: Object.freeze(["login"]),
    modelEnvKeys: Object.freeze(["CAREERRAT_INSTALLED_AI_MODEL"]),
    installUrl: "https://learn.chatgpt.com/docs/codex/cli",
    capabilities: FULL_WORKFLOW_ACCEPTED_CAPABILITIES,
    acceptedCapabilities: FULL_WORKFLOW_ACCEPTED_CAPABILITIES,
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    protocol: "acp",
    acpArgs: Object.freeze(["--acp"]),
    binaries: ["gemini"],
    commandShape: "gemini --acp",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl: "https://github.com/google-gemini/gemini-cli",
    capabilities: FULL_WORKFLOW_ACCEPTED_CAPABILITIES,
    acceptedCapabilities: NO_WORKFLOW_ACCEPTED_CAPABILITIES,
  },
  {
    id: "opencode",
    name: "OpenCode",
    protocol: "acp",
    acpArgs: Object.freeze(["acp"]),
    binaries: ["opencode"],
    commandShape: "opencode acp",
    authProbe: { args: ["auth", "list"] },
    installUrl: "https://opencode.ai/docs/",
    capabilities: FULL_WORKFLOW_ACCEPTED_CAPABILITIES,
    acceptedCapabilities: NO_WORKFLOW_ACCEPTED_CAPABILITIES,
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    protocol: "acp",
    acpArgs: Object.freeze(["--acp", "--stdio"]),
    binaries: ["copilot", "github-copilot"],
    commandShape: "copilot --acp --stdio",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl:
      "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
    capabilities: FULL_WORKFLOW_ACCEPTED_CAPABILITIES,
    acceptedCapabilities: NO_WORKFLOW_ACCEPTED_CAPABILITIES,
  },
  {
    id: "qwen",
    name: "Qwen Code",
    binaries: ["qwen"],
    commandShape: "qwen -p",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl: "https://github.com/QwenLM/qwen-code",
    capabilities: NO_WORKFLOW_ACCEPTED_CAPABILITIES,
    acceptedCapabilities: NO_WORKFLOW_ACCEPTED_CAPABILITIES,
  },
  {
    id: "antigravity",
    name: "Antigravity",
    binaries: ["agy", "antigravity", "antigravitycli"],
    commandShape: "agy -p",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl: "https://antigravity.google/docs/cli/install",
    capabilities: NO_WORKFLOW_ACCEPTED_CAPABILITIES,
    acceptedCapabilities: NO_WORKFLOW_ACCEPTED_CAPABILITIES,
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    protocol: "acp",
    acpArgs: Object.freeze(["--ignore-rules", "acp"]),
    binaries: ["hermes"],
    commandShape: "hermes acp",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl: "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
    capabilities: FULL_WORKFLOW_ACCEPTED_CAPABILITIES,
    acceptedCapabilities: NO_WORKFLOW_ACCEPTED_CAPABILITIES,
  },
  {
    id: "amp",
    name: "Amp",
    binaries: ["amp"],
    commandShape: "amp -x",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl: "https://ampcode.com/manual",
    capabilities: NO_WORKFLOW_ACCEPTED_CAPABILITIES,
    acceptedCapabilities: NO_WORKFLOW_ACCEPTED_CAPABILITIES,
  },
  {
    id: "goose",
    name: "Goose",
    binaries: ["goose"],
    commandShape: "goose run -i -",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl: "https://goose-docs.ai/docs/getting-started/installation/",
    capabilities: NO_WORKFLOW_ACCEPTED_CAPABILITIES,
    acceptedCapabilities: NO_WORKFLOW_ACCEPTED_CAPABILITIES,
  },
  {
    id: "droid",
    name: "Droid",
    binaries: ["droid"],
    commandShape: "droid exec",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Make sure you're signed in.",
    installUrl: "https://docs.factory.ai/droid-cli/quickstart",
    capabilities: NO_WORKFLOW_ACCEPTED_CAPABILITIES,
    acceptedCapabilities: NO_WORKFLOW_ACCEPTED_CAPABILITIES,
  },
];

export const SUPPORTED_INSTALLED_RUNTIME_IDS = Object.freeze(
  INSTALLED_RUNTIME_DEFINITIONS.filter(({ supported }) => supported === true).map(({ id }) => id)
);

const INSTALLED_RUNTIME_DEFINITIONS_BY_ID = new Map(
  INSTALLED_RUNTIME_DEFINITIONS.map((definition) => [definition.id, definition])
);

function installedRuntimeDefinition(runtimeId) {
  return INSTALLED_RUNTIME_DEFINITIONS_BY_ID.get(String(runtimeId || "").trim());
}

// The version-boundary policy floor a runtime is currently held to, so a
// cached probe can be checked against the floor in force right now rather
// than whatever floor happened to be current when the probe last ran. A
// runtime with no boundary policy (e.g. codex) has no minimum at all.
export function installedRuntimeBoundaryPolicyMinimum(runtimeId) {
  return installedRuntimeDefinition(runtimeId)?.minimumBoundaryVersion || null;
}

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

// Overriding the hardcoded default install directories (below) lets tests
// isolate detection from whatever CLIs happen to be installed on the
// machine running them. `searchDirs` is the direct option; unset, it falls
// back to the colon-separated CAREERRAT_RUNTIME_SEARCH_DIRS env var. Either
// form REPLACES the defaults outright rather than adding to them — PATH and
// CAREERRAT_RUNTIME_EXTRA_PATHS are unaffected either way. Production
// behaviour with neither set is unchanged.
export function runtimeSearchDirectories({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  searchDirs,
} = {}) {
  const separator = platform === "win32" ? ";" : delimiter;
  const dirs = [];
  addUnique(dirs, splitPaths(env.PATH, separator));
  addUnique(dirs, splitPaths(env.CAREERRAT_RUNTIME_EXTRA_PATHS, separator));

  const defaultDirsOverride =
    searchDirs !== undefined ? searchDirs : env.CAREERRAT_RUNTIME_SEARCH_DIRS;
  if (defaultDirsOverride !== undefined) {
    addUnique(
      dirs,
      Array.isArray(defaultDirsOverride)
        ? defaultDirsOverride.filter(Boolean)
        : splitPaths(defaultDirsOverride, separator)
    );
    return dirs;
  }

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
  { env = process.env, platform = process.platform, homeDir = homedir(), searchDirs } = {}
) {
  const dirs = runtimeSearchDirectories({ env, platform, homeDir, searchDirs });
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

// `fingerprintId` restricts binary hashing to a single definition id, for a
// caller that only ever needs the fingerprint of one already-known runtime
// (Doctor validating a cached verification for the selected engine, say).
// Passing the key at all — even as null, meaning "fingerprint none" — opts
// into the restriction; omitting it keeps the default of fingerprinting
// every detected executable, so existing callers (call-ai.mjs, the settings
// route, every test that doesn't pass this option) are unaffected. Reading
// and SHA-256 hashing a full binary is not cheap across hundreds of MB of
// installed CLIs, so a caller that only cares about one runtime's cached
// verification should never pay for the others.
export function detectInstalledRuntimes(options = {}) {
  const restrictFingerprint = Object.hasOwn(options, "fingerprintId");
  const fingerprintId = options.fingerprintId ?? null;
  return INSTALLED_RUNTIME_DEFINITIONS.map((definition) => {
    const path = findInstalledExecutable(definition.binaries, options);
    const realPath = path ? existingCanonicalPath(path) : null;
    const shouldFingerprint = !restrictFingerprint || definition.id === fingerprintId;
    const binaryFingerprint =
      realPath && shouldFingerprint ? runtimeBinaryFingerprint(realPath, options) : null;
    const runtimeCapabilities = installedRuntimeCapabilities(definition.id, {
      available: Boolean(path),
    });
    return {
      id: definition.id,
      name: definition.name,
      supported: definition.supported === true,
      commandShape: definition.commandShape,
      path,
      realPath,
      binaryFingerprint,
      available: Boolean(path),
      warning: definition.warning || null,
      installUrl: definition.installUrl || null,
      capabilities: runtimeCapabilities.capabilities,
      capabilitiesVerified: false,
      capabilityTier: runtimeCapabilities.capabilityTier,
      capabilityReason: runtimeCapabilities.capabilities.taskTools
        ? null
        : runtimeCapabilities.capabilities.completion
          ? "Ready for chat and drafting. Task tools and research are not verified for this CLI yet."
          : UNVERIFIED_COMPLETION_REASON,
    };
  });
}

export function installedRuntimeCapabilities(runtimeId, options = {}) {
  const { available = true } = options;
  const suppliedEvidence = options.capabilityEvidence ?? options.verifiedCapabilities ?? null;
  const acceptedCapabilities = installedRuntimeDefinition(runtimeId)?.capabilities || {};
  const capabilityEvidence = sanitizeInstalledRuntimeCapabilityEvidence(
    runtimeId,
    suppliedEvidence
  );
  const completion =
    acceptedCapabilities.completion === true && capabilityEvidence.completion === true;
  const capabilities = Object.fromEntries(
    Object.keys(acceptedCapabilities).map((capability) => [
      capability,
      capability === "completion"
        ? completion
        : completion &&
          acceptedCapabilities[capability] === true &&
          capabilityEvidence[capability] === true,
    ])
  );
  capabilities.taskTools =
    capabilities.appWorkflows && capabilities.exactRead && capabilities.publicWeb;
  capabilities.research = capabilities.appWorkflows && capabilities.publicWeb;
  const capabilityTier = !available
    ? "unavailable"
    : capabilities.taskTools
      ? "task_tools"
      : completion
        ? "chat_drafting"
        : "detected_unverified";
  return { capabilities, capabilityTier };
}

export function installedRuntimeModel(runtimeId, { env = process.env } = {}) {
  const definition = installedRuntimeDefinition(runtimeId);
  const keys = definition?.modelEnvKeys || ["CAREERRAT_INSTALLED_AI_MODEL"];
  for (const key of keys) {
    const value = String(env?.[key] || "").trim();
    if (value) return value;
  }
  return undefined;
}

function capabilityEvidenceForProbe(definition, overrides = {}) {
  const acceptedCapabilities = definition?.capabilities || {};
  return Object.fromEntries(
    Object.keys(acceptedCapabilities).map((capability) => [
      capability,
      overrides[capability] ?? acceptedCapabilities[capability] === true,
    ])
  );
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

function promptWithStructuredContract({ prompt, outputSchema } = {}) {
  if (!outputSchema) return String(prompt || "");
  return [
    String(prompt || ""),
    "Return only one JSON value that satisfies this CareerRat output schema. Do not wrap it in Markdown.",
    JSON.stringify(sanitizeInstalledOutputSchema(outputSchema)),
  ].join("\n\n");
}

function missingRuntimeCapability({ capabilities, skill, tools, outputSchema, streaming } = {}) {
  if (capabilities?.completion !== true) return "completion";
  if (outputSchema && capabilities.structuredOutput !== true) return "structuredOutput";
  if (skill && capabilities.appWorkflows !== true) return "appWorkflows";
  const requested = new Set(Array.isArray(tools) ? tools.filter(Boolean) : []);
  if (["Read", "Glob", "Grep"].some((tool) => requested.has(tool))) {
    if (capabilities.exactRead !== true) return "exactRead";
  }
  if (["WebSearch", "WebFetch"].some((tool) => requested.has(tool))) {
    if (capabilities.publicWeb !== true) return "publicWeb";
  }
  if (streaming && capabilities.liveActivity !== true) return "liveActivity";
  return null;
}

function assertRuntimeCapabilities({
  runtime,
  definition,
  skill,
  tools,
  outputSchema,
  streaming,
} = {}) {
  const capabilities = installedRuntimeCapabilities(runtime?.id, {
    available: Boolean(runtime?.path),
    capabilityEvidence: runtime?.capabilities,
  }).capabilities;
  const missing = missingRuntimeCapability({
    capabilities,
    skill,
    tools,
    outputSchema,
    streaming,
  });
  if (!missing) return capabilities;
  if (missing === "completion") {
    throw runtimeError(
      `${definition?.name || runtime.id} is detected, but it has no verified CareerRat adapter.`,
      "RUNTIME_COMPLETION_UNSUPPORTED",
      { runtimeId: runtime.id, capability: missing }
    );
  }
  const code =
    missing === "liveActivity" ? RUNTIME_STREAMING_UNSUPPORTED : RUNTIME_TOOL_PROFILE_UNSUPPORTED;
  throw runtimeError(
    `${definition?.name || runtime.id} cannot provide the ${missing} capability required by this CareerRat task.`,
    code,
    { runtimeId: runtime.id, capability: missing }
  );
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

// Authorization-grade version parsing: unlike parseVersion (first match,
// used for informational display), this only recognizes Claude Code's own
// `--version` output shape, exactly as it prints it: "2.1.200 (Claude
// Code)", nothing before it and nothing after. A boundary decision that
// unlocks the native installer must never be made by scanning arbitrary
// combined stdout/stderr for a version-shaped substring: "2.1.200.999" has
// an extra numeric component past the recognized shape, and "protocol
// 2.1.200; version unavailable" has a lone match sitting in unrelated
// prose. Both must refuse rather than guess.
const CLAUDE_VERSION_OUTPUT_SHAPE = /^(\d+\.\d+\.\d+) \(Claude Code\)$/;

function parseUnambiguousVersion(value) {
  const match = CLAUDE_VERSION_OUTPUT_SHAPE.exec(String(value || "").trim());
  return match ? match[1] : null;
}

// Tri-state classification for a completed version probe against a
// minimum boundary version. "below" and "at_or_above" both require a clean
// status-0 exit with exactly one unambiguous version in the combined
// output; anything else (nonzero exit, timeout, spawn failure, cancellation,
// empty or multi-version output) is "indeterminate" and must never be
// treated as authorization to run the native installer or to block a
// working runtime.
function classifyRuntimeVersionBoundary(result, minimumBoundaryVersion) {
  if (!minimumBoundaryVersion) return "at_or_above";
  if (result?.status !== 0 || result.error || result.signal) return "indeterminate";
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  const version = parseUnambiguousVersion(combined);
  if (!version) return "indeterminate";
  return versionAtLeast(version, minimumBoundaryVersion) ? "at_or_above" : "below";
}

const MAX_RUNTIME_PROBE_BYTES = 64 * 1024;
const COMPLETION_SMOKE_RECEIPT = "CAREERRAT_COMPLETION_READY";
const COMPLETION_SMOKE_TIMEOUT_MS = 30_000;
const COMPLETION_SMOKE_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const COMPLETION_SMOKE_FAILURE_TTL_MS = 30 * 1000;
const COMPLETION_SMOKE_CACHE_RELPATH = ".internal/runtime-completion-smoke.json";
const ACTIVE_COMPLETION_SMOKES = new Map();

const COMPLETION_SMOKE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    receipt: { type: "string", const: COMPLETION_SMOKE_RECEIPT },
  },
  required: ["receipt"],
});

// Discovery only checks the executable bit (X_OK), which an executable FIFO
// or other special file passes just as a real binary does. Fingerprinting is
// the first place that would actually read that path's content, so it's the
// place a FIFO with no writer would block forever on a plain readFileSync.
// O_NONBLOCK makes the open itself return immediately instead of waiting for
// a writer to connect; fstat-ing the resulting descriptor then proves what
// was actually opened before any bytes are read. Returns null (never
// throws) for anything that isn't a regular file, so callers treat a FIFO,
// directory, or device the same as an unreadable path: unknown identity, not
// a hang and not a fabricated fingerprint.
function readRegularFileBytes(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd);
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // fd already invalid; nothing left to release.
    }
  }
}

function runtimeBinaryFingerprint(
  path,
  {
    env = process.env,
    platform = process.platform,
    runtimeIdentityFilesImpl = runtimeProcessIdentityFiles,
  } = {}
) {
  try {
    if (platform === "win32" && /\.(?:bat|cmd)$/i.test(String(path || ""))) {
      const resolvedBytes = new Map();
      const readIdentityFile = (filePath) => {
        const bytes = readFileSync(filePath);
        resolvedBytes.set(String(filePath).toLowerCase(), bytes);
        return bytes;
      };
      const files = runtimeIdentityFilesImpl(path, {
        env,
        platform,
        readFileImpl: readIdentityFile,
      });
      if (!Array.isArray(files) || files.length < 3) return null;
      const hash = createHash("sha256").update("careerrat-runtime-chain-v1\0");
      const seenRoles = new Set();
      for (const file of files) {
        const role = String(file?.role || "").trim();
        const filePath = String(file?.path || "").trim();
        if (!role || !filePath || seenRoles.has(role)) return null;
        seenRoles.add(role);
        const bytes = resolvedBytes.get(filePath.toLowerCase()) || readIdentityFile(filePath);
        hash.update(`${role}\0${filePath.toLowerCase()}\0${bytes.length}\0`).update(bytes);
      }
      if (!seenRoles.has("launcher") || !seenRoles.has("wrapper") || !seenRoles.has("payload")) {
        return null;
      }
      return hash.digest("hex");
    }
    const bytes = readRegularFileBytes(path);
    if (bytes === null) return null;
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

export function installedRuntimeExecutionIdentity(
  runtime,
  {
    env = process.env,
    platform = process.platform,
    spawnSyncImpl = spawnSync,
    runtimeIdentityFilesImpl = runtimeProcessIdentityFiles,
    requireCurrentExecutable = false,
  } = {}
) {
  const path = String(runtime?.path || "").trim();
  if (!path) return null;
  const currentRealPath = existingCanonicalPath(path);
  const realPath =
    currentRealPath || (requireCurrentExecutable ? "" : String(runtime?.realPath || "").trim());
  const resolvedFingerprint = currentRealPath
    ? runtimeBinaryFingerprint(currentRealPath, { env, platform, runtimeIdentityFilesImpl })
    : null;
  const requiresResolvedChain = platform === "win32" && /\.(?:bat|cmd)$/i.test(String(realPath));
  const binaryFingerprint =
    resolvedFingerprint ||
    (requireCurrentExecutable || requiresResolvedChain
      ? null
      : String(runtime?.binaryFingerprint || "")
          .trim()
          .toLowerCase());
  let version = String(runtime?.version || "").trim();
  if (!version) {
    const childEnv = buildInstalledRuntimeChildEnv({ env });
    const invocation = runtimeProcessInvocation(path, ["--version"], {
      env: childEnv,
      platform,
    });
    try {
      const result = spawnSyncImpl(invocation.command, invocation.args, {
        ...invocation.options,
        env: childEnv,
        encoding: "utf8",
        maxBuffer: MAX_RUNTIME_PROBE_BYTES,
        timeout: 5_000,
        shell: false,
        windowsHide: true,
      });
      if (!result?.error && result?.status === 0) {
        version = parseVersion(`${result.stdout || ""}\n${result.stderr || ""}`)?.join(".") || "";
      }
    } catch {
      version = "";
    }
  }
  if (!realPath || !/^[a-f0-9]{64}$/.test(binaryFingerprint) || !version) return null;
  return { path, realPath, version, binaryFingerprint };
}

function assertInstalledRuntimeExecutionIdentity(
  runtime,
  {
    env = process.env,
    platform = process.platform,
    runtimeIdentityImpl = installedRuntimeExecutionIdentity,
  } = {}
) {
  const expected = {
    path: String(runtime?.path || "").trim(),
    realPath: String(runtime?.realPath || "").trim(),
    version: String(runtime?.version || "").trim(),
    binaryFingerprint: String(runtime?.binaryFingerprint || "")
      .trim()
      .toLowerCase(),
  };
  if (
    !expected.path ||
    !expected.realPath ||
    !expected.version ||
    !/^[a-f0-9]{64}$/.test(expected.binaryFingerprint)
  ) {
    throw runtimeError(
      "The selected AI CLI has no complete verified execution identity. Re-check it in Settings.",
      "RUNTIME_EXECUTION_IDENTITY_REQUIRED",
      { runtimeId: runtime?.id || null }
    );
  }
  let current = null;
  try {
    current = runtimeIdentityImpl(runtime, { env, platform, requireCurrentExecutable: true });
  } catch {
    current = null;
  }
  if (
    !current ||
    current.path !== expected.path ||
    current.realPath !== expected.realPath ||
    current.version !== expected.version ||
    current.binaryFingerprint !== expected.binaryFingerprint
  ) {
    throw runtimeError(
      "The selected AI CLI changed after CareerRat verified it. Start this work again.",
      "RUNTIME_EXECUTABLE_CHANGED",
      { runtimeId: runtime?.id || null }
    );
  }
  return current;
}

function completionSmokeCachePath({ cwd, env }) {
  return userPath({ repoRoot: cwd, env }, COMPLETION_SMOKE_CACHE_RELPATH);
}

function sanitizedCompletionSmokeEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const path = String(value.path || "").trim();
  const version = String(value.version || "").trim();
  const binaryFingerprint = String(value.binaryFingerprint || "").trim();
  const checkedAt = String(value.checkedAt || "").trim();
  if (
    !path ||
    !version ||
    !binaryFingerprint ||
    !checkedAt ||
    Number.isNaN(Date.parse(checkedAt)) ||
    typeof value.ok !== "boolean"
  ) {
    return null;
  }
  return { path, version, binaryFingerprint, checkedAt, ok: value.ok };
}

function loadCompletionSmokeCache({ runtimeId, cwd, env }) {
  try {
    const path = completionSmokeCachePath({ cwd, env });
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return sanitizedCompletionSmokeEntry(parsed?.runtimes?.[runtimeId]);
  } catch {
    return null;
  }
}

function saveCompletionSmokeCache({ runtimeId, cwd, env, entry }) {
  const path = completionSmokeCachePath({ cwd, env });
  const runtimes = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed?.runtimes &&
      typeof parsed.runtimes === "object" &&
      !Array.isArray(parsed.runtimes)
    ) {
      for (const [id, value] of Object.entries(parsed.runtimes)) {
        if (!installedRuntimeDefinition(id)?.supported) continue;
        const sanitized = sanitizedCompletionSmokeEntry(value);
        if (sanitized) runtimes[id] = sanitized;
      }
    }
  } catch {
    // A missing or damaged cache is replaced by the one bounded receipt below.
  }
  runtimes[runtimeId] = sanitizedCompletionSmokeEntry(entry);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify({ schemaVersion: 1, runtimes }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);
}

function completionSmokeMessage(runtime, ok) {
  const name = runtime?.name || installedRuntimeDefinition(runtime?.id)?.name || "This AI CLI";
  return ok
    ? `${name} returned a test reply and is ready.`
    : `${name} is installed and signed in, but it didn't return a usable test reply.`;
}

function completionSmokeResult({ runtime, entry, cached }) {
  return {
    ok: entry.ok,
    cached,
    checkedAt: entry.checkedAt,
    probeMessage: completionSmokeMessage(runtime, entry.ok),
    action: entry.ok ? null : "retry",
    actionLabel: entry.ok ? null : "Try again",
  };
}

function cachedCompletionSmoke({ runtime, version, binaryFingerprint, entry, nowMs }) {
  if (
    !entry ||
    entry.path !== runtime.path ||
    entry.version !== version ||
    entry.binaryFingerprint !== binaryFingerprint
  ) {
    return null;
  }
  const ageMs = nowMs - Date.parse(entry.checkedAt);
  const ttlMs = entry.ok ? COMPLETION_SMOKE_SUCCESS_TTL_MS : COMPLETION_SMOKE_FAILURE_TTL_MS;
  return ageMs >= 0 && ageMs < ttlMs
    ? completionSmokeResult({ runtime, entry, cached: true })
    : null;
}

export async function probeInstalledRuntimeCompletion({
  runtime,
  version,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  force = false,
  timeoutMs = COMPLETION_SMOKE_TIMEOUT_MS,
  nowImpl = Date.now,
  runtimeIdentityImpl = installedRuntimeExecutionIdentity,
  loadCompletionSmokeCacheImpl = loadCompletionSmokeCache,
  saveCompletionSmokeCacheImpl = saveCompletionSmokeCache,
  runInstalledRuntimeImpl = runInstalledRuntime,
} = {}) {
  const definition = installedRuntimeDefinition(runtime?.id);
  if (!definition?.supported || !runtime?.path || !version) {
    return completionSmokeResult({
      runtime,
      cached: false,
      entry: { ok: false, checkedAt: new Date(nowImpl()).toISOString() },
    });
  }
  let executionIdentity = null;
  try {
    executionIdentity = runtimeIdentityImpl(
      { ...runtime, version },
      { env, platform, requireCurrentExecutable: true }
    );
  } catch {
    executionIdentity = null;
  }
  const binaryFingerprint = executionIdentity?.binaryFingerprint;
  const nowMs = nowImpl();
  if (!binaryFingerprint) {
    return completionSmokeResult({
      runtime,
      cached: false,
      entry: { ok: false, checkedAt: new Date(nowMs).toISOString() },
    });
  }
  if (!force) {
    const cached = cachedCompletionSmoke({
      runtime,
      version,
      binaryFingerprint,
      entry: loadCompletionSmokeCacheImpl({ runtimeId: runtime.id, cwd, env }),
      nowMs,
    });
    if (cached) return cached;
  }

  const key = `${runtime.id}:${runtime.path}:${version}:${binaryFingerprint}`;
  const active = ACTIVE_COMPLETION_SMOKES.get(key);
  if (active) return active;
  const smoke = (async () => {
    let ok = false;
    try {
      const capabilityEvidence = Object.fromEntries(
        Object.keys(definition.capabilities || {}).map((capability) => [
          capability,
          capability === "completion" || capability === "structuredOutput",
        ])
      );
      const result = await runInstalledRuntimeImpl({
        runtime: { ...runtime, ...executionIdentity, capabilities: capabilityEvidence },
        prompt:
          "Return the exact CareerRat readiness receipt requested by the output schema. Do not use tools or inspect files.",
        outputSchema: COMPLETION_SMOKE_SCHEMA,
        tools: [],
        skill: null,
        repoRoot: null,
        approvedReadPaths: [],
        env,
        timeoutMs: Math.min(COMPLETION_SMOKE_TIMEOUT_MS, Math.max(1, timeoutMs)),
      });
      const parsed = JSON.parse(String(result?.text || ""));
      ok =
        parsed?.receipt === COMPLETION_SMOKE_RECEIPT &&
        Object.keys(parsed).length === 1 &&
        !Array.isArray(parsed);
    } catch {
      ok = false;
    }
    const entry = {
      path: runtime.path,
      version,
      binaryFingerprint,
      checkedAt: new Date(nowImpl()).toISOString(),
      ok,
    };
    try {
      saveCompletionSmokeCacheImpl({ runtimeId: runtime.id, cwd, env, entry });
    } catch {
      // Readiness stays factual even when the private optimization cache cannot be written.
    }
    return completionSmokeResult({ runtime, entry, cached: false });
  })();
  ACTIVE_COMPLETION_SMOKES.set(key, smoke);
  try {
    return await smoke;
  } finally {
    if (ACTIVE_COMPLETION_SMOKES.get(key) === smoke) ACTIVE_COMPLETION_SMOKES.delete(key);
  }
}

// Shared async child-process probe: bounded output (MAX_RUNTIME_PROBE_BYTES),
// abort-signal propagation, and SIGTERM-then-SIGKILL escalation via
// scheduleRuntimeProcessKill. Platform-agnostic: killRuntimeProcess (inside
// scheduleRuntimeProcessKill) already branches on win32 vs POSIX signal
// delivery, so this same implementation is safe for any caller that cannot
// tolerate a synchronous spawn blocking its process (for example a probe run
// from Electron's main/local-server process).
function runInstalledRuntimeProbeAsync(
  invocation,
  options,
  {
    spawnImpl = spawn,
    treeKillImpl = spawnSync,
    env = process.env,
    platform = process.platform,
    timeoutMs = 5000,
    signal,
    beforeSpawn,
  } = {}
) {
  if (signal?.aborted) {
    return Promise.resolve({
      status: null,
      stdout: "",
      stderr: "",
      error: runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED"),
    });
  }

  return new Promise((resolve) => {
    let child;
    try {
      beforeSpawn?.();
      child = spawnImpl(invocation.command, invocation.args, {
        ...options,
        // POSIX only: a detached child becomes its own process-group leader
        // (pgid === pid), so scheduleRuntimeProcessKill's `process.kill(-pid,
        // signal)` below actually reaches the whole group, including any
        // descendant the probed CLI forks that inherits its stdio pipes.
        // Without this, `-child.pid` is not the child's real group id (it's
        // still grouped with this Node process) and the signal can miss the
        // real group entirely or land on an unrelated one. Windows has no
        // process-group signaling here, so it keeps the platform's own tree
        // kill (taskkill /t) via killRuntimeProcess instead.
        detached: platform !== "win32",
      });
    } catch (error) {
      resolve({ status: null, stdout: "", stderr: "", error });
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let stopError = null;
    let forceKillTimer = null;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const stop = (error) => {
      stopError ||= error;
      if (forceKillTimer) return;
      forceKillTimer = scheduleRuntimeProcessKill(
        child,
        () =>
          finish({
            status: null,
            stdout,
            stderr,
            error: stopError,
            signal: "SIGKILL",
          }),
        { platform, env, spawnSyncImpl: treeKillImpl }
      );
    };
    function abort() {
      stop(runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED"));
    }
    child.stdout?.on("data", (chunk) => {
      if (stopError) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_RUNTIME_PROBE_BYTES) {
        stop(
          Object.assign(new Error("Runtime probe output exceeded 64KB."), { code: "EOVERFLOW" })
        );
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      if (stopError) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_RUNTIME_PROBE_BYTES) {
        stop(
          Object.assign(new Error("Runtime probe output exceeded 64KB."), { code: "EOVERFLOW" })
        );
        return;
      }
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      // Once a stop is in flight, the scheduled group SIGKILL (forceKillTimer)
      // is the only thing allowed to settle the probe: finishing here instead
      // would race a same-group descendant that ignored the SIGTERM and is
      // still alive when the wrapper itself errors out.
      if (stopError) return;
      finish({ status: null, stdout, stderr, error });
    });
    child.on("close", (status, signal) => {
      // Same race as the error handler above: a same-group descendant can
      // outlive the wrapper's own close event, so a pending stop must wait
      // for the scheduled group SIGKILL rather than settling here.
      if (stopError) return;
      finish({ status, stdout, stderr, signal });
    });
    timer = setTimeout(
      () => stop(Object.assign(new Error("Runtime probe timed out."), { code: "ETIMEDOUT" })),
      Math.max(1, timeoutMs)
    );
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function runInstalledRuntimeProbe(
  invocation,
  {
    spawnImpl = spawn,
    spawnSyncImpl = spawnSync,
    treeKillImpl = spawnSync,
    env = process.env,
    platform = process.platform,
    timeoutMs = 5000,
    signal,
    beforeSpawn,
  } = {}
) {
  const options = {
    shell: false,
    windowsHide: true,
    ...invocation.options,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (platform !== "win32") {
    beforeSpawn?.();
    try {
      return spawnSyncImpl(invocation.command, invocation.args, {
        ...options,
        encoding: "utf8",
        timeout: timeoutMs,
      });
    } catch {
      return null;
    }
  }

  return runInstalledRuntimeProbeAsync(invocation, options, {
    spawnImpl,
    treeKillImpl,
    env,
    platform,
    timeoutMs,
    signal,
    beforeSpawn,
  });
}

async function assertInstalledRuntimeBoundaryVersion(
  runtime,
  {
    spawnImpl = spawn,
    spawnSyncImpl = spawnSync,
    treeKillImpl = spawnSync,
    env = process.env,
    platform = process.platform,
    timeoutMs = 5000,
    signal,
    beforeSpawn,
  } = {}
) {
  const definition = installedRuntimeDefinition(runtime?.id);
  if (!definition?.minimumBoundaryVersion) return;
  const childEnv = buildInstalledRuntimeChildEnv({ env });
  const versionInvocation = runtimeProcessInvocation(runtime.path, ["--version"], {
    env: childEnv,
    platform,
  });
  const result = await runInstalledRuntimeProbe(versionInvocation, {
    spawnImpl,
    spawnSyncImpl,
    treeKillImpl,
    env: childEnv,
    platform,
    timeoutMs,
    signal,
    beforeSpawn,
  });
  if (result?.error?.code === "RUNTIME_CANCELLED") throw result.error;
  if (
    result?.error?.code === "RUNTIME_EXECUTABLE_CHANGED" ||
    result?.error?.code === "RUNTIME_EXECUTION_IDENTITY_REQUIRED"
  ) {
    throw result.error;
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

// A lightweight, non-throwing companion to assertInstalledRuntimeBoundaryVersion.
// The guided-setup route uses this to decide whether an already-installed
// Claude Code may still run the native installer as an in-place update: it
// only runs the cheap --version check and skips the auth and completion
// probes entirely, since it never needs to know anything beyond the version
// gap to make that call.
//
// Authorization is tri-state, not boolean, and fails closed: "below" is the
// only result that may ever authorize running the native installer.
// "at_or_above" and "indeterminate" (nonzero exit, timeout, spawn failure,
// cancellation, or unparseable/ambiguous output) must both refuse. The probe
// itself always runs through the async, abort-aware, SIGTERM-then-SIGKILL
// path (runInstalledRuntimeProbeAsync) regardless of platform, because this
// function is called from Electron's main/local-server process and a
// synchronous spawn there can block the whole app if the child ignores
// SIGTERM.
export async function isInstalledRuntimeBelowVersionBoundary(
  runtime,
  {
    spawnImpl = spawn,
    treeKillImpl = spawnSync,
    env = process.env,
    platform = process.platform,
    timeoutMs = 5000,
    signal,
  } = {}
) {
  const definition = installedRuntimeDefinition(runtime?.id);
  if (!definition?.minimumBoundaryVersion || !runtime?.path) return "at_or_above";
  const childEnv = buildInstalledRuntimeChildEnv({ env });
  const versionInvocation = runtimeProcessInvocation(runtime.path, ["--version"], {
    env: childEnv,
    platform,
  });
  const options = {
    shell: false,
    windowsHide: true,
    ...versionInvocation.options,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  };
  const result = await runInstalledRuntimeProbeAsync(versionInvocation, options, {
    spawnImpl,
    treeKillImpl,
    env: childEnv,
    platform,
    timeoutMs,
    signal,
  });
  return classifyRuntimeVersionBoundary(result, definition.minimumBoundaryVersion);
}

export async function probeInstalledRuntime(
  runtime,
  {
    spawnImpl = spawn,
    spawnSyncImpl = spawnSync,
    treeKillImpl = spawnSync,
    env = process.env,
    timeoutMs = 5000,
    cwd = process.cwd(),
    probeAcpRuntimeImpl = probeAcpRuntime,
    completionProbeImpl = probeInstalledRuntimeCompletion,
    forceCompletionProbe = false,
    platform = process.platform,
  } = {}
) {
  if (!runtime?.available || !runtime.path) {
    return { status: "not_installed", ready: false, action: null };
  }
  const definition = installedRuntimeDefinition(runtime.id);
  if (!definition) return { status: "unsupported", ready: false, action: null };
  const childEnv = buildInstalledRuntimeChildEnv({ env });
  let runtimeVersion = null;
  let capabilityOverrides = {};
  let capabilityReason = null;
  let versionBoundaryState = "at_or_above";

  if (definition.supported === true || definition.minimumBoundaryVersion) {
    const versionInvocation = runtimeProcessInvocation(runtime.path, ["--version"], {
      env: childEnv,
      platform,
    });
    const versionResult = await runInstalledRuntimeProbe(versionInvocation, {
      spawnImpl,
      spawnSyncImpl,
      treeKillImpl,
      env: childEnv,
      platform,
      timeoutMs,
    });
    versionBoundaryState = classifyRuntimeVersionBoundary(
      versionResult,
      definition.minimumBoundaryVersion
    );
    if (definition.minimumBoundaryVersion && versionBoundaryState !== "at_or_above") {
      capabilityOverrides = {
        exactRead: false,
        publicWeb: false,
      };
      capabilityReason = `Update ${definition.name} to ${definition.minimumBoundaryVersion} or newer for secure CareerRat tool runs.`;
    }
    runtimeVersion = parseVersion(
      `${versionResult?.stdout || ""}\n${versionResult?.stderr || ""}`
    )?.join(".");
  }

  // A conclusive below-boundary version blocks the runtime before the auth
  // and completion probes ever run: no amount of successful sign-in or
  // completion smoke changes the fact that the tool boundary isn't met, and
  // running those probes anyway used to let a signed-out or completion-
  // failing old install mask update_required behind authentication_required
  // or completion_probe_failed. An indeterminate version never reaches this
  // branch, so it always falls through to the existing non-installer states.
  if (definition.minimumBoundaryVersion && versionBoundaryState === "below") {
    const runtimeCapabilities = installedRuntimeCapabilities(definition.id, {
      capabilityEvidence: capabilityEvidenceForProbe(definition, capabilityOverrides),
    }).capabilities;
    return {
      status: "update_required",
      ready: false,
      action: "retry",
      actionLabel: "Check again",
      version: runtimeVersion,
      minimumVersion: definition.minimumBoundaryVersion,
      capabilities: runtimeCapabilities,
      probeMessage: capabilityReason,
      capabilityReason,
    };
  }

  if (definition.protocol === "acp") {
    try {
      await probeAcpRuntimeImpl({
        runtime: { ...runtime, acpArgs: definition.acpArgs },
        cwd,
        env: childEnv,
        timeoutMs,
        platform,
      });
      if (definition.supported === true) {
        const completionProbe = await completionProbeImpl({
          runtime: { ...runtime, name: definition.name },
          version: runtimeVersion,
          cwd,
          env: childEnv,
          force: forceCompletionProbe,
          timeoutMs: Math.min(COMPLETION_SMOKE_TIMEOUT_MS, Math.max(1, timeoutMs * 6)),
        });
        if (completionProbe?.ok !== true) {
          const acpCapabilityReason =
            completionProbe?.probeMessage || completionSmokeMessage(runtime, false);
          return {
            status: "completion_probe_failed",
            ready: false,
            action: completionProbe?.action || "retry",
            actionLabel: completionProbe?.actionLabel || "Try again",
            probeMessage: acpCapabilityReason,
            capabilities: installedRuntimeCapabilities(definition.id, {
              capabilityEvidence: capabilityEvidenceForProbe(definition, { completion: false }),
            }).capabilities,
            capabilityReason: acpCapabilityReason,
          };
        }
      }
      const runtimeCapabilities = installedRuntimeCapabilities(definition.id, {
        capabilityEvidence:
          definition.supported === true
            ? capabilityEvidenceForProbe(definition, capabilityOverrides)
            : {},
      }).capabilities;
      return {
        status: "ready",
        ready: true,
        action: null,
        version: runtimeVersion,
        versionBoundaryState,
        minimumVersion: definition.minimumBoundaryVersion || null,
        capabilities: runtimeCapabilities,
        capabilityReason:
          capabilityReason || (runtimeCapabilities.taskTools ? null : UNVERIFIED_COMPLETION_REASON),
      };
    } catch (error) {
      if (error?.code === "RUNTIME_AUTH_REQUIRED") {
        return { status: "authentication_required", ready: false, action: "start_sign_in" };
      }
      return { status: "probe_failed", ready: false, action: "retry" };
    }
  }

  const probeInvocation = runtimeProcessInvocation(runtime.path, definition.authProbe.args, {
    env: childEnv,
    platform,
  });
  const result = await runInstalledRuntimeProbe(probeInvocation, {
    spawnImpl,
    spawnSyncImpl,
    treeKillImpl,
    env: childEnv,
    platform,
    timeoutMs,
  });
  if (!result) {
    return { status: "probe_failed", ready: false, action: "retry" };
  }
  if (result?.error?.code === "ETIMEDOUT" || result?.signal === "SIGTERM") {
    return { status: "probe_failed", ready: false, action: "retry" };
  }
  if (result?.status === 0) {
    if (definition.supported === true) {
      const completionProbe = await completionProbeImpl({
        runtime: { ...runtime, name: definition.name },
        version: runtimeVersion,
        cwd,
        env: childEnv,
        force: forceCompletionProbe,
        timeoutMs: Math.min(COMPLETION_SMOKE_TIMEOUT_MS, Math.max(1, timeoutMs * 6)),
      });
      if (completionProbe?.ok !== true) {
        const capabilityReason =
          completionProbe?.probeMessage || completionSmokeMessage(runtime, false);
        return {
          status: "completion_probe_failed",
          ready: false,
          action: completionProbe?.action || "retry",
          actionLabel: completionProbe?.actionLabel || "Try again",
          probeMessage: capabilityReason,
          capabilities: installedRuntimeCapabilities(definition.id, {
            capabilityEvidence: capabilityEvidenceForProbe(definition, { completion: false }),
          }).capabilities,
          capabilityReason,
        };
      }
    }
    const runtimeCapabilities = installedRuntimeCapabilities(definition.id, {
      capabilityEvidence: capabilityEvidenceForProbe(definition, capabilityOverrides),
    }).capabilities;
    // A conclusive below-boundary version already returned update_required
    // above, before this auth/completion probe ever ran. Any capabilityReason
    // reaching this point comes from an indeterminate version probe, which
    // never earns update_required. It stays a soft, advisory warning on an
    // otherwise-ready runtime, exactly as it did before the boundary gate
    // existed, since offering the installer with no conclusive basis is the
    // fail-open bug this fix closes.
    return {
      status: definition.authProbe.launchOnly ? "ready_unverified" : "ready",
      ready: true,
      action: null,
      version: runtimeVersion,
      versionBoundaryState,
      minimumVersion: definition.minimumBoundaryVersion || null,
      capabilities: runtimeCapabilities,
      capabilityReason:
        capabilityReason ||
        (runtimeCapabilities.taskTools
          ? null
          : runtimeCapabilities.completion
            ? "Ready for chat and drafting. Task tools and research are not verified for this CLI yet."
            : UNVERIFIED_COMPLETION_REASON),
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

function exactApprovedReadPaths({ repoRoot, env, skill, approvedReadPaths, runtimeId } = {}) {
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
      { runtimeId: runtimeId || null, skill: skill || null }
    );
  }

  const lexicalAllowedRoot = resolve(userPath({ repoRoot, env }, join(...rootSegments)));
  const canonicalAllowedRoot = existingCanonicalPath(lexicalAllowedRoot);
  if (!canonicalAllowedRoot) {
    throw runtimeError(
      `Skill "${skill}" cannot resolve its saved-upload boundary.`,
      RUNTIME_READ_BOUNDARY_INVALID,
      { runtimeId: runtimeId || null, skill }
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
      !isWithinRuntimePath(lexicalAllowedRoot, lexical) ||
      !isWithinRuntimePath(canonicalAllowedRoot, canonical) ||
      canonical !== expectedCanonical
    ) {
      throw runtimeError(
        `Skill "${skill}" received a read path outside its exact saved-upload boundary.`,
        RUNTIME_READ_BOUNDARY_INVALID,
        { runtimeId: runtimeId || null, skill }
      );
    }
    return canonical;
  });
  return [...new Set(approved)];
}

function stageApprovedReadInput({
  repoRoot,
  env,
  skill,
  approvedReadPaths,
  isolatedCwd,
  runtimeId,
}) {
  const [source] = exactApprovedReadPaths({
    repoRoot,
    env,
    skill,
    approvedReadPaths,
    runtimeId,
  });
  const inputDir = join(isolatedCwd, "input");
  mkdirSync(inputDir, { recursive: true });
  const stagedPath = join(inputDir, basename(source));
  copyFileSync(source, stagedPath);
  return stagedPath;
}

function approvedInstalledRuntimeReadPaths({
  repoRoot,
  env,
  skill,
  isolatedCwd,
  approvedReadPaths,
} = {}) {
  return [
    ...exactApprovedReadPaths({
      repoRoot,
      env,
      skill,
      approvedReadPaths,
      runtimeId: "claude",
    }),
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

function scopedToolsServerArgs({ allowPublicWeb = false, stagedReadPath = null } = {}) {
  return [
    INSTALLED_RUNTIME_MODULE_PATH,
    SCOPED_TOOLS_SERVER_ARG,
    ...(allowPublicWeb ? [SCOPED_PUBLIC_WEB_ARG] : []),
    ...(stagedReadPath ? [SCOPED_READ_FILE_ARG, stagedReadPath] : []),
  ];
}

function scopedToolsMcpConfig({
  runtimeHostPath = process.execPath,
  allowPublicWeb = false,
  stagedReadPath = null,
} = {}) {
  if (!allowPublicWeb && !stagedReadPath) return emptyMcpConfig();
  return {
    mcpServers: {
      [SCOPED_TOOLS_SERVER_NAME]: {
        command: runtimeHostPath,
        args: scopedToolsServerArgs({ allowPublicWeb, stagedReadPath }),
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  };
}

function emptyMcpConfig() {
  return { mcpServers: {} };
}

function codexScopedToolsConfigArgs({
  runtimeHostPath = process.execPath,
  allowPublicWeb = false,
  stagedReadPath = null,
} = {}) {
  if (!allowPublicWeb && !stagedReadPath) return [];
  const prefix = `mcp_servers.${SCOPED_TOOLS_SERVER_NAME}`;
  const enabledTools = [
    ...(allowPublicWeb ? ["fetch"] : []),
    ...(stagedReadPath ? ["read_staged_input"] : []),
  ];
  const overrides = [
    ...(allowPublicWeb ? ['web_search="live"'] : []),
    `${prefix}.command=${JSON.stringify(runtimeHostPath)}`,
    `${prefix}.args=${JSON.stringify(scopedToolsServerArgs({ allowPublicWeb, stagedReadPath }))}`,
    `${prefix}.enabled_tools=${JSON.stringify(enabledTools)}`,
    `${prefix}.required=true`,
    `${prefix}.default_tools_approval_mode="approve"`,
    `${prefix}.env.ELECTRON_RUN_AS_NODE="1"`,
  ];
  return overrides.flatMap((override) => ["-c", override]);
}

function acpScopedToolsServers({
  runtimeHostPath = process.execPath,
  allowPublicWeb = false,
  stagedReadPath = null,
} = {}) {
  if (!allowPublicWeb && !stagedReadPath) return [];
  return [
    {
      name: SCOPED_TOOLS_SERVER_NAME,
      command: runtimeHostPath,
      args: scopedToolsServerArgs({ allowPublicWeb, stagedReadPath }),
      env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }],
    },
  ];
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
    mcpConfig: scopedToolsMcpConfig({ runtimeHostPath, allowPublicWeb: usesPublicWeb }),
  };
}

export function buildInstalledRuntimeInvocation({
  runtimeId,
  executablePath,
  schema,
  schemaPath,
  model,
  effort,
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
  stagedReadPath,
  runtimeHostPath,
  // Claude uses stream-json for live protocol messages. Codex always emits its
  // structural JSONL events through `exec --json`; the flag has no effect there.
  streaming = false,
} = {}) {
  const definition = installedRuntimeDefinition(runtimeId);
  const common = {
    command: executablePath,
    stdin: true,
    options: { shell: false, windowsHide: true },
  };
  if (definition?.protocol === "claude-json") {
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
    if (effort) args.push("--effort", effort);
    if (schema) args.push("--json-schema", JSON.stringify(sanitizeInstalledOutputSchema(schema)));
    return { ...common, args };
  }
  if (definition?.protocol === "codex-jsonl") {
    const requested = new Set(Array.isArray(tools) ? tools.filter(Boolean) : []);
    const usesPublicWeb = requested.has("WebSearch") || requested.has("WebFetch");
    const usesLocalRead = ["Read", "Glob", "Grep"].some((tool) => requested.has(tool));
    if (requested.has("Glob") || requested.has("Grep")) {
      throw runtimeError(
        "Installed CareerRat skills do not expose broad file discovery tools.",
        RUNTIME_READ_BOUNDARY_INVALID,
        { runtimeId: "codex" }
      );
    }
    if (usesLocalRead && !stagedReadPath) {
      throw runtimeError(
        "Codex exact-read work requires one staged CareerRat input.",
        RUNTIME_READ_BOUNDARY_INVALID,
        { runtimeId: "codex" }
      );
    }
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
      "--strict-config",
      ...disabledFeatures.flatMap((feature) => ["--disable", feature]),
      "--sandbox",
      "read-only",
      ...codexScopedToolsConfigArgs({
        runtimeHostPath,
        allowPublicWeb: usesPublicWeb,
        stagedReadPath: usesLocalRead ? stagedReadPath : null,
      }),
      "--ephemeral",
      "--skip-git-repo-check",
    ];
    if (model) args.push("--model", model);
    if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
    if (schemaPath) args.push("--output-schema", schemaPath);
    args.push("-");
    return { ...common, args };
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
  const declaresObject =
    sanitized.type === "object" ||
    (Array.isArray(sanitized.type) && sanitized.type.includes("object"));
  if (
    declaresObject &&
    (!sanitized.properties || typeof sanitized.properties !== "object") &&
    sanitized.additionalProperties !== false
  ) {
    throw runtimeError(
      "Codex structured output requires every object field to declare its allowed properties.",
      "RUNTIME_OUTPUT_SCHEMA_UNSUPPORTED"
    );
  }
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
    const canonicalDest = join(tempDir, ".agents", "skills", skill);
    copySkillTree(sourceDir, canonicalDest);
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
  platform = process.platform,
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
    const processInvocation = runtimeProcessInvocation(bin, args, {
      env: childEnv,
      platform,
    });
    child = spawnImpl(processInvocation.command, processInvocation.args, {
      shell: false,
      windowsHide: true,
      ...processInvocation.options,
      cwd,
      env: childEnv,
      detached: platform !== "win32",
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
        scheduleRuntimeProcessKill(child, undefined, { platform, env: childEnv });
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
  const definition = installedRuntimeDefinition(runtimeId);
  if (!definition?.supported || !Array.isArray(definition.signInArgs)) return null;
  return [definition.binaries[0], ...definition.signInArgs].join(" ");
}

export const CLAUDE_NATIVE_INSTALL_COMMAND = "curl -fsSL https://claude.ai/install.sh | bash";
const GUIDED_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const GUIDED_SETUP_GROUP_DEATH_TIMEOUT_MS = 5000;
const GUIDED_SETUP_GROUP_DEATH_POLL_MS = 50;

// The real group-liveness check scheduleRuntimeProcessKill's SIGKILL escalation
// must be confirmed against: process.kill(-pid, 0) targets the whole process
// group (matching killRuntimeProcess's own -pid signal delivery), so a
// resistant descendant the installer forked still counts as alive. win32 has
// no POSIX process-group signaling, so this is unreachable there in practice
// (the caller guards platform === "darwin" up front) but still returns a safe
// `false` rather than throwing if it's ever invoked off that path.
function guidedSetupGroupAlive(pid, platform) {
  if (platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Polls group liveness after a SIGKILL escalation instead of trusting the
// signal was delivered and acted on instantly: a resistant descendant can
// take a moment to actually die even once it can no longer ignore the
// signal. Bounded, so a group that genuinely never disappears (a wedged
// kernel state, a permissions surprise) can't hang the caller forever.
// isAliveImpl is injectable so tests can force both outcomes deterministically
// instead of depending on real OS reap timing.
async function waitForProcessGroupDeath(
  pid,
  {
    platform = process.platform,
    timeoutMs = GUIDED_SETUP_GROUP_DEATH_TIMEOUT_MS,
    intervalMs = GUIDED_SETUP_GROUP_DEATH_POLL_MS,
    isAliveImpl = guidedSetupGroupAlive,
  } = {}
) {
  if (platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!isAliveImpl(pid, platform)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function startInstalledRuntimeGuidedSetup(
  runtimeId,
  {
    spawnImpl = spawn,
    treeKillImpl = spawnSync,
    env = process.env,
    platform = process.platform,
    onOutput,
    onStart,
    signal,
    timeoutMs = GUIDED_SETUP_TIMEOUT_MS,
    groupDeathTimeoutMs = GUIDED_SETUP_GROUP_DEATH_TIMEOUT_MS,
    groupDeathPollIntervalMs = GUIDED_SETUP_GROUP_DEATH_POLL_MS,
    isGroupAliveImpl = guidedSetupGroupAlive,
  } = {}
) {
  if (runtimeId !== "claude" || platform !== "darwin") {
    throw runtimeError(
      "In-app installation isn't available for this AI tool or operating system. Use its setup guide instead.",
      "RUNTIME_GUIDED_SETUP_UNSUPPORTED"
    );
  }

  // /bin/sh with no pipefail lets `curl ... | bash` report success even when
  // curl fails before producing any input: without pipefail the pipeline's
  // exit status is bash's own (0, for an empty script), so a download
  // failure could be reported as a completed update. macOS's /bin/bash
  // supports `-o pipefail`, which makes the pipeline's status the last
  // *failing* stage's status instead, so a curl failure can never resolve
  // as a successful install. The displayed install command text itself
  // (CLAUDE_NATIVE_INSTALL_COMMAND) is unchanged; only how it's invoked is.
  const child = spawnImpl("/bin/bash", ["-o", "pipefail", "-c", CLAUDE_NATIVE_INSTALL_COMMAND], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // Its own POSIX process group (this function only ever runs on darwin,
    // per the guard above) so a cancelled or timed-out update can stop curl
    // and bash together, the same tree-kill guarantee runInstalledRuntimeProbeAsync
    // gives a hung version probe.
    detached: true,
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let forceKillTimer = null;
    let stopError = null;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener?.("abort", abort);
      if (error) reject(error);
      else
        resolve({
          ok: true,
          runtimeId,
          installCommand: CLAUDE_NATIVE_INSTALL_COMMAND,
        });
    };
    const fail = (message, fields = {}) =>
      finish(runtimeError(message, "RUNTIME_GUIDED_SETUP_LAUNCH_FAILED", fields));
    // Shared with the version probe's cleanup: SIGTERM the whole process
    // group, then escalate to SIGKILL after a short grace period if curl,
    // bash, or a descendant they forked ignores it. The cancelled/timed-out
    // result only settles once that cleanup has actually run (either the
    // process closes on its own or the escalation completes), never the
    // instant the signal is sent, so a cancelled request can't race a still
    // -running installer.
    //
    // The escalation callback itself only dispatches SIGKILL; it does not
    // wait for the OS to actually reap the group. Settling right there (the
    // old behavior) let a retry land in the gap between "signal sent" and
    // "process actually gone" and be admitted against a still-alive
    // installer. waitForProcessGroupDeath below polls for confirmed death
    // before this promise settles at all; if the group never disappears
    // within the bound, this rejects with a distinct error instead of the
    // original cancel/timeout cause, and the caller (the guided-setup route)
    // keeps its lock rather than releasing it against an unconfirmed group.
    const stop = (error) => {
      stopError ||= error;
      if (forceKillTimer) return;
      forceKillTimer = scheduleRuntimeProcessKill(
        child,
        () => {
          const pid = child.pid;
          waitForProcessGroupDeath(pid, {
            platform,
            timeoutMs: groupDeathTimeoutMs,
            intervalMs: groupDeathPollIntervalMs,
            isAliveImpl: isGroupAliveImpl,
          }).then((confirmedDead) => {
            if (confirmedDead) {
              finish(stopError);
              return;
            }
            finish(
              runtimeError(
                "CareerRat could not confirm the Claude Code installer stopped. It may still be running.",
                "RUNTIME_GUIDED_SETUP_STOP_UNCONFIRMED",
                { cause: stopError }
              )
            );
          });
        },
        {
          platform,
          env,
          spawnSyncImpl: treeKillImpl,
        }
      );
    };
    const abort = () => {
      stop(runtimeError("Claude Code setup was cancelled.", "RUNTIME_GUIDED_SETUP_CANCELLED"));
    };
    const report = (chunk) => {
      const message = safeRuntimeDiagnostic(chunk);
      if (!message) return;
      try {
        onOutput?.(message);
      } catch {
        // The installer stays authoritative if its optional display callback closes.
      }
    };

    child.stdout?.on("data", report);
    child.stderr?.on("data", report);
    child.once("spawn", () => {
      try {
        // Detached (see the spawn options above), so on POSIX child.pid is
        // also the process-group id, exactly the pid a durable ownership
        // record (and process.kill(-pid, ...)) needs to identify the whole
        // installer group later, including across a crash or relaunch.
        onStart?.({ pid: child.pid });
      } catch (error) {
        stop(
          runtimeError(
            "CareerRat could not start the in-app installer.",
            "RUNTIME_GUIDED_SETUP_LAUNCH_FAILED",
            {
              cause: error,
            }
          )
        );
      }
    });
    child.once("error", (error) => {
      // A stopped setup stays pending until the scheduled group SIGKILL
      // (forceKillTimer, via stop() above) has actually run: bash or curl
      // can error out while a resistant descendant they forked is still
      // alive, and finishing here instead would let the route release its
      // lock while installer work continues underneath it.
      if (stopError) return;
      fail("CareerRat could not start the in-app installer.", { cause: error });
    });
    // A close, status 0 or not, only means bash itself exited; a detached
    // descendant it forked with its own redirected stdio can outlive it in
    // the same process group. Confirm the whole group is actually dead
    // before settling, the same bound stop() above waits on, so a caller
    // can't start a concurrent installer against a "finished" run that's
    // still holding the group open. If the group survives the wait,
    // escalate (SIGTERM then, after scheduleRuntimeProcessKill's grace
    // period, SIGKILL) and confirm once more; only reject with
    // RUNTIME_GUIDED_SETUP_STOP_UNCONFIRMED (retaining the caller's lock) if
    // it is still alive after that. `onConfirmedDead` decides how to settle
    // once death is confirmed: success for a status-0 close, or the
    // original installer error for a nonzero one, so a surviving descendant
    // never gets a chance to overlap a retry either way.
    const confirmCloseGroupDeath = (onConfirmedDead) => {
      const pid = child.pid;
      waitForProcessGroupDeath(pid, {
        platform,
        timeoutMs: groupDeathTimeoutMs,
        intervalMs: groupDeathPollIntervalMs,
        isAliveImpl: isGroupAliveImpl,
      }).then((confirmedDead) => {
        if (confirmedDead) {
          onConfirmedDead();
          return;
        }
        forceKillTimer = scheduleRuntimeProcessKill(
          child,
          () => {
            waitForProcessGroupDeath(pid, {
              platform,
              timeoutMs: groupDeathTimeoutMs,
              intervalMs: groupDeathPollIntervalMs,
              isAliveImpl: isGroupAliveImpl,
            }).then((confirmedDeadAfterKill) => {
              if (confirmedDeadAfterKill) {
                onConfirmedDead();
                return;
              }
              finish(
                runtimeError(
                  "CareerRat could not confirm the Claude Code installer stopped. It may still be running.",
                  "RUNTIME_GUIDED_SETUP_STOP_UNCONFIRMED"
                )
              );
            });
          },
          {
            platform,
            env,
            spawnSyncImpl: treeKillImpl,
          }
        );
      });
    };
    child.once("close", (status, closeSignal) => {
      // Same race as the error handler above: bash can exit before a
      // resistant descendant it forked, so a pending stop must wait for the
      // scheduled group SIGKILL rather than settling here.
      if (stopError) return;
      if (status === 0) {
        confirmCloseGroupDeath(() => finish());
        return;
      }
      confirmCloseGroupDeath(() =>
        fail("The Claude Code installer did not finish successfully.", {
          status,
          signal: closeSignal,
        })
      );
    });

    timer = setTimeout(
      () => {
        stop(
          runtimeError(
            "The Claude Code installer took too long to finish.",
            "RUNTIME_GUIDED_SETUP_LAUNCH_FAILED",
            { code: "ETIMEDOUT" }
          )
        );
      },
      Math.max(1, timeoutMs)
    );
    timer.unref?.();
    signal?.addEventListener?.("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

const ACTIVE_RUNTIME_SIGN_INS = new Map();
const RUNTIME_SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

function installedRuntimeSignInArgs(runtimeId) {
  const definition = installedRuntimeDefinition(runtimeId);
  if (!definition?.supported || !Array.isArray(definition.signInArgs)) return null;
  return [...definition.signInArgs];
}

export function startInstalledRuntimeSignIn(
  runtime,
  {
    spawnImpl = spawn,
    timeoutMs = RUNTIME_SIGN_IN_TIMEOUT_MS,
    env = process.env,
    platform = process.platform,
    spawnSyncImpl = spawnSync,
  } = {}
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

  const processInvocation = runtimeProcessInvocation(runtime.path, args, { env, platform });
  const child = spawnImpl(processInvocation.command, processInvocation.args, {
    shell: false,
    detached: platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
    ...processInvocation.options,
  });
  let forceKillTimer = null;
  const terminate = () => {
    if (forceKillTimer) return;
    forceKillTimer = scheduleRuntimeProcessKill(child, undefined, {
      platform,
      env,
      spawnSyncImpl,
    });
  };
  const timer = setTimeout(terminate, timeoutMs);
  timer.unref?.();
  const clear = () => {
    clearTimeout(timer);
    clearTimeout(forceKillTimer);
    if (ACTIVE_RUNTIME_SIGN_INS.get(runtime.id)?.child === child) {
      ACTIVE_RUNTIME_SIGN_INS.delete(runtime.id);
    }
  };
  child.once?.("exit", clear);
  child.once?.("error", clear);
  ACTIVE_RUNTIME_SIGN_INS.set(runtime.id, { child, timer, terminate });
  child.unref?.();
  return { ok: true, runtimeId: runtime.id, signInCommand, reused: false };
}

export function stopInstalledRuntimeSignIns() {
  for (const { timer, terminate } of ACTIVE_RUNTIME_SIGN_INS.values()) {
    clearTimeout(timer);
    terminate();
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

export function candidateSafeRuntimeUsageLimit(
  value,
  { providerName = "The selected AI provider" } = {}
) {
  const diagnostic = safeRuntimeDiagnostic(value);
  if (
    !/(?:\byou(?:'ve| have)\s+hit\b|\bhas\s+reached\b|\breached\b|\bexceeded\b)[^\n\r]{0,60}\b(?:weekly\s+|monthly\s+|usage\s+)?limit\b|\busage limit\b[^\n\r]{0,40}\b(?:reached|exceeded)\b/i.test(
      diagnostic
    )
  ) {
    return null;
  }
  const resetMatch = diagnostic.match(
    /\bresets?(?:\s+at)?\s+((?:\d{1,2}(?::\d{2})?\s*(?:am|pm))(?:\s*\([A-Za-z][A-Za-z0-9_+/-]{0,63}\))?)/i
  );
  const resetAt = resetMatch?.[1]?.replace(/\s+/g, " ").trim() || null;
  return {
    message: resetAt
      ? `${providerName} has reached its usage limit. It resets at ${resetAt}. Try again after the reset.`
      : `${providerName} has reached its usage limit. Try again later.`,
    resetAt,
  };
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
  const protocol = installedRuntimeDefinition(runtimeId)?.protocol;
  if (protocol === "claude-json") return parseClaudeResult(stdout);
  if (protocol === "codex-jsonl") return parseCodexResult(stdout);
  return { text: stdout.trim(), usage: null, model: null };
}

export async function runInstalledRuntime({
  runtime,
  prompt,
  outputSchema,
  model,
  effort,
  tools = [],
  cwd,
  env = process.env,
  signal,
  timeoutMs = ONE_SHOT_RUNTIME_TIMEOUT_MS,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  treeKillImpl = spawnSync,
  runAcpRuntimeImpl = runAcpRuntime,
  runtimeIdentityImpl = installedRuntimeExecutionIdentity,
  platform = process.platform,
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
  runtime = Object.freeze({
    ...runtime,
    ...(runtime.capabilities && typeof runtime.capabilities === "object"
      ? { capabilities: Object.freeze({ ...runtime.capabilities }) }
      : {}),
  });
  if (signal?.aborted) {
    throw runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED");
  }
  const definition = installedRuntimeDefinition(runtime.id);
  const providerTools = Array.isArray(tools)
    ? tools.filter((tool) => tool && tool !== "Skill")
    : [];
  const toolBearing = providerTools.length > 0;
  assertRuntimeCapabilities({ runtime, definition, skill, tools: providerTools, outputSchema });
  const childEnv = buildInstalledRuntimeChildEnv({ env });
  const assertExecutionIdentity = () =>
    assertInstalledRuntimeExecutionIdentity(runtime, {
      env: childEnv,
      platform,
      runtimeIdentityImpl,
    });
  if (toolBearing) {
    await assertInstalledRuntimeBoundaryVersion(runtime, {
      spawnImpl,
      spawnSyncImpl,
      treeKillImpl,
      env: childEnv,
      platform,
      signal,
      beforeSpawn: assertExecutionIdentity,
    });
    if (signal?.aborted) {
      throw runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED");
    }
  }
  let installedPrompt = promptWithInstalledSkill({ prompt, repoRoot, skill });
  if (definition?.protocol === "acp") {
    installedPrompt = promptWithStructuredContract({ prompt: installedPrompt, outputSchema });
  }

  let tempDir = null;
  let skillCwd = null;
  let taskCwd = null;
  let stagedReadPath = null;
  try {
    let schemaPath = null;
    if (definition?.protocol === "codex-jsonl" && outputSchema) {
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
      if (providerTools.includes("Read")) {
        stagedReadPath = stageApprovedReadInput({
          repoRoot,
          env,
          skill,
          approvedReadPaths,
          isolatedCwd: skillCwd,
          runtimeId: runtime.id,
        });
        installedPrompt = [
          installedPrompt,
          definition?.protocol === "claude-json"
            ? `CareerRat staged the one user-approved input at ${stagedReadPath}. Use that copy as the input for this task.`
            : "Use CareerRat's read_staged_input tool to read the one user-approved input. No other filesystem read is available for this task.",
        ].join("\n\n");
      }
    } else if (!toolBearing) {
      taskCwd = mkdtempSync(join(tmpdir(), "careerrat-task-cwd-"));
      chmodSync(taskCwd, 0o700);
    }
    if (definition?.protocol === "acp") {
      const mcpServers = acpScopedToolsServers({
        allowPublicWeb: providerTools.includes("WebSearch") || providerTools.includes("WebFetch"),
        stagedReadPath,
      });
      return await runAcpRuntimeImpl({
        runtime: { ...runtime, acpArgs: definition.acpArgs },
        prompt: installedPrompt,
        cwd: skillCwd || taskCwd || cwd,
        tools: providerTools,
        env: childEnv,
        signal,
        timeoutMs,
        mcpServers,
        spawnImpl,
        platform,
        beforeSpawn: assertExecutionIdentity,
      });
    }
    const invocation = buildInstalledRuntimeInvocation({
      runtimeId: runtime.id,
      executablePath: runtime.path,
      schema: outputSchema,
      schemaPath,
      model,
      effort,
      tools: providerTools,
      // Only tell the arg-builder a skill is "ready" once isolation actually
      // succeeded — never claim --setting-sources project against a plain
      // repoRoot cwd, which would reintroduce the full checkout context and
      // defeat the per-call filesystem boundary.
      skill: definition?.protocol === "claude-json" && skillCwd ? skill : undefined,
      repoRoot,
      env,
      isolatedCwd: skillCwd,
      approvedReadPaths,
      stagedReadPath,
    });

    const processInvocation = runtimeProcessInvocation(invocation.command, invocation.args, {
      env: childEnv,
      platform,
    });
    const result = await new Promise((resolve, reject) => {
      assertExecutionIdentity();
      let child;
      try {
        child = spawnImpl(processInvocation.command, processInvocation.args, {
          ...invocation.options,
          ...processInvocation.options,
          cwd: skillCwd || taskCwd || cwd,
          env: childEnv,
          detached: platform !== "win32",
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
      let stopError = null;
      let forceKillTimer = null;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceKillTimer);
        signal?.removeEventListener("abort", abort);
        callback();
      };
      const stop = (error) => {
        stopError ||= error;
        if (forceKillTimer) return;
        forceKillTimer = scheduleRuntimeProcessKill(child, () => finish(() => reject(stopError)), {
          platform,
        });
      };
      const abort = () => {
        stop(runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED"));
      };
      const timer = setTimeout(
        () => {
          stop(runtimeError("Installed AI request timed out.", "RUNTIME_TIMEOUT"));
        },
        Math.max(1, timeoutMs)
      );
      timer.unref?.();
      signal?.addEventListener("abort", abort, { once: true });

      child.stdout?.on("data", (chunk) => {
        if (stopError) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_RUNTIME_OUTPUT_BYTES) {
          stop(
            runtimeError(
              "Installed AI output exceeded the 10MB safety limit.",
              "RUNTIME_OUTPUT_LIMIT"
            )
          );
          return;
        }
        const text = chunk.toString("utf8");
        stdout += text;
        onEvent?.({ type: "output", stream: "stdout", bytes: chunk.length });
      });
      child.stderr?.on("data", (chunk) => {
        if (stopError) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_RUNTIME_OUTPUT_BYTES) {
          stop(
            runtimeError(
              "Installed AI output exceeded the 10MB safety limit.",
              "RUNTIME_OUTPUT_LIMIT"
            )
          );
          return;
        }
        stderr += chunk.toString("utf8");
        onEvent?.({ type: "output", stream: "stderr", bytes: chunk.length });
      });
      child.on("error", (error) => {
        finish(() => {
          if (stopError) {
            reject(stopError);
            return;
          }
          reject(
            runtimeError("Could not start the selected AI CLI.", "RUNTIME_SPAWN", { cause: error })
          );
        });
      });
      child.on("close", (status, closeSignal) => {
        finish(() => {
          if (stopError) {
            reject(stopError);
            return;
          }
          if (status !== 0) {
            const diagnostic =
              (definition?.protocol === "claude-json" ? claudeFailureDiagnostic(stdout) : "") ||
              safeRuntimeDiagnostic(stderr);
            const usageLimit = candidateSafeRuntimeUsageLimit(diagnostic, {
              providerName: definition?.name || "The selected AI provider",
            });
            if (usageLimit) {
              reject(
                runtimeError(usageLimit.message, "RUNTIME_USAGE_LIMIT", {
                  exitStatus: status,
                  signal: closeSignal || null,
                  resetAt: usageLimit.resetAt,
                })
              );
              return;
            }
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
// runInstalledRuntimeStream — the live-activity sibling of runInstalledRuntime.
// Capability-gated adapters emit their native structured event stream here;
// ACP adapters delegate to the same normalized stream contract in acp-runtime.
// An adapter without verified liveActivity fails before a process is spawned.
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
  return installedRuntimeDefinition(runtimeId)?.capabilities?.liveActivity === true;
}

function normalizedCodexActivity(message, { sessionId } = {}) {
  const item = message?.item;
  if (!item?.id) return [];
  const isSearch = item.type === "web_search";
  const isScopedTool =
    item.type === "mcp_tool_call" &&
    item.server === SCOPED_TOOLS_SERVER_NAME &&
    ["fetch", "read_staged_input"].includes(item.tool);
  if (!isSearch && !isScopedTool) return [];
  const isRead = isScopedTool && item.tool === "read_staged_input";
  const query = String(item.query || item.action?.query || "").trim();
  const url = String(item.arguments?.url || "").trim();
  const name = isSearch ? "WebSearch" : isRead ? "Read" : "WebFetch";
  if (message.type === "item.started") {
    return [
      {
        type: "assistant",
        session_id: sessionId || null,
        message: {
          content: [
            {
              type: "tool_use",
              id: item.id,
              name,
              input: isSearch ? (query ? { query } : {}) : isRead ? {} : url ? { url } : {},
            },
          ],
        },
      },
    ];
  }
  if (message.type === "item.completed") {
    const failed = item.status === "failed" || Boolean(item.error);
    const subject = isSearch ? query : isRead ? "staged input" : url;
    const completed = isSearch ? "Search completed" : isRead ? "Read" : "Fetched";
    const failedLabel = isSearch ? "Search failed" : isRead ? "Read failed" : "Fetch failed";
    return [
      {
        type: "user",
        session_id: sessionId || null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: item.id,
              content: failed
                ? `${failedLabel}${subject ? ` for ${subject}` : ""}`
                : `${completed}${subject ? ` ${isSearch ? "for " : ""}${subject}` : ""}`,
              is_error: failed,
            },
          ],
        },
      },
    ];
  }
  return [];
}

export const RUNTIME_STREAMING_UNSUPPORTED = "RUNTIME_STREAMING_UNSUPPORTED";

export async function runInstalledRuntimeStream({
  runtime,
  prompt,
  outputSchema,
  model,
  effort,
  tools = [],
  cwd,
  env = process.env,
  signal,
  timeoutMs = ONE_SHOT_RUNTIME_TIMEOUT_MS,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  treeKillImpl = spawnSync,
  runAcpRuntimeImpl = runAcpRuntime,
  runtimeIdentityImpl = installedRuntimeExecutionIdentity,
  platform = process.platform,
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
  runtime = Object.freeze({
    ...runtime,
    ...(runtime.capabilities && typeof runtime.capabilities === "object"
      ? { capabilities: Object.freeze({ ...runtime.capabilities }) }
      : {}),
  });
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
  const definition = installedRuntimeDefinition(runtime.id);
  const providerTools = Array.isArray(tools)
    ? tools.filter((tool) => tool && tool !== "Skill")
    : [];
  assertRuntimeCapabilities({
    runtime,
    definition,
    skill,
    tools: providerTools,
    outputSchema,
    streaming: true,
  });
  const childEnv = buildInstalledRuntimeChildEnv({ env });
  const assertExecutionIdentity = () =>
    assertInstalledRuntimeExecutionIdentity(runtime, {
      env: childEnv,
      platform,
      runtimeIdentityImpl,
    });
  if (providerTools.length > 0) {
    await assertInstalledRuntimeBoundaryVersion(runtime, {
      spawnImpl,
      spawnSyncImpl,
      treeKillImpl,
      env: childEnv,
      platform,
      signal,
      beforeSpawn: assertExecutionIdentity,
    });
    if (signal?.aborted) {
      throw runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED");
    }
  }

  let tempDir = null;
  let skillCwd = null;
  let taskCwd = null;
  let stagedReadPath = null;
  try {
    let schemaPath = null;
    if (definition?.protocol === "codex-jsonl" && outputSchema) {
      tempDir = mkdtempSync(join(tmpdir(), "careerrat-runtime-schema-"));
      chmodSync(tempDir, 0o700);
      schemaPath = join(tempDir, "output-schema.json");
      writeFileSync(schemaPath, `${JSON.stringify(sanitizeCodexOutputSchema(outputSchema))}\n`, {
        mode: 0o600,
      });
    }
    let installedPrompt = String(prompt || "");
    if (skill) {
      skillCwd = materializeIsolatedSkillCwd({ repoRoot, skill });
      if (!skillCwd) {
        throw runtimeError(
          `Could not create the isolated CareerRat runtime for skill "${skill}".`,
          "RUNTIME_BOUNDARY_UNAVAILABLE",
          { runtimeId: runtime.id }
        );
      }
      installedPrompt = promptWithInstalledSkill({ prompt: installedPrompt, repoRoot, skill });
      if (providerTools.includes("Read")) {
        stagedReadPath = stageApprovedReadInput({
          repoRoot,
          env,
          skill,
          approvedReadPaths,
          isolatedCwd: skillCwd,
          runtimeId: runtime.id,
        });
        installedPrompt = [
          installedPrompt,
          definition?.protocol === "claude-json"
            ? `CareerRat staged the one user-approved input at ${stagedReadPath}. Use that copy as the input for this task.`
            : "Use CareerRat's read_staged_input tool to read the one user-approved input. No other filesystem read is available for this task.",
        ].join("\n\n");
      }
    } else if (definition?.protocol === "acp") {
      taskCwd = mkdtempSync(join(tmpdir(), "careerrat-task-cwd-"));
      chmodSync(taskCwd, 0o700);
    }
    if (definition?.protocol === "acp") {
      installedPrompt = promptWithStructuredContract({ prompt: installedPrompt, outputSchema });
    }
    if (definition?.protocol === "acp") {
      const mcpServers = acpScopedToolsServers({
        allowPublicWeb: providerTools.includes("WebSearch") || providerTools.includes("WebFetch"),
        stagedReadPath,
      });
      return await runAcpRuntimeImpl({
        runtime: { ...runtime, acpArgs: definition.acpArgs },
        prompt: installedPrompt,
        cwd: skillCwd || taskCwd || cwd,
        tools: providerTools,
        env: childEnv,
        signal,
        timeoutMs,
        mcpServers,
        onMessage,
        spawnImpl,
        platform,
        beforeSpawn: assertExecutionIdentity,
      });
    }
    const invocation = buildInstalledRuntimeInvocation({
      runtimeId: runtime.id,
      executablePath: runtime.path,
      schema: outputSchema,
      schemaPath,
      model,
      effort,
      tools,
      skill: skillCwd ? skill : undefined,
      repoRoot,
      env,
      isolatedCwd: skillCwd,
      approvedReadPaths,
      stagedReadPath,
      streaming: true,
    });

    const processInvocation = runtimeProcessInvocation(invocation.command, invocation.args, {
      env: childEnv,
      platform,
    });
    const result = await new Promise((resolve, reject) => {
      assertExecutionIdentity();
      let child;
      try {
        child = spawnImpl(processInvocation.command, processInvocation.args, {
          ...invocation.options,
          ...processInvocation.options,
          cwd: skillCwd || cwd,
          env: childEnv,
          detached: platform !== "win32",
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
      let stopError = null;
      let finalResult = null;
      let codexSessionId = null;
      let codexText = "";
      let forceKillTimer = null;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceKillTimer);
        signal?.removeEventListener("abort", abort);
        callback();
      };
      const stop = (error) => {
        stopError ||= error;
        if (forceKillTimer) return;
        forceKillTimer = scheduleRuntimeProcessKill(child, () => finish(() => reject(stopError)), {
          platform,
        });
      };
      const abort = () => {
        stop(runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED"));
      };
      const timer = setTimeout(
        () => {
          stop(runtimeError("Installed AI request timed out.", "RUNTIME_TIMEOUT"));
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
        if (stopError) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        let message;
        try {
          message = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (definition?.protocol === "codex-jsonl") {
          if (message?.type === "thread.started") {
            codexSessionId = String(message.thread_id || "").trim() || null;
          }
          if (message?.type === "item.completed" && message?.item?.type === "agent_message") {
            codexText = String(message.item.text || "").trim();
          }
          if (message?.type === "turn.completed") {
            finalResult = {
              type: "result",
              subtype: "success",
              result: codexText,
              usage: message.usage || null,
              session_id: codexSessionId,
            };
          }
          if (message?.type === "turn.failed") {
            finalResult = {
              type: "result",
              subtype: "error",
              is_error: true,
              result:
                safeRuntimeDiagnostic(message?.error?.message) ||
                "Codex CLI reported an unsuccessful turn.",
              session_id: codexSessionId,
            };
          }
          for (const activity of normalizedCodexActivity(message, {
            sessionId: codexSessionId,
          })) {
            try {
              onMessage?.(activity);
            } catch {
              // a caller's own mapping/dispatch error must never break the pump
            }
          }
        } else {
          if (message?.type === "result") finalResult = message;
          try {
            onMessage?.(message);
          } catch {
            // a caller's own mapping/dispatch error must never break the pump
          }
        }
      }

      child.stdout?.on("data", (chunk) => {
        if (stopError) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_RUNTIME_OUTPUT_BYTES) {
          stop(
            runtimeError(
              "Installed AI output exceeded the 10MB safety limit.",
              "RUNTIME_OUTPUT_LIMIT"
            )
          );
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
        if (stopError) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_RUNTIME_OUTPUT_BYTES) {
          stop(
            runtimeError(
              "Installed AI output exceeded the 10MB safety limit.",
              "RUNTIME_OUTPUT_LIMIT"
            )
          );
          return;
        }
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        finish(() => {
          if (stopError) {
            reject(stopError);
            return;
          }
          reject(
            runtimeError("Could not start the selected AI CLI.", "RUNTIME_SPAWN", { cause: error })
          );
        });
      });
      child.on("close", (status, closeSignal) => {
        finish(() => {
          // Flush a final complete-but-unterminated line (a process that
          // exits without a trailing newline after its last NDJSON object).
          if (lineBuffer.trim()) handleLine(lineBuffer);
          if (stopError) {
            reject(stopError);
            return;
          }
          if (status !== 0) {
            const diagnostic =
              (definition?.protocol === "claude-json"
                ? claudeFailureDiagnostic(finalResult)
                : "") || safeRuntimeDiagnostic(stderr);
            const usageLimit = candidateSafeRuntimeUsageLimit(diagnostic, {
              providerName: definition?.name || "The selected AI provider",
            });
            if (usageLimit) {
              reject(
                runtimeError(usageLimit.message, "RUNTIME_USAGE_LIMIT", {
                  exitStatus: status,
                  signal: closeSignal || null,
                  resetAt: usageLimit.resetAt,
                })
              );
              return;
            }
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
                  `${definition?.name || runtime.id} reported an unsuccessful result.`,
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
      child.stdin?.end(installedPrompt);
    });

    return { ...result, runtimeId: runtime.id };
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    if (skillCwd) rmSync(skillCwd, { recursive: true, force: true });
    if (taskCwd) rmSync(taskCwd, { recursive: true, force: true });
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

function scopedReadError(message) {
  return {
    isError: true,
    content: [{ type: "text", text: `Scoped read rejected: ${message}` }],
  };
}

export function readInstalledRuntimeScopedFile(
  stagedPath,
  { input = {}, maxBytes = MAX_SCOPED_READ_BYTES } = {}
) {
  if (
    input &&
    (typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0)
  ) {
    return scopedReadError("the staged-input tool does not accept a caller-selected path.");
  }
  const candidate = String(stagedPath || "").trim();
  if (!candidate || !isAbsolute(candidate)) {
    return scopedReadError("no absolute staged input was configured.");
  }
  try {
    const lexical = resolve(candidate);
    const details = lstatSync(lexical);
    if (details.isSymbolicLink() || !details.isFile()) {
      return scopedReadError("the staged input is not a regular file.");
    }
    if (details.size > maxBytes) {
      return scopedReadError("the staged input exceeds the bounded read size.");
    }
    const extension = extname(lexical).toLowerCase();
    const mimeTypes = {
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".md": "text/markdown",
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".txt": "text/plain",
      ".webp": "image/webp",
    };
    const mimeType = mimeTypes[extension];
    if (!mimeType) return scopedReadError("the staged input type is unsupported.");
    const canonical = realpathSync(lexical);
    const data = readFileSync(canonical);
    if (mimeType.startsWith("text/")) {
      return { content: [{ type: "text", text: data.toString("utf8") }] };
    }
    if (mimeType.startsWith("image/")) {
      return { content: [{ type: "image", data: data.toString("base64"), mimeType }] };
    }
    return {
      content: [
        {
          type: "resource",
          resource: {
            uri: pathToFileURL(canonical).href,
            mimeType,
            blob: data.toString("base64"),
          },
        },
      ],
    };
  } catch {
    return scopedReadError("the staged input is missing or unreadable.");
  }
}

function writeMcpMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleScopedToolsMcpRequest(
  message,
  { allowPublicWeb = false, stagedReadPath = null } = {}
) {
  if (!message || message.id === undefined) return;
  const base = { jsonrpc: "2.0", id: message.id };
  if (message.method === "initialize") {
    writeMcpMessage({
      ...base,
      result: {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: SCOPED_TOOLS_SERVER_NAME, version: "1.0.0" },
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
          ...(allowPublicWeb
            ? [
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
              ]
            : []),
          ...(stagedReadPath
            ? [
                {
                  name: "read_staged_input",
                  description:
                    "Read the single file CareerRat staged for this request. This tool accepts no path.",
                  inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                  },
                },
              ]
            : []),
        ],
      },
    });
    return;
  }
  if (allowPublicWeb && message.method === "tools/call" && message.params?.name === "fetch") {
    writeMcpMessage({
      ...base,
      result: await fetchInstalledRuntimePublicUrl(message.params?.arguments?.url),
    });
    return;
  }
  if (
    stagedReadPath &&
    message.method === "tools/call" &&
    message.params?.name === "read_staged_input"
  ) {
    writeMcpMessage({
      ...base,
      result: readInstalledRuntimeScopedFile(stagedReadPath, {
        input: message.params?.arguments,
      }),
    });
    return;
  }
  writeMcpMessage({
    ...base,
    error: { code: -32601, message: "Method not found" },
  });
}

function scopedToolsServerOptions(args = process.argv) {
  const readIndex = args.indexOf(SCOPED_READ_FILE_ARG);
  return {
    allowPublicWeb: args.includes(SCOPED_PUBLIC_WEB_ARG),
    stagedReadPath: readIndex >= 0 ? String(args[readIndex + 1] || "").trim() || null : null,
  };
}

function startScopedToolsMcpServer() {
  const options = scopedToolsServerOptions();
  const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  input.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    Promise.resolve(handleScopedToolsMcpRequest(message, options)).catch((error) => {
      if (message?.id === undefined) return;
      writeMcpMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: safeRuntimeDiagnostic(error?.message) || "Internal error" },
      });
    });
  });
}

if (process.argv.includes(SCOPED_TOOLS_SERVER_ARG)) startScopedToolsMcpServer();
