import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function workflow(name) {
  return readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
}

test("release workflows use one global lane so branch backfills cannot race their resolved tag", async () => {
  for (const name of ["desktop-release.yml", "publish.yml", "release-assets.yml", "sbom.yml"]) {
    const source = await workflow(name);
    assert.match(
      source,
      /concurrency:\s*\n\s+group:\s*\$\{\{ github\.workflow \}\}\s*\n/,
      `${name} must serialize release events and branch-dispatched backfills together`
    );
    assert.doesNotMatch(source, /group:[^\n]*(?:github\.ref|tag_name)/);
    assert.match(source, /cancel-in-progress:\s*false/);
  }
});

test("desktop release rejects unsigned or lightweight release tags", async () => {
  const source = await workflow("desktop-release.yml");
  const resolve = source.slice(
    source.indexOf("  resolve-tag:"),
    source.indexOf("  prepare-draft-release:")
  );

  const tagRefAt = resolve.indexOf("git/ref/tags/$TAG");
  const tagRecordAt = resolve.indexOf("git/tags/$tag_object");
  const tagNameAt = resolve.indexOf("'.tag'");
  const targetTypeAt = resolve.indexOf("'.object.type'", tagRecordAt);
  const compareAt = resolve.indexOf("compare/$tag_commit...main");
  const outputAt = resolve.indexOf('echo "tag=$tag"');

  assert.ok(tagRefAt >= 0 && tagRecordAt > tagRefAt);
  assert.ok(tagNameAt > tagRecordAt, "the signed tag object's own name must be checked");
  assert.ok(targetTypeAt > tagNameAt, "the signed tag must peel directly to a commit");
  assert.ok(compareAt > targetTypeAt, "the tagged commit must be compared with protected main");
  assert.ok(outputAt > compareAt, "no tag output may escape before every trust check passes");
  assert.match(resolve, /\[ "\$recorded_tag" != "\$TAG" \]/);
  assert.match(resolve, /\[ "\$target_type" != "commit" \]/);
  assert.match(resolve, /"\$main_relation" != "ahead"[\s\S]*"\$main_relation" != "identical"/);
  assert.match(resolve, /"\$verified" != "true"[\s\S]*"\$reason" != "valid"/);
});

