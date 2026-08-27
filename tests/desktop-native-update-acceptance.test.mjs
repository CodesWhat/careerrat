import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

const roots = [];
const { privateKey: acceptancePrivateKey, publicKey: acceptancePublicKey } =
  generateKeyPairSync("ed25519");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function optionalImport(path) {
  try {
    return await import(new URL(path, import.meta.url));
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}

function acceptanceFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "careerrat-native-update-test-"));
  roots.push(root);
  const homeDir = join(root, "careerrat-home");
  const userDataDir = join(root, "electron-user-data");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  const sentinel = "career-rat-home-stays-put";
  writeFileSync(join(homeDir, "acceptance-sentinel.txt"), sentinel);
  const requestPath = join(root, "request.json");
  const requestBytes = Buffer.from(
    `${JSON.stringify({
      feedUrl: "http://127.0.0.1:48191/",
      fromVersion: "0.16.2",
      expectedVersion: "0.16.3",
      sentinel,
      ...overrides,
    })}\n`
  );
  const signaturePath = join(root, "request.sig");
  writeFileSync(requestPath, requestBytes);
  writeFileSync(
    signaturePath,
    `${sign(null, requestBytes, acceptancePrivateKey).toString("base64")}\n`
  );
  return { root, homeDir, userDataDir, requestPath, sentinel, signaturePath };
}

test("native update acceptance is explicit, packaged-only, and loopback-only", async () => {
  const acceptance = await optionalImport("../apps/desktop/native-update-acceptance.mjs");
  assert.ok(acceptance, "the packaged acceptance helper must exist");
  const fixture = acceptanceFixture();

  assert.equal(
    acceptance.resolveNativeUpdateAcceptance({
      argv: [],
      isPackaged: true,
      platform: "darwin",
      currentVersion: "0.16.2",
      userDataDir: fixture.userDataDir,
    }),
    null,
    "normal packaged launches must not acquire a feed override"
  );

  const resolved = acceptance.resolveNativeUpdateAcceptance({
    argv: [`--native-update-acceptance=${fixture.requestPath}`],
    isPackaged: true,
    platform: "darwin",
    currentVersion: "0.16.2",
    userDataDir: fixture.userDataDir,
    acceptancePublicKey,
  });
  assert.equal(resolved.mode, "start");
  assert.equal(resolved.feedUrl, "http://127.0.0.1:48191/");
  assert.equal(resolved.homeDir, fixture.homeDir);
  assert.equal(resolved.resultPath, join(fixture.root, "result.json"));

  assert.throws(
    () =>
      acceptance.resolveNativeUpdateAcceptance({
        argv: [`--native-update-acceptance=${fixture.requestPath}`],
        isPackaged: false,
        platform: "darwin",
        currentVersion: "0.16.2",
        userDataDir: fixture.userDataDir,
      }),
    /packaged macOS/i
  );

  for (const feedUrl of [
    "https://github.com/CodesWhat/careerrat/releases/latest",
    "http://localhost:48191/",
    "http://192.168.1.10:48191/",
  ]) {
    const unsafe = acceptanceFixture({ feedUrl });
    assert.throws(
      () =>
        acceptance.resolveNativeUpdateAcceptance({
          argv: [`--native-update-acceptance=${unsafe.requestPath}`],
          isPackaged: true,
          platform: "darwin",
          currentVersion: "0.16.2",
          userDataDir: unsafe.userDataDir,
          acceptancePublicKey,
        }),
      /literal loopback/i,
      feedUrl
    );
  }
});

test("native update acceptance rejects missing, invalid, and tampered request signatures", async () => {
  const acceptance = await optionalImport("../apps/desktop/native-update-acceptance.mjs");
  assert.ok(acceptance, "the packaged acceptance helper must exist");

  const missing = acceptanceFixture();
  const invalid = acceptanceFixture();
  const tampered = acceptanceFixture();
  rmSync(missing.signaturePath);
  writeFileSync(invalid.signaturePath, `${Buffer.alloc(64).toString("base64")}\n`);
  writeFileSync(tampered.requestPath, `${readFileSync(tampered.requestPath, "utf8")} `);

  for (const fixture of [missing, invalid, tampered]) {
    assert.throws(
      () =>
        acceptance.resolveNativeUpdateAcceptance({
          argv: [`--native-update-acceptance=${fixture.requestPath}`],
          isPackaged: true,
          platform: "darwin",
          currentVersion: "0.16.2",
          userDataDir: fixture.userDataDir,
          acceptancePublicKey,
        }),
      /valid Ed25519 signature/i
    );
  }
});

test("native update acceptance drives the updater and leaves a one-shot restart marker", async () => {
  const acceptance = await optionalImport("../apps/desktop/native-update-acceptance.mjs");
  assert.ok(acceptance, "the packaged acceptance helper must exist");
  const fixture = acceptanceFixture();
  const resolved = acceptance.resolveNativeUpdateAcceptance({
    argv: [`--native-update-acceptance=${fixture.requestPath}`],
    isPackaged: true,
    platform: "darwin",
    currentVersion: "0.16.2",
    userDataDir: fixture.userDataDir,
    acceptancePublicKey,
  });
  const calls = [];
  let controllerOptions;
  const updater = {
    setFeedURL(value) {
      calls.push(["feed", value]);
    },
  };

  const result = await acceptance.beginNativeUpdateAcceptance({
    acceptance: resolved,
    updater,
    createController(options) {
      controllerOptions = options;
      return {
        async checkNow() {
          options.push({ phase: "ready", version: "0.16.3" });
        },
        install() {
          calls.push(["install"]);
          return true;
        },
      };
    },
  });

  assert.deepEqual(calls, [
    ["feed", { provider: "generic", url: "http://127.0.0.1:48191/" }],
    ["install"],
  ]);
  assert.equal(
    updater.disableDifferentialDownload,
    true,
    "the loopback fixture serves one full signed ZIP, independent of updater cache state"
  );
  assert.equal(controllerOptions.selfUpdateSupported, true);
  assert.equal(controllerOptions.currentVersion, "0.16.2");
  assert.equal(result.installStarted, true);
  assert.deepEqual(JSON.parse(readFileSync(resolved.pointerPath, "utf8")), {
    requestPath: fixture.requestPath,
  });
});

