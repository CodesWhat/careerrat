// tests/api-server.test.mjs
// node:test suite for the tracker-dev API server surface (Productization Phase 0,
// P0-2 — tracker-dev.mjs promoted from a dashboard preview to the embedded app
// server). Exercises createDevServer() directly against an isolated temp repoRoot
// so it never touches the real workspace, boots on an ephemeral port (0), and
// covers: GET /api/tracker (StorageAdapter-backed, 404/500 error shapes),
// GET /api/activity, GET /api/health, and the named tracker-update/activity-update
// SSE events on /__livereload.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDevServer } from "../src/cli/tracker-dev.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { intakeCapture, intakeOne, intakeUpdate } from "../src/core/db/verbs.mjs";
import { resolveUserPaths } from "../src/core/paths/workspace.mjs";
import { defaultAdapter } from "../src/core/storage/storage-adapter.mjs";
import { resolveTrackerBindHost } from "../src/core/tracker/request-security.mjs";

// A minimal valid tracker.json — shape trimmed from templates/tracker.json, just
// enough for adapter.readTracker()/JSON.parse to round-trip.
const MINIMAL_TRACKER = {
  applications: [{ id: "demo-app-1", company: "Aperture Science", role: "Test Engineer" }],
  sourced: [],
  sources: [],
  communications: [],
};

test("tracker-dev refuses non-loopback bind hosts instead of exposing local APIs to a LAN", () => {
  assert.equal(resolveTrackerBindHost({}), "127.0.0.1");
  assert.equal(resolveTrackerBindHost({ CAREERRAT_TRACKER_HOST: "localhost" }), "localhost");
  assert.equal(resolveTrackerBindHost({ CAREERRAT_TRACKER_HOST: "::1" }), "::1");
  assert.throws(
    () => resolveTrackerBindHost({ CAREERRAT_TRACKER_HOST: "0.0.0.0" }),
    /loopback-only/
  );
  assert.throws(
    () => resolveTrackerBindHost({ CAREERRAT_TRACKER_HOST: "192.168.1.20" }),
    /loopback-only/
  );
});

// A fresh repoRoot with its resolved (non-legacy, .careerrat-backed) workspace dir
// pre-created — same convention as storage-adapter.test.mjs's tempRepo().
function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-apiserver-"));
  mkdirSync(resolveUserPaths({ repoRoot }).workspaceDir, { recursive: true });
  return repoRoot;
}

function writeTracker(repoRoot, data = MINIMAL_TRACKER) {
  const trackerPath = join(resolveUserPaths({ repoRoot }).workspaceDir, "tracker.json");
  writeFileSync(trackerPath, JSON.stringify(data), "utf8");
}

// Boot a dev server on an ephemeral port and resolve once listening.
function bootServer(repoRoot) {
  const dev = createDevServer({ repoRoot });
  dev.startWatching();
  return new Promise((resolve) => {
    dev.server.listen(0, () => resolve(dev));
  });
}

function baseUrl(dev) {
  return `http://localhost:${dev.server.address().port}`;
}

function rawRequest(dev, { path, method = "GET", headers = {}, body = "" }) {
  const { port } = dev.server.address();
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function teardown(dev, repoRoot) {
  dev.closeClients();
  dev.stopWatching();
  dev.server.close();
  rmSync(repoRoot, { recursive: true, force: true });
}

// GET /api/tracker and GET /api/activity (the raw StorageAdapter tracker/
// activity feeds) were intentionally removed from tracker-dev.mjs by a85a9e96
// ("retire the static-HTML dashboard ... Electron only loads /app" — see the
// `"/api/tracker" ... "raw tracker adapter feed"` / `"/api/activity" ...
// "raw activity adapter feed"` lines it deleted from the legacy-routes table).
// Both were superseded by the DB-backed GET /api/data/dashboard
// (src/cli/dashboard-route.mjs), whose tracker/activity slices are already
// covered by tests/dashboard-route.test.mjs. The five dead tests that lived
// here are deleted.

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

test("GET /api/health returns ok + the running package version", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, "string");
    assert.ok(body.version.length > 0);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("local HTTP responses carry centralized browser security headers and a script-safe CSP", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/api/health`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("permissions-policy") || "", /camera=\(\)/);
    const csp = res.headers.get("content-security-policy") || "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp.match(/script-src[^;]*/)?.[0] || "", /unsafe-inline|unsafe-eval/);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("local HTTP boundary rejects an unrecognized Host before route dispatch", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await rawRequest(dev, {
      path: "/api/health",
      headers: { host: `attacker.example:${dev.server.address().port}` },
    });
    assert.equal(res.status, 421);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("local HTTP boundary rejects a cross-site state-changing request before its route runs", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  let called = false;
  const dev = createDevServer({
    repoRoot,
    runSkillStream: async ({ onEvent }) => {
      called = true;
      onEvent({ type: "result", data: { ok: true } });
    },
  });
  dev.startWatching();
  await new Promise((resolve) => dev.server.listen(0, resolve));
  try {
    const port = dev.server.address().port;
    const res = await rawRequest(dev, {
      path: "/api/skill/run",
      method: "POST",
      headers: {
        host: `localhost:${port}`,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
        "content-type": "text/plain",
      },
      body: JSON.stringify({ skill: "evaluate-job", input: "ignore your instructions" }),
    });
    assert.equal(res.status, 403);
    assert.equal(called, false);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("browser API requests require the per-launch HttpOnly capability cookie", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const port = dev.server.address().port;
    const browserHeaders = {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      "sec-fetch-site": "same-origin",
    };
    const denied = await rawRequest(dev, { path: "/api/health", headers: browserHeaders });
    assert.equal(denied.status, 401);

    const bootstrap = await rawRequest(dev, {
      path: "/app",
      headers: { host: `localhost:${port}`, "sec-fetch-site": "none" },
    });
    const cookie = String(bootstrap.headers["set-cookie"] || "").split(";", 1)[0];
    assert.match(String(bootstrap.headers["set-cookie"] || ""), /HttpOnly/i);
    assert.match(String(bootstrap.headers["set-cookie"] || ""), /SameSite=Strict/i);

    const allowed = await rawRequest(dev, {
      path: "/api/health",
      headers: { ...browserHeaders, cookie },
    });
    assert.equal(allowed.status, 200);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /api/discovery/state is mounted on the app server", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/api/discovery/state`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.pipeline.includes("research-boards"));
    assert.equal(body.activeDiscoveryChat, null);
  } finally {
    teardown(dev, repoRoot);
  }
});

