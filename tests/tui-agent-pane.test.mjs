import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import headless from "@xterm/headless";

const { Terminal } = headless;

const api = await import("../src/core/tui/agent-pane.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
const prepare = await import("../src/core/tui/prepare.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
function requireFunction(owner, name) {
  assert.equal(typeof owner[name], "function", `missing terminal behavior: ${name}`);
  return owner[name];
}

const write = (terminal, value) => new Promise((resolve) => terminal.write(value, resolve));

test("terminal framebuffer preserves color, wide characters and cell boundaries", async () => {
  const render = requireFunction(api, "renderTerminalRows");
  const terminal = new Terminal({ cols: 12, rows: 3, allowProposedApi: true });
  const mirror = new Terminal({ cols: 12, rows: 3, allowProposedApi: true });
  try {
    await write(terminal, "\x1b[38;2;12;34;56m\x1b[1mA界\x1b[0m tail\r\n\x1b[48;5;120mB");
    const rows = render(terminal);
    assert.equal(rows.length, 3);
    await write(mirror, rows.map((line, index) => `\x1b[${index + 1};1H${line}`).join(""));
    assert.equal(mirror.buffer.active.getLine(0).translateToString(true).trimEnd(), "A界 tail");
    assert.equal(mirror.buffer.active.getLine(0).getCell(0).getFgColor(), 0x0c2238);
    assert.ok(mirror.buffer.active.getLine(0).getCell(0).isBold());
    assert.equal(mirror.buffer.active.getLine(0).getCell(1).getWidth(), 2);
    assert.equal(mirror.buffer.active.getLine(1).getCell(0).getBgColor(), 120);
  } finally {
    terminal.dispose();
    mirror.dispose();
  }
});

test("PTY setup repairs only the installed helper's executable bits", (t) => {
  const prepareHelpers = requireFunction(prepare, "preparePtyHelpers");
  const root = mkdtempSync(join(tmpdir(), "careerrat-pty-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = join(root, "prebuilds/darwin-arm64/spawn-helper");
  mkdirSync(dirname(helper), { recursive: true });
  writeFileSync(helper, "fixture", { mode: 0o640 });
  assert.deepEqual(prepareHelpers({ moduleRoot: root, platform: "darwin", arch: "arm64" }), [
    helper,
  ]);
  assert.equal(statSync(helper).mode & 0o777, 0o751);
  assert.deepEqual(prepareHelpers({ moduleRoot: root, platform: "darwin", arch: "arm64" }), []);
  assert.deepEqual(prepareHelpers({ moduleRoot: root, platform: "win32", arch: "arm64" }), []);
});

test("native agent pane routes input, terminal queries, resize and bracketed paste", {
  timeout: 10000,
}, async (t) => {
  const create = requireFunction(api, "createAgentPane");
  requireFunction(prepare, "preparePtyHelpers")();
  let pane;
  let failure;
  let stage = 0;
  let output = "";
  const program = `
    process.stdin.setRawMode(true);process.stdin.resume();
    process.stdout.write('READY:'+process.stdin.isTTY+' '+process.stdout.columns+'x'+process.stdout.rows+'\\r\\n\\x1b[?2004h\\x1b[?25l');
    process.stdin.on('data', data=>{
      const s=data.toString();
      if(s.includes('hello'))process.stdout.write('GOT:hello\\r\\n\\x1b[6n');
      if(s.includes('R'))process.stdout.write('QUERY:ok\\r\\n');
      if(s.includes('200~review'))process.stdout.write('PASTE:ok\\r\\n');
      if(s.includes('\\x03'))process.exit(0);
    });
    process.stdout.on('resize',()=>process.stdout.write('SIZE:'+process.stdout.columns+'x'+process.stdout.rows+'\\r\\n'));
  `;
  const done = new Promise((resolve, reject) => {
    failure = reject;
    pane = create({
      command: process.execPath,
      args: ["-e", program],
      cwd: process.cwd(),
      cols: 40,
      rows: 12,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      onChange() {
        try {
          output =
            pane.terminal.buffer.active.getLine(0)?.translateToString(true) +
            "\n" +
            Array.from(
              { length: pane.terminal.rows },
              (_, i) =>
                pane.terminal.buffer.active
                  .getLine(pane.terminal.buffer.active.baseY + i)
                  ?.translateToString(true) || ""
            ).join("\n");
          if (stage === 0 && output.includes("READY:true 40x12")) {
            stage = 1;
            assert.equal(pane.cursor().visible, false);
            pane.input("hello");
          }
          if (stage === 1 && output.includes("QUERY:ok")) {
            stage = 2;
            pane.resize(50, 14);
          }
          if (stage === 2 && output.includes("SIZE:50x14")) {
            stage = 3;
            pane.paste("review");
          }
          if (stage === 3 && output.includes("PASTE:ok")) {
            stage = 4;
            pane.input("\x03");
          }
        } catch (error) {
          reject(error);
        }
      },
      onExit(result) {
        result.exitCode === 0 && stage === 4
          ? resolve()
          : reject(new Error(JSON.stringify({ result, stage, output })));
      },
    });
  });
  const timer = setTimeout(
    () => failure(new Error(`Agent pane proof timed out at ${stage}: ${output}`)),
    8000
  );
  t.after(async () => {
    clearTimeout(timer);
    await pane?.dispose();
  });
  await done;
});

test("disposing a pane terminates its live child and releases the emulator", {
  timeout: 10000,
}, async () => {
  const create = requireFunction(api, "createAgentPane");
  requireFunction(prepare, "preparePtyHelpers")();
  const pane = create({
    command: process.execPath,
    args: ["-e", "process.stdin.resume()"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    cols: 20,
    rows: 5,
  });
  const pid = pane.pid;
  await pane.dispose();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await pane.dispose();
});

for (const leaderExits of [false, true]) {
  test(`disposing a pane stops its group ${leaderExits ? "after leader exit" : "while leader is live"}`, {
    skip: process.platform === "win32",
    timeout: 10000,
  }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "careerrat-pane-group-"));
    const readyPath = join(root, "ready.json");
    let descendantPid;
    let pane;
    const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(), 12000)"], {
      stdio: "ignore",
    });
    const unrelatedExit = new Promise((resolve) => unrelated.once("exit", resolve));
    t.after(async () => {
      // The fallback deadlines also bound fixture lifetime if the test is interrupted.
      for (const pid of [descendantPid, pane?.pid, unrelated.pid]) {
        if (!pid) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      await pane?.dispose().catch(() => {});
      await unrelatedExit;
      rmSync(root, { recursive: true, force: true });
    });
    const descendant = `
      process.on('SIGTERM', () => {});
      process.on('SIGHUP', () => {});
      setTimeout(() => process.exit(), 12000);
      require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ready: true, pid: process.pid}));
    `;
    const leader = `
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'inherit'});
      const timer = setInterval(() => {
        if (${leaderExits} && require('node:fs').existsSync(${JSON.stringify(readyPath)})) process.exit();
      }, 10);
      setTimeout(() => process.exit(), 12000);
    `;
    let leaderExited = false;
    pane = requireFunction(
      api,
      "createAgentPane"
    )({
      command: process.execPath,
      args: ["-e", leader],
      cwd: process.cwd(),
      onExit() {
        leaderExited = true;
      },
    });
    const deadline = Date.now() + 4000;
    while ((!existsSync(readyPath) || (leaderExits && !leaderExited)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(readyPath), "descendant reported readiness");
    const ready = JSON.parse(readFileSync(readyPath, "utf8"));
    descendantPid = ready.pid;
    assert.equal(ready.ready, true);
    assert.equal(leaderExited, leaderExits);
    process.kill(descendantPid, 0);
    await pane.dispose();
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
    await pane.dispose();
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  });
}
