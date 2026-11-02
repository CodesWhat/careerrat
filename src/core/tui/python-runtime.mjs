import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { userPath } from "../paths/workspace.mjs";

const execute = promisify(execFile);

export async function ensureTextualPython({
  repoRoot,
  env = process.env,
  platform = process.platform,
  run = execute,
  progress = () => {},
} = {}) {
  const requirements = join(repoRoot, "src/core/tui/requirements.txt");
  const digest = createHash("sha256").update(readFileSync(requirements)).digest("hex");
  const base = userPath({ repoRoot, env }, ".internal/tui");
  const directory = join(base, `python-${digest.slice(0, 16)}`);
  const python = join(directory, platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const ready = join(directory, ".ready.json");
  if (existsSync(python) && existsSync(ready)) {
    try {
      if (JSON.parse(readFileSync(ready, "utf8")).digest === digest) return python;
    } catch {
      /* An incomplete receipt is rebuilt under the setup lock. */
    }
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
    const bootstrap = env.CAREERRAT_TUI_PYTHON || (platform === "win32" ? "python" : "python3");
    progress("Checking Python 3.11 or newer…");
    await run(
      bootstrap,
      ["-c", 'import sys; assert sys.version_info >= (3,11), "Python 3.11 or newer is required"'],
      options
    );
    rmSync(directory, { recursive: true, force: true });
    progress("Creating a private Textual environment…");
    await run(bootstrap, ["-m", "venv", directory], options);
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
