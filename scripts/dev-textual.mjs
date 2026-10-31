#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const python = process.env.CAREERRAT_TUI_PYTHON || "python3";
const check = spawnSync(
  python,
  ["-c", 'from importlib.metadata import version; assert version("textual") == "8.2.8"'],
  { stdio: "ignore" }
);
if (check.status !== 0) {
  console.error(
    "Textual development entry requires Python with textual==8.2.8. Set CAREERRAT_TUI_PYTHON to that interpreter. Managed installation is still pending."
  );
  process.exitCode = 1;
} else {
  const child = spawn(
    python,
    [
      fileURLToPath(new URL("../src/core/tui/textual-app.py", import.meta.url)),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", env: { ...process.env, CAREERRAT_NODE: process.execPath } }
  );
  const stop = (signal) => child.kill(signal);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
    process.exitCode = code ?? 1;
  });
}
