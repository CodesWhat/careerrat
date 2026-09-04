import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  createDesktopUpdateController,
  DEFAULT_STATE,
  nextUpdateCheckDelay,
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

describe("desktop updater controller: accepted install is authoritative", () => {
  it("advances the runtime phase to installing as soon as the install latches", () => {
    const { controller, updater } = makeController();
    updater.emit("update-downloaded", { version: "0.16.4" });
    assert.equal(controller.getState().phase, "ready");

    assert.equal(controller.acceptInstall(), true);

    assert.equal(controller.getState().phase, "installing");
  });

  it("reports installing from the direct setEnabled response while installing", () => {
    const { controller, updater } = makeController();
    updater.emit("update-downloaded", { version: "0.16.4" });
    controller.acceptInstall();

    const response = controller.setEnabled(false);

    assert.equal(response.phase, "installing");
  });

  it("reports installing from the direct checkNow response while installing", async () => {
    const { controller, updater } = makeController();
    updater.emit("update-downloaded", { version: "0.16.4" });
    controller.acceptInstall();

    const response = await controller.checkNow({ manual: true, force: true });

    assert.equal(response.phase, "installing");
    assert.equal(updater.checkCalls, 0);
  });

  it("pushes installing to the renderer the moment the install latches", () => {
    const { controller, updater, pushes } = makeController();
    updater.emit("update-downloaded", { version: "0.16.4" });
    const pushesBefore = pushes.length;

    controller.acceptInstall();

    assert.equal(pushes.length, pushesBefore + 1);
    assert.equal(pushes.at(-1).phase, "installing");
  });

  it("still allows install() once accepted, now that the phase is installing", () => {
    const { controller, updater } = makeController();
    updater.emit("update-downloaded", { version: "0.16.4" });
    assert.equal(controller.acceptInstall(), true);
    assert.equal(controller.getState().phase, "installing");

    assert.equal(controller.install(), true);
    assert.deepEqual(updater.installCalls, [[false, true]]);
  });

  it("keeps the operation persisted as ready while installing, so a failed handoff still reconciles on relaunch", () => {
    const { controller, updater, writes } = makeController();
    updater.emit("update-downloaded", { version: "0.16.4" });
    const writesBeforeAccept = writes.length;

    assert.equal(controller.acceptInstall(), true);

    // acceptInstall() must not persist operation:null: a failed native
    // handoff would otherwise lose the staged update on relaunch.
    assert.equal(writes.length, writesBeforeAccept);
    assert.deepEqual(writes.at(-1).operation, { phase: "ready", version: "0.16.4" });

    // Simulate a relaunch after the native handoff never completed: rebuild
    // a controller from the persisted state and confirm startup
    // reconciliation is still pending rather than lost.
    const rebuilt = makeController({ persisted: writes.at(-1) });
    assert.equal(rebuilt.controller.needsStartupCheck(), true);
    assert.equal(rebuilt.controller.getState().phase, "checking");
  });

  it("treats installing like ready for scheduling: no next check is armed", () => {
    const delay = nextUpdateCheckDelay({
      phase: "installing",
      enabled: true,
      lastCheckedAt: "2026-08-25T20:00:00Z",
      now: Date.parse("2026-08-26T20:00:00Z"),
    });
    assert.equal(delay, null);
  });
});
