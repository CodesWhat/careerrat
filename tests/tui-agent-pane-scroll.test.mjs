import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { createAgentPane, renderTerminalRows } = await import("../src/core/tui/agent-pane.mjs");

async function until(check) {
  const end = Date.now() + 15000;
  while (!check()) {
    assert.ok(Date.now() < end, "timed out waiting for the pane");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function start(t, script, { rows = 10 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-pane-scroll-"));
  const log = join(dir, "input.log");
  const pane = createAgentPane({
    command: process.execPath,
    args: [
      "-e",
      `const fs=require('node:fs');process.stdin.setRawMode&&process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data',b=>fs.appendFileSync(${JSON.stringify(log)},b.toString('hex')+'\\n'));${script}`,
    ],
    cwd: process.cwd(),
    cols: 40,
    rows,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  t.after(async () => {
    await pane.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  return { pane, log };
}
const screen = (pane) => renderTerminalRows(pane.terminal).join("\n");

test("pane history scrolls back and returns to the live screen when you type", {
  skip: process.platform === "win32",
}, async (t) => {
  const { pane, log } = start(t, "for(let i=0;i<60;i++)console.log('LINE'+i);console.log('DONE');");
  await until(() => screen(pane).includes("DONE"));
  assert.equal(pane.scrollState().offset, 0);
  assert.equal(pane.scroll({ lines: -20 }), true);
  assert.equal(pane.scrollState().offset, 20);
  assert.doesNotMatch(screen(pane), /DONE/);
  assert.match(screen(pane), /LINE3\d/);
  assert.equal(pane.cursor().visible, false);
  assert.equal(pane.scroll({ pages: 1 }), true);
  assert.equal(pane.scrollState().offset, 20 - 9);
  pane.input("x");
  assert.equal(pane.scrollState().offset, 0);
  assert.match(screen(pane), /DONE/);
  await until(() => existsSync(log) && readFileSync(log, "utf8").includes("78"));
});

test("a wheel turn scrolls history unless the program asked for the mouse", {
  skip: process.platform === "win32",
}, async (t) => {
  const plain = start(t, "for(let i=0;i<60;i++)console.log('LINE'+i);console.log('DONE');");
  await until(() => screen(plain.pane).includes("DONE"));
  assert.equal(plain.pane.wheel({ direction: -1 }), "scroll");
  assert.equal(plain.pane.scrollState().offset, 3);
  assert.equal(plain.pane.wheel({ direction: 1 }), "scroll");
  assert.equal(plain.pane.scrollState().offset, 0);

  const mouse = start(t, "process.stdout.write('\\x1b[?1000h\\x1b[?1006hMOUSE_ON');");
  await until(() => screen(mouse.pane).includes("MOUSE_ON"));
  assert.equal(mouse.pane.wheel({ direction: -1, col: 4, row: 2 }), "mouse");
  assert.equal(mouse.pane.wheel({ direction: 1, col: 4, row: 2 }), "mouse");
  // Both wheel reports can arrive in one read, so wait on the bytes, not the
  // number of reads.
  const expected = "\x1b[<64;5;3M\x1b[<65;5;3M";
  const received = () =>
    existsSync(mouse.log)
      ? Buffer.from(readFileSync(mouse.log, "utf8").replace(/\n/g, ""), "hex").toString()
      : "";
  await until(() => received().length >= expected.length);
  assert.equal(received(), expected);

  const legacy = start(t, "process.stdout.write('\\x1b[?1000hLEGACY_ON');");
  await until(() => screen(legacy.pane).includes("LEGACY_ON"));
  assert.equal(legacy.pane.wheel({ direction: -1, col: 0, row: 0 }), "mouse");
  await until(() => existsSync(legacy.log));
  const bytes = Buffer.from(readFileSync(legacy.log, "utf8").trim(), "hex");
  assert.deepEqual([...bytes], [0x1b, 0x5b, 0x4d, 96, 33, 33]);
});
