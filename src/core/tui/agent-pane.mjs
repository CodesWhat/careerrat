import pty from "@homebridge/node-pty-prebuilt-multiarch";
import headless from "@xterm/headless";
import {
  killProcessTreeByPid,
  resolveWindowsCommandInterpreter,
  runtimeProcessInvocation,
} from "../ai/runtime-process.mjs";
import { preparePtyHelpers } from "./prepare.mjs";

const { Terminal } = headless;

const SCROLLBACK_LINES = 5000;
const WHEEL_LINES = 3;
const CLIPBOARD_BYTE_LIMIT = 1024 * 1024;

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
  onBell = () => {},
  onTitle = () => {},
  onClipboard = () => {},
} = {}) {
  preparePtyHelpers();
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true,
  });
  let visible = true;
  let sgrMouse = false;
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
  // Mouse reports are encoded one of two ways, and the parser doesn't say which.
  for (const [final, value] of [
    ["h", true],
    ["l", false],
  ])
    subscriptions.push(
      terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        if (params.includes(1006)) sgrMouse = value;
        return false;
      })
    );
  subscriptions.push(
    terminal.onBell(() => {
      if (!disposed) onBell();
    })
  );
  subscriptions.push(
    terminal.onTitleChange((title) => {
      if (!disposed) onTitle(title);
    })
  );
  // OSC 52: the program asks to set the clipboard. Reads ("?") are never
  // answered, so nothing the agent prints can pull the user's clipboard back.
  subscriptions.push(
    terminal.parser.registerOscHandler(52, (data) => {
      const payload = data.slice(data.indexOf(";") + 1);
      if (
        !disposed &&
        payload &&
        payload !== "?" &&
        payload.length <= Math.ceil((CLIPBOARD_BYTE_LIMIT * 4) / 3) + 4 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(payload)
      )
        onClipboard(Buffer.from(payload, "base64").toString("utf8"));
      return true;
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

  function scrollState() {
    const buffer = terminal.buffer.active;
    return { offset: buffer.baseY - buffer.viewportY, max: buffer.baseY };
  }
  function input(data) {
    if (exited || disposed) return;
    // Typing while looking at old output brings the live screen back.
    if (scrollState().offset > 0) terminal.scrollToBottom();
    terminal.input(data);
  }
  // Scroll the pane's own history. Returns whether anything moved.
  function scroll({ lines = 0, pages = 0 } = {}) {
    if (disposed) return false;
    const before = terminal.buffer.active.viewportY;
    terminal.scrollLines(lines + pages * Math.max(1, terminal.rows - 1));
    return terminal.buffer.active.viewportY !== before;
  }
  // A wheel turn goes to the program when it asked for the mouse (the agent's
  // fullscreen mode does), and scrolls the saved history when it didn't.
  function wheel({ direction, col = 0, row = 0 } = {}) {
    if (exited || disposed) return "ignored";
    if (terminal.modes.mouseTrackingMode !== "none") {
      const x = Math.min(Math.max(col, 0), terminal.cols - 1) + 1;
      const y = Math.min(Math.max(row, 0), terminal.rows - 1) + 1;
      const button = direction < 0 ? 64 : 65;
      child.write(
        sgrMouse
          ? `\x1b[<${button};${x};${y}M`
          : `\x1b[M${String.fromCharCode(32 + button, Math.min(32 + x, 255), Math.min(32 + y, 255))}`
      );
      return "mouse";
    }
    if (terminal.buffer.active.type === "alternate") return "ignored";
    scroll({ lines: direction * WHEEL_LINES });
    return "scroll";
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
      if (error.code !== "ESRCH" && !(process.platform !== "win32" && error.code === "EPERM"))
        throw error;
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
        // Darwin can briefly report EPERM for a group containing only zombies.
        if (error.code !== "EPERM") throw error;
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
    scroll,
    wheel,
    scrollState,
    cursor: () => ({
      x: Math.min(terminal.cols - 1, terminal.buffer.active.cursorX),
      y: terminal.buffer.active.cursorY,
      visible: visible && !exited && scrollState().offset === 0,
    }),
    dispose() {
      disposal ||= stop();
      return disposal;
    },
  };
}
