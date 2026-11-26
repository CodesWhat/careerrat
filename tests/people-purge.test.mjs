// CR130 D2/D6: purge backs the database up consistently, refuses while it is held,
// and its refusal guards leave everything in place.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { holdersDir, registerDbHolder } from "../src/core/db/holders.mjs";
import { createPersonRoot, personRoot } from "../src/core/paths/people.mjs";
import { purgePerson } from "../src/core/people/purge.mjs";

function tempBase(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "careerrat-purge-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function envFor(base) {
  const env = { ...process.env, CAREERRAT_DOWNLOADS_DIR: join(base, "dl") };
  for (const key of ["CAREERRAT_HOME", "CAREERRAT_PERSON", "CAREERRAT_PEOPLE_BASE"])
    delete env[key];
  return env;
}

test("purge backs up a live WAL database with its committed rows", (t) => {
  const base = tempBase(t);
  const root = createPersonRoot(base, "david");
  mkdirSync(join(root, "db"), { recursive: true });
  writeFileSync(join(root, "notes.txt"), "keep me");
  const live = new DatabaseSync(join(root, "db", "careerrat.db"));
  live.exec("PRAGMA journal_mode=WAL");
  live.exec("PRAGMA wal_autocheckpoint=0");
  live.exec("CREATE TABLE t (x TEXT)");
  live.exec("INSERT INTO t VALUES ('in the wal')");
  assert.ok(existsSync(join(root, "db", "careerrat.db-wal")));

  const result = purgePerson({ base, name: "david", env: envFor(base) });
  live.close();

  assert.equal(existsSync(root), false);
  const copy = new DatabaseSync(join(result.backup, "workspace", "db", "careerrat.db"));
  assert.deepEqual(
    copy
      .prepare("SELECT x FROM t")
      .all()
      .map((r) => r.x),
    ["in the wal"]
  );
  assert.equal(copy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  copy.close();
  assert.equal(existsSync(join(result.backup, "workspace", "db", "careerrat.db-wal")), false);
  assert.ok(existsSync(join(result.backup, "workspace", "notes.txt")));
});

test("purge refuses while a CareerRat process holds the workspace", (t) => {
  const base = tempBase(t);
  const root = createPersonRoot(base, "david");
  const ctx = { env: { CAREERRAT_HOME: root } };
  const release = registerDbHolder(ctx, "tui");
  // registerDbHolder marks this process; a purge from another process must refuse.
  const holders = holdersDir(ctx);
  const marker = readdirSync(holders)[0];
  release();
  writeFileSync(
    join(holders, marker),
    JSON.stringify({ pid: process.ppid, kind: "tui", startedAt: new Date().toISOString() })
  );
  assert.throws(
    () => purgePerson({ base, name: "david", env: envFor(base) }),
    (error) => error.code === "DB_IN_USE" && /can't purge/.test(error.message)
  );
  assert.ok(existsSync(root));
  assert.equal(existsSync(join(base, "people-backups")), false);
});

test("purge refuses a symlinked person root and removes nothing", (t) => {
  const base = tempBase(t);
  const elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "precious.txt"), "x");
  mkdirSync(join(base, "people"), { recursive: true });
  symlinkSync(elsewhere, personRoot(base, "david"));
  assert.throws(() => purgePerson({ base, name: "david", env: envFor(base) }), /symlink/);
  assert.ok(existsSync(join(elsewhere, "precious.txt")));
  assert.equal(existsSync(join(base, "people-backups")), false);
});

test("purge refuses an unknown person and an invalid name", (t) => {
  const base = tempBase(t);
  assert.throws(() => purgePerson({ base, name: "nobody", env: envFor(base) }), /No workspace/);
  assert.throws(
    () => purgePerson({ base, name: "../etc", env: envFor(base) }),
    /Invalid person name/
  );
  assert.equal(existsSync(join(base, "people-backups")), false);
});
