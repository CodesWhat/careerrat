import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function workflow(name) {
  return readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
}

test("release.yml queues each tag in its own lane so a later tag cannot drop an earlier one", async () => {
  // GitHub keeps one pending run per concurrency group and a newer pending run
  // replaces it. A shared group would let a third tag cancel the second tag's
  // queued release. A same-tag backfill race fails closed on the existing-release check.
  const source = await workflow("release.yml");
  assert.match(
    source,
    /concurrency:\s*\n(?:\s*#[^\n]*\n)*\s+group:\s*\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\s*\n/
  );
  assert.match(source, /cancel-in-progress:\s*false/);
  assert.match(source, /already has a published release|already exists/i);
});

test("dispatched release workflows use one global lane so branch backfills cannot race their resolved tag", async () => {
  for (const name of ["publish.yml", "sbom.yml"]) {
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

test("release rejects unsigned or lightweight release tags", async () => {
  const source = await workflow("release.yml");
  const resolve = source.slice(
    source.indexOf("  resolve-tag:"),
    source.indexOf("  publish-release:")
  );

  const tagRefAt = resolve.indexOf("git/ref/tags/$TAG");
  const tagRecordAt = resolve.indexOf("git/tags/$tag_object");
  const tagNameAt = resolve.indexOf("'.tag'");
  const targetTypeAt = resolve.indexOf("'.object.type'", tagRecordAt);
  const compareAt = resolve.indexOf("compare/$tag_commit...main");
  const versionAt = resolve.indexOf("contents/package.json?ref=$TAG");
  const outputAt = resolve.indexOf('echo "tag=$tag"');

  assert.ok(tagRefAt >= 0 && tagRecordAt > tagRefAt);
  assert.ok(tagNameAt > tagRecordAt, "the signed tag object's own name must be checked");
  assert.ok(targetTypeAt > tagNameAt, "the signed tag must peel directly to a commit");
  assert.ok(compareAt > targetTypeAt, "the tagged commit must be compared with protected main");
  assert.ok(versionAt > compareAt, "the tag's package.json version must be read at the tag itself");
  assert.ok(outputAt > versionAt, "no tag output may escape before every trust check passes");
  assert.match(resolve, /\[ "v\$pkg_version" != "\$TAG" \]/);
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

for (const name of ["release.yml"]) {
  test(`${name} waits for every dispatched workflow and propagates child failures`, async () => {
    const source = await workflow(name);
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
      "every child run id must be retained before waiting"
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
      "any child failure must fail the originating release"
    );
  });
}

test("post-release workflow dispatches stay pinned to the release tag", async () => {
  const [publish, sbom] = await Promise.all([workflow("publish.yml"), workflow("sbom.yml")]);

  assert.match(publish, /REF_TYPE:\s*\$\{\{ github\.ref_type \}\}/);
  assert.match(publish, /REF_NAME:\s*\$\{\{ github\.ref_name \}\}/);
  assert.match(publish, /if \[ "\$REF_TYPE" != "tag" \]/);
  assert.match(publish, /pkg_tag="v\$\(node -p .*package\.json.*version.*\)"/);
  assert.match(publish, /if \[ "\$pkg_tag" != "\$REF_NAME" \]/);

  assert.match(sbom, /REF_TYPE:\s*\$\{\{ github\.ref_type \}\}/);
  assert.match(sbom, /REF_NAME:\s*\$\{\{ github\.ref_name \}\}/);
  assert.match(sbom, /\[ "\$REF_TYPE" = "tag" \]/);
});

test("npm publish requires the exact published release whose tag matches the package version", async () => {
  const publish = await workflow("publish.yml");
  const releaseGateAt = publish.indexOf("Verify the exact published release");
  const npmPublishAt = publish.indexOf("npm publish --provenance");

  assert.ok(releaseGateAt >= 0, "publish must have a published-release gate");
  assert.ok(npmPublishAt > releaseGateAt, "the release gate must run before npm publish");
  assert.match(
    publish,
    /gh api "repos\/\$REPO\/releases" --paginate --slurp[\s\S]*--arg tag "\$REF_NAME"/,
    "publish must resolve the release by its validated tag, including workflow_dispatch runs"
  );
  assert.match(publish, /select\(\.tag_name==\$tag\)/);
  assert.match(publish, /"\$count" -ne 1/);
  assert.match(publish, /\.draft == false/);
  assert.match(publish, /\.published_at != null/);
  assert.match(publish, /release_tag="\$\(jq -r '\.tag_name' <<<"\$release"\)"/);
  assert.match(publish, /\[ "\$release_tag" != "v\$pkg_version" \]/);
  assert.doesNotMatch(publish, /\.dmg|\.zip|latest-mac|matching_dmgs/);
});

test("release publishes a non-draft release from the changelog, then dispatches npm and the SBOM", async () => {
  const source = await workflow("release.yml");
  const publishJob = source.slice(source.indexOf("  publish-release:"));
  const existingAt = publishJob.indexOf("refusing to replace it");
  const changelogAt = publishJob.indexOf("contents/CHANGELOG.md?ref=$TAG");
  const emptyAt = publishJob.indexOf("has no non-empty");
  const createAt = publishJob.indexOf('gh release create "$TAG"');
  const dispatchAt = publishJob.indexOf("actions/workflows/$workflow/dispatches");

  assert.match(
    source,
    /on:\s*\n\s+push:\s*\n\s+tags:\s*\n\s+- "v\*\.\*\.\*"\s*\n\s+workflow_dispatch: \{\}/
  );
  assert.match(source, /needs: resolve-tag/);
  assert.ok(
    existingAt >= 0 && changelogAt > existingAt,
    "an existing release must fail closed first"
  );
  assert.ok(emptyAt > changelogAt, "a missing changelog section must fail before release creation");
  assert.ok(createAt > emptyAt, "the release is created only with real notes");
  assert.ok(dispatchAt > createAt, "downstream workflows start only after publication");
  assert.match(publishJob, /--notes-file "\$notes_file"/);
  assert.match(publishJob, /--title "\$TAG"/);
  assert.match(publishJob, /--verify-tag/);
  assert.match(publishJob, /awk -v heading="## \[\$version\]"/);
  assert.doesNotMatch(source, /--draft|draft=true/);
  assert.match(publishJob, /for workflow in publish\.yml sbom\.yml; do/);
  assert.match(
    publishJob,
    /permissions:[\s\S]*?contents: write[\s\S]*?actions: write[\s\S]*?checks: read/
  );
  assert.match(
    publishJob,
    /gh api -X POST -H "X-GitHub-Api-Version: 2026-03-10"[\s\S]*actions\/workflows\/\$workflow\/dispatches[\s\S]*-f ref="\$TAG"/
  );
  assert.match(publishJob, /-F return_run_details=true/);
  assert.doesNotMatch(source, /release-assets|\.dmg|latest-mac|macos-/);
});

test("tags start release.yml only, and the retired desktop workflows are gone", async () => {
  const release = await workflow("release.yml");

  assert.match(release, /tags:\s*\n\s+- "v\*\.\*\.\*"/);
  for (const gone of ["desktop-release.yml", "release-assets.yml"]) {
    assert.ok(
      !existsSync(new URL(`../.github/workflows/${gone}`, import.meta.url)),
      `${gone} is gone with the Mac release`
    );
  }
});