test("restarted native update acceptance reports the new version and preserved home", async () => {
  const acceptance = await optionalImport("../apps/desktop/native-update-acceptance.mjs");
  assert.ok(acceptance, "the packaged acceptance helper must exist");
  const fixture = acceptanceFixture();
  const pointerPath = join(fixture.userDataDir, "native-update-acceptance.json");
  writeFileSync(pointerPath, `${JSON.stringify({ requestPath: fixture.requestPath })}\n`);

  const resolved = acceptance.resolveNativeUpdateAcceptance({
    argv: [],
    isPackaged: true,
    platform: "darwin",
    currentVersion: "0.16.3",
    userDataDir: fixture.userDataDir,
    acceptancePublicKey,
  });
  assert.equal(resolved.mode, "complete");

  const mutations = [];
  const result = acceptance.completeNativeUpdateAcceptance({
    acceptance: resolved,
    currentVersion: "0.16.3",
    removePointer(path) {
      mutations.push("remove-pointer");
      rmSync(path, { force: true });
    },
    writeResult(path, contents) {
      mutations.push("write-result");
      writeFileSync(path, contents);
    },
  });

  assert.deepEqual(result, {
    ok: true,
    fromVersion: "0.16.2",
    expectedVersion: "0.16.3",
    observedVersion: "0.16.3",
    sentinelPreserved: true,
  });
  assert.deepEqual(JSON.parse(readFileSync(resolved.resultPath, "utf8")), result);
  assert.equal(existsSync(pointerPath), false, "the restart marker must be one-shot");
  assert.deepEqual(mutations, ["remove-pointer", "write-result"]);
});

test("native acceptance runner rejects any result that did not transition and preserve data", async () => {
  const runner = await optionalImport("../apps/desktop/scripts/verify-native-update.mjs");
  assert.ok(runner, "the native acceptance runner must exist");

  assert.equal(runner.previousDesktopVersion("0.16.3"), "0.16.2");
  assert.equal(runner.previousDesktopVersion("1.0.0"), "0.999.999");
  assert.doesNotThrow(() =>
    runner.verifyNativeUpdateResult({
      result: {
        ok: true,
        fromVersion: "0.16.2",
        expectedVersion: "0.16.3",
        observedVersion: "0.16.3",
        sentinelPreserved: true,
      },
      fromVersion: "0.16.2",
      expectedVersion: "0.16.3",
    })
  );
  assert.throws(
    () =>
      runner.verifyNativeUpdateResult({
        result: {
          ok: true,
          fromVersion: "0.16.2",
          expectedVersion: "0.16.3",
          observedVersion: "0.16.2",
          sentinelPreserved: true,
        },
        fromVersion: "0.16.2",
        expectedVersion: "0.16.3",
      }),
    /did not report version 0\.16\.3/i
  );
});

test("desktop main handles native acceptance before normal boot and through clean shutdown", () => {
  const main = readFileSync(new URL("../apps/desktop/main.mjs", import.meta.url), "utf8");
  const resolveAt = main.indexOf("resolveNativeUpdateAcceptance(");
  const pathsAt = main.indexOf("resolveDesktopRuntimePaths(");
  const acceptanceAt = main.indexOf("beginNativeUpdateAcceptance(");
  const bootAt = main.lastIndexOf("const { url, route } = await boot()");

  assert.ok(resolveAt >= 0, "main must resolve the explicit packaged acceptance launch");
  assert.ok(resolveAt < pathsAt, "acceptance CAREERRAT_HOME must be known before runtime paths");
  assert.ok(acceptanceAt >= 0 && acceptanceAt < bootAt, "acceptance must bypass normal app boot");
  assert.match(main, /careerratHomeOverride:\s*nativeUpdateAcceptance\?\.homeDir/);
  assert.match(
    main,
    /requestInstall\(controller\)[\s\S]*installUpdateAfterShutdown = true[\s\S]*app\.quit\(\)/,
    "the acceptance installer must use the existing clean-shutdown path"
  );
  assert.match(main, /completeNativeUpdateAcceptance\([\s\S]*app\.exit\(result\.ok \? 0 : 1\)/);
  assert.match(
    main,
    /if \(!isSmoke && !nativeUpdateAcceptance && !nativeUpdateAcceptanceRequested\)/,
    "an invalid CI-only launch must exit instead of blocking on a GUI dialog"
  );
  assert.doesNotMatch(main, /shutdown\(\)\.finally\(/);
  assert.match(
    main,
    /shutdown\(\)\.then\([\s\S]*updateController\?\.install\(\)[\s\S]*,[\s\S]*shutdown failed[\s\S]*app\.exit\(1\)/i,
    "a rejected shutdown must exit without entering the install branch"
  );
});
