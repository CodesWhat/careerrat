import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readVersion } from "../src/core/version.mjs";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function fixture(t, { agentExit = 0, opener = false, appFails = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "careerrat-browser-start-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const agentRecord = join(home, "agent.json");
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}\nimport { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(agentRecord)}, JSON.stringify(process.argv.slice(2))); process.exit(${agentExit});\n`,
    { mode: 0o755 }
  );
  const openRecord = join(home, "opened.json");
  if (opener) {
    writeFileSync(
      join(bin, process.platform === "darwin" ? "open" : "xdg-open"),
      `#!${process.execPath}\nimport { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(openRecord)}, JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o755 }
    );
  }
  const server = createServer((req, res) => {
    assert.equal(req.url, "/api/health");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ ok: true, product: "careerrat", version: readVersion(), pid: process.pid })
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  if (appFails) await new Promise((resolve) => server.close(resolve));
  const launch = (args = []) =>
    run(process.execPath, ["bin/careerrat.mjs", "start", "--port", String(port), ...args], {
      cwd: ROOT,
      timeout: 15_000,
      env: {
        ...process.env,
        CAREERRAT_HOME: home,
        CAREERRAT_NO_UPDATE_CHECK: "1",
        PATH: bin,
        ...(appFails ? { CAREERRAT_TRACKER_HOST: "0.0.0.0" } : {}),
      },
    });
  return { home, port, launch, agentRecord, openRecord };
}

test("start keeps the conversation in the browser without launching a terminal agent", async (t) => {
  const f = await fixture(t, { agentExit: 42 });
  const result = await f.launch(["--no-open"]);

  assert.match(result.stdout, new RegExp(`http://localhost:${f.port}/app`));
  assert.match(result.stdout, /Continue in your browser/);
  assert.doesNotMatch(result.stdout, /Open your agent|Launching Claude|starter message/);
  assert.equal(existsSync(f.agentRecord), false);
  assert.equal(existsSync(f.openRecord), false);
});

test("browser startup preserves an existing workspace", async (t) => {
  const f = await fixture(t);
  const workspace = join(f.home, "workspace");
  mkdirSync(workspace, { recursive: true });
  const tracker = '{"applications":[{"id":"existing-job","status":"interview"}]}\n';
  writeFileSync(join(workspace, "tracker.json"), tracker);

  await f.launch(["--no-open"]);

  assert.equal(readFileSync(join(workspace, "tracker.json"), "utf8"), tracker);
  assert.equal(existsSync(f.agentRecord), false);
});

test("an explicit terminal agent retains the skill handoff", async (t) => {
  const f = await fixture(t);
  const result = await f.launch(["claude", "--no-open"]);

  assert.match(result.stdout, /Launching Claude/);
  const args = JSON.parse(readFileSync(f.agentRecord, "utf8"));
  assert.equal(args.length, 1);
  assert.match(args[0], /run careerrat doctor/);
});

test("browser start falls back to the printed URL if the opener is unavailable", async (t) => {
  const f = await fixture(t);
  const result = await f.launch();

  assert.match(result.stdout, /Open this address in your browser/);
  assert.match(result.stdout, new RegExp(`http://localhost:${f.port}/app`));
  assert.equal(existsSync(f.agentRecord), false);
});

test("browser start opens the actual app URL", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await fixture(t, { opener: true });
  await f.launch();
  const deadline = Date.now() + 2_000;
  while (!existsSync(f.openRecord) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(JSON.parse(readFileSync(f.openRecord, "utf8")), [
    `http://localhost:${f.port}/app`,
  ]);
  assert.equal(existsSync(f.agentRecord), false);
});

test("start help exits before creating workspace data or launching anything", async (t) => {
  const f = await fixture(t);
  const result = await f.launch(["--help"]);

  assert.match(result.stdout, /--no-open/);
  assert.equal(existsSync(join(f.home, "workspace")), false);
  assert.equal(existsSync(f.agentRecord), false);
});

test("start reports failure and never opens the browser when the local app does not come up", async (t) => {
  const f = await fixture(t, { opener: true, appFails: true });
  await assert.rejects(f.launch(), (err) => {
    assert.notEqual(err.code, 0);
    assert.match(err.stderr, new RegExp(`http://localhost:${f.port}/app`));
    assert.match(err.stderr, /did not come up/);
    assert.match(err.stderr, /tracker-dev\.log/);
    return true;
  });
  assert.equal(existsSync(f.openRecord), false);
});
