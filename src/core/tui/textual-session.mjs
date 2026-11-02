import { createHash, randomUUID } from "node:crypto";
import { readSavedJobDescription } from "../jobs/job-description.mjs";
import { stopTerminalSessionSearches } from "../search/terminal-search-worker.mjs";
import { withCareerratShim } from "./cli-shim.mjs";
import { createDataWatch } from "./data-watch.mjs";
import { applyTuiUndo } from "./history.mjs";
import { captureTuiContext, listDroppedFiles } from "./intake.mjs";
import { capWorkspaceMessages, readJobs, viewJobs } from "./jobs.mjs";
import { jobDetail, summaryJobs } from "./snapshot.mjs";
import { createWorkspaceState, refreshWorkspace, workspaceKey } from "./workspace.mjs";

// agentIssue says why there is no agent when one was asked for or expected:
// the TUI shows it in its own banner and names it when a request has nowhere to go.
export async function createTextualSession({
  repoRoot,
  env = process.env,
  agent = null,
  agentIssue = null,
  emit,
}) {
  const ctx = { repoRoot, env };
  const sessionId = randomUUID();
  let data = readJobs(ctx);
  let state = createWorkspaceState(data);
  let currentView;
  let pane;
  let native;
  let exited = false;
  let closing = false;
  let closePromise;
  let drawing;
  let watcher;
  let lastSnapshot = "";
  let framed = null;

  function send(event) {
    if (!closing) emit(event);
  }
  // The selected job travels in full after each snapshot and selection; the
  // snapshot itself carries summary rows only, so its size stays flat.
  function sendDetail() {
    const job = currentView?.jobs.find((item) => item.id === state.selectedId);
    if (job) send({ type: "detail", id: job.id, job: jobDetail(job) });
  }
  // A refresh that finds nothing new sends nothing, so an idle workspace stays
  // quiet and a status message isn't wiped by a snapshot identical to the last.
  function snapshot({ force = true } = {}) {
    const view = viewJobs(data, state);
    currentView = view;
    const capped = capWorkspaceMessages(view.workspaceMessages);
    const full = {
      ...view,
      workspaceMessages: capped.messages,
      workspaceMessagesTotal: capped.total,
    };
    const key = createHash("sha1")
      .update(JSON.stringify({ view: full, state }))
      .digest("hex");
    if (!force && key === lastSnapshot) return;
    lastSnapshot = key;
    send({
      type: "workspace",
      view: { ...full, jobs: summaryJobs(view.jobs) },
      state,
    });
    sendDetail();
  }
  // Only the rows that changed since the last frame go over the bridge. The
  // first frame, and any frame after a resize, carries every row.
  function frame() {
    drawing = null;
    if (!pane) return;
    const lines = native.renderTerminalRows(pane.terminal);
    const { cols, rows } = pane.terminal;
    const cursor = pane.cursor();
    const scroll = pane.scrollState();
    const meta = JSON.stringify([cols, rows, cursor, scroll]);
    const full = !framed || framed.lines.length !== lines.length || framed.cols !== cols;
    const changed = full
      ? []
      : lines.flatMap((line, index) => (line === framed.lines[index] ? [] : [[index, line]]));
    if (!full && !changed.length && meta === framed.meta) return;
    framed = { lines, cols, meta };
    send({
      type: "frame",
      ...(full ? { lines } : { changed }),
      cursor,
      cols,
      rows,
      scroll,
    });
  }
  function scheduleFrame() {
    if (!closing && !drawing) drawing = setTimeout(frame, 16);
  }
  function refresh({ force = true } = {}) {
    if (closing) return;
    try {
      data = readJobs(ctx);
      state = refreshWorkspace(data, state);
      snapshot({ force });
    } catch (error) {
      send({
        type: "error",
        message: `Saved data could not refresh: ${error.message}`,
      });
    }
  }
  function request(text, notice) {
    const inserted = Boolean(pane && !exited);
    if (inserted) pane.paste(text);
    const reason = inserted
      ? null
      : exited
        ? "The agent has exited."
        : agent
          ? "The agent is still starting."
          : agentIssue || "No agent is running.";
    send({ type: "request", text, inserted, notice: notice ?? null, reason });
  }
  function paneEnv() {
    let base = env;
    try {
      base = withCareerratShim({ repoRoot, env });
    } catch (error) {
      send({
        type: "error",
        message: `The agent may run a different careerrat install: ${error.message}`,
      });
    }
    return {
      ...base,
      CAREERRAT_SURFACE: "tui",
      CAREERRAT_TUI_SESSION: sessionId,
    };
  }
  async function dispatch(message) {
    if (closing) throw new Error("Textual session is closed");
    switch (message.op) {
      case "select": {
        // Only the selection changed: the list Python holds is still right, so
        // send the new state alone instead of every job again.
        if (
          message.id !== state.selectedId &&
          currentView.jobs.some((job) => job.id === message.id)
        )
          state = {
            ...state,
            selectedId: message.id,
            detailOffset: 0,
            pendingUndo: null,
          };
        else state = { ...state, pendingUndo: null };
        currentView = { ...currentView, selectedId: state.selectedId };
        send({ type: "selection", selectedId: state.selectedId, state });
        sendDetail();
        break;
      }
      case "view": {
        const options = {};
        for (const field of ["stage", "currency", "basis", "order"])
          if (message[field] !== undefined) options[field] = message[field];
        if (
          options.stage !== undefined &&
          options.stage !== "all" &&
          options.stage !== "active" &&
          !data.jobs.some((job) => job.stage.id === options.stage)
        )
          throw new TypeError("Unknown job stage");
        if (options.currency !== undefined && !/^[A-Z]{3}$/.test(options.currency))
          throw new TypeError("Currency must be a three-letter code");
        viewJobs(data, { ...state, ...options });
        state = refreshWorkspace(data, {
          ...state,
          ...options,
          pendingUndo: null,
        });
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
        if (next.effect?.type === "agent-request") request(next.effect.text, next.effect.notice);
        else if (next.effect?.type === "notice")
          send({ type: "notice", message: next.effect.text });
        break;
      }
      case "inspect": {
        if (typeof message.text !== "string") throw new TypeError("Pasted context must be text");
        let files = null;
        try {
          files = listDroppedFiles({ ...ctx, text: message.text });
        } catch {
          files = null;
        }
        send({ type: "intake-preview", id: message.id ?? null, files });
        break;
      }
      case "capture": {
        let captured;
        try {
          captured = await captureTuiContext({
            ...ctx,
            text: message.text,
            files: message.files,
            selectedId: state.selectedId,
          });
        } catch (error) {
          send({
            type: "capture-error",
            id: message.id ?? null,
            message: error.message,
          });
          break;
        }
        send({ type: "context", id: message.id ?? null, ...captured });
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
            env: paneEnv(),
            cols,
            rows,
            onChange: scheduleFrame,
            onExit: ({ exitCode }) => {
              exited = true;
              send({ type: "agent-exited", exitCode });
              refresh({ force: false });
            },
          });
          send({ type: "agent-started", pid: pane.pid });
        } else if (pane && !exited) pane.resize(cols, rows);
        scheduleFrame();
        break;
      }
      case "scroll": {
        const { lines = 0, pages = 0 } = message;
        if (!Number.isInteger(lines) || !Number.isInteger(pages))
          throw new TypeError("Scroll amounts must be whole numbers");
        if (pane && !exited && pane.scroll({ lines, pages })) scheduleFrame();
        break;
      }
      case "wheel": {
        const { direction, col = 0, row = 0 } = message;
        if (![-1, 1].includes(direction) || !Number.isInteger(col) || !Number.isInteger(row))
          throw new TypeError("Invalid wheel event");
        if (pane && !exited && pane.wheel({ direction, col, row }) === "scroll") scheduleFrame();
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
    watcher?.close();
    closePromise = (async () => {
      try {
        await pane?.dispose();
      } finally {
        await stopTerminalSessionSearches({ ...ctx, sessionId });
      }
    })();
    return closePromise;
  }
  snapshot();
  watcher = createDataWatch({
    ctx,
    onChange: () => refresh({ force: false }),
    onError: (error) =>
      send({
        type: "error",
        message: `Saved data could not be watched: ${error.message}`,
      }),
  });
  if (agentIssue) send({ type: "agent-status", message: agentIssue });
  return { dispatch, refresh, close };
}
