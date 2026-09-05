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
import {
  CLEANUP_DEADLINE_MS,
  KILL_TIMEOUT_MS,
} from "../../../src/core/ai/runtime-probe-constants.mjs";

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

  // The existence check above only proves the helper shipped; it doesn't
  // prove CareerRat.exe can actually run it. installed-runtimes.mjs's win32
  // probe path spawns process.execPath (CareerRat.exe here, not a Node
  // binary) with ELECTRON_RUN_AS_NODE=1 so it runs runtime-probe-helper.mjs
  // as a script instead of launching another Electron GUI instance -- and
  // the helper itself strips that same variable back out of the env before
  // it spawns the runtime it's probing (see runtime-probe-helper.mjs). Drive
  // the packaged helper through the real installed exe with a benign `cmd
  // /c echo %ELECTRON_RUN_AS_NODE%` probe and prove both halves end to end:
  // getting the packaged ESM helper running as Node at all, and the runtime
  // child it spawns never inheriting the flag. If the strip regressed, cmd
  // would resolve %ELECTRON_RUN_AS_NODE% to "1" instead of echoing the
  // unresolved literal back.
  const probeTimeoutMs = 5_000;
  const probeResult = spawnSync(
    appPath,
    [packagedHelperPath, "cmd", "/c", "echo %ELECTRON_RUN_AS_NODE%", "--timeout-ms", String(probeTimeoutMs)],
    {
      encoding: "utf8",
      env: { ...process.env, CAREERRAT_HOME: dataDir, ELECTRON_RUN_AS_NODE: "1" },
      // Mirrors installed-runtimes.mjs's own derived backstop: the helper's
      // worst case is the probe timeout plus a first tree-kill bound, plus
      // the cleanup closure wait, plus a retry tree-kill bound, plus margin
      // for the helper process's own startup and reporting. The benign echo
      // here should return almost instantly, but this has to be at least as
      // generous as the real caller or a slow CI host could trip it first.
      timeout: probeTimeoutMs + KILL_TIMEOUT_MS + CLEANUP_DEADLINE_MS + KILL_TIMEOUT_MS + 5_000,
      windowsHide: true,
    }
  );
  if (probeResult.error || probeResult.status !== 0) {
    throw new Error(
      `packaged runtime-probe-helper.mjs smoke failed${
        probeResult.error ? `: ${probeResult.error.message}` : ` with status ${probeResult.status}`
      }\nstdout: ${probeResult.stdout || ""}\nstderr: ${probeResult.stderr || ""}`
    );
  }
  let probeReported;
  try {
    probeReported = JSON.parse(probeResult.stdout);
  } catch (cause) {
    throw new Error(
      `packaged runtime-probe-helper.mjs did not report its JSON protocol: ${probeResult.stdout}`,
      { cause }
    );
  }
  if (probeReported.timedOut || probeReported.status !== 0) {
    throw new Error(
      `packaged runtime-probe-helper.mjs's probed command did not exit cleanly: ${JSON.stringify(probeReported)}`
    );
  }
  if (probeReported.stdout.trim() !== "%ELECTRON_RUN_AS_NODE%") {
    throw new Error(
      "packaged runtime-probe-helper.mjs must strip ELECTRON_RUN_AS_NODE from the runtime child's " +
        `env before spawning it; expected the unresolved literal %ELECTRON_RUN_AS_NODE%, got: ` +
        `${JSON.stringify(probeReported.stdout)}`
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
