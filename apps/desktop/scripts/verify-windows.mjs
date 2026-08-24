#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("Windows installer verification must run on Windows.");
}

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const distDir = join(desktopRoot, "dist");
const expectedName = `CareerRat-${desktopPackage.version}-win-x64-Setup.exe`;
const installerPath = join(distDir, expectedName);

if (!existsSync(installerPath)) {
  throw new Error(`Windows installer is missing: ${installerPath}`);
}

const scratch = mkdtempSync(join(tmpdir(), "careerrat-windows-package-"));
const installDir = join(scratch, "installed");
const dataDir = join(scratch, "data");

function run(command, args, label, timeout = 240_000) {
  const childEnv = { ...process.env, CAREERRAT_HOME: dataDir };
  delete childEnv.GH_TOKEN;
  delete childEnv.GITHUB_TOKEN;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: childEnv,
    timeout,
    windowsHide: true,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} failed${result.error ? `: ${result.error.message}` : ` with status ${result.status}`}` +
        `${output ? `\n${output}` : ""}`
    );
  }
  return output;
}

try {
  run(installerPath, ["/S", `/D=${installDir}`], "silent install");
  const appPath = join(installDir, "CareerRat.exe");
  if (!existsSync(appPath)) throw new Error(`installed app is missing: ${appPath}`);

  const smokeOutput = run(appPath, ["--smoke"], "installed app smoke");
  if (!/SMOKE OK\s+http:\/\/127\.0\.0\.1:\d+/.test(smokeOutput)) {
    throw new Error(`installed app smoke did not report success\n${smokeOutput}`);
  }

  const uninstallerName = readdirSync(installDir).find((name) => /^Uninstall .*\.exe$/i.test(name));
  if (!uninstallerName) throw new Error("the NSIS package installed no uninstaller");
  run(join(installDir, uninstallerName), ["/S", `_?=${installDir}`], "silent uninstall");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(`WINDOWS SMOKE OK ${expectedName}\n`);
