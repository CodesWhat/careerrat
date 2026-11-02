import assert from "node:assert/strict";
import { test } from "node:test";

const { createAgentPane } = await import("../src/core/tui/agent-pane.mjs");

test("bell, title and clipboard-set requests are surfaced; clipboard reads and junk are not", {
  skip: process.platform === "win32",
  timeout: 8000,
}, async (t) => {
  const got = { bells: 0, titles: [], clipboard: [], wrote: false };
  const script = [
    "process.stdin.on('data',()=>{});",
    "process.stdout.write('\\x07\\x1b]2;Plan mode\\x07');",
    "process.stdout.write('\\x1b]52;c;aGVsbG8gd29ybGQ=\\x07');",
    "process.stdout.write('\\x1b]52;c;?\\x07');",
    "process.stdout.write('\\x1b]52;c;!!not base64!!\\x07');",
    "process.stdout.write('\\x1b]52;c;'+'QUFB'.repeat(500000)+'\\x07');",
    "process.stdout.write('END');",
  ].join("");
  let done;
  const finished = new Promise((resolve) => {
    done = resolve;
  });
  const pane = createAgentPane({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    cols: 40,
    rows: 5,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    onBell: () => got.bells++,
    onTitle: (title) => got.titles.push(title),
    onClipboard: (text) => got.clipboard.push(text),
    onChange: () => {
      if (pane?.terminal.buffer.active.getLine(0)?.translateToString().includes("END")) done();
    },
  });
  t.after(() => pane.dispose());
  await finished;
  assert.equal(got.bells, 1);
  assert.deepEqual(got.titles, ["Plan mode"]);
  assert.deepEqual(got.clipboard, ["hello world"]);
});
