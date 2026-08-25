import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

const WINDOWS_BATCH_EXTENSION = /\.(?:bat|cmd)$/i;
const WINDOWS_NPM_SHIM = /(?:^|[\\/])(?:node_modules[\\/]\.bin|npm)[\\/][^\\/]+\.(?:bat|cmd)$/i;
const WINDOWS_COMMAND_META = /([()\][%!^"`<>&|;, *?])/g;
const WINDOWS_LINE_BREAK = /[\r\n]/;

const RUNTIME_TERMINATION_GRACE_MS = 250;

function escapeWindowsCommand(value) {
  return String(value).replace(WINDOWS_COMMAND_META, "^$1");
}

function escapeWindowsArgument(value, doubleEscapeMetaCharacters) {
  let argument = String(value);
  argument = argument.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  argument = argument.replace(/(?=(\\+?)?)\1$/g, "$1$1");
  argument = `"${argument}"`.replace(WINDOWS_COMMAND_META, "^$1");
  return doubleEscapeMetaCharacters ? argument.replace(WINDOWS_COMMAND_META, "^$1") : argument;
}

export function runtimeProcessInvocation(
  command,
  args,
  { env = process.env, platform = process.platform } = {}
) {
  const sourceArgs = Array.isArray(args) ? [...args] : [];
  if (platform !== "win32" || !WINDOWS_BATCH_EXTENSION.test(String(command || ""))) {
    return { command, args: sourceArgs, options: {} };
  }
  const commandText = String(command || "");
  if (
    WINDOWS_LINE_BREAK.test(commandText) ||
    sourceArgs.some((argument) => WINDOWS_LINE_BREAK.test(String(argument)))
  ) {
    throw new TypeError("Windows batch commands and arguments cannot contain line breaks.");
  }
  const doubleEscapeMetaCharacters = WINDOWS_NPM_SHIM.test(commandText);
  const shellCommand = [
    escapeWindowsCommand(commandText),
    ...sourceArgs.map((argument) => escapeWindowsArgument(argument, doubleEscapeMetaCharacters)),
  ].join(" ");
  return {
    command: String(env.COMSPEC || env.ComSpec || "cmd.exe"),
    args: ["/d", "/s", "/v:off", "/c", `"${shellCommand}"`],
    options: { windowsVerbatimArguments: true },
  };
}

function terminateWindowsProcessTree(child, { env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const pid = Number(child?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    try {
      child?.kill?.("SIGKILL");
    } catch {
      // The process already exited between the state check and kill.
    }
    return;
  }
  const systemRoot = String(env.SystemRoot || env.SYSTEMROOT || env.WINDIR || "C:\\Windows");
  const command = win32.join(systemRoot, "System32", "taskkill.exe");
  try {
    const result = spawnSyncImpl(command, ["/pid", String(pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    if (result?.error || (Number.isInteger(result?.status) && result.status !== 0)) {
      throw result.error || new Error(`taskkill exited with status ${result.status}`);
    }
  } catch {
    try {
      child.kill?.("SIGKILL");
    } catch {
      // The process already exited between the tree-kill attempt and fallback.
    }
  }
}

function killRuntimeProcess(
  child,
  signal = "SIGTERM",
  { platform = process.platform, env = process.env, spawnSyncImpl = spawnSync } = {}
) {
  if (!child || (signal === "SIGTERM" && child.killed)) return;
  if (platform === "win32") {
    if (signal === "SIGKILL") terminateWindowsProcessTree(child, { env, spawnSyncImpl });
    return;
  }
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited between the state check and kill.
    }
  }
}

export function scheduleRuntimeProcessKill(
  child,
  onEscalated,
  {
    graceMs = RUNTIME_TERMINATION_GRACE_MS,
    platform = process.platform,
    env = process.env,
    spawnSyncImpl = spawnSync,
  } = {}
) {
  if (platform !== "win32") {
    killRuntimeProcess(child, "SIGTERM", { platform, env, spawnSyncImpl });
  }
  const timer = setTimeout(() => {
    killRuntimeProcess(child, "SIGKILL", { platform, env, spawnSyncImpl });
    onEscalated?.();
  }, graceMs);
  timer.unref?.();
  return timer;
}
