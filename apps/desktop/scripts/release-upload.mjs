import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const distDir = join(desktopRoot, "dist");

function fail(message) {
  console.error(message);
  process.exit(1);
}

try {
  execFileSync("gh", ["--version"], { stdio: "ignore" });
} catch {
  fail("The `gh` CLI is required to upload release assets but was not found on PATH.");
}

if (!existsSync(distDir)) {
  fail(`No build output found: ${distDir} does not exist. Run \`npm run dist\` first.`);
}

const dmgFiles = readdirSync(distDir).filter((name) => name.endsWith(".dmg"));

if (dmgFiles.length === 0) {
  fail(`No .dmg files found in ${distDir}. Run \`npm run dist\` first.`);
}

// electron-builder writes into dist/ without clearing it, so builds from
// prior versions accumulate there. Upload only the ones matching the version
// we're actually releasing, and never let a stale artifact ride along.
//
// Match the version as a whole token rather than a substring: a plain
// includes() would accept CareerRat-0.9.10-arm64.dmg while releasing 0.9.1,
// which is exactly how a stale build sneaks into a release.
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const versionToken = new RegExp(`(?<![0-9.])${escapeRegExp(version)}(?![0-9.])`);
const matchingDmgs = dmgFiles.filter((name) => versionToken.test(name));
const staleDmgs = dmgFiles.filter((name) => !versionToken.test(name));

if (matchingDmgs.length === 0) {
  fail(
    `No .dmg in ${distDir} matches package.json version ${version}. ` +
      `Found only: ${staleDmgs.join(", ")}. Run \`npm run dist\` to build ${version}.`
  );
}

if (staleDmgs.length > 0) {
  console.warn(`Skipping stale build output not matching ${version}: ${staleDmgs.join(", ")}`);
}

const filesToUpload = [];
for (const dmgFile of matchingDmgs) {
  filesToUpload.push(join(distDir, dmgFile));
  const blockmapFile = `${dmgFile}.blockmap`;
  if (existsSync(join(distDir, blockmapFile))) {
    filesToUpload.push(join(distDir, blockmapFile));
  }
}

try {
  execFileSync("gh", ["release", "view", tag], { stdio: "ignore" });
} catch {
  fail(
    `No GitHub release exists for tag ${tag}. Create the draft release first: ` +
      `\`gh release create ${tag} --draft ...\``
  );
}

try {
  execFileSync("gh", ["release", "upload", tag, ...filesToUpload, "--clobber"], {
    stdio: "inherit",
  });
} catch {
  fail(`Failed to upload release assets to ${tag}.`);
}

console.log(`Uploaded to ${tag}:`);
for (const file of filesToUpload) {
  console.log(`  ${file}`);
}
