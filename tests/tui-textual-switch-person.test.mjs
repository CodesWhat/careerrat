import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { createTextualSession } from "../src/core/tui/textual-session.mjs";

const root = join(import.meta.dirname, "..");

function writeTracker(home, applications) {
  mkdirSync(join(home, "workspace"), { recursive: true });
  writeFileSync(
    join(home, "workspace/tracker.json"),
    JSON.stringify({ meta: { version: 7 }, applications })
  );
}
function app(id, company) {
  return { id, company, role: "Engineer", status: "applied" };
}
// Two synthetic people next to the owner's own workspace, all under one base.
async function fixture(t, agent = null, search = undefined) {
  const base = mkdtempSync(join(tmpdir(), "careerrat-switch-"));
  writeTracker(base, [app("owner-job", "OwnerCo")]);
  writeTracker(join(base, "people/ada"), [app("ada-job", "AdaCo")]);
  writeTracker(join(base, "people/bo"), [app("bo-job", "BoCo")]);
  const env = { ...process.env, CAREERRAT_HOME: base };
  for (const key of ["CAREERRAT_PERSON", "CAREERRAT_PEOPLE_BASE"]) delete env[key];
  const events = [];
  const session = await createTextualSession({
    repoRoot: root,
    env,
    agent,
    emit: (e) => events.push(e),
    ...(search ? { search } : {}),
  });
  t.after(async () => {
    await session.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { base, events, session };
}
const lastView = (events) => events.filter((e) => e.type === "workspace").at(-1).view;
const ids = (events) => lastView(events).jobs.map((job) => job.id);
function screen(events) {
  let lines = [];
  for (const event of events) {
    if (event.type !== "frame") continue;
    if (event.lines) lines = [...event.lines];
    else for (const [index, line] of event.changed) lines[index] = line;
  }
  return lines.join("");
}
async function until(check) {
  const end = Date.now() + 20_000;
  while (!check()) {
    assert.ok(Date.now() < end, "timed out waiting for a session event");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the people list names everyone with a workspace and who is open", async (t) => {
  const { events, session } = await fixture(t);
  await session.dispatch({ op: "people" });
  const listed = events.find((e) => e.type === "people");
  assert.deepEqual(
    listed.people.map((p) => p.name),
    ["ada", "bo"]
  );
  assert.equal(listed.current, null);
});

test("switching shows only the chosen person's jobs, then back to the owner's", async (t) => {
  const { events, session } = await fixture(t);
  assert.deepEqual(ids(events), ["owner-job"]);
  await session.dispatch({ op: "switch-person", person: "ada" });
  assert.deepEqual(ids(events), ["ada-job"]);
  assert.equal(events.filter((e) => e.type === "person").at(-1).person, "ada");
  await session.dispatch({ op: "switch-person", person: "bo" });
  assert.deepEqual(ids(events), ["bo-job"]);
  await session.dispatch({ op: "switch-person", person: null });
  assert.deepEqual(ids(events), ["owner-job"]);
  assert.equal(events.filter((e) => e.type === "person").at(-1).person, null);
  for (const snap of events.filter((e) => e.type === "workspace")) {
    assert.equal(snap.view.jobs.length, 1, "a snapshot never mixes people");
  }
});

test("after a switch the watcher follows the new root only", async (t) => {
  const { base, events, session } = await fixture(t);
  await session.dispatch({ op: "switch-person", person: "ada" });
  writeTracker(join(base, "people/ada"), [app("ada-job", "AdaCo"), app("ada-two", "AdaTwo")]);
  await until(() => ids(events).length === 2);
  assert.deepEqual(ids(events).sort(), ["ada-job", "ada-two"]);
  // A write to the owner's workspace is not watched any more.
  const seen = events.length;
  writeTracker(base, [app("owner-job", "OwnerCo"), app("owner-two", "OwnerTwo")]);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(
    events.slice(seen).some((e) => e.type === "workspace"),
    false
  );
  assert.deepEqual(ids(events).sort(), ["ada-job", "ada-two"]);
});

test("the agent pane stops on the old root and restarts on the new one", {
  timeout: 30_000,
}, async (t) => {
  const childCode =
    "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('ROOT['+process.env.CAREERRAT_HOME+'] PERSON['+(process.env.CAREERRAT_PERSON||'none')+']');setInterval(()=>{},1000);";
  const { base, events, session } = await fixture(t, {
    command: process.execPath,
    args: ["-e", childCode],
  });
  await session.dispatch({ op: "resize", cols: 200, rows: 10 });
  await until(() => screen(events).includes("PERSON[none]"));
  const firstPid = events.find((e) => e.type === "agent-started").pid;
  await session.dispatch({ op: "switch-person", person: "ada" });
  assert.throws(() => process.kill(firstPid, 0), { code: "ESRCH" });
  assert.equal(
    events.some((e) => e.type === "agent-exited"),
    false,
    "a deliberate stop is not reported as the agent dying"
  );
  await session.dispatch({ op: "resize", cols: 200, rows: 10 });
  await until(() => events.filter((e) => e.type === "agent-started").length === 2);
  await until(() => screen(events).includes("PERSON[ada]"));
  assert.ok(screen(events).includes(`ROOT[${join(base, "people/ada")}]`));
  const secondPid = events.filter((e) => e.type === "agent-started").at(-1).pid;
  assert.notEqual(secondPid, firstPid);
});

test("an unknown or removed person is refused and the session stays where it was", async (t) => {
  const { base, events, session } = await fixture(t);
  await session.dispatch({ op: "switch-person", person: "ghost" });
  const refusal = events.filter((e) => e.type === "notice").at(-1);
  assert.match(refusal.message, /Can't switch: No workspace for "ghost"/);
  assert.deepEqual(ids(events), ["owner-job"]);
  assert.equal(
    events.some((e) => e.type === "person"),
    false
  );
  await session.dispatch({ op: "switch-person", person: "Bad Name" });
  assert.match(events.filter((e) => e.type === "notice").at(-1).message, /Invalid person name/);
  await session.dispatch({ op: "switch-person", person: "ada" });
  rmSync(join(base, "people/bo"), { recursive: true, force: true });
  await session.dispatch({ op: "switch-person", person: "bo" });
  assert.match(events.filter((e) => e.type === "notice").at(-1).message, /No workspace for "bo"/);
  assert.deepEqual(ids(events), ["ada-job"]);
  await assert.rejects(session.dispatch({ op: "switch-person", person: 7 }), /Person must be/);
});

test("switching to the workspace that is already open says so and restarts nothing", async (t) => {
  const { events, session } = await fixture(t);
  const before = events.filter((e) => e.type === "workspace").length;
  await session.dispatch({ op: "switch-person", person: null });
  assert.match(events.at(-1).message, /Already in your own workspace/);
  assert.equal(events.filter((e) => e.type === "workspace").length, before);
});

// --- Codex pass-1 findings ---

test("a destination that can't be read is refused before anything is torn down", async (t) => {
  const started = [];
  const { base, events, session } = await fixture(t, null, {
    start: async (ctx) => {
      started.push(ctx.env.CAREERRAT_HOME);
      return { reused: false, run: { id: "r1" } };
    },
    cancel: () => {},
  });
  writeFileSync(join(base, "people/ada/workspace/tracker.json"), "{ not json");
  await session.dispatch({ op: "switch-person", person: "ada" });
  assert.match(events.filter((e) => e.type === "notice").at(-1).message, /Can't switch/);
  assert.equal(
    events.some((e) => e.type === "person"),
    false
  );
  assert.deepEqual(ids(events), ["owner-job"]);
  await session.dispatch({ op: "search-start" });
  assert.deepEqual(started, [base], "search still runs against the workspace on screen");
});

test("actions issued for the previous workspace are rejected after a switch", async (t) => {
  const started = [];
  const { events, session } = await fixture(t, null, {
    start: async (ctx) => {
      started.push(ctx.env.CAREERRAT_HOME);
      return { reused: false, run: { id: "r1" } };
    },
    cancel: () => {},
  });
  await session.dispatch({ op: "switch-person", person: "ada" });
  const person = events.filter((e) => e.type === "person").at(-1);
  assert.equal(typeof person.generation, "number");
  await session.dispatch({ op: "search-start", generation: person.generation - 1 });
  assert.deepEqual(started, [], "a stale search never reaches the new workspace");
  assert.match(events.at(-1).message, /previous workspace/);
  await session.dispatch({ op: "search-start", generation: person.generation });
  assert.equal(started.length, 1);
});

test("actions sent while a switch is in flight are not run", async (t) => {
  const started = [];
  const { session } = await fixture(t, null, {
    start: async (ctx) => {
      started.push(ctx.env.CAREERRAT_HOME);
      return { reused: false, run: { id: "r1" } };
    },
    cancel: () => {},
  });
  const switching = session.dispatch({ op: "switch-person", person: "ada" });
  await session.dispatch({ op: "search-start" });
  await switching;
  assert.deepEqual(started, []);
});

test("switching closes and evicts the old workspace's cached database connection", async (t) => {
  const { base, session } = await fixture(t);
  t.after(() => closeAll());
  const db = openDb({ repoRoot: root, env: { ...process.env, CAREERRAT_HOME: base } });
  await session.dispatch({ op: "switch-person", person: "ada" });
  assert.throws(() => db.prepare("SELECT 1").get(), /not open|closed/i);
  const again = openDb({ repoRoot: root, env: { ...process.env, CAREERRAT_HOME: base } });
  assert.notEqual(again, db, "the next open makes a fresh connection");
});

test("returning to the owner restores the original environment, unset keys included", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "careerrat-legacy-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeTracker(repo, [app("legacy-owner", "LegacyCo")]);
  writeTracker(join(repo, ".careerrat/people/ada"), [app("ada-job", "AdaCo")]);
  const env = { ...process.env, HOME: repo };
  for (const key of ["CAREERRAT_HOME", "CAREERRAT_PERSON", "CAREERRAT_PEOPLE_BASE"])
    delete env[key];
  const events = [];
  const session = await createTextualSession({
    repoRoot: repo,
    env,
    emit: (e) => events.push(e),
  });
  t.after(() => session.close());
  assert.deepEqual(ids(events), ["legacy-owner"]);
  await session.dispatch({ op: "switch-person", person: "ada" });
  assert.deepEqual(ids(events), ["ada-job"]);
  await session.dispatch({ op: "switch-person", person: null });
  assert.deepEqual(ids(events), ["legacy-owner"]);
});

test("the agent's launch arguments are worked out for each person on every start", {
  timeout: 30_000,
}, async (t) => {
  const childCode =
    "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('ARGS['+process.argv.slice(1).join('|')+']');setInterval(()=>{},1000);";
  const { events, session } = await fixture(t, {
    command: process.execPath,
    args: ["-e", childCode, "base"],
    opening: (env) => (env.CAREERRAT_PERSON ? null : "ONBOARD"),
  });
  await session.dispatch({ op: "resize", cols: 200, rows: 10 });
  await until(() => screen(events).includes("ARGS[base|ONBOARD]"));
  await session.dispatch({ op: "switch-person", person: "ada" });
  await session.dispatch({ op: "resize", cols: 200, rows: 10 });
  await until(() => screen(events).includes("ARGS[base]"));
});
