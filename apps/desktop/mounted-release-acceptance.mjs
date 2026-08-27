import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { verifyPackagedSmoke } from "./scripts/verify-packaged.mjs";

function checked(run, command, args, label) {
  const result = run(command, args, { encoding: "utf8" });
  if (result?.error || result?.status !== 0) {
    const output = `${result?.stdout || ""}\n${result?.stderr || ""}`.trim();
    throw new Error(`${label} failed${output ? `: ${output}` : "."}`);
  }
  return result;
}

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

export function parseDmgMountPoints(plist) {
  return [...String(plist || "").matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/g)].map(
    (match) => decodeXml(match[1])
  );
}

export async function verifyMountedReleaseDmg({
  dmgPath,
  expectedVersion,
  run = spawnSync,
  listDirectory = readdirSync,
  smoke = verifyPackagedSmoke,
  createDataDir = () => mkdtempSync(join(tmpdir(), "careerrat-mounted-smoke-")),
  removeDataDir = (path) => rmSync(path, { recursive: true, force: true }),
} = {}) {
  const expectedName = `CareerRat-${expectedVersion}-arm64.dmg`;
  if (basename(dmgPath || "") !== expectedName) {
    throw new Error(`Mounted release verification requires ${expectedName}.`);
  }
  const attach = checked(
    run,
    "hdiutil",
    ["attach", "-readonly", "-nobrowse", "-plist", dmgPath],
    "read-only DMG mount"
  );
  const mountPoints = parseDmgMountPoints(attach.stdout);
  let dataDir = null;
  try {
    if (mountPoints.length !== 1) {
      throw new Error(`Canonical DMG must mount exactly one volume, found ${mountPoints.length}.`);
    }
    const [mountPoint] = mountPoints;
    dataDir = createDataDir();
    const apps = listDirectory(mountPoint).filter((entry) => basename(entry) === "CareerRat.app");
    if (apps.length !== 1) {
      throw new Error(`Mounted DMG must contain exactly one CareerRat.app, found ${apps.length}.`);
    }
    const appPath = join(mountPoint, apps[0]);
    checked(run, "codesign", ["--verify", "--deep", "--strict", appPath], "app signature");
    checked(run, "spctl", ["--assess", "--type", "execute", "--verbose=2", appPath], "Gatekeeper");
    const version = checked(
      run,
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleShortVersionString", join(appPath, "Contents", "Info.plist")],
      "bundle version"
    ).stdout.trim();
    if (version !== expectedVersion) {
      throw new Error(`Mounted app reports version ${version || "unknown"}, expected ${expectedVersion}.`);
    }
    await smoke({ appPath, dataDir });
    return { appPath, mountPoint, version };
  } finally {
    if (dataDir) removeDataDir(dataDir);
    for (const mountPoint of mountPoints) {
      checked(run, "hdiutil", ["detach", mountPoint], "DMG detach");
    }
  }
}
