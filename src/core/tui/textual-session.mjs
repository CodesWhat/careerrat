import { createHash, randomUUID } from "node:crypto";
import { closeDb, retainDb } from "../db/connection.mjs";
import { registerDbHolder } from "../db/holders.mjs";
import { readSavedJobDescription } from "../jobs/job-description.mjs";
import { currentPerson, peopleBase, resolvePersonSelection } from "../paths/people.mjs";
import { borrowedAiWarning } from "../people/ai-route.mjs";
import { listPeople } from "../people/roster.mjs";
import {
  cancelTerminalSearch,
  startTerminalSearch,
  stopTerminalSessionSearches,
} from "../search/terminal-search-worker.mjs";
import { withCareerratShim } from "./cli-shim.mjs";
import { createDataWatch } from "./data-watch.mjs";
import { applyTuiUndo } from "./history.mjs";
import { captureTuiContext, listDroppedFiles } from "./intake.mjs";
import { capWorkspaceMessages, readJobs, viewJobs } from "./jobs.mjs";
import { jobDetail, summaryJobs } from "./snapshot.mjs";
import { createWorkspaceState, refreshWorkspace, workspaceKey } from "./workspace.mjs";

const PERSON_ENV_KEYS = ["CAREERRAT_HOME", "CAREERRAT_PERSON", "CAREERRAT_PEOPLE_BASE"];
// Ops that only touch the agent pane. A stale one is dropped without a notice.
const PANE_OPS = new Set(["resize", "input", "paste", "scroll", "wheel"]);

