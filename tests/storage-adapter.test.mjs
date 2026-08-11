// tests/storage-adapter.test.mjs
// node:test suite for the StorageAdapter seam (storage-adapter.mjs). This pins the
// local filesystem adapter's contract — readTracker/writeTracker, readActivity/
// appendActivity, readFile/writeFile — so a future hosted adapter can be swapped in
// behind the same six calls without behavior drift (Productization Phase 0, P0-1).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveUserPaths } from "../src/core/paths/workspace.mjs";
import { createLocalFsAdapter, defaultAdapter } from "../src/core/storage/storage-adapter.mjs";

const METHODS = [
  "readTracker",
  "writeTracker",
  "readActivity",
  "appendActivity",
  "readFile",
  "writeFile",
];

// A fresh repoRoot with its resolved (non-legacy, .rolester-backed) workspace dir
// pre-created — resolveUserPaths never creates directories on its own (see
// workspace-paths.test.mjs), and writeTrackerJson's atomicWriteFile assumes the
// target directory already exists, same as every real CLI call-site does.
function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-storage-"));
  mkdirSync(resolveUserPaths({ repoRoot }).workspaceDir, { recursive: true });
  return repoRoot;
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test("createLocalFsAdapter exposes exactly the six seam methods", () => {
  const repoRoot = tempRepo();
  try {
    const adapter = createLocalFsAdapter({ repoRoot });
    for (const method of METHODS) {
      assert.equal(typeof adapter[method], "function", `${method} should be a function`);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readTracker / writeTracker
// ---------------------------------------------------------------------------

test("writeTracker -> readTracker round-trips and stamps meta.lastUpdatedAt + version", () => {
  const repoRoot = tempRepo();
  try {
    const adapter = createLocalFsAdapter({ repoRoot });
    adapter.writeTracker({ applications: [] });

    const first = adapter.readTracker();
    assert.equal(first.meta.version, 1);
    assert.ok(first.meta.lastUpdatedAt);

    first.applications.push({ company: "Acme" });
    adapter.writeTracker(first);

    const second = adapter.readTracker();
    assert.equal(second.meta.version, 2);
    assert.equal(second.applications.length, 1);
    assert.ok(new Date(second.meta.lastUpdatedAt) >= new Date(first.meta.lastUpdatedAt));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("writeTracker with { stamp: false } leaves meta untouched", () => {
  const repoRoot = tempRepo();
  try {
    const adapter = createLocalFsAdapter({ repoRoot });
    const seeded = {
      applications: [],
      meta: { lastUpdatedAt: "2020-01-01T00:00:00.000Z", version: 5 },
    };
    adapter.writeTracker(seeded, { stamp: false });

    const data = adapter.readTracker();
    assert.equal(data.meta.version, 5);
    assert.equal(data.meta.lastUpdatedAt, "2020-01-01T00:00:00.000Z");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("readTracker throws a clear error when tracker.json is corrupt", () => {
  const repoRoot = tempRepo();
  try {
    const trackerPath = join(resolveUserPaths({ repoRoot }).workspaceDir, "tracker.json");
    // Write invalid JSON directly (bypassing the adapter) then confirm readTracker refuses cleanly.
    writeFileSync(trackerPath, "{not valid json", "utf8");
    const adapter = createLocalFsAdapter({ repoRoot });
    assert.throws(() => adapter.readTracker(), /not valid JSON/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("writeTracker is atomic-shaped: no leftover tmp file after write", () => {
  const repoRoot = tempRepo();
  try {
    const adapter = createLocalFsAdapter({ repoRoot });
    adapter.writeTracker({ applications: [] });
    const entries = readdirSync(resolveUserPaths({ repoRoot }).workspaceDir);
    assert.ok(!entries.some((f) => f.includes(".tmp-")), `no tmp file should remain: ${entries}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("readTracker throws a clear error when tracker.json is missing", () => {
  const repoRoot = tempRepo();
  try {
    const adapter = createLocalFsAdapter({ repoRoot });
    assert.throws(() => adapter.readTracker(), /no tracker\.json/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readActivity / appendActivity
// ---------------------------------------------------------------------------

test("appendActivity -> readActivity round-trips a valid event", () => {
  const repoRoot = tempRepo();
  try {
    const adapter = createLocalFsAdapter({ repoRoot });
    const res = adapter.appendActivity({ type: "system", title: "seam contract test event" });
    assert.equal(res.ok, true);

    const events = adapter.readActivity();
    assert.equal(events.length, 1);
    assert.equal(events[0].title, "seam contract test event");
    assert.equal(events[0].type, "system");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readFile / writeFile
// ---------------------------------------------------------------------------

test("readFile/writeFile round-trip; readFile of a missing file is null", () => {
  const repoRoot = tempRepo();
  try {
    const adapter = createLocalFsAdapter({ repoRoot });
    assert.equal(adapter.readFile("notes.txt"), null);
    adapter.writeFile("notes.txt", "hello from the seam");
    assert.equal(adapter.readFile("notes.txt"), "hello from the seam");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("readFile/writeFile reject path traversal and absolute paths", () => {
  const repoRoot = tempRepo();
  try {
    const adapter = createLocalFsAdapter({ repoRoot });
    assert.throws(() => adapter.readFile("../outside.txt"));
    assert.throws(() => adapter.writeFile("../outside.txt", "x"));
    assert.throws(() => adapter.readFile("/etc/passwd"));
    assert.throws(() => adapter.writeFile("/etc/passwd", "x"));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// defaultAdapter
// ---------------------------------------------------------------------------

test("defaultAdapter returns the same instance for the same repoRoot", () => {
  const repoRoot = tempRepo();
  try {
    const a = defaultAdapter(repoRoot);
    const b = defaultAdapter(repoRoot);
    assert.equal(a, b);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
