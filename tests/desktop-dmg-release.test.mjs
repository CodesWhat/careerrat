import assert from "node:assert/strict";
import test from "node:test";

async function loadReleaseModule() {
  return import("../apps/desktop/dmg-release.mjs").catch(() => ({}));
}

test("desktop DMG release resolves a Keychain profile without embedding credentials", async () => {
  const release = await loadReleaseModule();
  assert.equal(typeof release.resolveNotaryCredentials, "function");

  assert.deepEqual(
    release.resolveNotaryCredentials({
      APPLE_KEYCHAIN_PROFILE: "careerrat-notary",
      APPLE_KEYCHAIN: "/tmp/release.keychain-db",
    }),
    ["--keychain-profile", "careerrat-notary", "--keychain", "/tmp/release.keychain-db"]
  );
  assert.deepEqual(
    release.resolveNotaryCredentials({
      APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
      APPLE_API_KEY_ID: "KEYID12345",
      APPLE_API_ISSUER: "11111111-2222-3333-4444-555555555555",
    }),
    [
      "--key",
      "/tmp/AuthKey_TEST.p8",
      "--key-id",
      "KEYID12345",
      "--issuer",
      "11111111-2222-3333-4444-555555555555",
    ]
  );
  assert.throws(
    () => release.resolveNotaryCredentials({ APPLE_KEYCHAIN_PROFILE: "" }),
    /notarization credentials/i
  );
});

test("desktop DMG release reads the Developer ID identity from the signed app", async () => {
  const release = await loadReleaseModule();
  assert.equal(typeof release.parseDeveloperIdAuthority, "function");

  assert.equal(
    release.parseDeveloperIdAuthority(
      "Executable=/tmp/CareerRat.app/Contents/MacOS/CareerRat\n" +
        "Authority=Developer ID Application: Example Person (TEAMID1234)\n" +
        "Authority=Developer ID Certification Authority\n"
    ),
    "Developer ID Application: Example Person (TEAMID1234)"
  );
  assert.throws(() => release.parseDeveloperIdAuthority("Authority=Apple Root CA"), /Developer ID/);
});

