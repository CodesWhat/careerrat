import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { activeDbHolders, holdersDir } from "../src/core/db/holders.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const root = join(import.meta.dirname, "..");

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "careerrat-holders-"));
  const env = {
    CAREERRAT_HOME: home,
    HOME: home,
    PATH: process.env.PATH,
    CAREERRAT_NO_UPDATE_CHECK: "1",
  };
  const children = [];
  t.after(() => {
    for (const child of children) child.kill("SIGKILL");
    closeAll();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, env, ctx: { repoRoot: root, env }, children };
}

function cli(fx, args) {
  const result = spawnSync(process.execPath, [join(root, "bin/careerrat.mjs"), ...args, "--json"], {
    env: fx.env,
    encoding: "utf8",
  });
  return { status: result.status, body: JSON.parse(result.stdout || "{}"), err: result.stderr };
}

function appCount(fx) {
  const db = new DatabaseSync(join(fx.home, "db", "careerrat.db"), { readOnly: true });
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM applications").get().n;
  } finally {
    db.close();
  }
}

// A real second process that holds the database the way the TUI, server or
// search worker does, until it is killed.
function startHolder(fx, kind) {
  const code = `
    import { registerDbHolder } from ${JSON.stringify(new URL("../src/core/db/holders.mjs", import.meta.url).href)};
    registerDbHolder({ repoRoot: ${JSON.stringify(root)}, env: process.env }, ${JSON.stringify(kind)});
    console.log("READY");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: fx.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  fx.children.push(child);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", () => resolve(child));
  });
}

function prepare(fx) {
  assert.equal(cli(fx, ["data", "init"]).status, 0);
  const added = cli(fx, [
    "data",
    "app",
    "upsert",
    "--data",
    JSON.stringify({ id: "app-1", company: "Acme", role: "Dev", status: "applied" }),
  ]);
  assert.equal(added.status, 0, added.err);
  assert.equal(cli(fx, ["data", "backup"]).status, 0);
  const extra = cli(fx, [
    "data",
    "app",
    "upsert",
    "--data",
    JSON.stringify({ id: "app-2", company: "Beta", role: "Dev", status: "applied" }),
  ]);
  assert.equal(extra.status, 0, extra.err);
  assert.equal(appCount(fx), 2);
}

test("data restore refuses while a TUI or search worker holds the database, then works after it quits", async (t) => {
  const fx = fixture(t);
  prepare(fx);
  for (const [kind, label] of [
    ["tui", /TUI/],
    ["search", /job search/],
  ]) {
    const child = await startHolder(fx, kind);
    const refused = cli(fx, ["data", "restore", "1", "--yes"]);
    assert.equal(refused.status, 1);
    assert.match(refused.body.error, /can't restore while CareerRat is running/);
    assert.match(refused.body.error, label);
    assert.match(refused.body.error, new RegExp(`process ${child.pid}`));
    assert.equal(appCount(fx), 2, "a refused restore must leave the database alone");
    assert.equal(
      existsSync(join(fx.home, "db")) &&
        cli(fx, ["data", "restore"]).body.backups.every(
          (backup) => !/before-restore/.test(backup.name)
        ),
      true,
      "a refused restore must not even make its safety copy"
    );
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  const restored = cli(fx, ["data", "restore", "1", "--yes"]);
  assert.equal(restored.status, 0, JSON.stringify(restored.body));
  assert.equal(appCount(fx), 1);
});

test("a running careerrat start server, seen through its runtime owner file, also blocks a restore", async (t) => {
  const fx = fixture(t);
  prepare(fx);
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  fx.children.push(child);
  const owner = userPath(fx.ctx, ".internal/app-runtime.owner");
  mkdirSync(join(owner, ".."), { recursive: true });
  writeFileSync(
    owner,
    `${JSON.stringify({ id: "x", pid: child.pid, acquiredAt: "2026-11-02T00:00:00Z" })}\n`
  );
  const refused = cli(fx, ["data", "restore", "1", "--yes"]);
  assert.equal(refused.status, 1);
  assert.match(refused.body.error, /careerrat start/);
  assert.equal(appCount(fx), 2);
});

test("a marker left by a dead process does not block, and is cleaned up", (t) => {
  const fx = fixture(t);
  prepare(fx);
  const dir = holdersDir(fx.ctx);
  mkdirSync(dir, { recursive: true });
  const dead = spawnSync(process.execPath, ["-e", "0"]);
  assert.equal(dead.status, 0);
  const stale = join(dir, "999999-tui-stale.json");
  writeFileSync(stale, JSON.stringify({ pid: 2147483646, kind: "tui", startedAt: "2026-01-01" }));
  writeFileSync(join(dir, "garbage.json"), "not json");
  assert.deepEqual(activeDbHolders(fx.ctx), []);
  assert.equal(existsSync(stale), false);
  assert.equal(cli(fx, ["data", "restore", "1", "--yes"]).status, 0);
  assert.equal(appCount(fx), 1);
});

test("a Textual session marks the database as held until it closes", async (t) => {
  const fx = fixture(t);
  mkdirSync(join(fx.home, "workspace"), { recursive: true });
  const { createTextualSession } = await import("../src/core/tui/textual-session.mjs");
  const session = await createTextualSession({ ...fx.ctx, emit: () => {} });
  const mine = { ignorePid: -1 };
  assert.deepEqual(
    activeDbHolders(fx.ctx, mine).map((holder) => [holder.kind, holder.pid]),
    [["tui", process.pid]]
  );
  // The holder is this process, so this process's own restore isn't blocked.
  assert.deepEqual(activeDbHolders(fx.ctx), []);
  await session.close();
  assert.deepEqual(activeDbHolders(fx.ctx, mine), []);
});
