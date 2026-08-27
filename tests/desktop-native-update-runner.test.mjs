import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  choosePriorAcceptanceKind,
  hasNativeAcceptanceHook,
  sanitizeAcceptanceChildEnv,
  selectPriorFeedAssets,
  selectPriorPublishedRelease,
  signAcceptanceRequest,
  writeSignedAcceptanceRequest,
} from "../apps/desktop/scripts/verify-native-update.mjs";

test("acceptance request signature covers the exact request.json bytes", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const requestBytes = Buffer.from('{"feedUrl":"http://127.0.0.1:43119/"}\n');
  const signature = signAcceptanceRequest({
    requestBytes,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
  });

  assert.equal(verify(null, requestBytes, publicKey, signature), true);
  assert.equal(
    verify(null, Buffer.from(requestBytes.toString("utf8").trim()), publicKey, signature),
    false,
    "normalizing even the trailing newline must invalidate the signature"
  );
});

test("runner writes exact request.json bytes and a sibling base64 request.sig", () => {
  const root = mkdtempSync(join(tmpdir(), "careerrat-runner-signature-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const requestPath = join(root, "request.json");
    const requestBytes = Buffer.from('{"sentinel":"exact bytes"}\n');
    const signaturePath = writeSignedAcceptanceRequest({
      requestPath,
      requestBytes,
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    });

    assert.deepEqual(readFileSync(requestPath), requestBytes);
    assert.equal(signaturePath, join(root, "request.sig"));
    assert.equal(
      verify(
        null,
        requestBytes,
        publicKey,
        Buffer.from(readFileSync(signaturePath, "utf8").trim(), "base64")
      ),
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaged acceptance child receives no release or signing credentials", () => {
  const env = sanitizeAcceptanceChildEnv({
    PATH: "/usr/bin:/bin",
    SAFE_VALUE: "kept",
    CSC_LINK: "certificate",
    CSC_KEY_PASSWORD: "password",
    APPLE_API_KEY: "/private/apple-key.p8",
    APPLE_API_KEY_ID: "key-id",
    APPLE_API_ISSUER: "issuer",
    NATIVE_UPDATE_ACCEPTANCE_PRIVATE_KEY: "private-key",
    GH_TOKEN: "github-release-credential",
    GITHUB_TOKEN: "github-actions-credential",
  });

  assert.deepEqual(env, { PATH: "/usr/bin:/bin", SAFE_VALUE: "kept" });
});

test("runner selects the greatest published stable release below N+1", () => {
  const prior = selectPriorPublishedRelease(
    [
      { tag_name: "v0.16.5", draft: false, prerelease: false },
      { tag_name: "v0.16.4", draft: true, prerelease: false },
      { tag_name: "v0.16.3", draft: false, prerelease: false },
      { tag_name: "v0.16.2", draft: false, prerelease: false },
      { tag_name: "v0.16.4-beta.1", draft: false, prerelease: true },
    ],
    "0.16.5"
  );

  assert.equal(prior.tag_name, "v0.16.3");
});

test("prior feed requires one exact-version ZIP and latest-mac.yml", () => {
  assert.deepEqual(
    selectPriorFeedAssets(
      {
        assets: [
          { name: "CareerRat-0.16.4-arm64-mac.zip" },
          { name: "latest-mac.yml" },
          { name: "CareerRat-0.16.4-arm64-mac.zip.blockmap" },
        ],
      },
      "0.16.4"
    ),
    {
      zipName: "CareerRat-0.16.4-arm64-mac.zip",
      metadataName: "latest-mac.yml",
    }
  );
  assert.equal(selectPriorFeedAssets({ assets: [] }, "0.16.3"), null);
  assert.throws(
    () =>
      selectPriorFeedAssets(
        {
          assets: [
            { name: "CareerRat-0.16.4-arm64-mac.zip" },
            { name: "CareerRat-copy-0.16.4-arm64-mac.zip" },
            { name: "latest-mac.yml" },
          ],
        },
        "0.16.4"
      ),
    /exactly one updater ZIP/i
  );
});

test("acceptance hook inspection recognizes only the packaged helper path", () => {
  assert.equal(
    hasNativeAcceptanceHook("/main.mjs\n/native-update-acceptance.mjs\n/package.json\n"),
    true
  );
  assert.equal(hasNativeAcceptanceHook("/docs/native-update-acceptance.mjs.txt\n"), false);
});

test("only public 0.16.3 may use the synthetic bootstrap fixture", () => {
  assert.equal(
    choosePriorAcceptanceKind({
      priorVersion: "0.16.3",
      publishedFeedAvailable: false,
      acceptanceHookPresent: false,
    }),
    "bootstrap"
  );
  assert.equal(
    choosePriorAcceptanceKind({
      priorVersion: "0.16.4",
      publishedFeedAvailable: true,
      acceptanceHookPresent: true,
    }),
    "published"
  );
  assert.throws(
    () =>
      choosePriorAcceptanceKind({
        priorVersion: "0.16.4",
        publishedFeedAvailable: false,
        acceptanceHookPresent: false,
      }),
    /prior published updater feed is missing/i
  );
  assert.throws(
    () =>
      choosePriorAcceptanceKind({
        priorVersion: "0.16.4",
        publishedFeedAvailable: true,
        acceptanceHookPresent: false,
      }),
    /does not contain the native update acceptance hook/i
  );
});

test("runner integrates the published prior app, signed request, and scrubbed child", () => {
  const source = readFileSync(
    new URL("../apps/desktop/scripts/verify-native-update.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /gh["'],\s*\[\s*["']api["']/);
  assert.match(source, /gh["'],\s*\[\s*["']release["'],\s*["']download["']/);
  assert.match(
    source,
    /verifyMacUpdateFeed\(\{\s*zipPath,\s*metadataPath,\s*expectedVersion:\s*priorVersion/s
  );
  assert.match(source, /runChecked\(["']ditto["'],\s*\[["']-x["'],\s*["']-k["']/);
  assert.match(source, /runChecked\(["']spctl["'],\s*\[["']--assess["']/);
  assert.match(source, /hasNativeAcceptanceHook\(asarListing\)/);
  assert.match(source, /writeSignedAcceptanceRequest\(\{/);
  assert.match(source, /env:\s*sanitizeAcceptanceChildEnv\(process\.env\)/);
});
