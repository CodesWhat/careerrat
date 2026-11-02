import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

test("Textual bridge carries canonical requests and survives malformed messages until EOF", {
  timeout: 6000,
}, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "careerrat-textual-bridge-"));
  mkdirSync(join(home, "workspace"));
  writeFileSync(
    join(home, "workspace/tracker.json"),
    JSON.stringify({
      applications: [{ id: "saved-role", company: "Saved", role: "Lead", status: "applied" }],
    })
  );
  const child = spawn(process.execPath, ["src/core/tui/textual-bridge.mjs", "--no-agent"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, CAREERRAT_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => events.push(JSON.parse(line)));
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const exit = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await exit;
    lines.close();
    rmSync(home, { recursive: true, force: true });
  });
  child.stdin.write('not json\n{"op":"request","action":"apply"}\n');
  const deadline = Date.now() + 4000;
  while (!events.some((event) => event.type === "request")) {
    assert.ok(Date.now() < deadline, errors || "No bridge request");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(events[0].view.jobs[0].id, "saved-role");
  assert.ok(events.some((event) => event.type === "error"));
  assert.match(events.find((event) => event.type === "request").text, /saved-role/);
  child.stdin.end();
  assert.equal(await exit, 0, errors);
});
