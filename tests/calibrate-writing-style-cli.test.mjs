// With no writing samples the script wrote a style file that pointed at a README
// "Voice" section that doesn't exist and exited 0, so every later draft treated
// the style gate as passed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const repo = join(import.meta.dirname, "..");
const homes = [];
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function run(home) {
  return spawnSync(process.execPath, ["scripts/calibrate-writing-style.mjs"], {
    cwd: repo,
    env: { ...process.env, CAREERRAT_HOME: home, CAREERRAT_NO_UPDATE_CHECK: "1" },
    encoding: "utf8",
  });
}

test("no samples is a not-calibrated failure, every time, and the file says so", () => {
  const home = mkdtempSync(join(tmpdir(), "careerrat-style-"));
  homes.push(home);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run(home);
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.match(result.stderr, /Not calibrated/);
  }
  const style = readFileSync(join(home, "candidate/writing-style.md"), "utf8");
  assert.match(style, /not calibrated/i);
  assert.doesNotMatch(style, /README/);
});

test("with a sample it calibrates, exits 0 and replaces the placeholder", () => {
  const home = mkdtempSync(join(tmpdir(), "careerrat-style-"));
  homes.push(home);
  assert.equal(run(home).status, 3);
  mkdirSync(join(home, "workspace/writing-samples"), { recursive: true });
  writeFileSync(
    join(home, "workspace/writing-samples/note.md"),
    "I fixed the billing queue last spring. It was slow, so I traced it and cut the retries. Short and plain.\n"
  );
  const result = run(home);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const style = readFileSync(join(home, "candidate/writing-style.md"), "utf8");
  assert.doesNotMatch(style, /Not calibrated: no writing samples were provided/);
  assert.equal(run(home).status, 0);
});
