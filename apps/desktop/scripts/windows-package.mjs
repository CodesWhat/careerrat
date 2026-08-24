#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(desktopRoot, "../..");
const require = createRequire(import.meta.url);
const builderCli = require.resolve("electron-builder/cli.js");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

execFileSync(npmCommand, ["--prefix", repoRoot, "run", "app:build"], {
  cwd: repoRoot,
  stdio: "inherit",
});
execFileSync(process.execPath, [join(desktopRoot, "scripts", "stage.mjs")], {
  cwd: desktopRoot,
  env: { ...process.env, PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: "win64" },
  stdio: "inherit",
});
execFileSync(process.execPath, [builderCli, "--win", "nsis", "--x64", "--publish", "never"], {
  cwd: desktopRoot,
  stdio: "inherit",
});
