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
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("Windows installer verification must run on Windows.");
}

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(desktopRoot, "..", "..");
const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const distDir = join(desktopRoot, "dist");
const expectedName = `CareerRat-${desktopPackage.version}-win-x64-Setup.exe`;
const installerPath = join(distDir, expectedName);

if (!existsSync(installerPath)) {
  throw new Error(`Windows installer is missing: ${installerPath}`);
}

// installed-runtimes.mjs resolves runtime-probe-helper.mjs relative to its
// own module URL (`new URL("./runtime-probe-helper.mjs", import.meta.url)`),
// which means the helper only has to sit next to it wherever that file
// lands. electron-builder's `extraResources` (electron-builder.yml) copies
// the whole staged engine tree -- source included -- straight into
// resources/careerrat unpacked, the same tree every other per-child helper
// in this repo (runtime-process.mjs's taskkill spawn, update-core.mjs's
// installer relaunch) already relies on being real files on disk rather
// than asar entries. No asarUnpack rule is needed because extraResources
// never goes through app.asar in the first place; this check exists so a
// staging/electron-builder regression that broke that assumption (a moved
// file, a filter that dropped it) fails the Windows gate instead of only
// surfacing the first time a real user's Doctor probe silently comes back
// unverified. The relative path is derived from the real repo layout
// (rather than hardcoded) so it moves if installed-runtimes.mjs ever does.
const runtimeProbeHelperSource = join(repoRoot, "src", "core", "ai", "runtime-probe-helper.mjs");
if (!existsSync(runtimeProbeHelperSource)) {
  throw new Error(`runtime-probe-helper.mjs source is missing: ${runtimeProbeHelperSource}`);
}
const runtimeProbeHelperRelativePath = relative(repoRoot, runtimeProbeHelperSource);

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

  // Doctor and every installed-runtime caller need runtime-probe-helper.mjs
  // sitting next to the packaged installed-runtimes.mjs to run the Windows
  // `--version` probe at all -- a missing or misplaced helper leaves every
  // installed Windows runtime reporting unverified with no other packaged
  // signal catching it (see the comment above runtimeProbeHelperRelativePath).
  const packagedHelperPath = join(
    installDir,
    "resources",
    "careerrat",
    runtimeProbeHelperRelativePath
  );
  if (!existsSync(packagedHelperPath)) {
    throw new Error(
      `packaged app is missing runtime-probe-helper.mjs at the path installed-runtimes.mjs resolves: ${packagedHelperPath}`
    );
  }

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
