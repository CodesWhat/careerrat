import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { runMigrations } from "../src/core/db/migrations.mjs";

const root = join(import.meta.dirname, "..");

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "careerrat-integrity-"));
  const env = {
    CAREERRAT_HOME: home,
    HOME: home,
    PATH: process.env.PATH,
    CAREERRAT_NO_UPDATE_CHECK: "1",
  };
  t.after(() => {
    closeAll();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, env };
}

function run(ctx, args) {
  const result = spawnSync(process.execPath, [join(root, "bin/careerrat.mjs"), ...args], {
    env: ctx.env,
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

function json(ctx, args, expected = 0) {
  const result = run(ctx, [...args, "--json"]);
  assert.equal(result.status, expected, `${args.join(" ")}\n${result.out}${result.err}`);
  return JSON.parse(result.out);
}

function dbFile(ctx) {
  return join(ctx.home, "db", "careerrat.db");
}

function query(ctx, sql) {
  const db = new DatabaseSync(dbFile(ctx), { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function addApp(ctx, extra = {}) {
  return json(ctx, [
    "data",
    "app",
    "upsert",
    "--data",
    JSON.stringify({
      id: "app-1",
      company: "Example",
      role: "Engineer",
      status: "applied",
      ...extra,
    }),
  ]);
}

test("data init --demo refuses a workspace that already has data and leaves it alone", (t) => {
  const ctx = fixture(t);
  json(ctx, ["data", "init"]);
  json(ctx, [
    "data",
    "candidate",
    "patch",
    "profile",
    "--data",
    JSON.stringify({ candidate: { full_name: "Real Person" } }),
  ]);
  addApp(ctx);
  const before = query(ctx, "SELECT data FROM candidate_profile");

  const refused = json(ctx, ["data", "init", "--demo"], 1);
  assert.match(refused.error, /refusing to seed demo data/);
  assert.match(refused.error, /CAREERRAT_HOME/);
  assert.deepEqual(query(ctx, "SELECT data FROM candidate_profile"), before);
  assert.equal(query(ctx, "SELECT COUNT(*) AS n FROM applications")[0].n, 1);
});

test("data init --demo still seeds an empty database, and --force overrides the guard", (t) => {
  const ctx = fixture(t);
  json(ctx, ["data", "init"]);
  assert.equal(json(ctx, ["data", "init", "--demo"]).ok, true);
  assert.ok(query(ctx, "SELECT COUNT(*) AS n FROM applications")[0].n > 1);
  json(ctx, ["data", "init", "--demo"], 1);
  assert.equal(json(ctx, ["data", "init", "--demo", "--force"]).ok, true);
});

test("a database from a newer build is refused instead of written to", (t) => {
  const ctx = fixture(t);
  json(ctx, ["data", "init"]);
  const raw = new DatabaseSync(dbFile(ctx));
  raw.exec("PRAGMA user_version = 99");
  raw.close();
  const result = run(ctx, [
    "data",
    "app",
    "upsert",
    "--data",
    JSON.stringify({ id: "x1", company: "A", role: "B" }),
    "--json",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.out, /newer CareerRat/);
  assert.equal(query(ctx, "SELECT COUNT(*) AS n FROM applications")[0].n, 0);

  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA user_version = 99");
  assert.throws(() => runMigrations(db), /newer CareerRat/);
  db.close();
});

test("set-status, schedule-interview and --follow-up-due reject junk values", (t) => {
  const ctx = fixture(t);
  json(ctx, ["data", "init"]);
  addApp(ctx);
  const status = json(ctx, ["data", "app", "set-status", "app-1", "bogus-status"], 1);
  assert.match(status.error, /not a status CareerRat knows/);
  const due = json(
    ctx,
    ["data", "app", "set-status", "app-1", "interview", "--follow-up-due", "notadate"],
    1
  );
  assert.match(due.error, /followUpDueAt/);
  const at = json(ctx, ["data", "app", "schedule-interview", "app-1", "--at", "notadate"], 1);
  assert.match(at.error, /ISO date/);
  const stored = JSON.parse(query(ctx, "SELECT data FROM applications")[0].data);
  assert.equal(stored.status, "applied");
  assert.equal(stored.interviewAt, undefined);
  assert.equal(
    json(ctx, ["data", "app", "set-status", "app-1", "interview", "--follow-up-due", "2030-01-02"])
      .ok,
    true
  );
});

test("app upsert will not wipe an existing row, and promote will not overwrite one", (t) => {
  const ctx = fixture(t);
  json(ctx, ["data", "init"]);
  addApp(ctx, { note: "keep me" });
  const clash = json(
    ctx,
    ["data", "app", "upsert", "--data", JSON.stringify({ id: "app-1", company: "X", role: "Y" })],
    1
  );
  assert.match(clash.error, /already exists/);
  assert.equal(JSON.parse(query(ctx, "SELECT data FROM applications")[0].data).note, "keep me");
  assert.equal(
    json(ctx, [
      "data",
      "app",
      "upsert",
      "--replace",
      "--data",
      JSON.stringify({ id: "app-1", company: "X", role: "Y" }),
    ]).ok,
    true
  );

  json(ctx, [
    "data",
    "sourced",
    "upsert-batch",
    "--data",
    JSON.stringify([{ id: "app-1", company: "Other", role: "Role" }]),
  ]);
  const promote = json(ctx, ["data", "sourced", "promote", "app-1"], 1);
  assert.match(promote.error, /already exists/);
  assert.equal(JSON.parse(query(ctx, "SELECT data FROM applications")[0].data).company, "X");
});

test("candidate patch failures say which field is wrong", (t) => {
  const ctx = fixture(t);
  json(ctx, ["data", "init"]);
  json(ctx, ["data", "candidate", "init"]);
  const bad = json(
    ctx,
    [
      "data",
      "candidate",
      "patch",
      "modes",
      "--data",
      JSON.stringify({ application_mode: "nonsense" }),
    ],
    1
  );
  assert.match(bad.error, /application_mode/);
  assert.ok(Array.isArray(bad.errors) && bad.errors.length > 0);
});

test("evidence add --write fails when the bank already has the same claim under another id", (t) => {
  const ctx = fixture(t);
  json(ctx, ["data", "init"]);
  json(ctx, ["data", "candidate", "init"]);
  const one = join(ctx.home, "one.yml");
  const two = join(ctx.home, "two.yml");
  writeFileSync(one, "id: first\nclaim: Built a scheduler\nevidence: Notes\n");
  writeFileSync(two, "id: second\nclaim: Built a scheduler\nevidence: Notes\n");
  json(ctx, ["evidence", "add", "--file", one, "--write"]);
  const dup = json(ctx, ["evidence", "add", "--file", two, "--write"], 1);
  assert.equal(dup.duplicateOf, "first");
  assert.equal(query(ctx, "SELECT COUNT(*) AS n FROM candidate_evidence_claims")[0].n, 1);
});

test("changes undo exits non-zero when the undo is refused", (t) => {
  const ctx = fixture(t);
  json(ctx, ["data", "init"]);
  json(ctx, ["data", "candidate", "init"]);
  const file = join(ctx.home, "claim.yml");
  writeFileSync(file, "id: sample\nclaim: Built a scheduler\nevidence: Notes\n");
  json(ctx, ["evidence", "add", "--file", file, "--write"]);
  const change = json(ctx, ["data", "changes", "list"]).changes[0];
  const first = json(ctx, ["data", "changes", "undo", change.messageId, "0"]);
  assert.equal(first.operationResult.ok, true);
  assert.equal(first.messages, undefined, "undo must not dump the whole thread");
  const again = json(ctx, ["data", "changes", "undo", change.messageId, "0"], 1);
  assert.equal(again.ok, false);
  assert.match(again.error, /undo refused/);
});

test("activity prune is refused and backfill lands in the database on a database workspace", (t) => {
  const ctx = fixture(t);
  json(ctx, ["data", "init"]);
  addApp(ctx);
  const events = () => query(ctx, "SELECT COUNT(*) AS n FROM activity_events")[0].n;
  const before = events();
  const prune = json(ctx, ["activity", "prune", "--max", "1", "--write"], 1);
  assert.match(prune.error, /database/);
  assert.equal(events(), before);
  const backfill = json(ctx, ["activity", "backfill", "--write"]);
  assert.equal(backfill.ok, true);
  assert.equal(events(), before + backfill.written);
});

test("data import keeps edited database candidate settings unless --force-candidate", (t) => {
  const ctx = fixture(t);
  json(ctx, ["data", "init"]);
  mkdirYaml(ctx, "profile.yml", "candidate:\n  full_name: Stale Yaml Name\n");
  json(ctx, ["data", "candidate", "init"]);
  json(ctx, [
    "data",
    "candidate",
    "patch",
    "profile",
    "--data",
    JSON.stringify({ candidate: { full_name: "Db Name" } }),
  ]);
  json(ctx, ["data", "export"]);
  const kept = json(ctx, ["data", "import"]);
  assert.match(kept.warnings.join(" "), /Kept your saved candidate settings/);
  assert.equal(
    JSON.parse(query(ctx, "SELECT data FROM candidate_profile")[0].data).candidate.full_name,
    "Db Name"
  );
  json(ctx, ["data", "import", "--force-candidate"]);
  assert.equal(
    JSON.parse(query(ctx, "SELECT data FROM candidate_profile")[0].data).candidate.full_name,
    "Stale Yaml Name"
  );
});

function mkdirYaml(ctx, name, text) {
  const dir = join(ctx.home, "candidate");
  spawnSync("mkdir", ["-p", dir]);
  writeFileSync(join(dir, name), text);
}

test("data backup and data restore round-trip the database", (t) => {
  const ctx = fixture(t);
  json(ctx, ["data", "init"]);
  addApp(ctx);
  const made = json(ctx, ["data", "backup"]);
  assert.ok(existsSync(made.path));
  json(ctx, [
    "data",
    "app",
    "set-fields",
    "app-1",
    "--data",
    JSON.stringify({ note: "after backup" }),
  ]);
  addApp(ctx, { id: "app-2" });

  const refused = json(ctx, ["data", "restore", "1"], 1);
  assert.match(refused.error, /--yes/);
  assert.equal(query(ctx, "SELECT COUNT(*) AS n FROM applications")[0].n, 2);

  const listed = json(ctx, ["data", "restore"]);
  assert.equal(listed.backups.length, 1);
  const restored = json(ctx, ["data", "restore", "1", "--yes"]);
  assert.equal(restored.restored, made.name);
  assert.ok(restored.safetyCopy);
  assert.equal(query(ctx, "SELECT COUNT(*) AS n FROM applications")[0].n, 1);
  assert.equal(JSON.parse(query(ctx, "SELECT data FROM applications")[0].data).note, undefined);
  assert.equal(JSON.parse(readTrackerText(ctx)).applications.length, 1);
});

function readTrackerText(ctx) {
  return readFileSync(join(ctx.home, "workspace", "tracker.json"), "utf8");
}

test("data backup keeps only the newest N and rejects a corrupt backup on restore", (t) => {
  const ctx = fixture(t);
  json(ctx, ["data", "init"]);
  const names = new Set();
  for (let i = 0; i < 3; i++) names.add(json(ctx, ["data", "backup", "--keep", "2"]).name);
  const dir = join(ctx.home, "db", "backups");
  assert.equal(readdirSync(dir).filter((n) => n.endsWith(".db")).length, 2);
  writeFileSync(join(dir, "careerrat-zzz-corrupt.db"), "not a database");
  const bad = json(ctx, ["data", "restore", "careerrat-zzz-corrupt.db", "--yes"], 1);
  assert.match(bad.error, /can't be used/);
});

test("help text no longer claims the old recovery or automation defaults", (t) => {
  const ctx = fixture(t);
  assert.doesNotMatch(run(ctx, ["help"]).out, /defaults OFF/);
  assert.doesNotMatch(
    run(ctx, ["tracker", "--help"]).out,
    /copy a snapshot back over workspace\/tracker\.json to restore/
  );
  json(ctx, ["data", "init"]);
  const restore = run(ctx, ["restore"]);
  assert.equal(restore.status, 1);
  assert.match(restore.err, /data restore/);
});
