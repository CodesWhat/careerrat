import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { userPath } from "../paths/workspace.mjs";

const execute = promisify(execFile);

function textualEnvironment({ repoRoot, env, platform }) {
  const requirements = join(repoRoot, "src/core/tui/requirements.txt");
  const digest = createHash("sha256").update(readFileSync(requirements)).digest("hex");
  const base = userPath({ repoRoot, env }, ".internal/tui");
  const directory = join(base, `python-${digest.slice(0, 16)}`);
  const python =
    platform === "win32"
      ? join(directory, "Scripts", "python.exe")
      : join(directory, "bin", "python");
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

// Interpreters that might build the private environment, in order. An explicit
// CAREERRAT_TUI_PYTHON is the only choice when set. Windows puts the `py -3`
// launcher first (python.org installs it, and a bare `python` there is often
// the Microsoft Store stub); other platforms try python3, then python.
export function bootstrapPythonCandidates({ env = process.env, platform = process.platform } = {}) {
  if (env.CAREERRAT_TUI_PYTHON) return [{ command: env.CAREERRAT_TUI_PYTHON, args: [] }];
  if (platform === "win32")
    return [
      { command: "py", args: ["-3"] },
      { command: "python", args: [] },
      { command: "python3", args: [] },
    ];
  return [
    { command: "python3", args: [] },
    { command: "python", args: [] },
  ];
}

const PYTHON_VERSION_CHECK =
  'import sys; assert sys.version_info >= (3,11), "Python 3.11 or newer is required"';

// The first candidate that runs and is 3.11+. Reports the last failure if none do.
async function selectBootstrapPython({ candidates, run, options }) {
  let failure;
  for (const candidate of candidates) {
    try {
      await run(candidate.command, [...candidate.args, "-c", PYTHON_VERSION_CHECK], options);
      return candidate;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
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
  if (textualEnvironmentReady(found)) return python;
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
    progress("Checking Python 3.11 or newer…");
    const bootstrap = await selectBootstrapPython({
      candidates: bootstrapPythonCandidates({ env, platform }),
      run,
      options,
    });
    rmSync(directory, { recursive: true, force: true });
    progress("Creating a private Textual environment…");
    await run(bootstrap.command, [...bootstrap.args, "-m", "venv", directory], options);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    progress("Installing verified Textual dependencies…");
    await run(
      python,
      [
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
      ["-c", 'from importlib.metadata import version; assert version("textual") == "8.2.8"'],
      options
    );
    writeFileSync(ready, `${JSON.stringify({ digest, at: new Date().toISOString() })}\n`, {
      mode: 0o600,
    });
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
