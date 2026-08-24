import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const distDir = join(desktopRoot, "dist");
let expectedReleaseId = String(process.env.CAREERRAT_RELEASE_ID || "").trim();

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

if (expectedReleaseId && !/^\d+$/.test(expectedReleaseId)) {
  fail("CAREERRAT_RELEASE_ID must be a numeric GitHub release id.");
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

function resolveExactDraftRelease() {
  let pages;
  try {
    const output = execFileSync(
      "gh",
      ["api", "repos/{owner}/{repo}/releases", "--paginate", "--slurp"],
      { encoding: "utf8" }
    );
    pages = JSON.parse(output);
  } catch {
    fail(`Could not revalidate the GitHub release for ${tag}.`);
  }
  const releases = Array.isArray(pages[0]) ? pages.flat() : pages;
  const matches = releases.filter((release) => release.tag_name === tag);
  if (matches.length !== 1) {
    fail(`Expected one GitHub release for ${tag}, found ${matches.length}.`);
  }
  const [release] = matches;
  if (release.draft !== true) {
    fail(`Release ${tag} is no longer a draft; refusing to upload public assets.`);
  }
  if (!expectedReleaseId) expectedReleaseId = String(release.id);
  if (String(release.id) !== expectedReleaseId) {
    fail(
      `Release identity changed from ${expectedReleaseId} to ${release.id}; refusing to upload.`
    );
  }
  return release;
}

for (const file of filesToUpload) {
  resolveExactDraftRelease();
  try {
    execFileSync("gh", ["release", "upload", tag, file], { stdio: "inherit" });
  } catch {
    fail(`Failed to upload ${file} to draft ${tag}.`);
  }
}

console.log(`Uploaded to ${tag}:`);
for (const file of filesToUpload) {
  console.log(`  ${file}`);
}
