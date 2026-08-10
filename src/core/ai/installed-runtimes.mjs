// Installed AI CLI registry shared by the terminal launcher and Electron.
// Discovery never executes a candidate binary. Readiness probes and requests
// spawn the resolved executable directly with fixed argv and shell:false.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export const INSTALLED_RUNTIME_DEFINITIONS = [
  {
    id: "claude",
    name: "Claude Code",
    binaries: ["claude"],
    commandShape: "claude -p --output-format json",
    authProbe: { args: ["auth", "status"] },
    installUrl: "https://code.claude.com/docs/en/quickstart",
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
    warning: "May ask you to sign in the first time.",
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
    warning: "May ask you to sign in the first time.",
    installUrl:
      "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
  },
  {
    id: "qwen",
    name: "Qwen Code",
    binaries: ["qwen"],
    commandShape: "qwen -p",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "May ask you to sign in the first time.",
    installUrl: "https://github.com/QwenLM/qwen-code",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    binaries: ["antigravity", "antigravitycli"],
    commandShape: "antigravity -p",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Installed, but we can't tell if it's set up yet.",
    installUrl: "https://antigravity.google/docs/cli/install",
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    binaries: ["hermes"],
    commandShape: "hermes -z",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "May ask you to sign in the first time.",
    installUrl: "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
  },
  {
    id: "amp",
    name: "Amp",
    binaries: ["amp"],
    commandShape: "amp -x",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "May ask you to sign in the first time.",
    installUrl: "https://ampcode.com/manual",
  },
  {
    id: "goose",
    name: "Goose",
    binaries: ["goose"],
    commandShape: "goose run -i -",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Installed, but we can't tell if it's set up yet.",
    installUrl: "https://goose-docs.ai/docs/getting-started/installation/",
  },
  {
    id: "droid",
    name: "Droid",
    binaries: ["droid"],
    commandShape: "droid exec",
    authProbe: { args: ["--version"], launchOnly: true },
    warning: "Installed, but we can't tell if it's set up yet.",
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
  addUnique(dirs, splitPaths(env.ROLESTER_RUNTIME_EXTRA_PATHS, separator));

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
      // Rolester checkout it added ~136k input tokens and pushed a PDF extract
      // beyond the two-minute runtime limit. Safe mode keeps subscription auth
      // and built-in tools available while isolating this bounded app call.
      "--safe-mode",
      "--output-format",
      "json",
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

export function sanitizeInstalledOutputSchema(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeInstalledOutputSchema(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$schema" && key !== "$id")
      .map(([key, entry]) => [key, sanitizeInstalledOutputSchema(entry)])
  );
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
  timeoutMs = 120000,
  spawnImpl = spawn,
  onEvent,
} = {}) {
  if (!runtime?.id || !runtime?.path) {
    throw runtimeError("No installed AI runtime is selected.", "RUNTIME_NOT_SELECTED");
  }
  if (signal?.aborted) {
    throw runtimeError("Installed AI request was cancelled.", "RUNTIME_CANCELLED");
  }

  let tempDir = null;
  try {
    let schemaPath = null;
    if (runtime.id === "codex" && outputSchema) {
      tempDir = mkdtempSync(join(tmpdir(), "rolester-runtime-schema-"));
      chmodSync(tempDir, 0o700);
      schemaPath = join(tempDir, "output-schema.json");
      writeFileSync(
        schemaPath,
        `${JSON.stringify(sanitizeInstalledOutputSchema(outputSchema))}\n`,
        {
          mode: 0o600,
        }
      );
    }
    const invocation = buildInstalledRuntimeInvocation({
      runtimeId: runtime.id,
      executablePath: runtime.path,
      schema: outputSchema,
      schemaPath,
      model,
      tools,
    });

    const result = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(invocation.command, invocation.args, {
          ...invocation.options,
          cwd,
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
  }
}