test("desktop DMG release signs, submits, and staples the container in order", async () => {
  const release = await loadReleaseModule();
  assert.equal(typeof release.releaseDmgContainer, "function");

  const calls = [];
  release.releaseDmgContainer({
    dmgPath: "/tmp/CareerRat.dmg",
    signingIdentity: "Developer ID Application: Example (TEAMID1234)",
    env: { APPLE_KEYCHAIN_PROFILE: "careerrat-notary" },
    run(command, args) {
      calls.push([command, args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(calls, [
    [
      "codesign",
      ["--force", "--sign", "Developer ID Application: Example (TEAMID1234)", "/tmp/CareerRat.dmg"],
    ],
    [
      "xcrun",
      [
        "notarytool",
        "submit",
        "/tmp/CareerRat.dmg",
        "--keychain-profile",
        "careerrat-notary",
        "--wait",
      ],
    ],
    ["xcrun", ["stapler", "staple", "/tmp/CareerRat.dmg"]],
  ]);
});

test("desktop DMG release stops at the first failed container command", async () => {
  const release = await loadReleaseModule();
  assert.equal(typeof release.releaseDmgContainer, "function");

  const calls = [];
  assert.throws(
    () =>
      release.releaseDmgContainer({
        dmgPath: "/tmp/CareerRat.dmg",
        signingIdentity: "Developer ID Application: Example (TEAMID1234)",
        env: { APPLE_KEYCHAIN_PROFILE: "careerrat-notary" },
        run(command, args) {
          calls.push([command, args]);
          return { status: command === "codesign" ? 1 : 0, stdout: "", stderr: "bad signature" };
        },
      }),
    /DMG signing failed/i
  );
  assert.equal(calls.length, 1);
});

test("final release smoke mounts the exact canonical DMG read-only and detaches it", async () => {
  const release = await import("../apps/desktop/mounted-release-acceptance.mjs").catch(() => ({}));
  assert.equal(typeof release.verifyMountedReleaseDmg, "function");
  const calls = [];

  const result = await release.verifyMountedReleaseDmg({
    dmgPath: "/dist/CareerRat-0.16.6-arm64.dmg",
    expectedVersion: "0.16.6",
    run(command, args) {
      calls.push([command, args]);
      if (command === "hdiutil" && args[0] === "attach") {
        return {
          status: 0,
          stdout:
            "<plist><dict><key>system-entities</key><array><dict><key>mount-point</key><string>/Volumes/CareerRat</string></dict></array></dict></plist>",
          stderr: "",
        };
      }
      if (command === "/usr/libexec/PlistBuddy") {
        return { status: 0, stdout: "0.16.6\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    listDirectory(path) {
      assert.equal(path, "/Volumes/CareerRat");
      return ["Applications", "CareerRat.app"];
    },
    smoke({ appPath }) {
      calls.push(["smoke", appPath]);
      return "SMOKE OK http://127.0.0.1:47777";
    },
    createDataDir() {
      return "/tmp/careerrat-mounted-smoke";
    },
    removeDataDir(path) {
      calls.push(["remove-data", path]);
    },
  });

  assert.equal(result.appPath, "/Volumes/CareerRat/CareerRat.app");
  assert.deepEqual(calls[0], [
    "hdiutil",
    ["attach", "-readonly", "-nobrowse", "-plist", "/dist/CareerRat-0.16.6-arm64.dmg"],
  ]);
  assert.ok(calls.some(([command]) => command === "codesign"));
  assert.ok(calls.some(([command]) => command === "spctl"));
  assert.ok(calls.some(([command]) => command === "smoke"));
  assert.deepEqual(calls.at(-1), ["hdiutil", ["detach", "/Volumes/CareerRat"]]);
});

test("mounted release smoke always detaches and rejects duplicate app bundles", async () => {
  const release = await import("../apps/desktop/mounted-release-acceptance.mjs").catch(() => ({}));
  assert.equal(typeof release.verifyMountedReleaseDmg, "function");
  const calls = [];
  await assert.rejects(
    release.verifyMountedReleaseDmg({
      dmgPath: "/dist/CareerRat-0.16.6-arm64.dmg",
      expectedVersion: "0.16.6",
      run(command, args) {
        calls.push([command, args]);
        if (args[0] === "attach") {
          return {
            status: 0,
            stdout: "<key>mount-point</key><string>/Volumes/CareerRat</string>",
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      listDirectory() {
        return ["CareerRat.app", "Copies/CareerRat.app"];
      },
      createDataDir() {
        return "/tmp/careerrat-mounted-smoke";
      },
      removeDataDir() {},
    }),
    /exactly one CareerRat\.app/i
  );
  assert.deepEqual(calls.at(-1), ["hdiutil", ["detach", "/Volumes/CareerRat"]]);
});

test("mounted release smoke detaches even when scratch setup fails", async () => {
  const { verifyMountedReleaseDmg } = await import(
    "../apps/desktop/mounted-release-acceptance.mjs"
  );
  const calls = [];
  await assert.rejects(
    verifyMountedReleaseDmg({
      dmgPath: "/dist/CareerRat-0.16.6-arm64.dmg",
      expectedVersion: "0.16.6",
      run(command, args) {
        calls.push([command, args]);
        if (args[0] === "attach") {
          return {
            status: 0,
            stdout: "<key>mount-point</key><string>/Volumes/CareerRat</string>",
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      createDataDir() {
        throw new Error("scratch unavailable");
      },
    }),
    /scratch unavailable/
  );
  assert.deepEqual(calls.at(-1), ["hdiutil", ["detach", "/Volumes/CareerRat"]]);
});
