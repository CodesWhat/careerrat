import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { win32 } from "node:path";

const WINDOWS_BATCH_EXTENSION = /\.(?:bat|cmd)$/i;
const WINDOWS_NPM_SHIM = /(?:^|[\\/])(?:node_modules[\\/]\.bin|npm)[\\/][^\\/]+\.(?:bat|cmd)$/i;
const WINDOWS_COMMAND_META = /([()\][%!^"`<>&|;, *?])/g;
const WINDOWS_LINE_BREAK = /[\r\n]/;
const WINDOWS_NODE_PAYLOAD = /((?:%~dp0|%dp0%)[\\/][^"'\r\n]*?\.(?:cjs|mjs|js))/gi;
const MAX_WINDOWS_SHIM_BYTES = 64 * 1024;

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

function windowsEnvValue(env, name) {
  const expected = String(name).toLowerCase();
  const entry = Object.entries(env || {}).find(([key]) => key.toLowerCase() === expected);
  return String(entry?.[1] || "").trim();
}

function canonicalPath(path, realpathImpl) {
  try {
    return realpathImpl(path);
  } catch {
    return null;
  }
}

function resolveWindowsExecutable(command, { env, realpathImpl, includeSystemCmd = false }) {
  const value = String(command || "").trim();
  if (!value || WINDOWS_LINE_BREAK.test(value)) return null;
  if (win32.isAbsolute(value) || /[\\/]/.test(value)) {
    return canonicalPath(value, realpathImpl);
  }

  const candidates = [];
  if (includeSystemCmd && /^cmd(?:\.exe)?$/i.test(value)) {
    const systemRoot = windowsEnvValue(env, "SystemRoot") || windowsEnvValue(env, "WINDIR");
    if (systemRoot) candidates.push(win32.join(systemRoot, "System32", "cmd.exe"));
  }
  const pathValue = windowsEnvValue(env, "PATH");
  const extensions = win32.extname(value)
    ? [""]
    : (windowsEnvValue(env, "PATHEXT") || ".EXE;.CMD;.BAT")
        .split(";")
        .map((extension) => extension.trim())
        .filter(Boolean);
  for (const directory of pathValue
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    for (const extension of extensions)
      candidates.push(win32.join(directory, `${value}${extension}`));
  }
  for (const candidate of candidates) {
    const resolved = canonicalPath(candidate, realpathImpl);
    if (resolved) return resolved;
  }
  return null;
}

function resolveShimPayload(reference, wrapperDirectory, realpathImpl) {
  const relativePayload = String(reference).replace(/^(?:%~dp0|%dp0%)[\\/]?/i, "");
  if (!relativePayload || win32.isAbsolute(relativePayload)) return null;
  const candidate = win32.resolve(wrapperDirectory, relativePayload);
  const allowedRoot =
    win32.basename(wrapperDirectory).toLowerCase() === ".bin" &&
    win32.basename(win32.dirname(wrapperDirectory)).toLowerCase() === "node_modules"
      ? win32.dirname(wrapperDirectory)
      : wrapperDirectory;
  const remainder = win32.relative(allowedRoot, candidate);
  if (remainder === ".." || remainder.startsWith(`..${win32.sep}`) || win32.isAbsolute(remainder)) {
    return null;
  }
  return canonicalPath(candidate, realpathImpl);
}

function resolveShimInterpreter({ shim, invocationPrefix, wrapperDirectory, env, realpathImpl }) {
  const localNode = canonicalPath(win32.join(wrapperDirectory, "node.exe"), realpathImpl);
  if (/"%_prog%"\s*$/i.test(invocationPrefix)) {
    const assignments = [...shim.matchAll(/^\s*set\s+"?_prog=([^"\r\n]+)"?\s*$/gim)].map((match) =>
      match[1].trim()
    );
    if (
      assignments.length === 0 ||
      assignments.some(
        (value) => !/^(?:(?:%~dp0|%dp0%)[\\/]node\.exe|node(?:\.exe)?)$/i.test(value)
      )
    ) {
      return null;
    }
    if (localNode) return localNode;
    if (!assignments.some((value) => /^node(?:\.exe)?$/i.test(value))) return null;
    const interpreter = resolveWindowsExecutable("node", { env, realpathImpl });
    return /\.exe$/i.test(String(interpreter || "")) ? interpreter : null;
  }
  if (/"?(?:%~dp0|%dp0%)[\\/]node\.exe"?\s*$/i.test(invocationPrefix)) return localNode;
  if (/\bnode(?:\.exe)?\s*$/i.test(invocationPrefix)) {
    return resolveWindowsExecutable("node", { env, realpathImpl });
  }
  return null;
}

function hasRecognizedNpmShimShape(shim, invocationLine, payloadReference) {
  const requiredLines = [
    /^goto start$/i,
    /^:find_dp0$/i,
    /^set dp0=%~dp0$/i,
    /^:start$/i,
    /^call :find_dp0$/i,
  ];
  const lines = shim
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    lines.at(-1) !== invocationLine.trim() ||
    requiredLines.some((pattern) => !lines.some((line) => pattern.test(line))) ||
    lines.filter((line) => /%\*/.test(line)).length !== 1
  ) {
    return false;
  }

  const payloadIndex = invocationLine.toLowerCase().indexOf(payloadReference.toLowerCase());
  const prefix = invocationLine.slice(0, payloadIndex);
  const suffix = invocationLine.slice(payloadIndex + payloadReference.length);
  if (
    !/^endlocal & goto #_undefined_# 2>nul \|\| title %comspec% & (?:set pathext=%pathext:;\.js;=;% & )?"%_prog%"\s+"$/i.test(
      prefix
    ) ||
    !/^"\s+%\*\s*$/i.test(suffix)
  ) {
    return false;
  }

  return lines.every(
    (line) =>
      /^@?echo off$/i.test(line) ||
      /^goto start$/i.test(line) ||
      /^:find_dp0$/i.test(line) ||
      /^set dp0=%~dp0$/i.test(line) ||
      /^exit \/b$/i.test(line) ||
      /^:start$/i.test(line) ||
      /^setlocal$/i.test(line) ||
      /^call :find_dp0$/i.test(line) ||
      /^if exist "(?:%~dp0|%dp0%)[\\/]node\.exe" \($/i.test(line) ||
      /^\) else \($/i.test(line) ||
      /^\)$/i.test(line) ||
      /^set\s+(?:"[^"\r\n]+"|[^&|<>\r\n]+)$/i.test(line) ||
      line === invocationLine.trim()
  );
}

export function runtimeProcessIdentityFiles(
  command,
  {
    env = process.env,
    platform = process.platform,
    readFileImpl = readFileSync,
    realpathImpl = realpathSync,
  } = {}
) {
  const commandText = String(command || "").trim();
  const wrapper = canonicalPath(commandText, realpathImpl);
  if (!wrapper) return null;
  if (platform !== "win32" || !WINDOWS_BATCH_EXTENSION.test(commandText)) {
    return [{ role: "executable", path: wrapper }];
  }
  if (!WINDOWS_NPM_SHIM.test(commandText)) return null;

  const launcherCommand = windowsEnvValue(env, "COMSPEC") || "cmd.exe";
  const launcher = resolveWindowsExecutable(launcherCommand, {
    env,
    realpathImpl,
    includeSystemCmd: true,
  });
  if (!launcher || !/\.exe$/i.test(launcher)) return null;

  let shim;
  try {
    const bytes = readFileImpl(wrapper);
    if (bytes.length > MAX_WINDOWS_SHIM_BYTES || String(bytes).includes("\0")) return null;
    shim = String(bytes);
  } catch {
    return null;
  }

  const payloadReferences = [...shim.matchAll(WINDOWS_NODE_PAYLOAD)].map((match) => match[1]);
  const uniquePayloads = [
    ...new Map(payloadReferences.map((value) => [value.toLowerCase(), value])).values(),
  ];
  if (uniquePayloads.length !== 1) return null;
  const payloadReference = uniquePayloads[0];
  const invocationLine = shim
    .split(/\r?\n/)
    .find(
      (line) => line.toLowerCase().includes(payloadReference.toLowerCase()) && /%\*/.test(line)
    );
  if (!invocationLine) return null;
  if (!hasRecognizedNpmShimShape(shim, invocationLine, payloadReference)) return null;
  const payloadIndex = invocationLine.toLowerCase().indexOf(payloadReference.toLowerCase());
  const invocationPrefix = invocationLine
    .slice(0, payloadIndex)
    .replace(/["']\s*$/, "")
    .trimEnd();
  const wrapperDirectory = win32.dirname(wrapper);
  const interpreter = resolveShimInterpreter({
    shim,
    invocationPrefix,
    wrapperDirectory,
    env,
    realpathImpl,
  });
  const payload = resolveShimPayload(payloadReference, wrapperDirectory, realpathImpl);
  if (!interpreter || !payload) return null;

  return [
    { role: "launcher", path: launcher },
    { role: "wrapper", path: wrapper },
    { role: "interpreter", path: interpreter },
    { role: "payload", path: payload },
  ];
}

// The Windows half of the tree kill: taskkill's /t walks the whole process
// tree rooted at `pid`, which is the closest POSIX-detached-group equivalent
// Windows offers (there's no negative-pid group signal to send). Shared by
// the ChildProcess-based path below and killProcessTreeByPid's pid-only path,
// so both ever have exactly one place that knows how to reach a tree here.
function taskkillProcessTree(pid, { env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const systemRoot = String(env.SystemRoot || env.SYSTEMROOT || env.WINDIR || "C:\\Windows");
  const command = win32.join(systemRoot, "System32", "taskkill.exe");
  const result = spawnSyncImpl(command, ["/pid", String(pid), "/t", "/f"], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  if (result?.error || (Number.isInteger(result?.status) && result.status !== 0)) {
    throw result.error || new Error(`taskkill exited with status ${result.status}`);
  }
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
  try {
    taskkillProcessTree(pid, { env, spawnSyncImpl });
  } catch {
    try {
      child.kill?.("SIGKILL");
    } catch {
      // The process already exited between the tree-kill attempt and fallback.
    }
  }
}

// A synchronous, pid-only counterpart to scheduleRuntimeProcessKill for
// callers that only ever have a spawnSync result (no ChildProcess object to
// hang a `.kill()` fallback off of) — installedRuntimeExecutionIdentity's
// own `--version` probe being the one caller today. Reuses the exact same
// mechanism: process-group SIGKILL on POSIX (the probe is spawned with
// `detached: true` so its pid doubles as its pgid), taskkill's tree walk on
// Windows. Best-effort and silent: the pid may already be gone by the time
// this runs, and that's the success case, not an error.
export function killProcessTreeByPid(
  pid,
  { platform = process.platform, env = process.env, spawnSyncImpl = spawnSync } = {}
) {
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid <= 0) return;
  if (platform === "win32") {
    try {
      taskkillProcessTree(numericPid, { env, spawnSyncImpl });
    } catch {
      // The process tree may have already exited on its own.
    }
    return;
  }
  try {
    process.kill(-numericPid, "SIGKILL");
  } catch {
    try {
      process.kill(numericPid, "SIGKILL");
    } catch {
      // Already gone.
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
