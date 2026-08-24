#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { npmInvocation } from "./npm-invocation.mjs";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(desktopRoot, "../..");
const require = createRequire(import.meta.url);
const builderCli = require.resolve("electron-builder/cli.js");
const appBuild = npmInvocation(["--prefix", repoRoot, "run", "app:build"]);

execFileSync(appBuild.file, appBuild.args, {
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
