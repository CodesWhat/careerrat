import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  CHECK_INTERVAL_MS,
  createDesktopUpdateController,
  DEFAULT_STATE,
  nextUpdateCheckDelay,
  updaterErrorCopy,
} from "../apps/desktop/update-check.mjs";

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = false;
    this.autoInstallOnAppQuit = true;
    this.allowPrerelease = true;
    this.allowDowngrade = true;
    this.checkCalls = 0;
    this.installCalls = [];
  }

  async checkForUpdates() {
    this.checkCalls += 1;
    return { updateInfo: { version: "0.16.4" } };
  }

  quitAndInstall(...args) {
    this.installCalls.push(args);
  }
}

function makeController({ platform = "darwin", persisted = DEFAULT_STATE } = {}) {
  const updater = new FakeUpdater();
  const writes = [];
  const pushes = [];
  const logs = [];
  const controller = createDesktopUpdateController({
    updater,
    platform,
    currentVersion: "0.16.3",
    persisted,
    now: () => Date.parse("2026-08-26T20:00:00Z"),
    persist: (state) => writes.push(state),
    push: (state) => pushes.push(state),
    log: (message) => logs.push(message),
  });
  return { controller, updater, writes, pushes, logs };
}

describe("desktop updater controller", () => {
  it("configures the pinned v6 updater for explicit restart installation", () => {
    const { updater } = makeController();

    assert.equal(updater.autoDownload, true);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(updater.allowPrerelease, false);
    assert.equal(updater.allowDowngrade, false);
  });

  it("replaces the per-install staging header with one shared CareerRat value", () => {
    const firstUpdater = new FakeUpdater();
    firstUpdater.requestHeaders = { Accept: "application/octet-stream" };
    createDesktopUpdateController({
      updater: firstUpdater,
      platform: "darwin",
      currentVersion: "0.16.3",
    });

    const secondUpdater = new FakeUpdater();
    createDesktopUpdateController({
      updater: secondUpdater,
      platform: "darwin",
      currentVersion: "0.16.3",
    });

    assert.equal(firstUpdater.requestHeaders.Accept, "application/octet-stream");
    assert.equal(
      firstUpdater.requestHeaders["x-user-staging-id"],
      "00000000-0000-5000-8000-000000000000"
    );
    assert.equal(
      secondUpdater.requestHeaders["x-user-staging-id"],
      firstUpdater.requestHeaders["x-user-staging-id"]
    );
  });

  it("maps the native lifecycle into typed, candidate-safe state", () => {
    const { controller, updater, pushes } = makeController();

    updater.emit("checking-for-update");
    assert.equal(controller.getState().phase, "checking");

    updater.emit("update-available", { version: "0.16.4" });
    assert.equal(controller.getState().phase, "downloading");
    assert.equal(controller.getState().version, "0.16.4");

    updater.emit("download-progress", {
      percent: 42.49,
      transferred: 4249,
      total: 10000,
    });
    assert.equal(controller.getState().progress, 42);

    updater.emit("update-downloaded", { version: "0.16.4" });
    assert.equal(controller.getState().phase, "ready");
    assert.equal(controller.getState().notify, true);
    assert.equal(controller.getState().progress, 100);
    assert.ok(pushes.length >= 4);
  });

  it("starts a check and download without opening GitHub", async () => {
    const { controller, updater, writes } = makeController();

    const state = await controller.checkNow({ manual: true });

    assert.equal(updater.checkCalls, 1);
    assert.equal(state.phase, "checking");
    assert.equal(state.manual, true);
    assert.equal(writes.at(-1).lastCheckedAt, Date.parse("2026-08-26T20:00:00Z"));
  });

  it("only installs after update-downloaded and uses the v6 positional API", () => {
    const { controller, updater } = makeController();

    assert.equal(controller.install(), false);
    updater.emit("update-downloaded", { version: "0.16.4" });
    assert.equal(controller.install(), true);
    assert.deepEqual(updater.installCalls, [[false, true]]);
  });

  it("keeps a downloaded update cached while Later hides its prompt", async () => {
    const { controller, updater, writes } = makeController();
    await controller.checkNow({ manual: true });
    updater.emit("update-downloaded", { version: "0.16.4" });

    const state = controller.skipVersion("0.16.4");

    assert.equal(state.phase, "ready");
    assert.equal(state.notify, false);
    assert.equal(state.manual, false);
    assert.equal(writes.at(-1).skippedVersion, "0.16.4");
    assert.equal(controller.install(), true);
  });

  it("does not invoke the native updater and links to honest Windows release status", async () => {
    const { controller, updater } = makeController({ platform: "win32" });

    const state = await controller.checkNow({ manual: true });

    assert.equal(state.supported, false);
    assert.equal(state.phase, "unsupported");
    assert.equal(state.manual, true);
    assert.match(state.message, /can't install updates inside the Windows app/i);
    assert.match(state.message, /installer isn't publicly available yet/i);
    assert.doesNotMatch(state.message, /download the current version|run the installer/i);
    assert.equal(
      state.downloadUrl,
      "https://github.com/CodesWhat/careerrat/blob/main/docs/WINDOWS.md"
    );
    assert.equal(updater.checkCalls, 0);
    assert.equal(controller.install(), false);
  });

  it("turns native failures into typed recovery without leaking raw jargon", () => {
    const cases = [
      [
        "Cannot update while running on a read-only volume /Volumes/CareerRat",
        "move-to-applications",
      ],
      ["sha512 checksum mismatch in latest-mac.yml", "verification"],
      ["net::ERR_CONNECTION_RESET fetching github.com", "network"],
      ["ShipIt exited with ENOENT at /Users/person/Library/Caches", "unknown"],
    ];

    for (const [raw, expectedKind] of cases) {
      const { controller, updater, logs } = makeController();
      updater.emit("error", new Error(raw));
      const state = controller.getState();
      assert.equal(state.phase, "error");
      assert.equal(state.errorKind, expectedKind);
      assert.doesNotMatch(
        JSON.stringify(state),
        /ShipIt|ENOENT|sha512|latest-mac|\/Users|github\.com/
      );
      assert.equal(logs.at(-1), raw);
    }
  });

  it("reports current only from update-not-available", () => {
    const { controller, updater } = makeController();
    updater.emit("update-not-available", { version: "0.16.3" });

    assert.equal(controller.getState().phase, "current");
    assert.equal(controller.getState().version, "0.16.3");
  });
});

describe("updater error copy", () => {
  it("gives people a next step for every native failure class", () => {
    assert.match(updaterErrorCopy("read-only volume").message, /Applications/);
    assert.match(updaterErrorCopy("checksum mismatch").message, /wasn.t installed/);
    assert.match(updaterErrorCopy("ECONNRESET").message, /connection/);
    assert.match(updaterErrorCopy("unrecognized native failure").message, /Try again/);
  });
});

describe("next update check delay", () => {
  it("respects the preference, cadence, and first-launch delay", () => {
    const now = Date.parse("2026-08-26T20:00:00Z");
    assert.equal(nextUpdateCheckDelay({ enabled: false, now }), null);
    assert.equal(nextUpdateCheckDelay({ lastCheckedAt: null, initialDelayMs: 5000, now }), 5000);
    assert.equal(
      nextUpdateCheckDelay({ lastCheckedAt: now - 1000, now }),
      CHECK_INTERVAL_MS - 1000
    );
  });
});
