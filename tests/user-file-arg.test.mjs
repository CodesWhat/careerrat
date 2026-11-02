// Skills tell the agent to run `careerrat evaluate workspace/...`, but those
// files live under the data root. The CLIs used to resolve against the current
// directory only, so the documented form failed on every default-layout install.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const repo = join(import.meta.dirname, "..");
const homes = [];
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function home() {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-userfile-"));
  homes.push(dir);
  mkdirSync(join(dir, "workspace/jobs"), { recursive: true });
  writeFileSync(
    join(dir, "workspace/jobs/role.md"),
    "---\ntitle: Role\n---\n\n# Job Description\n\nText.\n"
  );
  return dir;
}

function run(script, args, dir) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    env: { ...process.env, CAREERRAT_HOME: dir, CAREERRAT_NO_UPDATE_CHECK: "1" },
    encoding: "utf8",
  });
}

test("evaluate, questions and export find workspace/ files under the data root", () => {
  const dir = home();
  for (const [script, extra] of [
    ["src/cli/evaluate.mjs", []],
    ["src/cli/questions.mjs", []],
    ["src/cli/export.mjs", ["--ats"]],
  ]) {
    const result = run(script, ["workspace/jobs/role.md", ...extra], dir);
    assert.doesNotMatch(
      result.stderr + result.stdout,
      /not found/i,
      `${script} must resolve workspace/ paths: ${result.stderr}`
    );
  }
});

test("a missing file names every place that was searched, including the data root", () => {
  const dir = home();
  const result = run("src/cli/evaluate.mjs", ["workspace/jobs/missing.md"], dir);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(join(dir, "workspace/jobs/missing.md")), result.stderr);
});
