import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { workspaceThreadRead } from "../src/core/agent/workspace-thread.mjs";
import { closeAll, requireDb } from "../src/core/db/connection.mjs";
import { candidateConfigGet, candidateSetupInitialize } from "../src/core/db/verbs/candidate.mjs";
import { applyTuiUndo } from "../src/core/tui/history.mjs";
import { readJobs } from "../src/core/tui/jobs.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "careerrat-cli-settings-history-"));
  const ctx = {
    repoRoot: root,
    env: {
      CAREERRAT_HOME: home,
      HOME: home,
      PATH: process.env.PATH,
      CAREERRAT_NO_UPDATE_CHECK: "1",
    },
  };
  candidateSetupInitialize(ctx);
  t.after(() => {
    closeAll();
    rmSync(home, { recursive: true, force: true });
  });
  return ctx;
}
function cli(ctx, args, expected = 0) {
  const result = spawnSync(process.execPath, [join(root, "bin/careerrat.mjs"), ...args, "--json"], {
    env: ctx.env,
    encoding: "utf8",
  });
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
test("validated gate writes create real Undo entries while dry runs, no-ops and confirmation refusals don't", (t) => {
  const ctx = fixture(t);
  const original = candidateConfigGet(ctx).profile.compensation?.minimum_base;
  const db = requireDb(ctx);
  const version = db.prepare("SELECT version FROM meta WHERE id = 1").get().version;
  const events = db.prepare("SELECT count(*) AS n FROM activity_events").get().n;
  cli(ctx, ["gate", "comp-floor", "176000"]);
  assert.equal(workspaceThreadRead(ctx).messages.length, 0);
  cli(ctx, ["gate", "comp-floor", "176000", "--write"]);
  assert.equal(db.prepare("SELECT version FROM meta WHERE id = 1").get().version, version + 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM activity_events").get().n, events + 1);
  const changes = readJobs(ctx).changes;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].entry.after, 176000);
  assert.equal(changes[0].entry.path, "compensation.minimum_base");
  cli(ctx, ["gate", "comp-floor", "176000", "--write"]);
  cli(ctx, ["gate", "comp-floor", "175000", "--write"], 2);
  assert.equal(readJobs(ctx).changes.length, 1);
  assert.equal(db.prepare("SELECT version FROM meta WHERE id = 1").get().version, version + 1);
  assert.equal(candidateConfigGet(ctx).profile.compensation.minimum_base, 176000);
  cli(ctx, ["gate", "comp-floor", "175000", "--write", "--confirm"]);
  const latest = readJobs(ctx).changes[0];
  assert.equal(latest.entry.after, 175000);
  assert.equal(applyTuiUndo({ ...ctx, preview: latest }).operationResult.ok, true);
  assert.equal(candidateConfigGet(ctx).profile.compensation.minimum_base, 176000);
  assert.equal(applyTuiUndo({ ...ctx, preview: changes[0] }).operationResult.ok, true);
  assert.equal(candidateConfigGet(ctx).profile.compensation?.minimum_base, original);
});
test("mode and automation CLI writes appear in the same recorded-change view", (t) => {
  const ctx = fixture(t);
  for (const args of [
    ["modes", "set", "usage", "lean"],
    ["automation", "disable", "mail_access"],
    ["automation", "session", "playwright"],
    ["automation", "submit", "manual"],
  ]) {
    const before = readJobs(ctx).changes.length;
    cli(ctx, [...args, "--write"]);
    const next = readJobs(ctx).changes;
    assert.equal(next.length, before + 1, args.join(" "));
    assert.equal(next[0].entry.kind, "knowledge_write");
    assert.equal(applyTuiUndo({ ...ctx, preview: next[0] }).operationResult.ok, true);
  }
});
test("a history failure rolls the candidate write and its activity back atomically", (t) => {
  const ctx = fixture(t);
  const db = requireDb(ctx);
  const before = candidateConfigGet(ctx).profile;
  const activityCount = db.prepare("SELECT count(*) AS n FROM activity_events").get().n;
  db.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON workspace_messages BEGIN SELECT RAISE(ABORT, 'history unavailable'); END"
  );
  const result = cli(ctx, ["gate", "comp-floor", "176000", "--write"], 1);
  assert.equal(result.written, false);
  assert.match(result.error, /history unavailable/);
  assert.deepEqual(candidateConfigGet(ctx).profile, before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM activity_events").get().n, activityCount);
  assert.equal(workspaceThreadRead(ctx).messages.length, 0);
});

test("array and honesty gates retain their actual pre-write value for Undo", (t) => {
  const ctx = fixture(t);
  for (const args of [
    ["gate", "exclude-company", "Synthetic Employer"],
    ["gate", "keep-signal", "Own a platform"],
    ["gate", "do-not-claim", "Synthetic Tool"],
  ]) {
    cli(ctx, [...args, "--write"]);
    const change = readJobs(ctx).changes[0];
    assert.equal(change.entry.source.kind, "cli");
    assert.equal(applyTuiUndo({ ...ctx, preview: change }).operationResult.ok, true);
  }
});

test("the recording adapter exposes references and redacts private values from history", async (t) => {
  const { patchRecordedCandidateConfig } = await import(
    "../src/core/agent/recorded-config-write.mjs"
  );
  const ctx = fixture(t);
  const result = patchRecordedCandidateConfig({
    ...ctx,
    name: "profile",
    patch: { compensation: { current_base: 124321 } },
    writes: [{ path: "compensation.current_base", label: "Private compensation" }],
    writer: "test-private",
  });
  assert.equal(JSON.stringify(result).includes("124321"), false);
  const messages = workspaceThreadRead(ctx).messages;
  assert.equal(JSON.stringify(messages).includes("124321"), false);
  assert.equal(messages.at(-1).artifacts[0].revertible, false);
});
