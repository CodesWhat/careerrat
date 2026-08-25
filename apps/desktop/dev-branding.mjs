import { chmodSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CAREERRAT_APP_NAME,
  CAREERRAT_DEV_APP_ID,
} from "./desktop-identity.mjs";

const ELECTRON_EXECUTABLE = "Electron";

export function buildInfoPlistBrandCommands({
  appName = CAREERRAT_APP_NAME,
  bundleIdentifier = CAREERRAT_DEV_APP_ID,
  executableName = CAREERRAT_APP_NAME,
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
    targetExecutable: join(macOsDir, CAREERRAT_APP_NAME),
    electronPathFile: join(repoRoot, "node_modules/electron/path.txt"),
    electronPathEntry: `Electron.app/Contents/MacOS/${CAREERRAT_APP_NAME}`,
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
