import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { ArrowUpIcon } from "../components/icons.jsx";
import {
  ApiError,
  getWorkspaceThread,
  previewWorkspaceQuery,
  runWorkspaceIntent,
  sendWorkspaceMessage,
} from "../lib/api.js";
import { useGlobalShortcut } from "../lib/useGlobalShortcut.js";

// AskBar — the W3 shell-docked ask bar (DESIGN-SPEC.md "Ask bar (component)").
// Mounted once in AppShell.jsx, docked at the bottom of every route, same
// "cross-cutting chrome, mounted once" precedent as ActivityBell and
// DashboardContext (see AppShell.jsx's own header comment). Retires the old
// floating CaptureBar (M9, never actually mounted) — this is its W3
// evolution: answer + act through the one durable workspace agent instead of
// a paste-only intake tray.
//
// State machine: idle (placeholder + ⌘K hint) -> focused (debounced classify
// preview, ACTION/ANSWER rows, nothing runs on a guess) -> acting (progress
// line with a live client ticker, swapped for a receipt + one-line summary on
// completion). Never a modal; the input stays usable throughout, including
// while an action runs in the background.

const PREVIEW_DEBOUNCE_MS = 300;
const ACTION_POLL_MS = 2000;
const ACTION_POLL_TIMEOUT_MS = 5 * 60 * 1000;

