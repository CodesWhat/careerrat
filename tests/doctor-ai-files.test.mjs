// A malformed config/ai.json or ai-preferences.json was silently replaced by
// defaults. Doctor now says so, and no longer calls unused plugins "runnable".
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

function doctor(home, args = []) {
  return spawnSync(process.execPath, ["src/cli/doctor.mjs", ...args], {
    cwd: repo,
    env: { ...process.env, CAREERRAT_HOME: home, CAREERRAT_NO_UPDATE_CHECK: "1" },
    encoding: "utf8",
    timeout: 60000,
  });
}

function home() {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-doctor-ai-"));
  homes.push(dir);
  return dir;
}

test("doctor reports an unparseable ai.json and ai-preferences.json", () => {
  const dir = home();
  mkdirSync(join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, "internal"), { recursive: true });
  writeFileSync(join(dir, "config/ai.json"), "{ not json");
  writeFileSync(join(dir, "internal/ai-preferences.json"), '{"version":2}');
  const parsed = JSON.parse(doctor(dir, ["--json", "--guidance-only"]).stdout);
  assert.equal(parsed.aiFiles.config.status, "invalid");
  assert.match(parsed.aiFiles.config.error, /not valid JSON/);
  assert.equal(parsed.aiFiles.preferences.status, "invalid");
  const text = doctor(dir, ["--guidance-only"]).stdout;
  assert.match(text, /could not read \(defaults are in use\)/);
});

test("missing AI settings files are fine and not reported", () => {
  const dir = home();
  const parsed = JSON.parse(doctor(dir, ["--json", "--guidance-only"]).stdout);
  assert.equal(parsed.aiFiles.config.status, "missing");
  assert.doesNotMatch(doctor(dir, ["--guidance-only"]).stdout, /could not read/);
});

test("the plugin line says verified, not runnable", () => {
  const out = doctor(home(), ["--guidance-only"]).stdout;
  assert.match(out, /verified \(nothing calls plugins yet\)/);
  assert.doesNotMatch(out, /runnable/);
});
