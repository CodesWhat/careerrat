import { randomUUID } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { dirname } from "node:path";
import { dbFilePath } from "../db/connection.mjs";
import { readSavedJobDescription } from "../jobs/job-description.mjs";
import { userPath } from "../paths/workspace.mjs";
import { stopTerminalSessionSearches } from "../search/terminal-search-worker.mjs";
import { applyTuiUndo } from "./history.mjs";
import { captureTuiContext } from "./intake.mjs";
import { readJobs, viewJobs } from "./jobs.mjs";
import { createWorkspaceState, refreshWorkspace, workspaceKey } from "./workspace.mjs";

export async function createTextualSession({ repoRoot, env = process.env, agent = null, emit }) {
  const ctx = { repoRoot, env };
  const sessionId = randomUUID();
  let data = readJobs(ctx);
  let state = createWorkspaceState(data);
  let pane;
  let native;
  let exited = false;
  let closing = false;
  let closePromise;
  let drawing;
  let refreshing;
  let watched = "";
  let watchers = [];

  function send(event) {
    if (!closing) emit(event);
  }
  function snapshot() {
    send({ type: "workspace", view: viewJobs(data, state), state });
  }
  function frame() {
    drawing = null;
    if (!pane) return;
    send({
      type: "frame",
      lines: native.renderTerminalRows(pane.terminal),
      cursor: pane.cursor(),
      cols: pane.terminal.cols,
      rows: pane.terminal.rows,
    });
  }
  function scheduleFrame() {
    if (!closing && !drawing) drawing = setTimeout(frame, 16);
  }
  function watchTargets() {
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
          if (closing || refreshing) return;
          refreshing = setTimeout(() => {
            refreshing = null;
            refresh();
          }, 40);
        });
        watcher.on("error", (error) => send({ type: "error", message: error.message }));
        watchers.push(watcher);
      } catch (error) {
        send({ type: "error", message: error.message });
      }
    }
  }
  function refresh() {
    if (closing) return;
    try {
      data = readJobs(ctx);
      state = refreshWorkspace(data, state);
      watchTargets();
      snapshot();
    } catch (error) {
      send({ type: "error", message: `Saved data could not refresh: ${error.message}` });
    }
  }
  function request(text) {
    const inserted = Boolean(pane && !exited);
    if (inserted) pane.paste(text);
    send({ type: "request", text, inserted });
  }
  async function dispatch(message) {
    if (closing) throw new Error("Textual session is closed");
    switch (message.op) {
      case "select": {
        if (viewJobs(data, state).jobs.some((job) => job.id === message.id))
          state = refreshWorkspace(data, { ...state, selectedId: message.id, pendingUndo: null });
        snapshot();
        break;
      }
      case "view": {
        const options = {};
        for (const field of ["stage", "currency", "basis", "order"])
          if (message[field] !== undefined) options[field] = message[field];
        if (
          options.stage !== undefined &&
          options.stage !== "all" &&
          !data.jobs.some((job) => job.stage.id === options.stage)
        )
          throw new TypeError("Unknown job stage");
        if (options.currency !== undefined && !/^[A-Z]{3}$/.test(options.currency))
          throw new TypeError("Currency must be a three-letter code");
        viewJobs(data, { ...state, ...options });
        state = refreshWorkspace(data, { ...state, ...options, pendingUndo: null });
        snapshot();
        break;
      }
      case "refresh":
        refresh();
        break;
      case "document": {
        const job = data.jobs.find((item) => item.id === message.id);
        if (!job) throw new Error("Saved job was not found");
        const document = readSavedJobDescription({
          ...ctx,
          record: job.record,
          recordType: job.kind,
          recordId: job.id,
        });
        send({ type: "document", ...document });
        break;
      }
      case "request": {
        const name = { search: "1", review: "2", apply: "3", context: "4" }[message.action];
        if (!name) throw new TypeError("Unknown agent action");
        const next = workspaceKey(data, { ...state, focus: "jobs", pendingUndo: null }, { name });
        if (next.effect?.type === "agent-request") request(next.effect.text);
        break;
      }
      case "capture": {
        const captured = await captureTuiContext({
          ...ctx,
          text: message.text,
          selectedId: state.selectedId,
        });
        send({ type: "context", ...captured });
        if (!closing) request(captured.request);
        break;
      }
      case "key": {
        const next = workspaceKey(
          data,
          { ...state, focus: "jobs" },
          { name: message.name, sequence: message.name }
        );
        state = next.state;
        if (next.effect?.type === "undo") {
          const result = applyTuiUndo({ ...ctx, preview: next.effect.preview });
          state = {
            ...state,
            message: result.operationResult?.ok
              ? "Change undone."
              : result.messages?.at(-1)?.text || "Undo was refused; inspect the saved change.",
          };
          send({ type: "undo", result });
          refresh();
        } else snapshot();
        break;
      }
      case "resize": {
        const { cols, rows } = message;
        if (
          !Number.isInteger(cols) ||
          !Number.isInteger(rows) ||
          cols < 1 ||
          rows < 1 ||
          cols > 1000 ||
          rows > 500
        )
          throw new TypeError("Invalid terminal dimensions");
        if (agent && !pane && !exited) {
          native = await import("./agent-pane.mjs");
          if (closing) return;
          pane = native.createAgentPane({
            command: agent.command,
            args: agent.args || [],
            cwd: repoRoot,
            env: { ...env, CAREERRAT_SURFACE: "tui", CAREERRAT_TUI_SESSION: sessionId },
            cols,
            rows,
            onChange: scheduleFrame,
            onExit: ({ exitCode }) => {
              exited = true;
              send({ type: "agent-exited", exitCode });
              refresh();
            },
          });
          send({ type: "agent-started", pid: pane.pid });
        } else if (pane && !exited) pane.resize(cols, rows);
        scheduleFrame();
        break;
      }
      case "input":
      case "paste":
        if (typeof message.data !== "string") throw new TypeError("Agent input must be text");
        if (pane && !exited) pane[message.op](message.data);
        break;
      default:
        throw new TypeError("Unknown Textual operation");
    }
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(drawing);
    clearTimeout(refreshing);
    for (const watcher of watchers) watcher.close();
    closePromise = (async () => {
      try {
        await pane?.dispose();
      } finally {
        await stopTerminalSessionSearches({ ...ctx, sessionId });
      }
    })();
    return closePromise;
  }
  watchTargets();
  snapshot();
  return { dispatch, refresh, close };
}
