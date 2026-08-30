import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyLiveSearchReceiptDirectory } from "../../../scripts/lib/live-search-receipts.mjs";
import {
  selectMacUpdateZip,
  verifyDesktopRelease,
  verifyMacUpdateFeed,
} from "../release-verification.mjs";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(desktopRoot, "..", "..");
const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const appPath = join(desktopRoot, "dist", "mac-arm64", `${pkg.build?.productName || "CareerRat"}.app`);
const dmgPath = join(desktopRoot, "dist", `CareerRat-${pkg.version}-arm64.dmg`);
const metadataPath = join(desktopRoot, "dist", "latest-mac.yml");
let zipPath = null;

try {
  const evidence = verifyLiveSearchReceiptDirectory({ repoRoot, releaseVersion: pkg.version });
  if (evidence.evidenceStatus === "version-scoped-exception") {
    console.log(
      `EXCEPTION live-search release evidence ${evidence.combinations.join(", ")} from ${evidence.sourceRevision}; waived ${evidence.waivedCombinations.join(", ")} (${evidence.reasonCode})`
    );
  } else {
    console.log(
      `PASS live-search release evidence ${evidence.combinations.join(", ")} from ${evidence.sourceRevision}`
    );
  }
} catch (error) {
  console.error(`Live-search release evidence failed: ${error?.message || String(error)}`);
  process.exitCode = 1;
}

if (existsSync(join(desktopRoot, "dist"))) {
  try {
    zipPath = join(
      desktopRoot,
      "dist",
      selectMacUpdateZip(readdirSync(join(desktopRoot, "dist")), pkg.version)
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (!zipPath && !process.exitCode) {
  console.error(`Desktop release must contain exactly one updater ZIP for ${pkg.version}.`);
  process.exitCode = 1;
}

for (const artifactPath of [appPath, dmgPath, metadataPath, ...(zipPath ? [zipPath] : [])]) {
  if (!existsSync(artifactPath)) {
    console.error(`Desktop release artifact is missing: ${artifactPath}`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  const result = verifyDesktopRelease({ appPath, dmgPath });
  for (const check of result.checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"} ${check.label}`);
    if (!check.ok && check.output) console.error(check.output);
  }
  console.log(result.summary);
  if (!result.ok) process.exitCode = 1;

  const feed = await verifyMacUpdateFeed({
    zipPath,
    metadataPath,
    expectedVersion: pkg.version,
  });
  for (const check of feed.checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"} ${check.label}`);
    if (!check.ok && check.output) console.error(check.output);
  }
  if (!feed.ok) process.exitCode = 1;
}
