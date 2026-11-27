import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RETIRED = /The browser workspace was retired in v0\.26\. Use `careerrat start`/;

function launch(t, args) {
  const home = mkdtempSync(join(tmpdir(), "careerrat-retired-browser-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return run(process.execPath, ["bin/careerrat.mjs", ...args], {
    cwd: ROOT,
    timeout: 15_000,
    env: {
      ...process.env,
      CAREERRAT_HOME: home,
      CAREERRAT_NO_UPDATE_CHECK: "1",
      PATH: join(home, "no-agents"),
    },
  }).then(
    (ok) => ({ code: 0, home, ...ok }),
    (err) => ({ home, ...err })
  );
}

for (const args of [
  ["start", "--browser"],
  ["start", "--port", "1"],
  ["start", "--no-open"],
  ["tracker-dev"],
]) {
  test(`${args.join(" ")} prints the retired message and exits 1`, async (t) => {
    const result = await launch(t, args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, RETIRED);
    assert.equal(existsSync(join(result.home, "workspace")), false);
  });
}

test("start help no longer advertises the browser workspace", async (t) => {
  const result = await launch(t, ["start", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /terminal workspace/);
  assert.doesNotMatch(result.stdout, /--browser|--no-open|--port|tracker-dev/);
});

test("start with no flags never serves or opens the browser workspace, even with no terminal", async (t) => {
  const result = await launch(t, ["start"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Interactive TUI requires a terminal/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /localhost|\/app\b/);
});
