#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMountedReleaseDmg } from "../mounted-release-acceptance.mjs";
import { canonicalMacDmgName, selectMacReleaseArtifacts } from "../release-artifacts.mjs";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  if (process.platform !== "darwin") throw new Error("Mounted DMG verification requires macOS.");
  const version = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")).version;
  const distDir = join(desktopRoot, "dist");
  selectMacReleaseArtifacts({ names: readdirSync(distDir), version });
  const result = await verifyMountedReleaseDmg({
    dmgPath: join(distDir, canonicalMacDmgName(version)),
    expectedVersion: version,
  });
  process.stdout.write(`MOUNTED RELEASE SMOKE OK ${result.appPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
