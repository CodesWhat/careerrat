#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findInstalledExecutable,
  installedRuntimeExecutionIdentity,
  runtimeExecutionChainDigests,
} from "../../../src/core/ai/installed-runtimes.mjs";
import {
  CLEANUP_DEADLINE_MS,
  KILL_TIMEOUT_MS,
} from "../../../src/core/ai/runtime-probe-constants.mjs";
import { writeInstalledRuntimeSelection } from "../../../src/core/ai/runtime-selection.mjs";

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

// Same shape of check for doctor.mjs (CR44 packaged Doctor smoke, below):
// it ships the same way runtime-probe-helper.mjs does -- staged as a real
// file under extraResources, not through app.asar -- so it only needs to
// sit at the path installed-runtime-route.mjs's callers already resolve it
// at (src/core/tracker/agent-guidance-snapshot.mjs's `join(root,
// "src/cli/doctor.mjs")`).
const doctorScriptSource = join(repoRoot, "src", "cli", "doctor.mjs");
if (!existsSync(doctorScriptSource)) {
  throw new Error(`doctor.mjs source is missing: ${doctorScriptSource}`);
}
const doctorScriptRelativePath = relative(repoRoot, doctorScriptSource);

// CR44 fixture constants -----------------------------------------------------
// A supported runtime id (INSTALLED_RUNTIME_DEFINITIONS) is required so
// findInstalledExecutable's `codex`/`codex.cmd` search actually matches the
// fixture launcher below; "codex" carries no version-boundary minimum, which
// keeps the "verifies cleanly" assertion below from also depending on that
// separate check.
const DOCTOR_FIXTURE_RUNTIME_ID = "codex";
const DOCTOR_FIXTURE_BASELINE_VERSION = "9.9.9";
const DOCTOR_FIXTURE_SWAPPED_VERSION = "1.1.1";
// installedRuntimeExecutionIdentity's own win32 --version probe budget
// (probeTimeoutMs + two tree-kill bounds + the cleanup wait + its own
// startup/reporting margin -- see installed-runtimes.mjs) plus extra slack
// for doctor.mjs's other checks (plugin verification, template-leftover
// scanning, etc.), all of which are local filesystem reads.
const DOCTOR_SMOKE_PROBE_TIMEOUT_MS =
  10_000 + KILL_TIMEOUT_MS + CLEANUP_DEADLINE_MS + KILL_TIMEOUT_MS + 15_000;

// Byte-for-byte the same npm cmd-shim shape as
// tests/installed-runtime.test.mjs's "[win32] installedRuntimeExecutionIdentity
// verifies a real npm-shim .cmd end to end with no spawn injection" fixture,
// renamed to a real INSTALLED_RUNTIME_DEFINITIONS id (codex) instead of the
// unit test's synthetic "myshim". No "&" in the fixture root on purpose: this
// is byte-for-byte what npm's cmd-shim writes, and its unquoted
// `SET dp0=%~dp0` makes cmd.exe split the value at an ampersand.
function buildDoctorFixtureLauncher(root) {
  if (root.includes("&")) {
    throw new Error(`doctor smoke fixture root must not contain "&": ${root}`);
  }
  const npmDir = join(root, "npm");
  const payloadDir = join(npmDir, "node_modules", DOCTOR_FIXTURE_RUNTIME_ID, "bin");
  mkdirSync(payloadDir, { recursive: true });
  copyFileSync(process.execPath, join(npmDir, "node.exe"));
  writeFileSync(
    join(npmDir, `${DOCTOR_FIXTURE_RUNTIME_ID}.cmd`),
    [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      ")",
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%" "%dp0%\\node_modules\\${DOCTOR_FIXTURE_RUNTIME_ID}\\bin\\${DOCTOR_FIXTURE_RUNTIME_ID}.js" %*`,
    ].join("\r\n"),
    "utf8"
  );
  return { npmDir, payloadPath: join(payloadDir, `${DOCTOR_FIXTURE_RUNTIME_ID}.js`) };
}

// findInstalledExecutable appends whatever extension PATHEXT lists (typically
// ".CMD", uppercase) rather than the literal lowercase ".cmd" the file was
// written with above -- Windows resolves the two identically on disk, but
// doctor.mjs's own cache matcher compares detectInstalledRuntimes' raw `path`
// string byte-for-byte against the cached one (installedRuntimeVerificationCurrent),
// so the cache has to be seeded against this exact resolved string, not the
// one buildDoctorFixtureLauncher happened to write the file at, or a PATHEXT
// casing difference alone would make a freshly-seeded, untouched cache read
// as already stale.
function resolveDoctorFixtureWrapperPath(npmDir) {
  const wrapperPath = findInstalledExecutable([DOCTOR_FIXTURE_RUNTIME_ID], {
    env: { ...process.env, CAREERRAT_RUNTIME_SEARCH_DIRS: npmDir },
    platform: "win32",
  });
  if (!wrapperPath) {
    throw new Error(`doctor smoke fixture: findInstalledExecutable did not resolve the launcher under ${npmDir}`);
  }
  return wrapperPath;
}

