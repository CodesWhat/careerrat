import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { posix, win32 } from "node:path";

const WINDOWS_BATCH_EXTENSION = /\.(?:bat|cmd)$/i;
const WINDOWS_NPM_SHIM = /(?:^|[\\/])(?:node_modules[\\/]\.bin|npm)[\\/][^\\/]+\.(?:bat|cmd)$/i;
const WINDOWS_COMMAND_META = /([()\][%!^"`<>&|;, *?])/g;
const WINDOWS_LINE_BREAK = /[\r\n]/;
const WINDOWS_NODE_PAYLOAD = /((?:%~dp0|%dp0%)[\\/][^"'\r\n]*?\.(?:cjs|mjs|js))/gi;
const MAX_WINDOWS_SHIM_BYTES = 64 * 1024;

// POSIX counterpart to the Windows npm-shim recognition below: the classic
// two-branch launcher npm/bin-links generates for a global or local install,
// where the wrapper script's own bytes never change even when the payload it
// `exec`s underneath does. Only a script whose shebang names an actual POSIX
// shell is even a candidate — `#!/usr/bin/env node` (or any other non-shell
// interpreter) means the file itself IS the payload, interpreted directly,
// with no further indirection to resolve.
const POSIX_SHELL_INTERPRETER_NAMES = new Set(["sh", "bash", "dash", "ksh", "zsh"]);
const POSIX_SHEBANG_PATTERN = /^#!\s*(\/\S+)(?:\s+(\S+))?[ \t]*\r?\n?$/;
const MAX_SHEBANG_LINE_BYTES = 256;
const MAX_POSIX_SHIM_BYTES = 64 * 1024;
// The classic npm/bin-links basedir line uses a doubled backslash inside the
// sed pattern (`s,\\,/,g`, sed's own escape for "match one literal
// backslash"), translating a Windows-ish `$0` to forward slashes — a no-op
// on a real POSIX path, but required for the sed invocation itself to be
// valid regardless of what `$0` looks like.
const POSIX_SHIM_BASEDIR_LINE =
  /^basedir=\$\(dirname "\$\(echo "\$0" \| sed -e 's,\\\\,\/,g'\)"\)$/;
const POSIX_SHIM_CASE_LINE = /^case `uname` in$/;
const POSIX_SHIM_CYGWIN_LINE =
  /^\*CYGWIN\*\|\*MINGW\*\|\*MSYS\*\) basedir=`cygpath -w "\$basedir"`;;$/;
const POSIX_SHIM_ESAC_LINE = /^esac$/;
const POSIX_SHIM_IF_LINE = /^if \[ -x "\$basedir\/node" \]; then$/;
const POSIX_SHIM_ELSE_LINE = /^else$/;
const POSIX_SHIM_FI_LINE = /^fi$/;
const POSIX_SHIM_IF_EXEC_LINE = /^exec "\$basedir\/node"\s+"(\$basedir\/[^"]+)"\s+"\$@"$/;
const POSIX_SHIM_ELSE_EXEC_LINE = /^exec node\s+"(\$basedir\/[^"]+)"\s+"\$@"$/;
const POSIX_SHIM_REQUIRED_LINES = [
  POSIX_SHIM_BASEDIR_LINE,
  POSIX_SHIM_CASE_LINE,
  POSIX_SHIM_CYGWIN_LINE,
  POSIX_SHIM_ESAC_LINE,
  POSIX_SHIM_IF_LINE,
  POSIX_SHIM_ELSE_LINE,
  POSIX_SHIM_FI_LINE,
];

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
  { env = process.env, platform = process.platform, resolveInterpreter } = {}
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
  // Callers that already carry an execution-identity guarantee (today, only
  // installedRuntimeExecutionIdentity's own `--version` probe) pass
  // resolveInterpreter so the exact same absolute cmd.exe path used to build
  // that guarantee is also the one that gets spawned, never a bare
  // "cmd.exe" that Windows would resolve against cwd/PATH on its own. Every
  // other caller keeps the historical COMSPEC-or-literal behavior; widening
  // this resolution to them is CR42's hash-to-spawn-window work, not this
  // fix's.
  const interpreter = resolveInterpreter
    ? resolveInterpreter()
    : String(env.COMSPEC || env.ComSpec || "cmd.exe");
  if (!interpreter) {
    throw new TypeError("Unable to resolve the Windows command interpreter (cmd.exe).");
  }
  return {
    command: interpreter,
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

// The one place that decides which cmd.exe is "the" Windows command
// interpreter: COMSPEC if it's set and actually resolves, else the canonical
// SystemRoot\System32\cmd.exe, else null. No PATH search, ever. A bare
// "cmd.exe" handed to spawn would let Windows' own executable search (which
// checks the current directory before PATH) run a decoy sitting ahead of the
// real one. Every consumer that needs "the" interpreter, the npm-shim
// identity chain below and installedRuntimeExecutionIdentity's own
// `--version` probe, calls this exact function so the path that gets
// fingerprinted is provably the same path that gets spawned. Callers must
// fail closed (no spawn) when this returns null.
export function resolveWindowsCommandInterpreter({
  env = process.env,
  realpathImpl = realpathSync,
} = {}) {
  const comspec = windowsEnvValue(env, "COMSPEC");
  if (comspec) {
    const resolved = canonicalPath(comspec, realpathImpl);
    if (resolved) return resolved;
  }
  const systemRoot = windowsEnvValue(env, "SystemRoot") || windowsEnvValue(env, "WINDIR");
  if (!systemRoot) return null;
  return canonicalPath(win32.join(systemRoot, "System32", "cmd.exe"), realpathImpl);
}

function resolveWindowsExecutable(command, { env, realpathImpl }) {
  const value = String(command || "").trim();
  if (!value || WINDOWS_LINE_BREAK.test(value)) return null;
  if (win32.isAbsolute(value) || /[\\/]/.test(value)) {
    return canonicalPath(value, realpathImpl);
  }

  const candidates = [];
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

// Bounded, non-blocking read of just the shebang line (if any). Confirms the
// descriptor names a regular file before touching its content — the same
// FIFO-safety pattern installed-runtimes.mjs's readRegularFileBytes uses —
// because this sniff runs on every POSIX executable Doctor fingerprints, not
// only ones already known to be regular files. Capped at 256 bytes: any real
// shebang line is a fraction of that, so a longer or missing terminator
// means "not a recognizable shebang" rather than "keep reading."
function readPosixShebangLine(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(MAX_SHEBANG_LINE_BYTES);
    const bytesRead = readSync(fd, buffer, 0, MAX_SHEBANG_LINE_BYTES, 0);
    if (bytesRead < 2 || buffer[0] !== 0x23 || buffer[1] !== 0x21) return null;
    const text = buffer.toString("utf8", 0, bytesRead);
    const newlineIndex = text.indexOf("\n");
    if (newlineIndex !== -1) return text.slice(0, newlineIndex + 1);
    return bytesRead < MAX_SHEBANG_LINE_BYTES ? text : null;
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

// Recognizes exactly the classic npm/bin-links POSIX launcher shape (the
// direct counterpart to hasRecognizedNpmShimShape above): a fixed basedir
// derivation, a Cygwin/MSYS basedir rewrite that's a no-op on real POSIX, and
// two `exec` branches — one preferring a node binary bundled next to the
// wrapper, one falling back to `node` on PATH — that must reference the
// identical payload. Anything else (a hand-written wrapper, a different
// shim generator's shape, or just prose that happens to start with a shell
// shebang) is deliberately NOT recognized here, so it falls back to being
// treated as a self-contained executable rather than failing closed: most
// installed POSIX binaries and single-file scripts are not delegating shims
// at all, and there is no way to prove that a script doesn't `exec`
// elsewhere without a positively recognized grammar to check it against.
function hasRecognizedPosixNpmShimShape(lines) {
  const ifLine = lines.find((line) => POSIX_SHIM_IF_EXEC_LINE.test(line));
  const elseLine = lines.find((line) => POSIX_SHIM_ELSE_EXEC_LINE.test(line));
  if (!ifLine || !elseLine) return null;
  const ifMatch = POSIX_SHIM_IF_EXEC_LINE.exec(ifLine);
  const elseMatch = POSIX_SHIM_ELSE_EXEC_LINE.exec(elseLine);
  if (ifMatch[1] !== elseMatch[1]) return null;
  if (POSIX_SHIM_REQUIRED_LINES.some((pattern) => !lines.some((line) => pattern.test(line)))) {
    return null;
  }
  const allowed = [
    ...POSIX_SHIM_REQUIRED_LINES,
    POSIX_SHIM_IF_EXEC_LINE,
    POSIX_SHIM_ELSE_EXEC_LINE,
  ];
  if (!lines.every((line) => allowed.some((pattern) => pattern.test(line)))) return null;
  return { payloadReference: ifMatch[1] };
}

function resolvePosixExecutable(command, { env, realpathImpl }) {
  const value = String(command || "").trim();
  if (!value) return null;
  if (value.includes("/")) return canonicalPath(value, realpathImpl);
  const pathValue = String(env?.PATH || "");
  for (const directory of pathValue
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const resolved = canonicalPath(posix.join(directory, value), realpathImpl);
    if (resolved) return resolved;
  }
  return null;
}

function resolvePosixShimInterpreter({ wrapperDirectory, env, realpathImpl }) {
  const localNode = canonicalPath(posix.join(wrapperDirectory, "node"), realpathImpl);
  if (localNode) return localNode;
  return resolvePosixExecutable("node", { env, realpathImpl });
}

// POSIX global and local npm layouts both put the shim's own directory one
// level below the tree the payload actually lives under — a global install's
// bin dir sits next to `lib/node_modules`, and a local install's
// `node_modules/.bin` sits directly inside `node_modules` — so allowing any
// resolution that stays at or under the wrapper directory's PARENT covers
// both without the Windows resolver's separate `.bin`-vs-not branch (whose
// global layout differs: node_modules sits directly inside the shim's own
// directory there, not one level up).
function resolvePosixShimPayload(reference, wrapperDirectory, realpathImpl) {
  const relativePayload = String(reference).replace(/^\$basedir\/?/, "");
  if (!relativePayload || posix.isAbsolute(relativePayload)) return null;
  const candidate = posix.resolve(wrapperDirectory, relativePayload);
  const allowedRoot = posix.dirname(wrapperDirectory);
  const remainder = posix.relative(allowedRoot, candidate);
  if (remainder === ".." || remainder.startsWith(`..${posix.sep}`) || posix.isAbsolute(remainder)) {
    return null;
  }
  return canonicalPath(candidate, realpathImpl);
}

function posixRuntimeIdentityFiles(wrapper, { env, readFileImpl, realpathImpl }) {
  const fallback = [{ role: "executable", path: wrapper }];
  const shebangLine = readPosixShebangLine(wrapper);
  if (!shebangLine) return fallback;
  const shebangMatch = POSIX_SHEBANG_PATTERN.exec(shebangLine);
  if (!shebangMatch) return fallback;
  const [, interpreterPath, envArg] = shebangMatch;
  const interpreterName = posix.basename(interpreterPath).toLowerCase();
  const shellName =
    interpreterName === "env" && envArg ? String(envArg).toLowerCase() : interpreterName;
  if (!POSIX_SHELL_INTERPRETER_NAMES.has(shellName)) return fallback;

  let content;
  try {
    const bytes = readFileImpl(wrapper);
    if (bytes.length > MAX_POSIX_SHIM_BYTES || String(bytes).includes("\0")) return fallback;
    content = String(bytes);
  } catch {
    return fallback;
  }

  const lines = content
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
  const recognized = hasRecognizedPosixNpmShimShape(lines);
  if (!recognized) return fallback;

  // From here the wrapper is a confirmed, recognized delegator whose own
  // bytes never change even when the payload underneath it does. Every
  // remaining resolution failure fails closed (null) rather than falling
  // back to the wrapper's own bytes: we now know self-hashing the wrapper
  // alone would miss exactly the swap this shape exists to make possible.
  const launcher =
    interpreterName === "env"
      ? resolvePosixExecutable(shellName, { env, realpathImpl })
      : canonicalPath(interpreterPath, realpathImpl);
  const wrapperDirectory = posix.dirname(wrapper);
  const interpreter = resolvePosixShimInterpreter({ wrapperDirectory, env, realpathImpl });
  const payload = resolvePosixShimPayload(
    recognized.payloadReference,
    wrapperDirectory,
    realpathImpl
  );
  if (!launcher || !interpreter || !payload) return null;

  return [
    { role: "launcher", path: launcher },
    { role: "wrapper", path: wrapper },
    { role: "interpreter", path: interpreter },
    { role: "payload", path: payload },
  ];
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
  if (platform !== "win32") {
    return posixRuntimeIdentityFiles(wrapper, { env, readFileImpl, realpathImpl });
  }
  if (!WINDOWS_BATCH_EXTENSION.test(commandText)) {
    return [{ role: "executable", path: wrapper }];
  }
  if (!WINDOWS_NPM_SHIM.test(commandText)) return null;

  const launcher = resolveWindowsCommandInterpreter({ env, realpathImpl });
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
//
// Bounded by timeoutMs (killProcessTreeByPid's own default, 2000ms): a
// blocked or hung taskkill.exe must not leave the caller waiting on this
// spawnSync forever. spawnSync's own timeout handling kills taskkill with
// SIGKILL and reports that via `result.signal`, never `result.error` or a
// normal exit status, so that has to be checked here too or a timed-out
// taskkill would read as a silent success.
function taskkillProcessTree(
  pid,
  { env = process.env, spawnSyncImpl = spawnSync, timeoutMs } = {}
) {
  const systemRoot = String(env.SystemRoot || env.SYSTEMROOT || env.WINDIR || "C:\\Windows");
  const command = win32.join(systemRoot, "System32", "taskkill.exe");
  const result = spawnSyncImpl(command, ["/pid", String(pid), "/t", "/f"], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
    ...(Number.isFinite(timeoutMs) ? { timeout: timeoutMs, killSignal: "SIGKILL" } : {}),
  });
  if (
    result?.error ||
    result?.signal ||
    (Number.isInteger(result?.status) && result.status !== 0)
  ) {
    throw (
      result?.error ||
      new Error(
        result?.signal
          ? `taskkill timed out and was killed by ${result.signal}`
          : `taskkill exited with status ${result.status}`
      )
    );
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
// Windows. Best-effort: the pid may already be gone by the time this runs,
// and that's a success case too. Returns whether the kill attempt itself
// reported success (taskkill exited 0 on Windows, either SIGKILL landed on
// POSIX) so callers who need a fallback (runProbe's helper, when taskkill is
// blocked or unavailable and descendants may have survived) know to run one
// instead of the failure being swallowed silently.
//
// timeoutMs bounds the Windows taskkill spawnSync call itself — the POSIX
// path below never spawns anything, so it has nothing to bound. A blocked or
// hung taskkill.exe must not leave this call, and runProbe's cleanup
// deadline waiting on it, hanging indefinitely; a timed-out kill counts as a
// failed one, same as any other taskkill error.
export function killProcessTreeByPid(
  pid,
  {
    platform = process.platform,
    env = process.env,
    spawnSyncImpl = spawnSync,
    timeoutMs = 2000,
  } = {}
) {
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid <= 0) return false;
  if (platform === "win32") {
    try {
      taskkillProcessTree(numericPid, { env, spawnSyncImpl, timeoutMs });
      return true;
    } catch {
      // The process tree may have already exited on its own, or taskkill
      // was blocked/unavailable — either way, the caller can't tell which
      // from here, so it's reported as a failed attempt.
      return false;
    }
  }
  try {
    process.kill(-numericPid, "SIGKILL");
    return true;
  } catch {
    try {
      process.kill(numericPid, "SIGKILL");
      return true;
    } catch {
      // Already gone.
      return false;
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
