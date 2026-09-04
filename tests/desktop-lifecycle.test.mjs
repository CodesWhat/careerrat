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
    async shutdownAiWebSearch() {
      calls.push("ai-search:start");
      await Promise.resolve();
      calls.push("ai-search:end");
    },
    async shutdownResumeExtractions() {
      calls.push("resume:start");
      await Promise.resolve();
      calls.push("resume:end");
    },
    async shutdownAppOperations() {
      calls.push("app-operations:start");
      await Promise.resolve();
      calls.push("app-operations:end");
    },
    chatRuntime: {
      async shutdown() {
        calls.push("chat:shutdown");
      },
    },
    stopRuntimeSignIns() {
      calls.push("sign-ins:stop");
    },
    async shutdownGuidedSetups() {
      calls.push("guided-setups:start");
      await Promise.resolve();
      calls.push("guided-setups:end");
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
    "ai-search:start",
    "ai-search:end",
    "resume:start",
    "resume:end",
    "app-operations:start",
    "app-operations:end",
    "chat:shutdown",
    "sign-ins:stop",
    "guided-setups:start",
    "guided-setups:end",
    "browser:shutdown",
    "server:close",
  ]);
});
