import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";

const api = await import("../src/core/tui/textual-session.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
const root = join(import.meta.dirname, "..");
async function fixture(t, agent = null, extraEnv = {}, extraOptions = {}) {
  assert.equal(
    typeof api.createTextualSession,
    "function",
    "Textual must use a package-owned canonical session"
  );
  const home = mkdtempSync(join(tmpdir(), "careerrat-textual-"));
  mkdirSync(join(home, "workspace"));
  const tracker = {
    meta: { version: 7 },
    applications: [
      {
        id: "northstar",
        company: "Northstar",
        role: "Staff Engineer",
        status: "interview",
        evaluation: {
          gate: "keep",
          compensation: {
            currency: "USD",
            basis: "base",
            source: "job-description",
            minBase: 190000,
            maxBase: 211000,
          },
        },
      },
      {
        id: "harbor",
        company: "Harbor",
        role: "Platform Lead",
        status: "applied",
      },
    ],
  };
  const path = join(home, "workspace/tracker.json");
  writeFileSync(path, JSON.stringify(tracker));
  const events = [];
  const session = await api.createTextualSession({
    repoRoot: root,
    env: { ...process.env, CAREERRAT_HOME: home, ...extraEnv },
    agent,
    ...extraOptions,
    emit: (event) => events.push(event),
  });
  t.after(async () => {
    await session.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, path, events, session, tracker };
}
function snapshot(events) {
  return events.filter((event) => event.type === "workspace").at(-1);
}
// Replays frame events the way the Python side does: a full frame, then only
// the rows that changed.
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
  const end = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < end, "timed out waiting for a real session event");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Textual session reads canonical jobs and preserves read-only browsing", async (t) => {
  const { path, events, session, tracker } = await fixture(t);
  assert.equal(snapshot(events).view.jobs.length, 2);
  assert.equal(snapshot(events).state.stage, "active");
  await session.dispatch({ op: "select", id: "harbor" });
  assert.equal(events.filter((event) => event.type === "selection").at(-1).selectedId, "harbor");
  await session.dispatch({ op: "view", stage: "applied" });
  assert.equal(snapshot(events).view.selectedId, "harbor");
  assert.equal(snapshot(events).view.jobs.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path)), tracker);
  assert.equal(readFileSync(path, "utf8").includes("lastUpdatedAt"), false);
  await session.dispatch({ op: "select", id: "missing" });
  assert.equal(events.filter((event) => event.type === "selection").at(-1).selectedId, "harbor");
  assert.equal(snapshot(events).view.mode, "legacy");
});

test("selecting a row sends the new selection and state, never the job list again", async (t) => {
  const { events, session } = await fixture(t);
  const snapshots = () => events.filter((event) => event.type === "workspace").length;
  const before = snapshots();
  await session.dispatch({ op: "select", id: "harbor" });
  await session.dispatch({ op: "select", id: "northstar" });
  assert.equal(snapshots(), before);
  const picks = events.filter((event) => event.type === "selection");
  assert.deepEqual(
    picks.map((event) => event.selectedId),
    ["harbor", "northstar"]
  );
  assert.equal(picks[1].state.selectedId, "northstar");
  assert.equal(picks[1].state.pendingUndo, null);
  assert.equal("view" in picks[1], false);
});

test("selecting a row clears a pending Undo preview", async (t) => {
  const { events, session } = await fixture(t);
  await session.dispatch({ op: "key", name: "u" });
  await session.dispatch({ op: "select", id: "harbor" });
  assert.equal(events.filter((event) => event.type === "selection").at(-1).state.pendingUndo, null);
});

test("Review and Apply report what they took and refuse closed-out targets", async (t) => {
  const { events, session, path, tracker } = await fixture(t);
  tracker.applications.push({
    id: "gone",
    company: "Gone",
    role: "Dev",
    status: "rejected",
  });
  writeFileSync(path, JSON.stringify(tracker));
  session.refresh();
  await until(() => snapshot(events).view.total === 3);
  assert.equal(snapshot(events).view.jobs.length, 2);
  await session.dispatch({ op: "request", action: "review" });
  const review = events.find((event) => event.type === "request");
  assert.match(review.text, /northstar/);
  assert.doesNotMatch(review.text, /gone/);
  assert.match(review.notice, /first 2 active jobs/);
  await session.dispatch({ op: "view", stage: "rejected" });
  const before = events.filter((event) => event.type === "request").length;
  await session.dispatch({ op: "request", action: "apply" });
  await session.dispatch({ op: "request", action: "review" });
  assert.equal(events.filter((event) => event.type === "request").length, before);
  assert.equal(events.filter((event) => event.type === "notice").length, 2);
});

