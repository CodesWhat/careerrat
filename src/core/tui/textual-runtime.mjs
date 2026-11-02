import { spawn } from "node:child_process";
import { join } from "node:path";
import { ensureTextualPython } from "./python-runtime.mjs";

export async function runTextualWorkspace({ repoRoot, env = process.env, args = [] } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Interactive TUI requires a terminal; use careerrat tui --json for saved jobs");
  const python = await ensureTextualPython({ repoRoot, env, progress: console.error });
  return new Promise((resolve, reject) => {
    const child = spawn(python, [join(repoRoot, "src/core/tui/textual-app.py"), ...args], {
      cwd: repoRoot,
      env: { ...env, CAREERRAT_NODE: process.execPath },
      stdio: "inherit",
    });
    const terminate = () => child.kill("SIGTERM");
    const hangup = () => child.kill("SIGHUP");
    function cleanup() {
      process.off("SIGTERM", terminate);
      process.off("SIGHUP", hangup);
    }
    process.on("SIGTERM", terminate);
    process.on("SIGHUP", hangup);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      resolve(code ?? 1);
    });
  });
}
