import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const api = await import("../src/core/tui/textual-session.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
const root = join(import.meta.dirname, "..");
async function fixture(t, agent = null) {
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
      { id: "harbor", company: "Harbor", role: "Platform Lead", status: "applied" },
    ],
  };
  const path = join(home, "workspace/tracker.json");
  writeFileSync(path, JSON.stringify(tracker));
  const events = [];
  const session = await api.createTextualSession({
    repoRoot: root,
    env: { ...process.env, CAREERRAT_HOME: home },
    agent,
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
  await session.dispatch({ op: "select", id: "harbor" });
  assert.equal(snapshot(events).view.selectedId, "harbor");
  await session.dispatch({ op: "view", stage: "applied" });
  assert.equal(snapshot(events).view.jobs.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path)), tracker);
  assert.equal(readFileSync(path, "utf8").includes("lastUpdatedAt"), false);
  await session.dispatch({ op: "select", id: "missing" });
  assert.equal(snapshot(events).view.selectedId, "harbor");
  assert.equal(snapshot(events).view.mode, "legacy");
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
    snapshot(events).view.jobs.some((job) => job.record.statusNote === "Recruiter replied")
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
  await until(() =>
    events.some(
      (event) => event.type === "frame" && event.lines.join("").includes("TEXTUAL_NATIVE_READY")
    )
  );
  const pid = events.find((event) => event.type === "agent-started").pid;
  await session.dispatch({ op: "input", data: "hello" });
  await until(() =>
    events.some((event) => event.type === "frame" && event.lines.join("").includes("GOT:hello"))
  );
  await session.dispatch({ op: "paste", data: "world" });
  await until(() =>
    events.some((event) => event.type === "frame" && event.lines.join("").includes("world"))
  );
  await session.dispatch({ op: "resize", cols: 64, rows: 15 });
  await until(() =>
    events.some((event) => event.type === "frame" && event.cols === 64 && event.rows === 15)
  );
  await session.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
