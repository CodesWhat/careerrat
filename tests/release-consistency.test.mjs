import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The official grammar from semver.org, not a loose approximation. A hand
// rolled `\d+\.\d+\.\d+(-...)?` accepts `01.2.3` and `1.2.3-alpha..1` and
// rejects valid build metadata like `1.2.3+build.7`. Inlined rather than
// pulling in the `semver` package, which is not a declared dependency here and
// would trip knip.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// Packages that are deliberately NOT synced to the root version: apps/web
// (SPA shell, still 0.1.0), apps/website (marketing site, still 0.0.0), and
// apps/docs (docs site, still 0.0.0). Do not add a version-sync assertion for
// these — they ship independently of the CLI/desktop pair.
const UNVERSIONED_APP_PACKAGE_JSON_PATHS = [
  "apps/web/package.json",
  "apps/website/package.json",
  "apps/docs/package.json",
];

// Round-trip rather than a NaN check. JS silently normalizes an out-of-range
// day instead of rejecting it, so `2026-02-30` parses fine and comes back as
// `2026-03-02`. Only comparing the formatted result to the input catches that.
// (`2026-13-01` does yield NaN, but the day case does not, so a NaN check
// alone is not enough.)
function normalizeCalendarDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? "invalid" : parsed.toISOString().slice(0, 10);
}

function findNewestChangelogHeading(changelog) {
  for (const line of changelog.split("\n")) {
    const match = line.match(/^## \[([^\]]+)\](?: - (.+))?/);
    if (!match) continue;
    if (match[1] === "Unreleased") continue;
    return { version: match[1], date: match[2] };
  }
  return null;
}

test("package.json and apps/desktop/package.json versions are identical", async () => {
  const rootPackageJson = JSON.parse(await readFile("package.json", "utf8"));
  const desktopPackageJson = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));

  assert.equal(
    desktopPackageJson.version,
    rootPackageJson.version,
    `\`apps/desktop/package.json\` is ${desktopPackageJson.version} but \`package.json\` is ${rootPackageJson.version}. The CLI and desktop app ship as a pair; bump both.`
  );
});

test("root package.json version is valid semver", async () => {
  const rootPackageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.match(
    rootPackageJson.version,
    SEMVER_PATTERN,
    `\`package.json\` version "${rootPackageJson.version}" is not valid semver (expected x.y.z or x.y.z-prerelease).`
  );
});

test("CHANGELOG.md's newest release heading matches the root package.json version", async () => {
  const rootPackageJson = JSON.parse(await readFile("package.json", "utf8"));
  const changelog = await readFile("CHANGELOG.md", "utf8");

  const newest = findNewestChangelogHeading(changelog);
  assert.ok(
    newest,
    "CHANGELOG.md has no `## [x.y.z] - DATE` release heading. Add one for the current release."
  );

  assert.equal(
    newest.version,
    rootPackageJson.version,
    `CHANGELOG.md's newest release heading is [${newest.version}] but \`package.json\` is ${rootPackageJson.version}. Add or fix the CHANGELOG entry for this release, or bump package.json to match.`
  );
});

test("CHANGELOG.md's newest release heading has a real YYYY-MM-DD date", async () => {
  const changelog = await readFile("CHANGELOG.md", "utf8");

  const newest = findNewestChangelogHeading(changelog);
  assert.ok(
    newest,
    "CHANGELOG.md has no `## [x.y.z] - DATE` release heading. Add one for the current release."
  );
  assert.ok(
    newest.date,
    `CHANGELOG.md's newest release heading [${newest.version}] is missing a "- YYYY-MM-DD" date.`
  );

  assert.match(
    newest.date,
    /^\d{4}-\d{2}-\d{2}$/,
    `CHANGELOG.md's newest release heading date "${newest.date}" is not YYYY-MM-DD. Fix the date on the [${newest.version}] heading.`
  );

  assert.equal(
    normalizeCalendarDate(newest.date),
    newest.date,
    `CHANGELOG.md's newest release heading date "${newest.date}" is not a real calendar date. Fix the date on the [${newest.version}] heading.`
  );
});

test("the semver check accepts and rejects the right shapes", () => {
  for (const good of ["0.10.0", "1.2.3", "1.2.3-rc.1", "1.2.3+build.7", "1.2.3-rc.1+build.7"]) {
    assert.match(good, SEMVER_PATTERN, `${good} should be accepted`);
  }
  for (const bad of ["01.2.3", "1.2.3-alpha..1", "1.2", "1.2.3.4", "v1.2.3", ""]) {
    assert.doesNotMatch(bad, SEMVER_PATTERN, `${bad} should be rejected`);
  }
});

test("the date check rejects dates that only look valid", () => {
  for (const good of ["2026-08-19", "2024-02-29", "2026-12-31"]) {
    assert.equal(normalizeCalendarDate(good), good, `${good} should be accepted`);
  }
  // Each of these would pass a plain Number.isNaN check: the first three get
  // silently rolled forward into the next month, so only the round-trip
  // catches them.
  for (const bad of ["2026-02-30", "2026-02-29", "2026-04-31", "2026-13-01"]) {
    assert.notEqual(normalizeCalendarDate(bad), bad, `${bad} should be rejected`);
  }
});

// Guard against someone "helpfully" mass-bumping every package.json in the
// monorepo to match the root/desktop version. apps/web, apps/website, and
// apps/docs are intentionally on their own version tracks.
test("intentionally unversioned apps do not track the root version", async () => {
  const rootPackageJson = JSON.parse(await readFile("package.json", "utf8"));

  for (const path of UNVERSIONED_APP_PACKAGE_JSON_PATHS) {
    const packageJson = JSON.parse(await readFile(path, "utf8"));
    assert.notEqual(
      packageJson.version,
      rootPackageJson.version,
      `\`${path}\` now matches the root version (${rootPackageJson.version}). This app is intentionally unversioned relative to the CLI/desktop pair; if it was bumped to match on purpose, update this test's exemption list instead of the assertion.`
    );
  }
});
