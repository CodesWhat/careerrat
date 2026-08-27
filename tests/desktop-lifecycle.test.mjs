import assert from "node:assert/strict";
import { test } from "node:test";

test("desktop shutdown settles app-owned work before browser and server teardown", async () => {
  const lifecycle = await import("../apps/desktop/desktop-lifecycle.mjs").catch(() => null);
  assert.equal(typeof lifecycle?.shutdownDesktopRuntime, "function");

  const calls = [];
  const active = {
    stopWatching() {
      calls.push("watching:stop");
    },
    closeClients() {
      calls.push("clients:close");
    },
    async shutdownSourcingWorkers() {
      calls.push("sourcing:start");
      await Promise.resolve();
      calls.push("sourcing:end");
    },
    async shutdownIntake() {
      calls.push("intake:start");
      await Promise.resolve();
      calls.push("intake:end");
    },
    chatRuntime: {
      async shutdown() {
        calls.push("chat:shutdown");
      },
    },
    stopRuntimeSignIns() {
      calls.push("sign-ins:stop");
    },
    browserSessionManager: {
      async shutdown() {
        calls.push("browser:shutdown");
      },
    },
    server: {
      close(callback) {
        calls.push("server:close");
        callback();
      },
    },
  };

  await lifecycle.shutdownDesktopRuntime(active);

  assert.deepEqual(calls, [
    "watching:stop",
    "clients:close",
    "sourcing:start",
    "sourcing:end",
    "intake:start",
    "intake:end",
    "chat:shutdown",
    "sign-ins:stop",
    "browser:shutdown",
    "server:close",
  ]);
});