test("npm publish grants its OIDC credential only to the publishing job", async () => {
  const source = await workflow("publish.yml");
  const job = source.slice(source.indexOf("  npm-publish:"));

  assert.match(source, /permissions:\s*\{\}/);
  assert.match(job, /permissions:\s*\n\s+contents:\s*read\s*#[^\n]+\n\s+id-token:\s*write\s*#/);
  assert.doesNotMatch(source.slice(0, source.indexOf("jobs:")), /id-token:\s*write/);
});

test("npm publish runs the exact package-manager version pinned by the repository", async () => {
  const [source, packageText] = await Promise.all([
    workflow("publish.yml"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const pkg = JSON.parse(packageText);

  assert.match(pkg.packageManager, /^npm@\d+\.\d+\.\d+$/);
  assert.match(source, /EXPECTED_NPM=.*packageManager/);
  assert.match(source, /corepack npm --version/);
  assert.match(source, /corepack npm ci/);
  assert.match(source, /corepack npm publish --provenance/);
  assert.doesNotMatch(source, /npm@latest|npm install -g/);
});

test("desktop signing uses the supported pinned arm64 macOS runner", async () => {
  const [source, releaseDocs] = await Promise.all([
    workflow("desktop-release.yml"),
    readFile(new URL("../docs/RELEASE.md", import.meta.url), "utf8"),
  ]);
  const buildJob = source.slice(
    source.indexOf("  build-notarize-upload:"),
    source.indexOf("  publish-release:")
  );

  assert.match(buildJob, /runs-on:\s+macos-15\b/);
  assert.doesNotMatch(
    buildJob,
    /runs-on:\s+macos-14\b/,
    "the deprecated macOS 14 runner can brown out or block the only signed release job"
  );
  assert.match(releaseDocs, /build-notarize-upload[^\n]*macos-15[^\n]*arm64/);
  assert.doesNotMatch(releaseDocs, /build-notarize-upload[^\n]*macos-14/);
});

test("desktop release explicitly dispatches every post-release workflow after the DMG gate", async () => {
  const source = await workflow("desktop-release.yml");
  const publishJob = source.slice(source.indexOf("  publish-release:"));
  const dmgGateAt = publishJob.indexOf('endswith(".dmg")');
  const publishAt = publishJob.indexOf("-F draft=false");
  const dispatchAt = publishJob.indexOf("actions/workflows/$workflow/dispatches");

  assert.match(publishJob, /permissions:[\s\S]*?contents: write[\s\S]*?actions: write/);
  assert.ok(dmgGateAt >= 0, "the release must verify a DMG asset before publication");
  assert.ok(publishAt > dmgGateAt, "the DMG gate must run before the release is published");
  assert.ok(dispatchAt > publishAt, "downstream workflows must start only after publication");
  assert.match(publishJob, /for workflow in publish\.yml release-assets\.yml sbom\.yml/);
  assert.match(
    publishJob,
    /gh api -X POST -H "X-GitHub-Api-Version: 2026-03-10"[\s\S]*actions\/workflows\/\$workflow\/dispatches[\s\S]*-f ref="\$TAG"/
  );
  assert.match(
    publishJob,
    /-F return_run_details=true/,
    "the dispatch API must opt into the typed run-details response instead of returning 204"
  );
  assert.match(publishJob, /GITHUB_TOKEN[\s\S]*workflow_dispatch/i);
});

test("desktop release waits for every dispatched workflow and propagates child failures", async () => {
  const source = await workflow("desktop-release.yml");
  const publishJob = source.slice(source.indexOf("  publish-release:"));
  const dispatchAt = publishJob.indexOf("actions/workflows/$workflow/dispatches");
  const waitAt = publishJob.indexOf('gh run watch "$run_id"');

  assert.match(
    publishJob,
    /run_id="\$\(jq -er '\.workflow_run_id \| select\(type == "number" and \. > 0\)' <<<"\$dispatch"\)"/,
    "each dispatch must capture the exact run identity returned by the versioned API"
  );
  assert.match(
    publishJob,
    /permissions:[\s\S]*?actions: write[\s\S]*?checks: read/,
    "gh run watch requires read access to child check runs"
  );
  assert.match(
    publishJob,
    /downstream_run_ids\+=\("\$run_id"\)/,
    "all three child run ids must be retained before waiting"
  );
  assert.ok(waitAt > dispatchAt, "child runs must be watched after they are dispatched");
  assert.match(
    publishJob,
    /for run_id in "\$\{downstream_run_ids\[@\]\}"; do[\s\S]*gh run watch "\$run_id" --repo "\$REPO"[^\n]*--exit-status/,
    "the release job must wait for every child and ask gh to return its failure status"
  );
  assert.match(
    publishJob,
    /if \[ "\$downstream_failures" -gt 0 \]; then[\s\S]*exit 1/,
    "any child failure must fail the originating desktop release"
  );
});

test("post-release workflow dispatches stay pinned to the release tag", async () => {
  const [publish, releaseAssets, sbom] = await Promise.all([
    workflow("publish.yml"),
    workflow("release-assets.yml"),
    workflow("sbom.yml"),
  ]);

  assert.match(publish, /REF_TYPE:\s*\$\{\{ github\.ref_type \}\}/);
  assert.match(publish, /REF_NAME:\s*\$\{\{ github\.ref_name \}\}/);
  assert.match(publish, /if \[ "\$REF_TYPE" != "tag" \]/);
  assert.match(publish, /pkg_tag="v\$\(node -p .*package\.json.*version.*\)"/);
  assert.match(publish, /if \[ "\$pkg_tag" != "\$REF_NAME" \]/);

  for (const source of [releaseAssets, sbom]) {
    assert.match(source, /REF_TYPE:\s*\$\{\{ github\.ref_type \}\}/);
    assert.match(source, /REF_NAME:\s*\$\{\{ github\.ref_name \}\}/);
    assert.match(source, /\[ "\$REF_TYPE" = "tag" \]/);
  }
});

test("npm publish requires the exact published release and its version-matching DMG", async () => {
  const publish = await workflow("publish.yml");
  const releaseGateAt = publish.indexOf("Verify the exact published release and DMG");
  const npmPublishAt = publish.indexOf("npm publish --provenance");

  assert.ok(releaseGateAt >= 0, "publish must have a GitHub Release and DMG gate");
  assert.ok(npmPublishAt > releaseGateAt, "the release and DMG gate must run before npm publish");
  assert.match(
    publish,
    /gh api "repos\/\$REPO\/releases" --paginate --slurp[\s\S]*--arg tag "\$REF_NAME"/,
    "publish must resolve the release by its validated tag, including workflow_dispatch runs"
  );
  assert.match(publish, /select\(\.tag_name==\$tag\)/);
  assert.match(publish, /\.draft == false/);
  assert.match(publish, /\.published_at != null/);
  assert.match(
    publish,
    /"\$asset" == \*-"\$version"-\*\.dmg/,
    "the gate must require a DMG carrying this release's version as a whole filename segment"
  );
  assert.match(
    publish,
    /Release \$REF_NAME has no \.dmg asset matching version \$version/,
    "a missing or stale-version DMG must fail closed"
  );
});
