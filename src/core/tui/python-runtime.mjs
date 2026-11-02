import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { userPath } from "../paths/workspace.mjs";

const execute = promisify(execFile);

// Environments from earlier requirement sets are left alone for a week, so two
// checkouts on different versions don't rebuild each other's on every launch.
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// Remove private environments that no longer match the current requirements.
export function pruneTextualEnvironments({
  base,
  keep,
  now = Date.now(),
  olderThanMs = PRUNE_AFTER_MS,
} = {}) {
  const removed = [];
  let names = [];
  try {
    names = readdirSync(base);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!/^python-[0-9a-f]{16}$/.test(name)) continue;
    const path = join(base, name);
    if (path === keep) continue;
    try {
      if (now - statSync(path).mtimeMs < olderThanMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // In use or already gone: leave it for the next launch.
    }
  }
  return removed;
}

function textualEnvironment({ repoRoot, env, platform }) {
  const requirements = join(repoRoot, "src/core/tui/requirements.txt");
  const digest = createHash("sha256").update(readFileSync(requirements)).digest("hex");
  const base = userPath({ repoRoot, env }, ".internal/tui");
  const directory = join(base, `python-${digest.slice(0, 16)}`);
  const python = join(directory, platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const ready = join(directory, ".ready.json");
  return { requirements, digest, base, directory, python, ready };
}

function textualEnvironmentReady({ digest, python, ready }) {
  if (!existsSync(python) || !existsSync(ready)) return false;
  try {
    return JSON.parse(readFileSync(ready, "utf8")).digest === digest;
  } catch {
    return false;
  }
}

// Where the interface writes what it can't show on screen. It sits beside the
// private environments and is never part of the workspace data.
export function textualLogPath({ repoRoot, env = process.env } = {}) {
  return join(userPath({ repoRoot, env }, ".internal/tui"), "tui.log");
}

// Whether the private Textual environment is already built, without building
// it. The doctor uses this to say if `careerrat tui` can open right now.
export function textualPythonStatus({
  repoRoot,
  env = process.env,
  platform = process.platform,
} = {}) {
  const found = textualEnvironment({ repoRoot, env, platform });
  return { ready: textualEnvironmentReady(found), python: found.python };
}

export async function ensureTextualPython({
  repoRoot,
  env = process.env,
  platform = process.platform,
  run = execute,
  progress = () => {},
} = {}) {
  const found = textualEnvironment({ repoRoot, env, platform });
  const { requirements, digest, base, directory, python, ready } = found;
  // An incomplete receipt is rebuilt under the setup lock.
  if (textualEnvironmentReady(found)) {
    pruneTextualEnvironments({ base, keep: directory });
    return python;
  }
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const lock = join(base, "setup.lock");
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = Number(readFileSync(lock, "utf8"));
    if (!Number.isInteger(owner) || owner < 1)
      throw new Error("Textual setup is already running; retry when it finishes");
    try {
      process.kill(owner, 0);
      throw new Error("Textual setup is already running; retry when it finishes");
    } catch (probe) {
      if (probe.code !== "ESRCH") throw probe;
    }
    rmSync(lock);
    writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, abort);
  const options = { env, signal: controller.signal, timeout: 180000, maxBuffer: 2 * 1024 * 1024 };
  try {
    // The Windows launcher picks the newest Python 3; a bare `python` can be
    // the Store stub. -I keeps the user's PYTHON* variables and site packages
    // out of every interpreter we run.
    const bootstrap = env.CAREERRAT_TUI_PYTHON || (platform === "win32" ? "py" : "python3");
    const select = !env.CAREERRAT_TUI_PYTHON && platform === "win32" ? ["-3"] : [];
    progress("Checking Python 3.11 or newer…");
    await run(
      bootstrap,
      [
        ...select,
        "-I",
        "-c",
        'import sys; assert sys.version_info >= (3,11), "Python 3.11 or newer is required"',
      ],
      options
    );
    rmSync(directory, { recursive: true, force: true });
    progress("Creating a private Textual environment…");
    await run(bootstrap, [...select, "-I", "-m", "venv", directory], options);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    progress("Installing verified Textual dependencies…");
    await run(
      python,
      [
        "-I",
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--require-hashes",
        "--only-binary=:all:",
        "-r",
        requirements,
      ],
      options
    );
    await run(
      python,
      ["-I", "-c", 'from importlib.metadata import version; assert version("textual") == "8.2.8"'],
      options
    );
    writeFileSync(ready, `${JSON.stringify({ digest, at: new Date().toISOString() })}\n`, {
      mode: 0o600,
    });
    pruneTextualEnvironments({ base, keep: directory });
    return python;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(
      `Textual setup failed: ${error.message}. Python 3.11+ with venv is required; CAREERRAT_TUI_PYTHON can select an interpreter. Retry careerrat tui setup.`,
      { cause: error }
    );
  } finally {
    rmSync(lock, { force: true });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, abort);
  }
}