test("Textual requests pin the selected job and never silently execute it", async (t) => {
  const { events, session } = await fixture(t);
  await session.dispatch({ op: "select", id: "harbor" });
  await session.dispatch({ op: "request", action: "apply" });
  const request = events.find((event) => event.type === "request");
  assert.match(request.text, /harbor/);
  assert.doesNotMatch(request.text, /northstar/);
  assert.equal(request.inserted, false);
  await assert.rejects(session.dispatch({ op: "view", order: "untrusted" }), /order/i);
});

test("Textual refresh observes external canonical writes while keeping stable selection", async (t) => {
  const { events, session, path, tracker } = await fixture(t);
  await session.dispatch({ op: "select", id: "harbor" });
  tracker.applications[1].statusNote = "Recruiter replied";
  writeFileSync(path, JSON.stringify(tracker));
  await until(() =>
    events.some(
      (event) => event.type === "detail" && event.job.record.statusNote === "Recruiter replied"
    )
  );
  assert.equal(snapshot(events).view.selectedId, "harbor");
});

test("Textual context capture uses the durable owner before generating its request", async (t) => {
  const { events, session } = await fixture(t);
  await session.dispatch({
    op: "capture",
    text: "Recruiter transcript: platform ownership and on-call discussion.",
  });
  const receipt = events.find((event) => event.type === "context");
  assert.ok(receipt?.path);
  assert.match(readFileSync(receipt.path, "utf8"), /Recruiter transcript/);
  assert.match(events.find((event) => event.type === "request").text, /saved|context|intake/i);
});

test("Textual capture reports failure with its id and sends no request", async (t) => {
  const { events, session, home } = await fixture(t);
  const missing = join(home, "gone", "notes.txt");
  await session.dispatch({ op: "capture", id: 7, text: `'${missing}'` });
  const failure = events.find((event) => event.type === "capture-error");
  assert.equal(failure.id, 7);
  assert.ok(failure.message);
  assert.equal(
    events.some((event) => event.type === "context" || event.type === "request"),
    false
  );
});

test("Textual inspect lists dropped files and saves nothing; attached files capture before the request", async (t) => {
  const { events, session, home } = await fixture(t);
  const source = join(home, "my offer.txt");
  writeFileSync(source, "Synthetic offer");
  await session.dispatch({ op: "inspect", id: 1, text: `'${source}'` });
  await session.dispatch({
    op: "inspect",
    id: 2,
    text: "plain recruiter note",
  });
  const previews = events.filter((event) => event.type === "intake-preview");
  assert.deepEqual(previews[0].files, [{ path: source, name: "my offer.txt" }]);
  assert.equal(previews[1].files, null);
  assert.equal(
    events.some((event) => event.type === "request"),
    false
  );
  await session.dispatch({ op: "capture", id: 3, files: [source] });
  const order = events.map((event) => event.type);
  assert.ok(order.indexOf("context") !== -1 && order.indexOf("context") < order.indexOf("request"));
  assert.equal(events.find((event) => event.type === "context").id, 3);
  await assert.rejects(session.dispatch({ op: "inspect", text: 5 }), /text/i);
});

test("Textual opens the saved JD through the existing guarded artifact reader", async (t) => {
  const { session, events, home, path, tracker } = await fixture(t);
  mkdirSync(join(home, "workspace/jobs"));
  writeFileSync(
    join(home, "workspace/jobs/northstar.md"),
    "# Saved role\n\nOwn the platform and its services."
  );
  tracker.applications[0].artifacts = { jd: "workspace/jobs/northstar.md" };
  writeFileSync(path, JSON.stringify(tracker));
  session.refresh();
  await session.dispatch({ op: "document", id: "northstar" });
  assert.match(
    events.find((event) => event.type === "document").artifact.markdown,
    /Own the platform/
  );
  await assert.rejects(session.dispatch({ op: "document", id: "missing" }), /job/i);
  tracker.applications[0].artifacts.jd = "../outside.md";
  writeFileSync(path, JSON.stringify(tracker));
  session.refresh();
  await assert.rejects(session.dispatch({ op: "document", id: "northstar" }), /outside/);
});

