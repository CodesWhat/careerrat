import { chmodSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_NAME = "CareerRat";
const DEV_BUNDLE_IDENTIFIER = "com.codeswhat.careerrat.dev";
const ELECTRON_EXECUTABLE = "Electron";
const APP_EXECUTABLE = "CareerRat";

export function buildInfoPlistBrandCommands({
  appName = APP_NAME,
  bundleIdentifier = DEV_BUNDLE_IDENTIFIER,
  executableName = APP_EXECUTABLE,
  iconFile = "electron.icns",
} = {}) {
  return [
    ["Set", "CFBundleName", appName],
    ["Set", "CFBundleDisplayName", appName],
    ["Set", "CFBundleExecutable", executableName],
    ["Set", "CFBundleIdentifier", bundleIdentifier],
    ["Set", "CFBundleIconFile", iconFile],
  ];
}

function resolveDevBrandingPaths({ desktopDir = defaultDesktopDir() } = {}) {
  const repoRoot = join(desktopDir, "../..");
  const electronApp = join(repoRoot, "node_modules/electron/dist/Electron.app");
  const macOsDir = join(electronApp, "Contents/MacOS");
  return {
    electronApp,
    plist: join(electronApp, "Contents/Info.plist"),
    sourceExecutable: join(macOsDir, ELECTRON_EXECUTABLE),
    targetExecutable: join(macOsDir, APP_EXECUTABLE),
    electronPathFile: join(repoRoot, "node_modules/electron/path.txt"),
    electronPathEntry: `Electron.app/Contents/MacOS/${APP_EXECUTABLE}`,
    sourceIcon: join(desktopDir, "build/icon.icns"),
    targetIcon: join(electronApp, "Contents/Resources/electron.icns"),
  };
}

export function brandElectronDevApp({
  platform = process.platform,
  desktopDir = defaultDesktopDir(),
  exists = existsSync,
  copy = copyFileSync,
  chmod = chmodSync,
  write = writeFileSync,
  run = spawnSync,
} = {}) {
  if (platform !== "darwin") return { branded: false, reason: "not-darwin" };

  const paths = resolveDevBrandingPaths({ desktopDir });
  if (!exists(paths.plist)) return { branded: false, reason: "missing-electron-app" };

  for (const command of buildInfoPlistBrandCommands()) {
    runPlistBuddy({ run, plist: paths.plist, command });
  }

  if (exists(paths.sourceExecutable)) {
    copy(paths.sourceExecutable, paths.targetExecutable);
    chmod(paths.targetExecutable, 0o755);
    write(paths.electronPathFile, paths.electronPathEntry);
  }

  if (exists(paths.sourceIcon)) {
    copy(paths.sourceIcon, paths.targetIcon);
  }

  run("/usr/bin/touch", [paths.electronApp], { stdio: "ignore" });
  return { branded: true, paths };
}

function runPlistBuddy({ run, plist, command }) {
  const [operation, key, value] = command;
  const setResult = run("/usr/libexec/PlistBuddy", ["-c", `${operation} :${key} ${value}`, plist], {
    stdio: "ignore",
  });
  if (setResult.status === 0) return;

  run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist], {
    stdio: "ignore",
  });
}

function defaultDesktopDir() {
  return fileURLToPath(new URL(".", import.meta.url));
}