// The fixture's payload: proves it ran (writes `markerPath`) and reports a
// parseable version (installed-runtimes.mjs's parseVersion wants \d+.\d+.\d+
// somewhere in stdout).
function writeDoctorFixturePayload(payloadPath, { version, markerPath }) {
  writeFileSync(
    payloadPath,
    [
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, String(process.pid));`,
      `console.log(${JSON.stringify(`${DOCTOR_FIXTURE_RUNTIME_ID}-fixture ${version}`)});`,
      "",
    ].join("\n"),
    "utf8"
  );
}

// Seeds .internal/ai-runtime.json under `dataDir` with a genuine, uninjected
// identity read of the fixture launcher (the same production path Doctor and
// the AI router both verify against after a real pass), including the
// per-file chain breakdown a later mismatch gets attributed against
// (installedRuntimeExecutionMismatchRole). Mirrors
// tests/doctor-installed-runtimes.test.mjs's POSIX-shim cache-seeding step.
function seedDoctorRuntimeCache({ dataDir, wrapperPath, version }) {
  const identity = installedRuntimeExecutionIdentity({ path: wrapperPath }, { platform: "win32" });
  if (!identity) {
    throw new Error(
      "doctor smoke fixture: failed to establish a baseline identity for the npm-shim launcher"
    );
  }
  if (identity.version !== version) {
    throw new Error(
      `doctor smoke fixture: expected baseline version ${version}, got ${identity.version}`
    );
  }
  const chainFiles = runtimeExecutionChainDigests(wrapperPath, { platform: "win32" });
  if (!chainFiles) {
    throw new Error("doctor smoke fixture: failed to resolve the npm-shim launcher chain");
  }
  writeInstalledRuntimeSelection({
    repoRoot: dataDir,
    env: { CAREERRAT_HOME: dataDir },
    runtimeId: DOCTOR_FIXTURE_RUNTIME_ID,
    verification: {
      ...identity,
      chainFiles,
      capabilities: {},
      versionBoundaryState: "at_or_above",
      testedMinimumVersion: null,
      checkedAt: new Date().toISOString(),
    },
  });
}

// Drives `careerrat doctor` through the real installed CareerRat.exe, the
// same ELECTRON_RUN_AS_NODE=1 technique src/core/tracker/agent-guidance-snapshot.mjs
// already uses in production to run doctor.mjs's --guidance-only path from
// inside the packaged app's own tracker server -- this just also exercises
// the full (non guidance-only) path that file never requests.
// CAREERRAT_RUNTIME_SEARCH_DIRS overrides installed-runtimes.mjs's own
// detection directories so the fixture launcher is the only thing detection
// can find, isolated from whatever the runner otherwise has on PATH.
function runPackagedDoctor({ appPath, packagedEngineRoot, dataDir, searchDir, guidanceOnly }) {
  const args = [
    join(packagedEngineRoot, doctorScriptRelativePath),
    "--json",
    ...(guidanceOnly ? ["--guidance-only"] : []),
  ];
  const result = spawnSync(appPath, args, {
    cwd: packagedEngineRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CAREERRAT_HOME: dataDir,
      CAREERRAT_RUNTIME_SEARCH_DIRS: searchDir,
      ELECTRON_RUN_AS_NODE: "1",
    },
    timeout: DOCTOR_SMOKE_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || typeof result.stdout !== "string" || !result.stdout.trim()) {
    throw new Error(
      `packaged doctor invocation failed${result.error ? `: ${result.error.message}` : ""}\n` +
        `status: ${result.status}\nstdout: ${result.stdout || ""}\nstderr: ${result.stderr || ""}`
    );
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error(`packaged doctor did not report JSON: ${result.stdout}`, { cause });
  }
  return { status: result.status, data };
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

  // CR44: drive `careerrat doctor` through the real installed CareerRat.exe
  // against a genuine npm-shim .cmd launcher, then prove Doctor refuses a
  // stale cache once the launcher's payload is swapped out from underneath
  // it -- the same CR42 regression tests/doctor-installed-runtimes.test.mjs
  // and tests/installed-runtime.test.mjs already cover as unit tests, but
  // never before driven through the packaged app itself.
  const packagedEngineRoot = join(installDir, "resources", "careerrat");
  const packagedDoctorScriptPath = join(packagedEngineRoot, doctorScriptRelativePath);
  if (!existsSync(packagedDoctorScriptPath)) {
    throw new Error(
      `packaged app is missing doctor.mjs at the path this smoke resolves: ${packagedDoctorScriptPath}`
    );
  }

  const doctorFixtureRoot = join(scratch, "doctor-fixture");
  const doctorDataDir = join(scratch, "doctor-data");
  const { npmDir, payloadPath } = buildDoctorFixtureLauncher(doctorFixtureRoot);
  const wrapperPath = resolveDoctorFixtureWrapperPath(npmDir);
  const markerPath = join(doctorFixtureRoot, "payload-ran.marker");
  const swappedMarkerPath = join(doctorFixtureRoot, "swapped-payload-ran.marker");

  writeDoctorFixturePayload(payloadPath, {
    version: DOCTOR_FIXTURE_BASELINE_VERSION,
    markerPath,
  });
  seedDoctorRuntimeCache({
    dataDir: doctorDataDir,
    wrapperPath,
    version: DOCTOR_FIXTURE_BASELINE_VERSION,
  });
  // Seeding the cache above already ran the payload once (to read its live
  // version); reset before the assertion below so it only proves what the
  // packaged Doctor run itself did.
  rmSync(markerPath, { force: true });

  const verified = runPackagedDoctor({
    appPath,
    packagedEngineRoot,
    dataDir: doctorDataDir,
    searchDir: npmDir,
    guidanceOnly: false,
  });
  const verifiedRuntime = verified.data.installedRuntimes?.find(
    (r) => r.id === DOCTOR_FIXTURE_RUNTIME_ID
  );
  if (!verifiedRuntime) {
    throw new Error(
      `packaged doctor did not report the ${DOCTOR_FIXTURE_RUNTIME_ID} fixture as detected: ${JSON.stringify(verified.data.installedRuntimes)}`
    );
  }
  if (
    verifiedRuntime.version !== DOCTOR_FIXTURE_BASELINE_VERSION ||
    verifiedRuntime.boundaryProbePassed !== true ||
    verifiedRuntime.unverifiedReason
  ) {
    throw new Error(
      `packaged doctor did not verify the npm-shim fixture cleanly: ${JSON.stringify(verifiedRuntime)}`
    );
  }
  if (!existsSync(markerPath)) {
    throw new Error("packaged doctor never ran the fixture payload while verifying it");
  }

  rmSync(markerPath, { force: true });
  // Swap the payload behind the unchanged launcher .cmd -- the launcher's
  // own bytes never move, only what it delegates to underneath it.
  writeDoctorFixturePayload(payloadPath, {
    version: DOCTOR_FIXTURE_SWAPPED_VERSION,
    markerPath: swappedMarkerPath,
  });

  const mismatched = runPackagedDoctor({
    appPath,
    packagedEngineRoot,
    dataDir: doctorDataDir,
    searchDir: npmDir,
    guidanceOnly: false,
  });
  const mismatchedRuntime = mismatched.data.installedRuntimes?.find(
    (r) => r.id === DOCTOR_FIXTURE_RUNTIME_ID
  );
  if (!mismatchedRuntime) {
    throw new Error(
      `packaged doctor did not report the ${DOCTOR_FIXTURE_RUNTIME_ID} fixture after the payload swap: ${JSON.stringify(mismatched.data.installedRuntimes)}`
    );
  }
  if (
    mismatchedRuntime.unverifiedReason !==
    "The payload changed since CareerRat last verified this CLI."
  ) {
    throw new Error(
      `packaged doctor did not name the payload as the mismatched launcher-chain role: ${JSON.stringify(mismatchedRuntime)}`
    );
  }
  if (mismatchedRuntime.boundaryProbePassed !== false || mismatchedRuntime.version) {
    throw new Error(`packaged doctor kept trusting the stale cache: ${JSON.stringify(mismatchedRuntime)}`);
  }
  // Belt-and-suspenders: `result.ok` also depends on this scratch install
  // having no candidate/ scaffold at all, so a nonzero exit here doesn't by
  // itself prove the runtime mismatch was the cause -- unverifiedReason
  // above is the load-bearing assertion. A clean exit 0 would still be a
  // real regression (result.ok can never be true while any runtime is
  // unverified), so this stays a hard failure.
  if (mismatched.status === 0) {
    throw new Error("packaged doctor exited 0 with a refused runtime cached");
  }
  if (existsSync(markerPath) || existsSync(swappedMarkerPath)) {
    throw new Error("packaged doctor executed the swapped payload instead of refusing it");
  }

  const guidanceOnly = runPackagedDoctor({
    appPath,
    packagedEngineRoot,
    dataDir: doctorDataDir,
    searchDir: npmDir,
    guidanceOnly: true,
  });
  if (
    !Array.isArray(guidanceOnly.data.installedRuntimes) ||
    guidanceOnly.data.installedRuntimes.length !== 0
  ) {
    throw new Error(
      `packaged doctor --guidance-only must skip runtime detection entirely: ${JSON.stringify(guidanceOnly.data.installedRuntimes)}`
    );
  }
  if (existsSync(markerPath) || existsSync(swappedMarkerPath)) {
    throw new Error("packaged doctor --guidance-only executed a payload it must never spawn");
  }

  const uninstallerName = readdirSync(installDir).find((name) => /^Uninstall .*\.exe$/i.test(name));
  if (!uninstallerName) throw new Error("the NSIS package installed no uninstaller");
  run(join(installDir, uninstallerName), ["/S", `_?=${installDir}`], "silent uninstall");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(`WINDOWS SMOKE OK ${expectedName}\n`);
