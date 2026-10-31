import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workspaceThreadRead } from "../src/core/agent/workspace-thread.mjs";
import { closeAll, requireDb } from "../src/core/db/connection.mjs";
import { candidateConfigGet, candidateSetupInitialize } from "../src/core/db/verbs/candidate.mjs";
import { applyTuiUndo } from "../src/core/tui/history.mjs";
import { readJobs } from "../src/core/tui/jobs.mjs";

const root = join(import.meta.dirname, "..");
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "careerrat-evidence-history-"));
  const ctx = { repoRoot: root, env: { CAREERRAT_HOME: home, HOME: home, PATH: process.env.PATH } };
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
function merge(ctx, claims, expected = 0) {
  return cli(ctx, ["data", "candidate", "evidence", "--data", JSON.stringify(claims)], expected);
}
test("native evidence saves record canonical ids and support update then add Undo", (t) => {
  const ctx = fixture(t);
  const result = merge(ctx, [
    { claim: "  Built a scheduling engine  ", evidence: "Project notes" },
  ]);
  const added = readJobs(ctx).changes[0];
  assert.ok(added, "the evidence save must appear in recorded changes");
  assert.equal(added.entry.id, result.data.claims[0].id);
  assert.equal(added.entry.after.claim, "Built a scheduling engine");
  assert.equal(added.entry.source.kind, "cli");
  const original = candidateConfigGet(ctx).evidence.claims[0];
  merge(ctx, [{ ...original, evidence: "Project notes and design review" }]);
  const updated = readJobs(ctx).changes[0];
  assert.deepEqual(updated.entry.before, original);
  assert.equal(applyTuiUndo({ ...ctx, preview: updated }).operationResult.ok, true);
  assert.deepEqual(candidateConfigGet(ctx).evidence.claims[0], original);
  assert.equal(applyTuiUndo({ ...ctx, preview: added }).operationResult.ok, true);
  assert.deepEqual(candidateConfigGet(ctx).evidence.claims, []);
});
test("evidence dry runs, unchanged writes and skipped duplicate claims create no extra history", (t) => {
  const ctx = fixture(t);
  const file = join(ctx.env.CAREERRAT_HOME, "claim.yml");
  writeFileSync(file, "id: sample-claim\nclaim: Built a scheduler\nevidence: Project notes\n");
  cli(ctx, ["evidence", "add", "--file", file]);
  assert.equal(workspaceThreadRead(ctx).messages.length, 0);
  cli(ctx, ["evidence", "add", "--file", file, "--write"]);
  assert.equal(readJobs(ctx).changes.length, 1);
  const original = candidateConfigGet(ctx).evidence.claims[0];
  merge(ctx, [original]);
  merge(ctx, [{ claim: original.claim, evidence: "Duplicate without id" }]);
  assert.equal(readJobs(ctx).changes.length, 1);
});
test("a failed evidence history insert rolls back evidence, setup, activity and revision", (t) => {
  const ctx = fixture(t);
  const db = requireDb(ctx);
  const before = candidateConfigGet(ctx);
  const version = db.prepare("SELECT version FROM meta WHERE id = 1").get().version;
  const events = db.prepare("SELECT count(*) AS n FROM activity_events").get().n;
  db.exec(
    "CREATE TRIGGER fail_evidence_history BEFORE INSERT ON workspace_messages BEGIN SELECT RAISE(ABORT, 'history unavailable'); END"
  );
  const result = merge(ctx, [{ claim: "Built a scheduler", evidence: "Project notes" }], 1);
  assert.match(result.error, /history unavailable/);
  assert.deepEqual(candidateConfigGet(ctx), before);
  assert.equal(db.prepare("SELECT version FROM meta WHERE id = 1").get().version, version);
  assert.equal(db.prepare("SELECT count(*) AS n FROM activity_events").get().n, events);
  assert.equal(workspaceThreadRead(ctx).messages.length, 0);
});
