import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyLocalAppRuntime,
  commandMatchesTrackerScript,
  findAvailableLoopbackPort,
  parseRecordedPid,
  readLocalAppHealth,
  trackerCommandPort,
} from "../src/core/update/local-app-runtime.mjs";

test("matching CareerRat runtime is reused without requiring a recorded PID", () => {
  assert.deepEqual(
    classifyLocalAppRuntime({
      health: {
        responding: true,
        careerrat: true,
        productVerified: true,
        version: "0.7.2",
        pid: 42,
      },
      installedVersion: "0.7.2",
      recordedPid: null,
      recordedProcessIsTracker: false,
    }),
    { state: "current", pid: 42 }
  );
});

test("stale CareerRat runtime is replaceable only when its reported PID matches the owned PID", () => {
  assert.deepEqual(
    classifyLocalAppRuntime({
      health: {
        responding: true,
        careerrat: true,
        productVerified: true,
        version: "0.7.1",
        pid: 42,
      },
      installedVersion: "0.7.2",
      recordedPid: 42,
      recordedProcessIsTracker: true,
    }),
    { state: "stale-owned", pid: 42, runningVersion: "0.7.1" }
  );
});

test("a stale PID file never authorizes killing a different responding process", () => {
  assert.deepEqual(
    classifyLocalAppRuntime({
      health: {
        responding: true,
        careerrat: true,
        productVerified: true,
        version: "0.7.1",
        pid: 99,
      },
      installedVersion: "0.7.2",
      recordedPid: 42,
      recordedProcessIsTracker: true,
    }),
    { state: "stale-unowned", runningVersion: "0.7.1" }
  );
});

test("an unowned legacy health lookalike is never reused as the current app", () => {
  assert.deepEqual(
    classifyLocalAppRuntime({
      health: {
        responding: true,
        careerrat: true,
        productVerified: false,
        version: "0.7.2",
        pid: null,
      },
      installedVersion: "0.7.2",
      recordedPid: null,
      recordedProcessIsTracker: false,
    }),
    { state: "foreign" }
  );
});

test("a matching reported PID still requires the recorded tracker command", () => {
  assert.deepEqual(
    classifyLocalAppRuntime({
      health: {
        responding: true,
        careerrat: true,
        productVerified: true,
        version: "0.7.1",
        pid: 42,
      },
      installedVersion: "0.7.2",
      recordedPid: 42,
      recordedProcessIsTracker: false,
    }),
    { state: "stale-unowned", runningVersion: "0.7.1" }
  );
});

test("legacy CareerRat health without a PID can use an exact tracker command ownership check", () => {
  assert.deepEqual(
    classifyLocalAppRuntime({
      health: { responding: true, careerrat: true, version: "0.7.0" },
      installedVersion: "0.7.1",
      recordedPid: 42,
      recordedProcessIsTracker: true,
    }),
    { state: "stale-owned", pid: 42, runningVersion: "0.7.0" }
  );
});

test("foreign listeners are never classified as CareerRat-owned", () => {
  assert.deepEqual(
    classifyLocalAppRuntime({
      health: { responding: true, careerrat: false, version: null, pid: null },
      installedVersion: "0.7.2",
      recordedPid: 42,
      recordedProcessIsTracker: true,
    }),
    { state: "foreign" }
  );
});

test("recorded PID parsing accepts positive integers only", () => {
  assert.equal(parseRecordedPid("42\n"), 42);
  assert.equal(parseRecordedPid("0"), null);
  assert.equal(parseRecordedPid("-1"), null);
  assert.equal(parseRecordedPid("42 trailing"), null);
  assert.equal(parseRecordedPid(""), null);
});

test("tracker ownership requires the exact expected script path", () => {
  const trackerScript = "/opt/careerrat/src/cli/tracker-dev.mjs";
  assert.equal(
    commandMatchesTrackerScript(
      "/usr/local/bin/node /opt/careerrat/src/cli/tracker-dev.mjs --port 7777",
      trackerScript
    ),
    true
  );
  assert.equal(
    commandMatchesTrackerScript(
      "/usr/local/bin/node /tmp/other/src/cli/tracker-dev.mjs --port 7777",
      trackerScript
    ),
    false
  );
  assert.equal(
    commandMatchesTrackerScript(
      "/usr/local/bin/node /opt/careerrat/src/cli/tracker-dev.mjs.evil --port 7777",
      trackerScript
    ),
    false
  );
});

test("tracker command ports distinguish default and explicitly selected runtimes", () => {
  assert.equal(trackerCommandPort("node /opt/careerrat/src/cli/tracker-dev.mjs"), 7777);
  assert.equal(trackerCommandPort("node /opt/careerrat/src/cli/tracker-dev.mjs --port 7792"), 7792);
  assert.equal(trackerCommandPort("node /opt/careerrat/src/cli/tracker-dev.mjs --port=7793"), 7793);
  assert.equal(trackerCommandPort("node app.mjs --port invalid"), null);
});

test("health reader distinguishes CareerRat JSON from a foreign HTTP listener", async () => {
  const current = await readLocalAppHealth("http://127.0.0.1:7777", {
    fetchImpl: async (url) => {
      assert.equal(url, "http://127.0.0.1:7777/api/health");
      return {
        ok: true,
        json: async () => ({ ok: true, product: "careerrat", version: "0.7.2", pid: 42 }),
      };
    },
  });
  assert.deepEqual(current, {
    responding: true,
    careerrat: true,
    productVerified: true,
    version: "0.7.2",
    pid: 42,
  });

  const legacy = await readLocalAppHealth("http://127.0.0.1:7777", {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, version: "0.7.1" }),
    }),
  });
  assert.deepEqual(legacy, {
    responding: true,
    careerrat: true,
    productVerified: false,
    version: "0.7.1",
    pid: null,
  });

  const foreign = await readLocalAppHealth("http://127.0.0.1:7777", {
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.deepEqual(foreign, {
    responding: true,
    careerrat: false,
    productVerified: false,
    version: null,
    pid: null,
  });
});

test("fallback port selection skips occupied ports without mutating them", async () => {
  const visited = [];
  const port = await findAvailableLoopbackPort({
    startPort: 7778,
    maxAttempts: 4,
    isAvailable: async (candidate) => {
      visited.push(candidate);
      return candidate === 7780;
    },
  });

  assert.equal(port, 7780);
  assert.deepEqual(visited, [7778, 7779, 7780]);
});
