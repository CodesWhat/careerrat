// `careerrat data verify` passed communication rows that `careerrat tracker
// --verify` rejects, because comm rows were stored unchecked and verify only
// ran the domain checks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const repo = join(import.meta.dirname, "..");
const roots = [];
const env = { ...process.env, CAREERRAT_NO_UPDATE_CHECK: "1" };
delete env.CAREERRAT_HOME;
delete env.CAREERRAT_PERSON;

function data(root, args) {
  return spawnSync(process.execPath, ["src/cli/data.mjs", "--root", root, "--json", ...args], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "careerrat-verify-"));
  roots.push(root);
  assert.equal(data(root, ["init"]).status, 0);
  return root;
}

test("a message with an unknown direction is refused when the thread is saved", () => {
  const root = workspace();
  const result = data(root, [
    "comm",
    "upsert",
    "--data",
    JSON.stringify({
      id: "comm-1",
      status: "waiting",
      summary: "Thread",
      messages: [{ direction: "sideways", summary: "x" }],
    }),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /direction must be one of/);
});

test("data verify fails on a communication row the tracker schema rejects", () => {
  const root = workspace();
  const saved = data(root, [
    "comm",
    "upsert",
    "--data",
    JSON.stringify({ id: "comm-2", status: "bogus-status", summary: "Thread", messages: [] }),
  ]);
  assert.equal(saved.status, 0, saved.stdout + saved.stderr);
  const verify = data(root, ["verify"]);
  assert.equal(verify.status, 1, verify.stdout);
  assert.match(verify.stdout, /schema .*status/i);
});

test("app set-status refuses a status the tracker doesn't recognize instead of saving it", () => {
  const root = workspace();
  const row = { id: "app-1", company: "Example", role: "Engineer", status: "awaiting" };
  assert.equal(data(root, ["app", "upsert", "--data", JSON.stringify(row)]).status, 0);
  const bad = data(root, ["app", "set-status", "app-1", "zzz-not-a-status"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /not a status CareerRat knows/);
  const good = data(root, ["app", "set-status", "app-1", "interview"]);
  assert.equal(good.status, 0, good.stdout + good.stderr);
});