test("Textual rejects invalid controls and cannot reopen a closed native session", async (t) => {
  const { session } = await fixture(t);
  for (const message of [
    { op: "view", stage: "missing" },
    { op: "view", currency: "usd" },
    { op: "view", basis: "equity" },
    { op: "resize", cols: -1, rows: 24 },
    { op: "resize", cols: 80, rows: 10000 },
    { op: "request", action: "submit" },
  ])
    await assert.rejects(session.dispatch(message), /stage|currency|basis|dimensions|action/i);
  await session.close();
  await session.close();
  await assert.rejects(session.dispatch({ op: "resize", cols: 80, rows: 24 }), /closed/);
});

test("Textual reuses the actual PTY for input, paste, resize and cleanup", {
  timeout: 9000,
}, async (t) => {
  const childCode =
    "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('TEXTUAL_NATIVE_READY');process.stdin.on('data',b=>process.stdout.write(' GOT:'+b.toString().replaceAll('\\r','ENTER')));";
  const { events, session } = await fixture(t, {
    command: process.execPath,
    args: ["-e", childCode],
  });
  await session.dispatch({ op: "resize", cols: 70, rows: 18 });
  await until(() => screen(events).includes("TEXTUAL_NATIVE_READY"));
  const pid = events.find((event) => event.type === "agent-started").pid;
  await session.dispatch({ op: "input", data: "hello" });
  await until(() => screen(events).includes("GOT:hello"));
  await session.dispatch({ op: "paste", data: "world" });
  await until(() => screen(events).includes("world"));
  await session.dispatch({ op: "resize", cols: 64, rows: 15 });
  await until(() =>
    events.some((event) => event.type === "frame" && event.cols === 64 && event.rows === 15)
  );
  await session.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("later frames carry only the rows that changed", { timeout: 9000 }, async (t) => {
  const childCode =
    "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('FIRST_ROW');process.stdin.on('data',()=>process.stdout.write('\\x1b[5;1HFIFTH_ROW'));";
  const { events, session } = await fixture(t, {
    command: process.execPath,
    args: ["-e", childCode],
  });
  await session.dispatch({ op: "resize", cols: 40, rows: 8 });
  await until(() => screen(events).includes("FIRST_ROW"));
  assert.equal(events.find((event) => event.type === "frame").lines.length, 8);
  const before = events.filter((event) => event.type === "frame").length;
  await session.dispatch({ op: "input", data: "x" });
  await until(() => screen(events).includes("FIFTH_ROW"));
  const later = events.filter((event) => event.type === "frame").slice(before);
  assert.ok(later.length > 0);
  for (const event of later) {
    assert.equal("lines" in event, false);
    assert.ok(event.changed.length <= 2, `sent ${event.changed.length} rows for one row's change`);
  }
  assert.ok(later.some((event) => event.changed.some(([index]) => index === 4)));
  // Nothing changed, so nothing more is sent.
  const count = events.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(events.length, count);
  await session.dispatch({ op: "resize", cols: 44, rows: 8 });
  await until(() => events.at(-1).type === "frame" && events.at(-1).cols === 44);
  assert.equal(events.at(-1).lines.length, 8);
});

test("the agent pane resolves careerrat to this checkout, not an earlier install", {
  timeout: 15000,
}, async (t) => {
  const decoy = mkdtempSync(join(tmpdir(), "careerrat-decoy-"));
  t.after(() => rmSync(decoy, { recursive: true, force: true }));
  writeFileSync(join(decoy, "careerrat"), "#!/bin/sh\necho OLD-INSTALL\n", {
    mode: 0o755,
  });
  const childCode =
    "const r=require('node:child_process').spawnSync('careerrat',['--version'],{encoding:'utf8',shell:process.platform==='win32'});process.stdout.write('CLI['+String(r.stdout).trim()+']');setTimeout(()=>{},3000)";
  const { events, session } = await fixture(
    t,
    { command: process.execPath, args: ["-e", childCode] },
    { PATH: `${decoy}${delimiter}${process.env.PATH}` }
  );
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  await session.dispatch({ op: "resize", cols: 70, rows: 18 });
  await until(() => screen(events).includes("CLI["));
  const text = screen(events);
  assert.match(text, new RegExp(`CLI\\[${version.replaceAll(".", "\\.")}\\]`));
  assert.doesNotMatch(text, /OLD-INSTALL/);
});

test("Textual opens a saved JD stored inline instead of as a file path", async (t) => {
  const { session, events, path, tracker } = await fixture(t);
  tracker.applications[0].artifacts = {
    jd: "# Platform role\n\nOwn the platform and its services.\n\nRequirements\n- Go",
  };
  writeFileSync(path, JSON.stringify(tracker));
  session.refresh();
  await session.dispatch({ op: "document", id: "northstar" });
  const { artifact } = events.find((event) => event.type === "document");
  assert.match(artifact.markdown, /Own the platform/);
  assert.equal(artifact.completeness, "complete");
});

test("a request with no agent says why and a missing agent is announced", async (t) => {
  const { session, events } = await fixture(
    t,
    null,
    {},
    {
      agentIssue: "Couldn't find codex on your PATH, so no agent started.",
    }
  );
  assert.deepEqual(
    events.find((event) => event.type === "agent-status"),
    {
      type: "agent-status",
      message: "Couldn't find codex on your PATH, so no agent started.",
    }
  );
  await session.dispatch({ op: "request", action: "search" });
  const request = events.find((event) => event.type === "request");
  assert.equal(request.inserted, false);
  assert.match(request.reason, /Couldn't find codex/);
  assert.match(request.text, /search-jobs/);
});

test("an idle database workspace doesn't keep re-reading and re-sending itself", async (t) => {
  const { home, tracker } = await fixture(t);
  const events = [];
  importFromTracker({
    repoRoot: root,
    env: { ...process.env, CAREERRAT_HOME: home },
    sourceDir: join(home, "workspace"),
  });
  closeAll();
  const session = await api.createTextualSession({
    repoRoot: root,
    env: { ...process.env, CAREERRAT_HOME: home },
    emit: (event) => events.push(event),
  });
  t.after(async () => {
    await session.close();
    closeAll();
  });
  // A real write is seen once...
  assert.equal(tracker.applications.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // ...but reading the database must not cause more reads on its own.
  assert.equal(
    events.filter((event) => event.type === "workspace").length,
    1,
    `idle workspace sent ${events.filter((event) => event.type === "workspace").length} snapshots`
  );
});

test("a database write is seen once by polling the data version, then the session goes quiet", async (t) => {
  const { home } = await fixture(t);
  const env = { ...process.env, CAREERRAT_HOME: home };
  importFromTracker({
    repoRoot: root,
    env,
    sourceDir: join(home, "workspace"),
  });
  closeAll();
  const events = [];
  const session = await api.createTextualSession({
    repoRoot: root,
    env,
    emit: (event) => events.push(event),
  });
  t.after(async () => {
    await session.close();
    closeAll();
  });
  const { DatabaseSync } = await import("node:sqlite");
  const { dbFilePath } = await import("../src/core/db/connection.mjs");
  const writer = new DatabaseSync(dbFilePath({ repoRoot: root, env }));
  t.after(() => writer.close());
  writer.exec("PRAGMA busy_timeout = 5000");
  const row = writer.prepare("SELECT id, data FROM applications WHERE id = 'northstar'").get();
  const record = JSON.parse(row.data);
  record.statusNote = "Changed from outside";
  writer
    .prepare("UPDATE applications SET data = ? WHERE id = ?")
    .run(JSON.stringify(record), row.id);
  await until(() =>
    events.some(
      (event) => event.type === "detail" && event.job.record.statusNote === "Changed from outside"
    )
  );
  const seen = events.filter((event) => event.type === "workspace").length;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(events.filter((event) => event.type === "workspace").length, seen);
});

test("snapshots carry summary rows and the selected job arrives as one detail event", async (t) => {
  const { events, session, path, tracker } = await fixture(t);
  tracker.applications[0].evaluation.requirements = Array.from({ length: 500 }, (_, index) => ({
    requirement: `Requirement ${index}`,
    evidence: "x".repeat(2000),
  }));
  writeFileSync(path, JSON.stringify(tracker));
  session.refresh();
  await until(() => events.some((event) => event.type === "detail" && event.job.truncated));
  const view = snapshot(events).view;
  assert.deepEqual(Object.keys(view.jobs[0].record).sort(), ["company", "role", "status"]);
  assert.ok(JSON.stringify(view).length < 20000, "summary snapshot grew with the saved data");
  const detail = events.filter((event) => event.type === "detail").at(-1);
  assert.equal(detail.job.record.evaluation.requirements.length, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) < 2 * 1024 * 1024);
  await session.dispatch({ op: "select", id: "harbor" });
  assert.equal(events.filter((event) => event.type === "detail").at(-1).id, "harbor");
});
