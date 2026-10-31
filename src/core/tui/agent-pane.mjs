import headless from "@xterm/headless";
import pty from "node-pty";
import {
  killProcessTreeByPid,
  resolveWindowsCommandInterpreter,
  runtimeProcessInvocation,
} from "../ai/runtime-process.mjs";
import { preparePtyHelpers } from "./prepare.mjs";

const { Terminal } = headless;

function cellStyle(cell) {
  const codes = [0];
  for (const [test, code] of [
    ["isBold", 1],
    ["isDim", 2],
    ["isItalic", 3],
    ["isUnderline", 4],
    ["isBlink", 5],
    ["isInverse", 7],
    ["isInvisible", 8],
    ["isStrikethrough", 9],
    ["isOverline", 53],
  ])
    if (cell[test]()) codes.push(code);
  for (const [prefix, color] of [
    ["Fg", 38],
    ["Bg", 48],
  ]) {
    const value = cell[`get${prefix}Color`]();
    if (cell[`is${prefix}RGB`]())
      codes.push(color, 2, (value >> 16) & 255, (value >> 8) & 255, value & 255);
    else if (cell[`is${prefix}Palette`]()) codes.push(color, 5, value);
  }
  return `\x1b[${codes.join(";")}m`;
}

export function renderTerminalRows(terminal) {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) => {
    const line = buffer.getLine(buffer.viewportY + row);
    let output = "";
    let previousStyle = "";
    for (let col = 0; col < terminal.cols; col++) {
      const cell = line?.getCell(col);
      if (!cell) {
        output += " ";
        continue;
      }
      if (cell.getWidth() === 0) continue;
      const style = cellStyle(cell);
      if (style !== previousStyle) {
        output += style;
        previousStyle = style;
      }
      output += cell.getChars() || " ";
    }
    return `${output}\x1b[0m`;
  });
}

export function createAgentPane({
  command,
  args = [],
  cwd,
  env = process.env,
  cols = 60,
  rows = 24,
  onChange = () => {},
  onExit = () => {},
} = {}) {
  preparePtyHelpers();
  const terminal = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
  let visible = true;
  let exited = false;
  let disposed = false;
  let disposal;
  let finishExit;
  const exit = new Promise((resolve) => {
    finishExit = resolve;
  });
  const subscriptions = [];
  let child;
  try {
    const launch = runtimeProcessInvocation(command, args, {
      env,
      resolveInterpreter: () => resolveWindowsCommandInterpreter({ env }),
    });
    child = pty.spawn(
      launch.command,
      launch.options.windowsVerbatimArguments ? launch.args.join(" ") : launch.args,
      {
        cwd,
        env: { ...env, TERM: "xterm-256color" },
        cols,
        rows,
        name: "xterm-256color",
      }
    );
  } catch (error) {
    terminal.dispose();
    throw error;
  }
  const groupPid = child.pid;
  subscriptions.push(
    terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (params.includes(25)) visible = true;
      return false;
    })
  );
  subscriptions.push(
    terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (params.includes(25)) visible = false;
      return false;
    })
  );
  subscriptions.push(
    terminal.onData((data) => {
      if (!exited) child.write(data);
    })
  );
  subscriptions.push(
    terminal.onBinary((data) => {
      if (!exited) child.write(Buffer.from(data, "binary"));
    })
  );
  subscriptions.push(
    terminal.onWriteParsed(() => {
      if (!disposed) onChange();
    })
  );
  subscriptions.push(
    child.onData((data) => {
      if (!disposed) terminal.write(data);
    })
  );
  subscriptions.push(
    child.onExit((result) => {
      exited = true;
      finishExit(result);
      if (!disposed) onExit(result);
    })
  );

  function input(data) {
    if (!exited && !disposed) terminal.input(data);
  }
  function paste(text) {
    const value = String(text)
      .replace(/\r\n?/g, "\n")
      .replace(/\p{Cc}/gu, (char) => (char === "\n" || char === "\t" ? char : ""));
    if (value.includes("\n") && !terminal.modes.bracketedPasteMode) {
      throw new Error("The agent has not enabled multiline paste yet");
    }
    input(terminal.modes.bracketedPasteMode ? `\x1b[200~${value}\x1b[201~` : value);
  }
  function resize(nextCols, nextRows) {
    if (disposed || exited) return;
    terminal.resize(nextCols, nextRows);
    child.resize(nextCols, nextRows);
  }
  function signal(name) {
    try {
      if (process.platform === "win32") {
        killProcessTreeByPid(child.pid, { env });
        child.kill();
      } else process.kill(-groupPid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  function waitForExit(ms) {
    if (exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      exit.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
  async function waitForGroupExit(ms) {
    const deadline = Date.now() + ms;
    while (true) {
      try {
        process.kill(-groupPid, 0);
      } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
    }
  }
  async function stop() {
    try {
      if (process.platform !== "win32") {
        signal("SIGTERM");
        if (!(await waitForGroupExit(1500))) {
          signal("SIGKILL");
          if (!(await waitForGroupExit(1000))) {
            throw new Error("The agent process group did not stop");
          }
        }
      } else if (!exited) {
        signal("SIGTERM");
        if (!(await waitForExit(1500))) {
          signal("SIGKILL");
          if (!(await waitForExit(1000))) throw new Error("The agent process did not stop");
        }
      }
    } finally {
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
      terminal.dispose();
    }
  }
  return {
    terminal,
    pid: child.pid,
    input,
    paste,
    resize,
    cursor: () => ({
      x: Math.min(terminal.cols - 1, terminal.buffer.active.cursorX),
      y: terminal.buffer.active.cursorY,
      visible: visible && !exited,
    }),
    dispose() {
      disposal ||= stop();
      return disposal;
    },
  };
}
