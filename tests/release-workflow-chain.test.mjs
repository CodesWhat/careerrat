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

test("desktop release blocks upload on a signed native N-to-N+1 acceptance transition", async () => {
  const [source, releaseDocs] = await Promise.all([
    workflow("desktop-release.yml"),
    readFile(new URL("../docs/RELEASE.md", import.meta.url), "utf8"),
  ]);
  const macJob = source.slice(
    source.indexOf("  build-notarize-upload:"),
    source.indexOf("  build-windows-upload:")
  );
  const buildAt = macJob.indexOf("- name: Build and notarize the app");
  const acceptanceAt = macJob.indexOf("- name: Verify native N-to-N+1 update");
  const removeSigningAt = macJob.indexOf("- name: Remove signing material from the runner");
  const uploadAt = macJob.indexOf("- name: Upload the macOS release and updater feed");
  const mountedAt = macJob.indexOf("- name: Mount and smoke the canonical notarized DMG");

  assert.ok(acceptanceAt > buildAt, "native acceptance must use the final signed N+1 app");
  assert.ok(
    removeSigningAt > acceptanceAt,
    "the separately signed N fixture needs the same signing identity"
  );
  assert.ok(uploadAt > acceptanceAt, "no release asset may upload before native acceptance passes");
  assert.ok(mountedAt > acceptanceAt && uploadAt > mountedAt);
  assert.match(
    macJob.slice(mountedAt, uploadAt),
    /npm --workspace apps\/desktop run verify:mounted/
  );
  assert.match(
    macJob.slice(acceptanceAt, removeSigningAt),
    /npm --workspace apps\/desktop run verify:native-update/
  );
  assert.match(macJob.slice(acceptanceAt, removeSigningAt), /CSC_LINK:/);
  assert.match(macJob.slice(acceptanceAt, removeSigningAt), /APPLE_API_KEY:/);
  assert.match(
    macJob.slice(acceptanceAt, removeSigningAt),
    /NATIVE_UPDATE_ACCEPTANCE_PRIVATE_KEY:\s*\$\{\{ secrets\.NATIVE_UPDATE_ACCEPTANCE_PRIVATE_KEY \}\}/
  );
  assert.match(macJob.slice(acceptanceAt, removeSigningAt), /GH_TOKEN:/);
  assert.match(
    macJob,
    /missing\+=\("NATIVE_UPDATE_ACCEPTANCE_PRIVATE_KEY"\)/,
    "the new signing secret must fail before release packaging starts"
  );
  assert.match(
    releaseDocs,
    /native N-to-N\+1 update[\s\S]*loopback feed[\s\S]*CAREERRAT_HOME sentinel/i
  );
  assert.match(releaseDocs, /NATIVE_UPDATE_ACCEPTANCE_PRIVATE_KEY[\s\S]*PKCS#8 PEM/i);
});

test("desktop release publishes only after the complete macOS updater feed is attached", async () => {
  const source = await workflow("desktop-release.yml");
  const publishJob = source.slice(source.indexOf("  publish-release:"));
  const dmgGateAt = publishJob.indexOf('endswith(".dmg")');
  const zipGateAt = publishJob.indexOf('endswith(".zip")');
  const metadataGateAt = publishJob.indexOf('== "latest-mac.yml"');
  const publishAt = publishJob.indexOf("-F draft=false");
  const dispatchAt = publishJob.indexOf("actions/workflows/$workflow/dispatches");

  assert.match(publishJob, /permissions:[\s\S]*?contents: write[\s\S]*?actions: write/);
  assert.ok(dmgGateAt >= 0, "the release must verify a DMG asset before publication");
  assert.ok(zipGateAt >= 0, "the release must verify the updater ZIP before publication");
  assert.ok(metadataGateAt >= 0, "the release must verify latest-mac.yml before publication");
  assert.ok(
    publishAt > Math.max(dmgGateAt, zipGateAt, metadataGateAt),
    "the complete macOS feed gate must run before the release is published"
  );
  assert.ok(dispatchAt > publishAt, "downstream workflows must start only after publication");
  assert.match(publishJob, /version="\$\{TAG#v\}"/);
  assert.match(publishJob, /canonical_dmg="CareerRat-\$version-arm64\.dmg"/);
  assert.match(publishJob, /dmg_count[\s\S]*-ne 1/);
  assert.match(publishJob, /unexpected_dmg_count[\s\S]*-ne 0/);
  assert.match(
    publishJob,
    /"\$mac_zip_name" != \*-"\$version"-\*\.zip/,
    "the updater ZIP must carry this release's exact version as a filename segment"
  );
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

test("macOS release upload requires exactly the canonical DMG, one ZIP, and metadata", async () => {
  const upload = await readFile(
    new URL("../apps/desktop/scripts/release-upload.mjs", import.meta.url),
    "utf8"
  );

  assert.match(upload, /name\.endsWith\("\.zip"\)/);
  assert.match(upload, /latest-mac\.yml/);
  assert.match(upload, /selectMacReleaseArtifacts/);
  assert.match(upload, /filesToUpload = \[metadataPath, matchingZips\[0\]/);
  assert.match(upload, /zipBlockmap/);
  assert.doesNotMatch(
    upload,
    /\$\{dmgFile\}\.blockmap/,
    "post-builder DMG blockmaps are stale after container signing and stapling"
  );
  assert.doesNotMatch(upload, /--clobber/);
});

test("release artifact selection rejects extra or renamed DMGs before upload", async () => {
  const { selectMacReleaseArtifacts } = await import("../apps/desktop/release-artifacts.mjs").catch(
    () => ({})
  );
  assert.equal(typeof selectMacReleaseArtifacts, "function");
  const complete = [
    "CareerRat-0.16.6-arm64.dmg",
    "CareerRat-0.16.6-arm64-mac.zip",
    "CareerRat-0.16.6-arm64-mac.zip.blockmap",
    "latest-mac.yml",
  ];
  assert.deepEqual(selectMacReleaseArtifacts({ names: complete, version: "0.16.6" }), complete);
  assert.throws(
    () =>
      selectMacReleaseArtifacts({
        names: [...complete, "CareerRat-copy-0.16.6-arm64.dmg"],
        version: "0.16.6",
      }),
    /exactly CareerRat-0\.16\.6-arm64\.dmg/i
  );
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

test("npm publish requires the exact published release and complete version-matching Mac feed", async () => {
  const publish = await workflow("publish.yml");
  const releaseGateAt = publish.indexOf("Verify the exact published release and Mac update feed");
  const npmPublishAt = publish.indexOf("npm publish --provenance");

  assert.ok(releaseGateAt >= 0, "publish must have a complete GitHub Release feed gate");
  assert.ok(npmPublishAt > releaseGateAt, "the complete feed gate must run before npm publish");
  assert.match(
    publish,
    /gh api "repos\/\$REPO\/releases" --paginate --slurp[\s\S]*--arg tag "\$REF_NAME"/,
    "publish must resolve the release by its validated tag, including workflow_dispatch runs"
  );
  assert.match(publish, /select\(\.tag_name==\$tag\)/);
  assert.match(publish, /\.draft == false/);
  assert.match(publish, /\.published_at != null/);
  assert.match(publish, /matching_dmgs\+=\("\$asset"\)/);
  assert.match(publish, /matching_zips\+=\("\$asset"\)/);
  assert.match(publish, /manifest_count=\$\(\(manifest_count \+ 1\)\)/);
  assert.match(publish, /"\$\{#matching_dmgs\[@\]\}" -ne 1/);
  assert.match(publish, /"\$\{#matching_zips\[@\]\}" -ne 1/);
  assert.match(publish, /"\$manifest_count" -ne 1/);
  assert.match(publish, /exactly one \.dmg asset matching version \$version/i);
  assert.match(publish, /exactly one updater \.zip asset matching version \$version/i);
  assert.match(publish, /exactly one latest-mac\.yml asset/i);
});

test("published-release asset verification independently requires the complete Mac feed", async () => {
  const releaseAssets = await workflow("release-assets.yml");

  assert.match(releaseAssets, /matching_dmgs\+=\("\$asset"\)/);
  assert.match(releaseAssets, /matching_zips\+=\("\$asset"\)/);
  assert.match(releaseAssets, /manifest_count=\$\(\(manifest_count \+ 1\)\)/);
  assert.match(releaseAssets, /"\$\{#matching_dmgs\[@\]\}" -ne 1/);
  assert.match(releaseAssets, /"\$\{#matching_zips\[@\]\}" -ne 1/);
  assert.match(releaseAssets, /"\$manifest_count" -ne 1/);
});