// Domain-neutral, page-aware placeholders (DESIGN-SPEC.md's examples are
// company-specific mockup copy — these are the generic equivalents the W3
// build brief calls for). Jobs Pipeline and Jobs Finder share one route
// (/jobs?tab=) — see JobsPage.jsx's own normalizeTab().
function placeholderForRoute(pathname, searchParams) {
  if (pathname === "/jobs") {
    return searchParams.get("tab") === "search"
      ? "sweep my pinned boards"
      : "what's blocking my top role?";
  }
  if (pathname === "/calendar") return "when's my next prep?";
  if (pathname === "/network") return "draft a nudge to a contact";
  if (pathname === "/library") return "which resume went where?";
  return "what should I do next?";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeAskBarError(err) {
  if (err instanceof ApiError) {
    const message = err.body?.error?.message || err.body?.error;
    return typeof message === "string" && message
      ? message
      : `That didn't go through (${err.status}).`;
  }
  return err instanceof Error ? err.message : "That didn't go through.";
}

function isTerminalActionMessage(message) {
  if (!message) return false;
  if (message.kind === "action_error") return true;
  if (message.kind !== "action_result") return false;
  // search.run starts in the background — recordWorkspaceSearchCompletion
  // (workspace-agent.mjs) appends a later terminal message once it finishes;
  // every other intent type is awaited fully server-side, so its first
  // action_result is already terminal (searchTerminal is simply absent).
  return message.metadata?.searchTerminal !== false;
}

// Polls GET /api/workspace/thread until the in-flight action's terminal
// message shows up (or the safety timeout elapses, in which case the caller
// just renders the latest non-terminal state rather than hanging forever).
// `isStale` lets a superseded turn abandon its poll loop instead of running
// out the full timeout against a turn nobody is rendering anymore.
async function pollForTerminalAction(pending, isStale) {
  const runId = pending?.metadata?.searchRunId;
  const deadline = Date.now() + ACTION_POLL_TIMEOUT_MS;
  let latest = pending;
  while (Date.now() < deadline) {
    await sleep(ACTION_POLL_MS);
    if (isStale?.()) return latest;
    let messages;
    try {
      const res = await getWorkspaceThread();
      messages = (res?.data || res)?.messages;
    } catch {
      continue; // a transient poll failure isn't the action failing — keep trying
    }
    if (!Array.isArray(messages) || !messages.length) continue;
    const found = runId
      ? messages.find((m) => m.metadata?.searchRunId === runId && isTerminalActionMessage(m))
      : [...messages].reverse().find(isTerminalActionMessage);
    if (found) return found;
    latest = messages[messages.length - 1] || latest;
  }
  return latest;
}

function formatElapsedSeconds(ms) {
  return `${Math.max(0, Math.round((ms || 0) / 1000))}S`;
}

export function AskBar() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const previewRequestId = useRef(0);
  // Committing a new turn while an earlier one is still resolving is allowed
  // (the input stays usable during acting) — this id keeps a superseded
  // turn's late completion from clobbering the newer turn's state.
  const turnIdRef = useRef(0);

  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [selected, setSelected] = useState("answer");
  const [turn, setTurn] = useState(null);
  const [, setTick] = useState(0);

  const placeholder = placeholderForRoute(location.pathname, searchParams);
  const panelOpen = focused && text.trim().length > 0;

  useGlobalShortcut("k", () => {
    inputRef.current?.focus();
  });

  // Outside click / Escape close the preview panel without a modal backdrop —
  // same pattern as ActivityBell.jsx's popover.
  useEffect(() => {
    if (!panelOpen) return undefined;
    function onPointerDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setFocused(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [panelOpen]);

  // Debounced classify — cheap, deterministic, side-effect free on the
  // server (previewWorkspaceIntent never writes to the thread).
  useEffect(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      setPreview(null);
      setPreviewPending(false);
      return undefined;
    }
    setPreviewPending(true);
    const requestId = ++previewRequestId.current;
    const timer = setTimeout(async () => {
      try {
        const res = await previewWorkspaceQuery(trimmed);
        if (previewRequestId.current !== requestId) return;
        const data = res?.data || res;
        setPreview(data || null);
        setSelected(data?.action ? "action" : "answer");
      } catch {
        if (previewRequestId.current !== requestId) return;
        setPreview(null);
      } finally {
        if (previewRequestId.current === requestId) setPreviewPending(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  // Live client-side elapsed ticker while a turn is running — reconciled
  // with the server's own elapsedMs the moment the turn completes.
  useEffect(() => {
    if (turn?.status !== "running") return undefined;
    const interval = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [turn?.status]);

  function availableRows() {
    return preview?.action ? ["action", "answer"] : ["answer"];
  }

  function handleKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (panelOpen) {
        setFocused(false);
      } else {
        inputRef.current?.blur();
      }
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && panelOpen) {
      e.preventDefault();
      const rows = availableRows();
      const idx = rows.indexOf(selected);
      const nextIdx =
        e.key === "ArrowDown" ? (idx + 1) % rows.length : (idx - 1 + rows.length) % rows.length;
      setSelected(rows[nextIdx]);
    }
  }

  function commit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (selected === "action" && preview?.action) {
      commitAction(preview.action);
    } else {
      commitAnswer(trimmed, preview);
    }
  }

  async function commitAction(action) {
    const label = action.label || "Run this action";
    const startedAt = Date.now();
    const turnId = ++turnIdRef.current;
    setTurn({
      kind: "action",
      status: "running",
      label,
      startedAt,
      elapsedMs: null,
      engine: null,
      resultText: null,
      error: null,
      noEngine: false,
    });
    setText("");
    setPreview(null);
    setFocused(false);

    try {
      const res = await runWorkspaceIntent(
        action.intent.type,
        action.intent.entity,
        action.intent.input
      );
      const messages = (res?.data || res)?.messages || [];
      let last = messages[messages.length - 1] || null;
      if (!isTerminalActionMessage(last)) {
        last = await pollForTerminalAction(last, () => turnIdRef.current !== turnId);
      }
      if (turnIdRef.current !== turnId) return;
      const isError = last?.kind === "action_error";
      setTurn((t) =>
        t
          ? {
              ...t,
              status: isError ? "error" : "done",
              resultText: isError ? null : last?.text || null,
              error: isError ? last?.text || "The action could not be completed." : null,
              engine: last?.metadata?.engine || null,
              elapsedMs:
                typeof last?.metadata?.elapsedMs === "number"
                  ? last.metadata.elapsedMs
                  : Date.now() - startedAt,
            }
          : t
      );
    } catch (err) {
      if (turnIdRef.current !== turnId) return;
      setTurn((t) => (t ? { ...t, status: "error", error: describeAskBarError(err) } : t));
    }
  }

  async function commitAnswer(trimmed, previewAtCommit) {
    const label = previewAtCommit?.answer?.label || trimmed;
    const startedAt = Date.now();
    const turnId = ++turnIdRef.current;
    setTurn({
      kind: "answer",
      status: "running",
      label,
      startedAt,
      elapsedMs: null,
      engine: null,
      resultText: null,
      error: null,
      noEngine: false,
    });
    setText("");
    setPreview(null);
    setFocused(false);

    if (previewAtCommit?.engineAvailable === false) {
      setTurn((t) =>
        t
          ? {
              ...t,
              status: "error",
              noEngine: true,
              error: "No AI engine is configured yet — connect one in Settings.",
            }
          : t
      );
      return;
    }

    try {
      const res = await sendWorkspaceMessage(trimmed);
      if (turnIdRef.current !== turnId) return;
      const messages = (res?.data || res)?.messages || [];
      const last = messages[messages.length - 1] || null;
      const isError = last?.kind === "agent_error";
      const isNoEngine = isError && last?.error?.code === "NO_AI_ROUTE";
      setTurn((t) =>
        t
          ? {
              ...t,
              status: isError ? "error" : "done",
              resultText: isError ? null : last?.text || null,
              error: isError ? last?.text || "The workspace agent could not answer." : null,
              engine: last?.metadata?.engine || null,
              elapsedMs:
                typeof last?.metadata?.elapsedMs === "number"
                  ? last.metadata.elapsedMs
                  : Date.now() - startedAt,
              noEngine: isNoEngine,
            }
          : t
      );
    } catch (err) {
      if (turnIdRef.current !== turnId) return;
      setTurn((t) => (t ? { ...t, status: "error", error: describeAskBarError(err) } : t));
    }
  }

  return (
    <div className="ask-bar" ref={rootRef}>
      <div className="ask-bar__shell">
        {turn ? <AskBarTurn turn={turn} /> : null}
        {panelOpen ? (
          <AskBarPreview
            preview={preview}
            pending={previewPending}
            selected={selected}
            onSelect={setSelected}
          />
        ) : null}
        <div className="ask-bar__row">
          <input
            ref={inputRef}
            type="text"
            className="ask-bar__input"
            role="combobox"
            aria-expanded={panelOpen}
            aria-haspopup="listbox"
            aria-controls="ask-bar-preview"
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFocused(true)}
            onKeyDown={handleKeyDown}
          />
          {!text.trim() ? (
            <span className="ask-bar__kbd" aria-hidden="true">
              ⌘K
            </span>
          ) : null}
          <button
            type="button"
            className="ask-bar__send"
            aria-label="Send"
            disabled={!text.trim()}
            onClick={commit}
          >
            <ArrowUpIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

function AskBarPreview({ preview, pending, selected, onSelect }) {
  if (pending && !preview) {
    return (
      <div
        className="ask-bar__preview"
        id="ask-bar-preview"
        role="listbox"
        aria-label="Ask bar suggestions"
      >
        <div className="ask-bar__preview-row ask-bar__preview-row--pending">
          <span className="ask-bar__preview-label">Reading your request…</span>
        </div>
      </div>
    );
  }
  if (!preview) return null;

  return (
    <div
      className="ask-bar__preview"
      id="ask-bar-preview"
      role="listbox"
      aria-label="Ask bar suggestions"
    >
      {preview.action ? (
        <button
          type="button"
          role="option"
          aria-selected={selected === "action"}
          className={`ask-bar__preview-row${selected === "action" ? " ask-bar__preview-row--selected" : ""}`}
          onClick={() => onSelect("action")}
        >
          <span className="ask-bar__preview-kind">Action</span>
          <span className="ask-bar__preview-label">{preview.action.label}</span>
          <span className="ask-bar__preview-kbd">↵ Run</span>
        </button>
      ) : null}
      <button
        type="button"
        role="option"
        aria-selected={selected === "answer"}
        className={`ask-bar__preview-row${selected === "answer" ? " ask-bar__preview-row--selected" : ""}`}
        onClick={() => onSelect("answer")}
      >
        <span className="ask-bar__preview-kind">Answer</span>
        <span className="ask-bar__preview-label">
          {preview.answer?.label || "Ask the workspace agent"}
        </span>
      </button>
      {preview.engineAvailable === false ? (
        <div className="ask-bar__preview-note">No AI engine is configured yet.</div>
      ) : null}
    </div>
  );
}

function EngineReceipt({ engine, elapsedMs, noEngine }) {
  if (noEngine)
    return <span className="ask-bar__receipt ask-bar__receipt--no-engine">No engine</span>;
  if (!engine) return null;
  return (
    <span className="ask-bar__receipt">
      AI · {engine.label} · {formatElapsedSeconds(elapsedMs)}
    </span>
  );
}

function AskBarTurn({ turn }) {
  if (turn.status === "running") {
    const elapsedMs = Date.now() - turn.startedAt;
    return (
      <div className="ask-bar__turn">
        <span className="ask-bar__progress">
          Running · {turn.label} · {formatElapsedSeconds(elapsedMs)}
        </span>
      </div>
    );
  }

  if (turn.status === "error") {
    return (
      <div className="ask-bar__turn">
        <p className="ask-bar__error">{turn.error}</p>
        {turn.noEngine ? <EngineReceipt noEngine /> : null}
      </div>
    );
  }

  if (turn.kind === "answer") {
    return (
      <div className="ask-bar__turn">
        {turn.resultText ? <p className="ask-bar__answer">{turn.resultText}</p> : null}
        <EngineReceipt engine={turn.engine} elapsedMs={turn.elapsedMs} />
      </div>
    );
  }

  return (
    <div className="ask-bar__turn">
      {turn.resultText ? <p className="ask-bar__summary">{turn.resultText}</p> : null}
      <EngineReceipt engine={turn.engine} elapsedMs={turn.elapsedMs} />
    </div>
  );
}
