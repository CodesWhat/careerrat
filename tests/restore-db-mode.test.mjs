import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appUpsert } from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const cleanup = [];

after(() => {
  closeAll();
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
});

test("restore refuses JSON snapshots when SQLite is canonical", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "careerrat-restore-db-"));
  cleanup.push(dataRoot);
  const env = { ...process.env, CAREERRAT_HOME: dataRoot };
  openDb({ repoRoot: ROOT, env });
  appUpsert({
    repoRoot: ROOT,
    env,
    row: { id: "app-current", company: "Current Co", role: "Engineer", status: "interview" },
  });
  const db = openDb({ repoRoot: ROOT, env });
  const snapshotPath = userPath({ repoRoot: ROOT, env }, "workspace/.snapshots/tracker-old.json");
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(
    snapshotPath,
    JSON.stringify({ meta: {}, applications: [], sourced: [], sources: [], communications: [] })
  );

  const result = spawnSync(process.execPath, ["src/cli/restore.mjs", "tracker-old.json"], {
    cwd: ROOT,
    env,
    input: "y\n",
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /database is canonical/i);
  assert.match(result.stderr, /nothing was changed/i);
  assert.ok(db.prepare("SELECT data FROM applications WHERE id = ?").get("app-current"));
});