// agentIssue says why there is no agent when one was asked for or expected:
// the TUI shows it in its own banner and names it when a request has nowhere to go.
export async function createTextualSession({
  repoRoot,
  env = process.env,
  agent = null,
  agentIssue = null,
  emit,
  search = { start: startTerminalSearch, cancel: cancelTerminalSearch },
}) {
  let ctx = { repoRoot, env };
  // The owner's own values for the person-selecting variables, unset ones
  // included, so returning to the owner restores exactly what the start had.
  const ownerOverrides = currentPerson(env)
    ? null
    : Object.fromEntries(PERSON_ENV_KEYS.map((key) => [key, env[key]]));
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
  // Bumped on every person switch so a stopped pane's late events are dropped.
  let generation = 0;
  let switching = false;
  retainDb(ctx);
  // The root this session currently retains and its holder. Released once and
  // cleared, so a close that lands mid-switch can't release the old root twice.
  let held = { ctx, release: registerDbHolder(ctx, "tui") };
  function releaseHeld() {
    const current = held;
    held = null;
    if (!current) return;
    current.release();
    closeDb(current.ctx);
  }
  let lastSnapshot = "";
  let framed = null;

  function send(event) {
    if (!closing) emit(event);
  }
  // The selected job travels in full after each snapshot and selection; the
  // snapshot itself carries summary rows only, so its size stays flat.
  function sendDetail(detail) {
    if (detail) return send({ type: "detail", id: detail.id, job: detail });
    const job = currentView?.jobs.find((item) => item.id === state.selectedId);
    if (job) send({ type: "detail", id: job.id, job: jobDetail(job) });
  }
  // A refresh that finds nothing new sends nothing, so an idle workspace stays
  // quiet and a status message isn't wiped by a snapshot identical to the last.
  // `view` is the viewJobs result the caller already built for this state.
  // The key covers what goes over the wire (summary rows, state, the selected
  // job's detail), not every full record; currentView still keeps them all.
  function snapshot({ force = true, view = viewJobs(data, state) } = {}) {
    currentView = view;
    const capped = capWorkspaceMessages(view.workspaceMessages);
    const summary = {
      ...view,
      workspaceMessages: capped.messages,
      workspaceMessagesTotal: capped.total,
      jobs: summaryJobs(view.jobs),
    };
    const selected = view.jobs.find((item) => item.id === state.selectedId);
    const detail = selected ? jobDetail(selected) : null;
    const key = createHash("sha1")
      .update(JSON.stringify({ view: summary, state, detail }))
      .digest("hex");
    if (!force && key === lastSnapshot) return;
    lastSnapshot = key;
    send({ type: "workspace", view: summary, state });
    if (detail) sendDetail(detail);
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
      const view = viewJobs(data, state);
      state = refreshWorkspace(data, state, view);
      snapshot({ force, view });
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
  // The env a fresh `careerrat --for <name>` start would run with, or the owner's
  // own workspace for null. Throws, touching nothing, for an unknown or removed person.
  function personContext(name) {
    if (name === null && ownerOverrides) {
      const next = { ...env };
      for (const [key, value] of Object.entries(ownerOverrides)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      return next;
    }
    if (name === null) {
      const base = peopleBase({ repoRoot, env });
      const next = { ...env, CAREERRAT_HOME: base };
      delete next.CAREERRAT_PERSON;
      delete next.CAREERRAT_PEOPLE_BASE;
      return next;
    }
    if (typeof name !== "string") throw new TypeError("Person must be a name or null");
    return { ...env, ...resolvePersonSelection({ repoRoot, env, forName: name }) };
  }
  function personEvent() {
    return { type: "person", person: currentPerson(env), generation };
  }
  function startWatcher() {
    watcher = createDataWatch({
      ctx,
      onChange: () => refresh({ force: false }),
      onError: (error) =>
        send({
          type: "error",
          message: `Saved data could not be watched: ${error.message}`,
        }),
    });
  }
  // Reads the destination first, then stops the agent pane, searches and watcher
  // on the old root and reopens all of it on the new one. A destination that
  // can't be read leaves the old session exactly as it was. Nothing from the old
  // person is kept: jobs, selection, filters and pending Undo all start over.
  async function switchPerson(name) {
    if (name === currentPerson(env)) {
      send({ type: "switch-end" });
      send({
        type: "notice",
        message: name ? `Already in ${name}'s workspace.` : "Already in your own workspace.",
      });
      return;
    }
    let nextEnv;
    let nextCtx;
    let nextData;
    let nextState;
    try {
      nextEnv = personContext(name);
      nextCtx = { repoRoot, env: nextEnv };
      nextData = readJobs(nextCtx);
      nextState = createWorkspaceState(nextData);
    } catch (error) {
      send({ type: "switch-end" });
      send({ type: "notice", message: `Can't switch: ${error.message}` });
      return;
    }
    const nextHolder = registerDbHolder(nextCtx, "tui");
    retainDb(nextCtx);
    switching = true;
    generation += 1;
    clearTimeout(drawing);
    drawing = null;
    watcher?.close();
    const oldPane = pane;
    const oldCtx = ctx;
    pane = undefined;
    exited = false;
    framed = null;
    let teardownError = null;
    try {
      try {
        await oldPane?.dispose();
      } finally {
        await stopTerminalSessionSearches({ ...oldCtx, sessionId });
      }
    } catch (error) {
      teardownError = error;
    } finally {
      // Held until cleanup is done, then the cached connection goes with it.
      releaseHeld();
      held = { ctx: nextCtx, release: nextHolder };
      switching = false;
    }
    if (closing) {
      releaseHeld();
      return;
    }
    env = nextEnv;
    ctx = nextCtx;
    // The watcher's baseline comes before the final read, so a write during
    // teardown is either in this read or reported by the watcher. If the fresh
    // read can't be used, the preflight one stands.
    startWatcher();
    try {
      const freshData = readJobs(ctx);
      state = createWorkspaceState(freshData);
      data = freshData;
    } catch {
      data = nextData;
      state = nextState;
    }
    lastSnapshot = "";
    send(personEvent());
    snapshot();
    send({
      type: "notice",
      message: name ? `Switched to ${name}'s workspace.` : "Switched to your own workspace.",
    });
    if (teardownError)
      send({
        type: "error",
        message: `The previous workspace did not stop cleanly: ${teardownError.message}`,
      });
  }
  // The agent's launch arguments for the workspace now open: the opening message
  // depends on that person's setup, so it is decided on every start.
  function agentArgs() {
    const args = [...(agent.args || [])];
    const opening = agent.opening?.(env);
    if (typeof opening === "string" && opening) args.push(opening);
    return args;
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
    // An action issued before the open workspace changed, or while it is
    // changing, was meant for a different person's data. It never runs.
    if (
      message.op !== "quit" &&
      ((message.generation !== undefined && message.generation !== generation) ||
        (switching && message.op !== "switch-person"))
    ) {
      if (!PANE_OPS.has(message.op))
        send({
          type: "notice",
          message: "That action was for the previous workspace, so it was not run.",
        });
      return;
    }
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
        const next = { ...state, ...options, pendingUndo: null };
        const view = viewJobs(data, next);
        state = refreshWorkspace(data, next, view);
        snapshot({ view });
        break;
      }
      case "refresh":
        refresh();
        break;
      case "people": {
        let people;
        try {
          people = listPeople({ repoRoot, env });
        } catch (error) {
          send({ type: "notice", message: `People could not be listed: ${error.message}` });
          break;
        }
        send({ type: "people", people, current: currentPerson(env) });
        break;
      }
      case "switch-person": {
        if (message.person !== null && typeof message.person !== "string")
          throw new TypeError("Person must be a name or null");
        await switchPerson(message.person);
        break;
      }
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
      // Search jobs is deterministic background work: it never touches the agent.
      case "search-start": {
        const warning = borrowedAiWarning(ctx);
        if (warning) send({ type: "notice", message: warning });
        let result;
        try {
          result = await search.start({
            ...ctx,
            env: { ...env, CAREERRAT_TUI_SESSION: sessionId },
          });
        } catch (error) {
          send({ type: "notice", message: `Search did not start: ${error.message}` });
          refresh();
          break;
        }
        send({ type: "search-started", reused: Boolean(result.reused), run: result.run });
        refresh();
        break;
      }
      case "search-cancel": {
        if (typeof message.id !== "string" || !message.id)
          throw new TypeError("Search cancel needs a run id");
        try {
          search.cancel({ ...ctx, id: message.id });
        } catch (error) {
          send({ type: "notice", message: `Search was not cancelled: ${error.message}` });
        }
        refresh();
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
          const born = generation;
          pane = native.createAgentPane({
            command: agent.command,
            args: agentArgs(),
            cwd: repoRoot,
            env: paneEnv(),
            cols,
            rows,
            onChange: () => {
              if (born === generation) scheduleFrame();
            },
            onBell: () => born === generation && send({ type: "bell" }),
            onTitle: (title) => born === generation && send({ type: "title", title }),
            onClipboard: (text) => born === generation && send({ type: "clipboard", text }),
            onExit: ({ exitCode }) => {
              if (born !== generation) return;
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
        try {
          await stopTerminalSessionSearches({ ...ctx, sessionId });
        } finally {
          releaseHeld();
        }
      }
    })();
    return closePromise;
  }
  snapshot();
  startWatcher();
  if (agentIssue) send({ type: "agent-status", message: agentIssue });
  return { dispatch, refresh, close };
}
