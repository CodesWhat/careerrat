import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repo = join(import.meta.dirname, "..");
function run(script, args) {
  const home = mkdtempSync(join(tmpdir(), "careerrat-flags-"));
  try {
    return spawnSync(process.execPath, [script, ...args], {
      cwd: repo,
      env: { ...process.env, CAREERRAT_HOME: home, CAREERRAT_NO_UPDATE_CHECK: "1" },
      encoding: "utf8",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("a typo'd tracker flag is an error, not a quiet snapshot", () => {
  const result = run("src/cli/tracker.mjs", ["--verifiy"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option --verifiy/);
});

test("a typo'd doctor flag is an error", () => {
  const result = run("src/cli/doctor.mjs", ["--jsno"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option --jsno/);
});

test("known flags still work", () => {
  assert.equal(run("src/cli/tracker.mjs", ["--help"]).status, 0);
});