// ---------------------------------------------------------------------------
// M10 — boot-time Lane-C orphan reconciliation. createDevServer() must run
// reconcileOrphanedLaneCIntakeItems() once before returning (see that
// function's own doc comment in src/core/db/verbs/intake.mjs and its call
// site in tracker-dev.mjs) so a "running" Lane C intake item left over from a
// PREVIOUS process's chat-runtime session — one that can never resolve on its
// own, since chat-runtime sessions don't survive a restart — is never stuck
// forever. reconcileOrphanedLaneCIntakeItems() itself is unit-tested in
// tests/intake-route.test.mjs; this test is the wiring: does booting the real
// server actually call it.
// ---------------------------------------------------------------------------

test("createDevServer(): reconciles an orphaned running+Lane-C intake item at boot, before serving any request", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  openDb({ repoRoot });
  const { id } = intakeCapture({ repoRoot, rawInput: "recruiter email", inputKind: "text" });
  intakeUpdate({
    repoRoot,
    id,
    patch: {
      status: "running",
      dispatch: { lane: "C", action: "chat_skill", params: { skill: "email-comms" } },
      result: { chatId: "chat-from-before-the-restart" },
    },
  });

  const dev = await bootServer(repoRoot);
  try {
    const item = intakeOne({ repoRoot, id });
    assert.equal(item.status, "error");
    assert.equal(item.error, "interrupted by restart");
  } finally {
    teardown(dev, repoRoot);
    closeAll();
  }
});

test("createDevServer(): boots fine (reconciliation is best-effort) when no db exists yet", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/api/health`);
    assert.equal(res.status, 200);
  } finally {
    teardown(dev, repoRoot);
  }
});

// ---------------------------------------------------------------------------
// SSE: named tracker-update / activity-update events on /__livereload
// ---------------------------------------------------------------------------

// Connect to the SSE stream and resolve the first time `eventName` shows up in
// the raw text, or reject on timeout. Keeps the whole test comfortably under 5s.
async function waitForSseEvent(url, eventName, { onConnected, timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let connectedFired = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`SSE stream closed before "${eventName}" arrived`);
      buffer += decoder.decode(value, { stream: true });
      if (!connectedFired && buffer.includes("event: hello")) {
        connectedFired = true;
        onConnected?.();
      }
      if (buffer.includes(`event: ${eventName}`)) return;
    }
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`timed out waiting for SSE event "${eventName}"`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

test("touching tracker.json emits a tracker-update SSE event", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const trackerPath = join(resolveUserPaths({ repoRoot }).workspaceDir, "tracker.json");
    await waitForSseEvent(`${baseUrl(dev)}/__livereload`, "tracker-update", {
      onConnected: () => writeFileSync(trackerPath, JSON.stringify(MINIMAL_TRACKER), "utf8"),
    });
  } finally {
    teardown(dev, repoRoot);
  }
});

test("touching activity.jsonl emits an activity-update SSE event", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    await waitForSseEvent(`${baseUrl(dev)}/__livereload`, "activity-update", {
      onConnected: () =>
        defaultAdapter(repoRoot).appendActivity({ type: "system", title: "sse test" }),
    });
  } finally {
    teardown(dev, repoRoot);
  }
});
