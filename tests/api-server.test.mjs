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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDevServer } from "../src/cli/tracker-dev.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { intakeCapture, intakeOne, intakeUpdate } from "../src/core/db/verbs.mjs";
import { resolveUserPaths } from "../src/core/paths/workspace.mjs";
import { defaultAdapter } from "../src/core/storage/storage-adapter.mjs";

// A minimal valid tracker.json — shape trimmed from templates/tracker.json, just
// enough for adapter.readTracker()/JSON.parse to round-trip.
const MINIMAL_TRACKER = {
  applications: [{ id: "demo-app-1", company: "Aperture Science", role: "Test Engineer" }],
  sourced: [],
  sources: [],
  communications: [],
};

// A fresh repoRoot with its resolved (non-legacy, .rolester-backed) workspace dir
// pre-created — same convention as storage-adapter.test.mjs's tempRepo().
function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-apiserver-"));
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

function teardown(dev, repoRoot) {
  dev.closeClients();
  dev.stopWatching();
  dev.server.close();
  rmSync(repoRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// GET /api/tracker
// ---------------------------------------------------------------------------

test("GET /api/tracker returns the parsed tracker.json as JSON", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/api/tracker`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const body = await res.json();
    assert.equal(body.applications[0].company, "Aperture Science");
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /api/tracker returns a 404 JSON error when tracker.json is missing", async () => {
  const repoRoot = tempRepo();
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/api/tracker`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error, "expected a JSON error body");
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /api/tracker returns a 500 JSON error when tracker.json is corrupt", async () => {
  const repoRoot = tempRepo();
  const trackerPath = join(resolveUserPaths({ repoRoot }).workspaceDir, "tracker.json");
  writeFileSync(trackerPath, "{not valid json", "utf8");
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/api/tracker`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(body.error, "expected a JSON error body");
  } finally {
    teardown(dev, repoRoot);
  }
});

// ---------------------------------------------------------------------------
// GET /api/activity
// ---------------------------------------------------------------------------

test("GET /api/activity returns [] before any activity has been written", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/api/activity`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, []);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /api/activity reflects an event written via the adapter", async () => {
  const repoRoot = tempRepo();
  writeTracker(repoRoot);
  const dev = await bootServer(repoRoot);
  try {
    const appendRes = defaultAdapter(repoRoot).appendActivity({
      type: "system",
      title: "api-server test event",
    });
    assert.equal(appendRes.ok, true);

    const apiRes = await fetch(`${baseUrl(dev)}/api/activity`);
    assert.equal(apiRes.status, 200);
    const body = await apiRes.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].title, "api-server test event");
  } finally {
    teardown(dev, repoRoot);
  }
});

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
