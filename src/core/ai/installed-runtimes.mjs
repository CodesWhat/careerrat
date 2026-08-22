// Installed AI CLI registry shared by the terminal launcher and Electron.
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
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { APP_SAFE_RUNTIME_TOOLS, CHAT_RUNTIME_TOOLS } from "./runtime-tools.mjs";

export const INSTALLED_RUNTIME_DEFINITIONS = [
  {
    id: "claude",
    name: "Claude Code",
    binaries: ["claude"],
    commandShape: "claude -p --output-format json",
    authProbe: { args: ["auth", "status"] },
    installUrl: "https://code.claude.com/docs/en/quickstart",
    // The only installed runtime whose CLI actually has a tool-allowlist
    // mechanism (`--tools`/`--allowedTools`, wired in
    // buildInstalledRuntimeInvocation's "claude" branch below). Every other
    // runtime in this registry ignores the `tools` param entirely — see
    // runInstalledRuntime's chat-tool-profile guard, which fails closed for
    // any of them rather than silently granting an unscoped tool surface.
    // Absent on every other definition means "unsupported," deliberately —
    // do not add this key anywhere else without also verifying that CLI has
    // a real per-call tool restriction, the way this one was verified against
    // the real installed `claude` CLI (see the file header comment).
    chatToolProfileSupported: true,
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
    return {
      id: definition.id,
      name: definition.name,
      commandShape: definition.commandShape,
      path,
      available: Boolean(path),
      warning: definition.warning || null,
      installUrl: definition.installUrl || null,
    };
  });
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

  let result;
  try {
    result = spawnSyncImpl(runtime.path, definition.authProbe.args, {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: timeoutMs,
      env,
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
    };
  }
  return {
    status: "authentication_required",
    ready: false,
    action: "open_terminal",
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
    const args = [
      "-p",
      // The app supplies the complete task/skill context in `prompt` below.
      // Loading a user's project hooks, plugins, MCP servers, auto-memory, and
      // CLAUDE.md here is both unnecessary and extremely expensive: in a real
      // CareerRat checkout it added ~136k input tokens and pushed a PDF extract
      // beyond the two-minute runtime limit. Safe mode keeps subscription auth
      // and built-in tools available while isolating this bounded app call —
      // EXCEPT `--safe-mode`'s own help text is explicit that it disables
      // "skills" outright, which leaves the Skill tool's registry empty even
      // for a project-local `.claude/skills/<name>` this call actually wants
      // (verified against the real installed CLI: a --safe-mode run's Skill
      // tool lists only Anthropic's fixed built-in skills, never a project
      // skill). When the caller has already isolated `cwd` to a temp dir
      // containing nothing but that one skill (runInstalledRuntime's
      // materializeIsolatedSkillCwd), `--setting-sources project` gets the
      // same cost/privacy posture --safe-mode promises — confirmed empirically
      // at ~5k cache-creation input tokens against that isolated cwd, not the
      // ~136k a real project cwd produces — while the Skill tool actually
      // resolves the skill. Every other call (no skill / isolation unavailable)
      // keeps exactly today's --safe-mode behavior.
      ...(skill ? ["--setting-sources", "project"] : ["--safe-mode"]),
      "--output-format",
      streaming ? "stream-json" : "json",
      ...(streaming ? ["--verbose"] : []),
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
    ];
    const allowedTools = Array.isArray(tools) ? tools.filter(Boolean) : [];
    args.push("--tools", allowedTools.join(","));
    if (allowedTools.length) args.push("--allowedTools", allowedTools.join(","));
    if (model) args.push("--model", model);
    if (schema) args.push("--json-schema", JSON.stringify(sanitizeInstalledOutputSchema(schema)));
    return { ...common, args };
  }
  if (runtimeId === "codex") {
    const args = [
      "exec",
      "--json",
      // CareerRat supplies the whole bounded task. Keep Codex account auth,
      // but do not load unrelated global MCP servers, hooks, or defaults
      // from ~/.codex/config.toml into an app-owned extraction/search call.
      "--ignore-user-config",
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
  // "custom" is the W4 onboarding 3d/3f custom-command runtime — its
  // `executablePath` isn't a resolved binary path (there's no fixed
  // definition to resolve against), it's the raw command string persisted by
  // POST /api/settings/ai-runtime/custom/select. Split it into argv here, at
  // invocation time, the same way probeCustomRuntimeCommand does.
  if (runtimeId === "custom") {
    const argv = parseCustomCommandString(executablePath);
    if (!argv.length) {
      const error = new Error("no custom command is configured");
      error.code = "RUNTIME_UNSUPPORTED";
      throw error;
    }
    const [bin, ...args] = argv;
    return { ...common, command: bin, args };
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
// Isolated skill cwd — the fix for the installed "claude" runtime's Skill
// tool coming up empty under --safe-mode (see buildInstalledRuntimeInvocation's
// comment above). Builds an app-owned, ephemeral cwd containing nothing but
// `.claude/skills/<skill>/`, symlinked to this repo's own `.agents/skills/<skill>`
// (the same source of truth scripts/install-skills.mjs shims into `.claude/skills`
// for a real checkout) — falling back to a copied tree the same way that
// script does when symlinks aren't available (e.g. Windows without developer
// mode). Verified empirically against the real installed CLI: a symlinked
// skill directory's contents resolve without the CLI walking up to the
// symlink target's real project root — spawning `claude -p --setting-sources
// project` from this cwd exposes exactly that one skill (plus Anthropic's
// fixed built-in skills) at the same ~5k-cache-creation-token cost
// --safe-mode's own baseline carries, never the real repo's other skills,
// CLAUDE.md, hooks, or MCP config. Never throws — returns null so callers
// fall back to plain --safe-mode (today's behavior) if the skill's SKILL.md
// can't be found or the temp dir can't be created.
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
    try {
      symlinkSync(sourceDir, dest, "dir");
    } catch {
      copySkillTree(sourceDir, dest);
    }
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

  let child;
  try {
    child = spawnImpl(bin, args, {
      shell: false,
      windowsHide: true,
      cwd,
      env,
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

export function openInstalledRuntimeTerminal(
  runtime,
  { platform = process.platform, spawnImpl = spawn } = {}
) {
  const signInCommand = installedRuntimeSignInCommand(runtime?.id);
  if (!signInCommand) {
    throw runtimeError("Unsupported installed AI runtime.", "RUNTIME_UNSUPPORTED");
  }
  let command;
  let args;
  if (platform === "darwin") {
    // The string passed to Terminal is produced entirely by the allowlisted
    // registry above; no request or filesystem value reaches the shell.
    command = "/usr/bin/osascript";
    args = ["-e", `tell application "Terminal" to do script "${signInCommand}"`];
  } else if (platform === "win32") {
    command = "cmd.exe";
    args = ["/c", "start", "", "cmd.exe"];
  } else {
    command = "x-terminal-emulator";
    args = [];
  }
  const child = spawnImpl(command, args, {
    shell: false,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref?.();
  return { ok: true, signInCommand };
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

// Tools that only ever appear in the restricted chat profile (WebSearch/
// WebFetch — see runtime-tools.mjs's CHAT_RUNTIME_TOOLS/APP_SAFE_RUNTIME_TOOLS
// and its own "structural prompt-injection boundary" comment). Computed as a
// set difference against those two canonical exports rather than duplicated
// here as a hardcoded tool-name list, so this stays correct automatically if
// either profile's tool set ever changes. Discriminator choice: a tool-count
// check or an allowlist of runtime ids would both silently rot the moment a
// profile's shape changes; comparing against the canonical exports can't.
const CHAT_ONLY_RUNTIME_TOOLS = new Set(
  CHAT_RUNTIME_TOOLS.filter((tool) => !APP_SAFE_RUNTIME_TOOLS.includes(tool))
);

// True when `tools` requests the restricted chat profile (any network-only
// tool from CHAT_ONLY_RUNTIME_TOOLS), as opposed to the ordinary app-safe
// one-shot profile (Read/Glob/Grep/Skill) every evaluate-job/tailor-application/
// resume-extract-style call uses. Only the chat profile is a boundary
// violation on a runtime with no tool-allowlist mechanism — the app-safe
// profile never requests network tools, so it's unaffected either way.
function isRestrictedChatToolProfile(tools) {
  return Array.isArray(tools) && tools.some((tool) => CHAT_ONLY_RUNTIME_TOOLS.has(tool));
}

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
  onEvent,
  // Skill this call is running (a directory name under `<repoRoot>/.agents/skills`)
  // and the repo root to resolve it against. Both optional — omit either and
  // this behaves exactly as before (--safe-mode, spawned at `cwd`). When both
  // are given and the skill's SKILL.md is found, the call spawns instead
  // against materializeIsolatedSkillCwd()'s isolated cwd with
  // `--setting-sources project`, so the Skill tool actually resolves this one
  // skill (see buildInstalledRuntimeInvocation's comment for why --safe-mode
  // alone can't do that).
  skill = null,
  repoRoot = null,
} = {}) {
  if (!runtime?.id || !runtime?.path) {
    throw runtimeError("No installed AI runtime is selected.", "RUNTIME_NOT_SELECTED");
  }
  if (signal?.aborted) {
    throw runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED");
  }
  // Shared choke point: every caller (call-ai.mjs, skill-runtime.mjs,
  // chat-runtime.mjs) reaches a spawn only through this function, so the
  // fail-closed check belongs here rather than duplicated per caller. Codex
  // `exec` (and every other non-claude runtime) has no tool-allowlist
  // mechanism at all — verified against the real installed CLI, see this
  // file's registry comment on `chatToolProfileSupported` — so there is
  // nothing to pass a restricted profile through to. Only the restricted
  // chat profile (network research, no Read) is a boundary violation; the
  // app-safe one-shot profile these same runtimes already handle for
  // evaluate-job/tailor-application/resume-extract is unaffected and keeps
  // spawning exactly as before.
  if (isRestrictedChatToolProfile(tools)) {
    const definition = INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === runtime.id);
    if (!definition?.chatToolProfileSupported) {
      throw runtimeError(
        `${definition?.name || runtime.id} has no tool-allowlist mechanism, so it cannot run ` +
          "CareerRat's restricted research-chat tool profile (network access without local file " +
          "access).",
        RUNTIME_TOOL_PROFILE_UNSUPPORTED,
        { runtimeId: runtime.id }
      );
    }
  }

  let tempDir = null;
  let skillCwd = null;
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
    // Only isolate cwd for tool profiles that have no Read/Glob/Grep. The
    // one-shot runtime's app-safe profile (evaluate-job, tailor-application,
    // resume-extract, ...) grants Read and its own SKILL.md files instruct
    // relative-path workspace reads ("Open workspace/tracker.json", "Read
    // candidate/application-limits.yml") that only resolve against the real
    // repoRoot — isolating cwd there would silently break every one of those
    // reads. The chat runtime's CHAT_RUNTIME_TOOLS profile (WebSearch/
    // WebFetch/Skill, never Read — see runtime-tools.mjs's own "structural
    // prompt-injection boundary" comment) has no such dependency, so it's the
    // only shape this isolation is safe for.
    const requiresRepoCwd = ["Read", "Glob", "Grep"].some((tool) => tools.includes(tool));
    if (runtime.id === "claude" && skill && !requiresRepoCwd) {
      skillCwd = materializeIsolatedSkillCwd({ repoRoot, skill });
    }
    const invocation = buildInstalledRuntimeInvocation({
      runtimeId: runtime.id,
      executablePath: runtime.path,
      schema: outputSchema,
      schemaPath,
      model,
      tools,
      // Only tell the arg-builder a skill is "ready" once isolation actually
      // succeeded — never claim --setting-sources project against a plain
      // repoRoot cwd, which would reintroduce the ~136k-token blowup
      // --safe-mode exists to prevent.
      skill: skillCwd ? skill : undefined,
    });

    const result = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(invocation.command, invocation.args, {
          ...invocation.options,
          cwd: skillCwd || cwd,
          env,
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
            const diagnostic = safeRuntimeDiagnostic(stderr);
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
      child.stdin?.end(String(prompt || ""));
    });

    return { ...result, runtimeId: runtime.id };
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    if (skillCwd) rmSync(skillCwd, { recursive: true, force: true });
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
  // Skill this call is running — same isolated-cwd semantics as
  // runInstalledRuntime's own skill/repoRoot params (see
  // materializeIsolatedSkillCwd and buildInstalledRuntimeInvocation above).
  skill = null,
  repoRoot = null,
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
  // Same fail-closed guard as runInstalledRuntime — kept here too so a future
  // streamingSupported runtime with no tool-allowlist mechanism can't slip
  // the restricted chat tool profile through this path either.
  if (isRestrictedChatToolProfile(tools)) {
    const definition = INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === runtime.id);
    if (!definition?.chatToolProfileSupported) {
      throw runtimeError(
        `${definition?.name || runtime.id} has no tool-allowlist mechanism, so it cannot run ` +
          "CareerRat's restricted research-chat tool profile (network access without local file " +
          "access).",
        RUNTIME_TOOL_PROFILE_UNSUPPORTED,
        { runtimeId: runtime.id }
      );
    }
  }

  let skillCwd = null;
  try {
    // Same isolation rule as runInstalledRuntime's own comment: only skip
    // cwd=repoRoot when the granted tool profile has no Read/Glob/Grep.
    const requiresRepoCwd = ["Read", "Glob", "Grep"].some((tool) => tools.includes(tool));
    if (runtime.id === "claude" && skill && !requiresRepoCwd) {
      skillCwd = materializeIsolatedSkillCwd({ repoRoot, skill });
    }
    const invocation = buildInstalledRuntimeInvocation({
      runtimeId: runtime.id,
      executablePath: runtime.path,
      model,
      tools,
      skill: skillCwd ? skill : undefined,
      streaming: true,
    });

    const result = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(invocation.command, invocation.args, {
          ...invocation.options,
          cwd: skillCwd || cwd,
          env,
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
            const diagnostic = safeRuntimeDiagnostic(stderr);
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
