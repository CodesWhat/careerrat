// CR130 D5: restore across schema versions, and the ways a restore must refuse
// without touching the live database.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { createBackup, listBackups, restoreBackup } from "../src/core/db/backup.mjs";
import { closeAll, dbFilePath, openDb } from "../src/core/db/connection.mjs";
import { holdersDir } from "../src/core/db/holders.mjs";
import { ALL_MIGRATIONS, runMigrations } from "../src/core/db/migrations.mjs";
import { appUpsert } from "../src/core/db/verbs.mjs";
import { dataPath } from "../src/core/paths/workspace.mjs";

const roots = [];
after(() => {
  closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const home = mkdtempSync(join(tmpdir(), "careerrat-backup-"));
  roots.push(home);
  const ctx = { env: { CAREERRAT_HOME: home } };
  openDb(ctx);
  return ctx;
}

const appIds = (ctx) =>
  openDb(ctx)
    .prepare("SELECT id FROM applications ORDER BY id")
    .all()
    .map((row) => row.id);

function addApp(ctx, id) {
  appUpsert({ ...ctx, row: { id, company: "Acme", role: "Engineer", status: "interview" } });
}

function plantBackup(ctx, name, build) {
  const dir = dataPath(ctx, "db/backups");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  build(file);
  return file;
}

test("restore brings back the backed-up rows and keeps a safety copy of the live db", () => {
  const ctx = workspace();
  addApp(ctx, "app-1");
  const backup = createBackup(ctx);
  addApp(ctx, "app-2");

  const result = restoreBackup(ctx, backup.name);

  assert.deepEqual(appIds(ctx), ["app-1"]);
  assert.match(result.safetyCopy, /^careerrat-before-restore-/);
  const safety = new DatabaseSync(join(dataPath(ctx, "db/backups"), result.safetyCopy));
  assert.equal(safety.prepare("SELECT COUNT(*) AS n FROM applications").get().n, 2);
  safety.close();
});

test("an older-schema backup is migrated up to the current schema on restore", () => {
  const ctx = workspace();
  addApp(ctx, "app-live");
  plantBackup(ctx, "careerrat-2020-01-01T00-00-00-000Z.db", (file) => {
    const old = new DatabaseSync(file);
    runMigrations(old, ALL_MIGRATIONS.slice(0, 2));
    old.close();
  });

  restoreBackup(ctx, "careerrat-2020");

  const db = openDb(ctx);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, ALL_MIGRATIONS.at(-1).id);
  assert.deepEqual(appIds(ctx), []);
});

test("a backup from a newer schema is refused and the live db is untouched", () => {
  const ctx = workspace();
  addApp(ctx, "app-live");
  plantBackup(ctx, "careerrat-2030-01-01T00-00-00-000Z.db", (file) => {
    const future = new DatabaseSync(file);
    runMigrations(future);
    future.exec(`PRAGMA user_version = ${ALL_MIGRATIONS.at(-1).id + 1}`);
    future.close();
  });

  assert.throws(
    () => restoreBackup(ctx, "careerrat-2030"),
    (error) => error.code === "BAD_BACKUP" && /newer CareerRat/.test(error.message)
  );
  assert.deepEqual(appIds(ctx), ["app-live"]);
  assert.equal(
    listBackups(ctx).some((b) => b.name.startsWith("careerrat-before-restore")),
    false
  );
});

test("a corrupt backup is refused and the live db is untouched", () => {
  const ctx = workspace();
  addApp(ctx, "app-live");
  plantBackup(ctx, "careerrat-2031-01-01T00-00-00-000Z.db", (file) =>
    writeFileSync(file, "this is not a database, just text padding ".repeat(200))
  );

  assert.throws(
    () => restoreBackup(ctx, "careerrat-2031"),
    (error) => error.code === "BAD_BACKUP"
  );
  assert.deepEqual(appIds(ctx), ["app-live"]);
});

test("an unknown backup selector is refused with NO_SUCH_BACKUP", () => {
  const ctx = workspace();
  addApp(ctx, "app-live");
  assert.throws(
    () => restoreBackup(ctx, "nope"),
    (error) => error.code === "NO_SUCH_BACKUP"
  );
  assert.deepEqual(appIds(ctx), ["app-live"]);
});

test("restore refuses while another CareerRat process holds the database", () => {
  const ctx = workspace();
  addApp(ctx, "app-1");
  const backup = createBackup(ctx);
  addApp(ctx, "app-2");
  mkdirSync(holdersDir(ctx), { recursive: true });
  writeFileSync(
    join(holdersDir(ctx), `${process.ppid}-tui-test.json`),
    JSON.stringify({ pid: process.ppid, kind: "tui", startedAt: new Date().toISOString() })
  );

  assert.throws(
    () => restoreBackup(ctx, backup.name),
    (error) => error.code === "DB_IN_USE"
  );
  assert.deepEqual(appIds(ctx), ["app-1", "app-2"]);
});

test("a restore leaves no staging file behind", () => {
  const ctx = workspace();
  addApp(ctx, "app-1");
  const backup = createBackup(ctx);
  restoreBackup(ctx, backup.name);
  const leftovers = readdirSync(join(dbFilePath(ctx), "..")).filter((n) =>
    n.endsWith(".restoring")
  );
  assert.deepEqual(leftovers, []);
  assert.equal(existsSync(dbFilePath(ctx)), true);
});
