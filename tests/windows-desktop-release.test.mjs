import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { npmInvocation } from "../apps/desktop/scripts/npm-invocation.mjs";

async function text(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function json(path) {
  return JSON.parse(await text(path));
}

function topLevelBlock(source, key) {
  const lines = source.split("\n");
  const start = lines.indexOf(`${key}:`);
  assert.notEqual(start, -1, `${key}: block must exist`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z0-9_-]+:/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

test("desktop dependency staging is reproducible and excludes the source-only Agent SDK", async () => {
  const [rootPackage, rootLock, runtimePackage, runtimeLock, stage] = await Promise.all([
    json("package.json"),
    json("package-lock.json"),
    json("apps/desktop/runtime-dependencies/package.json"),
    json("apps/desktop/runtime-dependencies/package-lock.json"),
    text("apps/desktop/scripts/stage.mjs"),
  ]);

  assert.ok(
    rootPackage.devDependencies?.["@anthropic-ai/claude-agent-sdk"],
    "source-only provider fallback keeps its test/development SDK"
  );
  assert.ok(rootLock.packages?.["node_modules/@anthropic-ai/claude-agent-sdk"]);
  assert.equal(runtimePackage.dependencies?.["@anthropic-ai/claude-agent-sdk"], undefined);
  assert.equal(runtimeLock.packages?.["node_modules/@anthropic-ai/claude-agent-sdk"], undefined);

  const expectedDependencyNames = [
    ...Object.keys(rootPackage.dependencies || {}),
    "playwright",
  ].sort();
  assert.deepEqual(Object.keys(runtimePackage.dependencies || {}).sort(), expectedDependencyNames);
  for (const [name, version] of Object.entries(runtimePackage.dependencies || {})) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${name} must be exact`);
    assert.equal(runtimeLock.packages?.[`node_modules/${name}`]?.version, version);
    assert.equal(
      rootLock.packages?.[`node_modules/${name}`]?.version,
      version,
      `${name} must match the root lock's reviewed version`
    );
  }
  for (const required of [
    "htmlparser2",
    "jszip",
    "mammoth",
    "playwright",
    "sanitize-html",
    "undici",
  ]) {
    assert.ok(runtimePackage.dependencies?.[required], `${required} must be staged`);
  }

  assert.match(stage, /npm(?:\.cmd)?["']?[\s\S]*["']ci["']/);
  assert.match(stage, /runtime-dependencies/);
  assert.doesNotMatch(stage, /["']install["'][\s\S]*--no-package-lock/);
  assert.doesNotMatch(stage, /@anthropic-ai\/claude-agent-sdk@\$\{/);
  assert.match(stage, /pkg\.version/);
});

test("the staged and packaged trees have an explicit Agent SDK exclusion", async () => {
  const [stage, builder] = await Promise.all([
    text("apps/desktop/scripts/stage.mjs"),
    text("apps/desktop/electron-builder.yml"),
  ]);
  assert.match(stage, /assertNoProprietarySdk/);
  assert.match(builder, /!@anthropic-ai\/claude-agent-sdk(?:"|')/);
  assert.match(builder, /!@anthropic-ai\/claude-agent-sdk\/\*\*/);
});

test("Electron builds a fixed desktop Windows x64 NSIS installer with the rat icon", async () => {
  const [builder, pkg] = await Promise.all([
    text("apps/desktop/electron-builder.yml"),
    json("apps/desktop/package.json"),
  ]);
  const win = topLevelBlock(builder, "win");
  const nsis = topLevelBlock(builder, "nsis");

  assert.match(win, /icon:\s+build\/icon\.ico/);
  assert.match(win, /target:[\s\S]*target:\s+nsis[\s\S]*-\s+x64/);
  assert.match(win, /requestedExecutionLevel:\s+asInvoker/);
  assert.match(nsis, /oneClick:\s+false/);
  assert.match(nsis, /perMachine:\s+false/);
  assert.match(nsis, /createDesktopShortcut:\s+always/);
  assert.ok(existsSync(new URL("../apps/desktop/build/icon.ico", import.meta.url)));

  assert.match(pkg.scripts?.["dist:windows"] || "", /windows-package\.mjs/);
  assert.match(pkg.scripts?.["verify:windows"] || "", /verify-windows\.mjs/);
  assert.doesNotMatch(win, /\b(?:appx|msix)\b/i);
  assert.doesNotMatch(builder, /publisher:\s+(?!null\b)\S+/i);
});

test("Windows cross-build stages Playwright's Windows browser on every host", async () => {
  const script = await text("apps/desktop/scripts/windows-package.mjs");
  const stageCall = script.slice(
    script.indexOf('join(desktopRoot, "scripts", "stage.mjs")'),
    script.indexOf("execFileSync(process.execPath, [builderCli")
  );

  assert.match(stageCall, /PLAYWRIGHT_HOST_PLATFORM_OVERRIDE:\s*"win64"/);
});

test("desktop packaging invokes npm through Node instead of the Windows cmd shim", async () => {
  const invocation = npmInvocation(["ci", "--prefix", "C:\\Career Rat"], {
    env: {
      npm_execpath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    },
    execPath: "C:\\Program Files\\nodejs\\node.exe",
  });

  assert.equal(invocation.file, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(invocation.args, [
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    "ci",
    "--prefix",
    "C:\\Career Rat",
  ]);

  const [packager, stage] = await Promise.all([
    text("apps/desktop/scripts/windows-package.mjs"),
    text("apps/desktop/scripts/stage.mjs"),
  ]);
  assert.doesNotMatch(packager, /execFileSync\(npmCommand/);
  assert.doesNotMatch(stage, /execFileSync\(\s*npmCmd/);
});

test("PR and push CI build, install-smoke, and retain the Windows installer", async () => {
  const ci = await text(".github/workflows/ci-verify.yml");
  const job = ci.slice(ci.indexOf("  windows-package-smoke:"));

  assert.match(job, /runs-on:\s+windows-latest/);
  assert.match(job, /npm run verify:windows --workspace apps\/desktop/);
  assert.match(job, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(job, /CareerRat-\*-(?:win-)?x64-Setup\.exe/);
});

test("tag release prepares one draft and requires both macOS and Windows artifacts", async () => {
  const release = await text(".github/workflows/desktop-release.yml");
  const prepare = release.slice(
    release.indexOf("  prepare-draft-release:"),
    release.indexOf("  build-notarize-upload:")
  );
  const windows = release.slice(
    release.indexOf("  build-windows-upload:"),
    release.indexOf("  publish-release:")
  );
  const publish = release.slice(release.indexOf("  publish-release:"));

  assert.match(prepare, /gh release create/);
  assert.match(prepare, /\.draft/);
  assert.match(prepare, /already published|not a draft/i);
  assert.doesNotMatch(
    release.slice(
      release.indexOf("  build-notarize-upload:"),
      release.indexOf("  build-windows-upload:")
    ),
    /gh release create/
  );
  assert.match(windows, /runs-on:\s+windows-latest/);
  assert.match(windows, /npm run dist:windows --workspace apps\/desktop/);
  assert.match(windows, /npm run verify:windows --workspace apps\/desktop/);
  const windowsJobHeader = windows.slice(0, windows.indexOf("    steps:"));
  assert.doesNotMatch(windowsJobHeader, /GH_TOKEN:/);
  assert.match(
    await text("apps/desktop/scripts/windows-package.mjs"),
    /--publish["'],\s*["']never/
  );
  assert.match(windows, /Get-FileHash[\s\S]*SHA256/);
  assert.match(windows, /gh release upload/);
  assert.match(publish, /needs:\s*\[[^\]]*build-notarize-upload[^\]]*build-windows-upload[^\]]*\]/);
  assert.match(publish, /endswith\("\.dmg"\)/);
  assert.match(publish, /endswith\("\.exe"\)/);
});

test("an unsigned Windows installer can never reach a public release", async () => {
  const release = await text(".github/workflows/desktop-release.yml");
  const windows = release.slice(
    release.indexOf("  build-windows-upload:"),
    release.indexOf("  publish-release:")
  );
  const authCheck = windows.indexOf("Get-AuthenticodeSignature");
  const signerCheck = windows.indexOf("SignPath Foundation", authCheck);
  const releaseUpload = windows.indexOf("gh release upload");

  assert.match(windows, /unsigned-qa/);
  assert.ok(authCheck > 0, "the Windows job must inspect Authenticode");
  assert.ok(signerCheck > authCheck, "the Windows job must require the Foundation signer");
  assert.ok(
    releaseUpload > signerCheck,
    "public upload must happen only after signature verification"
  );
  assert.equal((windows.match(/gh release upload/g) || []).length, 1);
  assert.match(
    windows.slice(windows.lastIndexOf("- name:", releaseUpload), releaseUpload),
    /if:\s*\$\{\{[^\n]*SIGNPATH_ENABLED[^\n]*\}\}/
  );
});

test("signed Windows smoke cannot inherit the release upload credential", async () => {
  const [release, windowsVerifier] = await Promise.all([
    text(".github/workflows/desktop-release.yml"),
    text("apps/desktop/scripts/verify-windows.mjs"),
  ]);
  const windows = release.slice(
    release.indexOf("  build-windows-upload:"),
    release.indexOf("  publish-release:")
  );
  const verify = windows.slice(
    windows.indexOf("- name: Verify the signed Windows installer"),
    windows.indexOf("- name: Upload the verified signed Windows installer")
  );
  const upload = windows.slice(
    windows.indexOf("- name: Upload the verified signed Windows installer"),
    windows.indexOf("- name: Record Windows publication state")
  );

  assert.match(verify, /npm run verify:windows --workspace apps\/desktop/);
  assert.doesNotMatch(verify, /GH_TOKEN|GITHUB_TOKEN|secrets\.GITHUB_TOKEN/);
  assert.match(upload, /GH_TOKEN:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(upload, /gh release upload/);
  assert.match(windowsVerifier, /delete childEnv\.GH_TOKEN/);
  assert.match(windowsVerifier, /delete childEnv\.GITHUB_TOKEN/);
});

test("every desktop asset upload revalidates the same exact draft after the long build", async () => {
  const [release, macUpload] = await Promise.all([
    text(".github/workflows/desktop-release.yml"),
    text("apps/desktop/scripts/release-upload.mjs"),
  ]);
  const prepare = release.slice(
    release.indexOf("  prepare-draft-release:"),
    release.indexOf("  build-notarize-upload:")
  );
  const mac = release.slice(
    release.indexOf("  build-notarize-upload:"),
    release.indexOf("  build-windows-upload:")
  );
  const windows = release.slice(
    release.indexOf("  build-windows-upload:"),
    release.indexOf("  publish-release:")
  );

  assert.match(prepare, /outputs:[\s\S]*release-id:/);
  assert.match(
    mac,
    /CAREERRAT_RELEASE_ID:\s*\$\{\{ needs\.prepare-draft-release\.outputs\.release-id \}\}/
  );
  assert.ok(
    mac.indexOf("run verify:packaged") <
      mac.indexOf("run: npm --workspace apps/desktop run release:upload")
  );
  assert.match(macUpload, /CAREERRAT_RELEASE_ID/);
  assert.match(macUpload, /gh["'],\s*\["api"/);
  assert.match(macUpload, /matches\.length !== 1/);
  assert.match(macUpload, /release\.draft !== true/);
  assert.match(macUpload, /String\(release\.id\)[\s\S]*expectedReleaseId/);
  const macLoop = macUpload.indexOf("for (const file of filesToUpload)");
  const macDraftCheck = macUpload.indexOf("resolveExactDraftRelease", macLoop);
  const macPublicUpload = macUpload.indexOf('"release", "upload"', macDraftCheck);
  assert.ok(macLoop > 0 && macDraftCheck > macLoop && macPublicUpload > macDraftCheck);
  assert.doesNotMatch(macUpload, /--clobber/);

  assert.match(
    windows,
    /EXPECTED_RELEASE_ID:\s*\$\{\{ needs\.prepare-draft-release\.outputs\.release-id \}\}/
  );
  const signedSmoke = windows.lastIndexOf("npm run verify:windows --workspace apps/desktop");
  const windowsDraftCheck = windows.indexOf("Assert-DraftRelease", signedSmoke);
  const windowsPublicUpload = windows.indexOf("gh release upload", windowsDraftCheck);
  assert.ok(
    signedSmoke > 0 && windowsDraftCheck > signedSmoke && windowsPublicUpload > windowsDraftCheck
  );
  assert.match(windows, /\.Count -ne 1/);
  assert.match(windows, /\.draft -ne \$true/);
  assert.match(windows, /\.id[\s\S]*EXPECTED_RELEASE_ID/);
  assert.doesNotMatch(windows, /gh release upload[^\n]*--clobber/);
});

test("desktop publication revalidates the prepared draft identity immediately before publishing", async () => {
  const release = await text(".github/workflows/desktop-release.yml");
  const publish = release.slice(release.indexOf("  publish-release:"));
  const publishStep = publish.slice(
    publish.indexOf("- name: Publish the release"),
    publish.indexOf("- name: Dispatch post-release")
  );
  const draftCheck = publishStep.indexOf(".draft");
  const identityCheck = publishStep.indexOf("EXPECTED_RELEASE_ID");
  const patch = publishStep.indexOf("-F draft=false");

  assert.match(
    publish,
    /needs:\s*\[[^\]]*prepare-draft-release[^\]]*build-notarize-upload[^\]]*build-windows-upload[^\]]*\]/
  );
  assert.match(
    publish,
    /EXPECTED_RELEASE_ID:\s*\$\{\{ needs\.prepare-draft-release\.outputs\.release-id \}\}/
  );
  assert.ok(draftCheck >= 0 && draftCheck < patch, "draft:true must be required before PATCH");
  assert.ok(
    identityCheck >= 0 && identityCheck < patch,
    "the immutable prepared release id must be required before PATCH"
  );
});

test("macOS release credentials are scoped away from install, verification, and packaged smoke", async () => {
  const [release, packagedSmoke] = await Promise.all([
    text(".github/workflows/desktop-release.yml"),
    text("apps/desktop/scripts/verify-packaged.mjs"),
  ]);
  const mac = release.slice(
    release.indexOf("  build-notarize-upload:"),
    release.indexOf("  build-windows-upload:")
  );
  const header = mac.slice(0, mac.indexOf("    steps:"));
  const install = mac.slice(
    mac.indexOf("- name: Install dependencies"),
    mac.indexOf("- name:", mac.indexOf("- name: Install dependencies") + 1)
  );
  const staticVerify = mac.slice(
    mac.indexOf("- name: Verify the signed"),
    mac.indexOf("- name:", mac.indexOf("- name: Verify the signed") + 1)
  );
  const packagedVerify = mac.slice(
    mac.indexOf("- name: Launch the exact signed"),
    mac.indexOf("- name:", mac.indexOf("- name: Launch the exact signed") + 1)
  );
  const stageAt = mac.indexOf("- name: Build and stage the app without signing credentials");
  const installAt = mac.indexOf("- name: Install dependencies");
  const secretsCheckAt = mac.indexOf(
    "- name: Verify required signing and notarization secrets are set"
  );
  const appleKeyAt = mac.indexOf(
    "- name: Write the App Store Connect API key to a runner-temp file"
  );
  const identityAt = mac.indexOf("- name: Import the signing identity into a persistent keychain");
  const signedBuildAt = mac.indexOf("- name: Build and notarize the app");
  const dmgAt = mac.indexOf("- name: Sign, notarize, and staple the DMG");
  const cleanupAt = mac.indexOf("- name: Remove signing material from the runner");
  const staticVerifyAt = mac.indexOf("- name: Verify the signed and notarized release");
  const packagedVerifyAt = mac.indexOf("- name: Launch the exact signed packaged app");
  const uploadAt = mac.indexOf("- name: Upload the dmg to the release");

  for (const section of [header, install, staticVerify, packagedVerify]) {
    assert.doesNotMatch(
      section,
      /secrets\.(?:CSC_LINK|CSC_KEY_PASSWORD|APPLE_API_KEY|APPLE_API_KEY_ID|APPLE_API_ISSUER)/
    );
  }
  assert.match(mac, /- name: Build and notarize the app[\s\S]*secrets\.CSC_LINK/);
  assert.match(mac, /- name: Sign, notarize, and staple the DMG[\s\S]*APPLE_API_KEY:/);
  assert.ok(installAt >= 0 && installAt < stageAt);
  assert.ok(
    stageAt < secretsCheckAt &&
      secretsCheckAt < appleKeyAt &&
      appleKeyAt < identityAt &&
      identityAt < signedBuildAt,
    "dependency install and staging must finish before any signing secret is materialized"
  );
  assert.ok(
    signedBuildAt < dmgAt &&
      dmgAt < cleanupAt &&
      cleanupAt < staticVerifyAt &&
      staticVerifyAt < packagedVerifyAt &&
      packagedVerifyAt < uploadAt,
    "all signing material must be removed before verification, packaged launch, and upload"
  );
  assert.doesNotMatch(mac.slice(stageAt, secretsCheckAt), /secrets\.(?:CSC_|APPLE_)/);
  assert.match(mac.slice(stageAt, secretsCheckAt), /run stage/);
  assert.match(mac.slice(signedBuildAt), /run package:mac/);
  const cleanup = mac.slice(cleanupAt, staticVerifyAt);
  assert.match(cleanup, /rm -f "\$RUNNER_TEMP\/apple-api-key\.p8"/);
  assert.match(cleanup, /rm -f "\$RUNNER_TEMP\/signing-cert\.p12"/);
  assert.match(cleanup, /security delete-keychain/);
  assert.match(packagedSmoke, /delete childEnv\.(?:CSC_LINK|CSC_KEY_PASSWORD)/);
  assert.match(packagedSmoke, /delete childEnv\.APPLE_API_KEY/);
});

test("SignPath wiring is inert until approval and repository configuration exist", async () => {
  const [release, policy, readme, releaseDocs] = await Promise.all([
    text(".github/workflows/desktop-release.yml"),
    text("docs/CODE_SIGNING_POLICY.md"),
    text("README.md"),
    text("docs/RELEASE.md"),
  ]);
  const windows = release.slice(
    release.indexOf("  build-windows-upload:"),
    release.indexOf("  publish-release:")
  );

  assert.match(windows, /signpath\/github-action-submit-signing-request@[0-9a-f]{40}/i);
  assert.match(windows, /if:\s*\$\{\{[^\n]*SIGNPATH_ENABLED[^\n]*==\s*'true'/);
  assert.match(windows, /wait-for-completion:\s+true/);
  assert.match(policy, /^# Code signing policy/m);
  assert.match(policy, /planned[\s\S]*pending/i);
  assert.match(
    policy,
    /Free code signing provided by SignPath\.io, certificate by SignPath Foundation/
  );
  assert.match(policy, /Authors[\s\S]*Reviewers[\s\S]*Approvers/);
  assert.match(policy, /privacy/i);
  assert.match(policy, /uninstall/i);
  assert.match(readme, /Code signing policy/);
  assert.match(releaseDocs, /Code signing policy/);
});

test("Microsoft Store readiness names the real external publisher-identity prerequisite", async () => {
  const docs = await text("docs/WINDOWS.md");
  assert.match(docs, /Partner Center/i);
  assert.match(docs, /reserve[\s\S]*product name/i);
  assert.match(docs, /Publisher[\s\S]*Identity/i);
  assert.match(docs, /MSIX/i);
  assert.match(docs, /Store[\s\S]*sign/i);
  assert.match(docs, /not generated/i);
});
