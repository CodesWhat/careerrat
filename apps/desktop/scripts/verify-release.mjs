import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDesktopRelease } from "../release-verification.mjs";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const appPath = join(desktopRoot, "dist", "mac-arm64", `${pkg.build?.productName || "CareerRat"}.app`);
const dmgPath = join(desktopRoot, "dist", `CareerRat-${pkg.version}-arm64.dmg`);

for (const artifactPath of [appPath, dmgPath]) {
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
}
