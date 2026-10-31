import { existsSync, watch } from "node:fs";
import { dirname } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { dbFilePath } from "../db/connection.mjs";
import { userPath } from "../paths/workspace.mjs";
import { captureTuiPaste } from "./intake.mjs";
import { readJobs } from "./jobs.mjs";
import {
  createWorkspaceState,
  refreshWorkspace,
  renderWorkspace,
  workspaceKey,
} from "./workspace.mjs";

export async function runTerminalWorkspace({
  repoRoot,
  env = process.env,
  agent = null,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  if (!input.isTTY || !output.isTTY)
    throw new Error("Interactive TUI requires a terminal; use careerrat tui --json for saved jobs");
  const ctx = { repoRoot, env };
  let data = readJobs(ctx);
  let state = createWorkspaceState(data);
  let pane = null;
  let paneRows;
  let agentExited = false;
  let closing = false;
  let drawing = null;
  let refreshing = null;
  let watched = "";
  let watchers = [];
  let pasted = null;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const wasRaw = input.isRaw || false;
  const wasFlowing = input.readableFlowing;
  const originalDataListeners = new Set(input.listeners("data"));
  const originalNewListeners = new Set(input.listeners("newListener"));

  function dimensions() {
    return { cols: Math.max(1, output.columns || 80), rows: Math.max(8, output.rows || 24) };
  }
  function render() {
    drawing = null;
    if (closing) return;
    const frame = renderWorkspace(
      data,
      state,
      dimensions(),
      pane ? { lines: paneRows(pane.terminal), cursor: pane.cursor() } : null
    );
    output.write(`\x1b[?2026h${frame.output}\x1b[?2026l`);
  }
  function scheduleRender() {
    if (!closing && drawing === null) drawing = setTimeout(render, 16);
  }
  function watchTargets() {
    if (closing) return;
    const targets = new Set(
      [dirname(dbFilePath(ctx)), userPath(ctx, "workspace")].map((path) => {
        while (!existsSync(path) && dirname(path) !== path) path = dirname(path);
        return path;
      })
    );
    const key = [...targets].sort().join("\n");
    if (key === watched) return;
    for (const watcher of watchers) watcher.close();
    watchers = [];
    watched = key;
    for (const target of targets) {
      try {
        const watcher = watch(target, () => {
          if (refreshing !== null || closing) return;
          refreshing = setTimeout(() => {
            refreshing = null;
            refresh();
          }, 40);
        });
        watcher.on("error", (error) => {
          state = { ...state, message: `Live refresh: ${error.message}. Press r to retry.` };
          scheduleRender();
        });
        watchers.push(watcher);
      } catch (error) {
        state = { ...state, message: `Live refresh: ${error.message}. Press r to retry.` };
      }
    }
  }
  function refresh() {
    if (closing) return;
    try {
      data = readJobs(ctx);
      state = refreshWorkspace(data, state);
      watchTargets();
    } catch (error) {
      state = { ...state, message: `Saved data could not refresh: ${error.message}` };
    }
    scheduleRender();
  }
  function request(text) {
    if (!pane || agentExited) {
      state = {
        ...state,
        focus: "jobs",
        message: "No running agent. Saved jobs and captured context remain available.",
      };
      return;
    }
    try {
      pane.paste(text);
      state = {
        ...state,
        focus: "agent",
        message: "Request inserted in agent. Review it and press Enter there.",
      };
    } catch (error) {
      state = { ...state, message: error.message };
    }
  }
  function finishPaste() {
    const text = pasted;
    pasted = null;
    if (!text.trim()) return;
    try {
      const captured = captureTuiPaste({ ...ctx, text });
      request(captured.request);
      state = {
        ...state,
        message: `Context saved: ${captured.path}${pane && !agentExited ? " / request inserted; Enter in agent" : ""}`,
      };
    } catch (error) {
      state = {
        ...state,
        message: `Context was not saved: ${error.message}. Keep the source and retry.`,
      };
    }
    scheduleRender();
  }
  function quit(code = 0) {
    if (!closing) {
      closing = true;
      finish(code);
    }
  }
  function keypress(_text, key = {}) {
    if (closing) return;
    if (key.sequence === "\x1b[200~") {
      pasted = "";
      return;
    }
    if (pasted !== null) {
      if (key.sequence === "\x1b[201~") finishPaste();
      else pasted += key.sequence || _text || "";
      return;
    }
    const next = workspaceKey(data, state, key);
    state = next.state;
    if (next.effect?.type === "quit") {
      quit();
      return;
    }
    if (next.effect?.type === "refresh") refresh();
    if (next.effect?.type === "agent-input" && pane && !agentExited) pane.input(next.effect.data);
    if (next.effect?.type === "agent-request") request(next.effect.text);
    scheduleRender();
  }
  function resize() {
    if (pane && !agentExited) {
      const { layout } = renderWorkspace(data, state, dimensions());
      pane.resize(layout.agent.cols, layout.agent.rows);
    }
    scheduleRender();
  }
  const terminate = () => quit(130);
  try {
    output.write("\x1b[?1049h\x1b[?7l\x1b[?2004h");
    input.setEncoding("utf8");
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on("keypress", keypress);
    input.resume();
    output.on("resize", resize);
    process.on("SIGTERM", terminate);
    process.on("SIGHUP", terminate);
    process.on("SIGINT", terminate);
    if (agent) {
      const native = await import("./agent-pane.mjs");
      const { layout } = renderWorkspace(data, state, dimensions());
      paneRows = native.renderTerminalRows;
      try {
        pane = native.createAgentPane({
          command: agent.command,
          args: agent.args || [],
          cwd: repoRoot,
          env: { ...env, CAREERRAT_SURFACE: "tui" },
          cols: layout.agent.cols,
          rows: layout.agent.rows,
          onChange: scheduleRender,
          onExit: ({ exitCode }) => {
            if (closing) return;
            agentExited = true;
            state = {
              ...state,
              focus: "jobs",
              message: `Agent exited (${exitCode}). Saved jobs remain available.`,
            };
            refresh();
          },
        });
      } catch (error) {
        state = { ...state, message: `Agent could not start: ${error.message}` };
      }
    }
    watchTargets();
    refresh();
    render();
    return await done;
  } finally {
    closing = true;
    clearTimeout(drawing);
    clearTimeout(refreshing);
    for (const watcher of watchers) watcher.close();
    input.off("keypress", keypress);
    output.off("resize", resize);
    process.off("SIGTERM", terminate);
    process.off("SIGHUP", terminate);
    process.off("SIGINT", terminate);
    try {
      await pane?.dispose();
    } finally {
      for (const listener of input.listeners("data"))
        if (!originalDataListeners.has(listener)) input.off("data", listener);
      for (const listener of input.listeners("newListener"))
        if (!originalNewListeners.has(listener)) input.off("newListener", listener);
      input.setRawMode(wasRaw);
      if (wasFlowing !== true) input.pause();
      output.write("\x1b[0m\x1b[?2026l\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l");
    }
  }
}
