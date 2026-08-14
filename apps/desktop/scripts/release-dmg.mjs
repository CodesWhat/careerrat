import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDeveloperIdAuthority, releaseDmgContainer } from "../dmg-release.mjs";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const appPath = join(desktopRoot, "dist", "mac-arm64", "CareerRat.app");
const dmgPath = join(desktopRoot, "dist", `CareerRat-${pkg.version}-arm64.dmg`);

for (const artifactPath of [appPath, dmgPath]) {
  if (!existsSync(artifactPath)) throw new Error(`Desktop release artifact is missing: ${artifactPath}`);
}

const inspection = spawnSync("codesign", ["-dv", "--verbose=4", appPath], {
  encoding: "utf8",
});
if (inspection.status !== 0) throw new Error("Unable to read the packaged app signing identity.");

const signingIdentity = parseDeveloperIdAuthority(
  `${inspection.stdout || ""}\n${inspection.stderr || ""}`
);

releaseDmgContainer({
  dmgPath,
  signingIdentity,
  env: process.env,
  run(command, args) {
    return spawnSync(command, args, { stdio: "inherit" });
  },
});

console.log("Desktop DMG signed, notarized, and stapled.");
