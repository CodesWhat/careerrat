import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { exportToTracker } from "../src/core/db/export-to-tracker.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const roots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-canonical-cli-"));
  roots.push(repoRoot);
  const sourceDir = join(repoRoot, "source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify({
      meta: {},
      applications: [
        {
          id: "app-rejected",
          company: "Acme",
          role: "Engineer",
          status: "rejected",
          roleFamily: "engineering",
        },
      ],
      sourced: [],
      sources: [],
      communications: [],
    })
  );
  importFromTracker({ repoRoot, sourceDir });
  exportToTracker({ repoRoot });
  return repoRoot;
}

function runCli(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
}

after(() => {
  closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("analytics --write persists through the canonical database in DB workspaces", () => {
  const repoRoot = tempRepo();
  const result = runCli("src/cli/analytics.mjs", [
    "refresh",
    "--write",
    "--json",
    "--at",
    "2026-08-27T17:30:00.000Z",
    "--root",
    repoRoot,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const db = openDb({ repoRoot });
  const row = db.prepare("SELECT data FROM analytics WHERE id = 1").get();
  assert.ok(row);
  assert.equal(JSON.parse(row.data).updatedAt, "2026-08-27T17:30:00.000Z");
  exportToTracker({ repoRoot });
  const tracker = JSON.parse(
    readFileSync(userPath({ repoRoot }, "workspace/tracker.json"), "utf8")
  );
  assert.equal(tracker.analytics.updatedAt, "2026-08-27T17:30:00.000Z");
});

test("activity append --write persists through the canonical database in DB workspaces", () => {
  const repoRoot = tempRepo();
  const result = runCli("src/cli/activity.mjs", [
    "append",
    "--type",
    "system",
    "--actor",
    "agent",
    "--title",
    "Canonical activity",
    "--at",
    "2026-08-27T17:31:00.000Z",
    "--write",
    "--json",
    "--root",
    repoRoot,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const db = openDb({ repoRoot });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_events").get().n, 1);
  exportToTracker({ repoRoot });
  const lines = readFileSync(userPath({ repoRoot }, "workspace/activity.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(lines[0].title, "Canonical activity");
});
