import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { Button, IconButton } from "../components/Button.jsx";
import { ArrowUpIcon, PaperclipIcon } from "../components/icons.jsx";
import {
  completeDiscoveryStep,
  confirmIntake,
  createIntake,
  dismissIntake,
  getWorkspaceThread,
  previewWorkspaceQuery,
  reclassifyIntake,
  runWorkspaceIntent,
  sendWorkspaceMessage,
  uploadIntakeFile,
} from "../lib/api.js";
import { emitDashboardChanged } from "../lib/dashboard-events.js";
import { errorState, resolveErrorCopy } from "../lib/errorCopy.js";
import { emitIntakeChanged } from "../lib/intake-events.js";
import { kindLabel } from "../lib/intake-labels.js";
import { safeExternalHttpUrl } from "../lib/safeExternalUrl.js";
import { useGlobalShortcut } from "../lib/useGlobalShortcut.js";
import { ChatPanel } from "../onboarding/ChatPanel.jsx";
import { useNeedsYouCount } from "./useNeedsYouCount.js";

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
//
// Lane B (universal intake, /inbox retired as a destination): a multi-line/
// long paste, a dropped file, or the attach button all feed the same M9
// intake pipeline (POST /api/intake, /api/intake/upload) this bar already
// had the workspace-agent APIs sitting next to. A paste/drop/attach that
// looks like a *capture* (not a short query) flips the bar into "capture
// mode" — the single-line input becomes a multiline surface, and the
// preview panel offers a CAPTURE row (Enter-default) alongside the existing
// ANSWER row. Committing CAPTURE reuses the exact same turnIdRef-guarded
// commit shape as commitAction/commitAnswer below, just carrying a
// classified intake item instead of an intent result — so a stale capture
// response can never clobber a newer turn, same guarantee the acting state
// machine already gave answers and actions.

const PREVIEW_DEBOUNCE_MS = 300;
const ACTION_POLL_MS = 2000;
const ACTION_POLL_TIMEOUT_MS = 5 * 60 * 1000;
// A paste/drop/attach this long or this multiline reads as a capture (a JD,
// a recruiter email, a status update), not a short query — see the M9
// intake pipeline's own kind classifier for the same rough shape rule.
const CAPTURE_MIN_LENGTH = 200;

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
  return resolveErrorCopy(err).message;
}

function appActionHref(value) {
  try {
    const appOrigin = "https://careerrat.invalid";
    const url = new URL(String(value || "").trim(), appOrigin);
    if (url.origin !== appOrigin) return null;
    if (url.pathname === "/settings" || url.pathname === "/app/settings") {
      if (url.search || url.hash) return null;
      return "/app/settings";
    }
    if (url.pathname !== "/jobs" && url.pathname !== "/app/jobs") return null;
    if (url.hash || [...url.searchParams.keys()].length !== 1) return null;

    if (url.searchParams.getAll("tab").length === 1) {
      return url.searchParams.get("tab") === "search" ? "/app/jobs?tab=search" : null;
    }
    const param = url.searchParams.getAll("open").length === 1 ? "open" : "dossier";
    if (url.searchParams.getAll(param).length !== 1) return null;

    const applicationId = url.searchParams.get(param);
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(applicationId || "")) return null;
    return `/app/jobs?${param}=${encodeURIComponent(applicationId)}`;
  } catch {
    return null;
  }
}

// Ported from the deleted CaptureBar.jsx (git show 95f27540~1) — the 409
// NO_DATABASE hint every /api/data/* route already surfaces for a legacy
// (pre-migration) workspace; intake is DB-native by construction
// (migration 002), so this is expected on an un-migrated workspace, not a
// bug. resolveErrorCopy() maps this to the same good copy that used to be
// hardcoded here, and maps everything else to human copy instead of the raw
// server string.
function describeCaptureError(err) {
  return resolveErrorCopy(err).message;
}

// Ported from the deleted inbox/IntakeCard.jsx's own inline catch. Renders
// into AskBarIntakeReceipt's one-line error slot (a plain <p>, no room for an
// action or a details disclosure) — resolveErrorCopy's message only, never
// the raw server string.
function describeDecideError(err, label) {
  return errorState(err, `${label} failed`).message;
}

// Mirrors executeLaneA/executeLaneB's own result shapes (intake-route.mjs) —
// ported from IntakeCard.jsx's describeResult().
function describeIntakeResult(item) {
  if (item.result?.summary) return item.result.summary;
  if (item.dispatch?.action === "app_set_status") {
    return `Status updated to "${item.result?.to ?? "?"}".`;
  }
  if (item.dispatch?.action === "run_skill") {
    return item.result?.ok === false
      ? "Skill run finished with an error. See below."
      : `${item.dispatch.params.skill} finished.`;
  }
  return "Completed.";
}

function isCaptureCandidate(text) {
  return text.includes("\n") || text.length > CAPTURE_MIN_LENGTH;
}

function requestedJobAction(text) {
  const instruction = String(text || "")
    .trim()
    .replace(/[,:.!?;-]+$/, "")
    .trim();
  const prefix = /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?/i;
  const target = "(?:this|the)\\s+(?:job|role|posting|opening)";
  if (
    new RegExp(
      `${prefix.source}(?:apply|submit|prepare)(?:\\s+(?:to|for))?\\s+${target}$`,
      "i"
    ).test(instruction)
  ) {
    return "prepare";
  }
  if (
    new RegExp(`${prefix.source}(?:rate|evaluate|review|assess)\\s+${target}$`, "i").test(
      instruction
    )
  ) {
    return "evaluate";
  }
  return null;
}

function splitCaptureInstruction(text) {
  const raw = String(text || "");
  const newline = raw.indexOf("\n");
  if (newline < 0) return { text: raw, requestedAction: null };
  const requestedAction = requestedJobAction(raw.slice(0, newline));
  if (!requestedAction) return { text: raw, requestedAction: null };
  return { text: raw.slice(newline + 1).trimStart(), requestedAction };
}

// Ported from the deleted CaptureBar.jsx — client-side text extraction for
// .txt/.md/.markdown drops/attaches. Anything else goes straight to
// POST /api/intake/upload as raw bytes (no text extraction yet, a known gap
// — intake-route.mjs:551).
function isTextFile(file) {
  return file.type.startsWith("text/") || /\.(txt|md|markdown)$/i.test(file.name);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("could not read file"));
    reader.readAsText(file);
  });
}

function isTerminalActionMessage(message) {
  if (!message) return false;
  if (message.kind === "action_error") return true;
  if (message.kind !== "action_result") return false;
  if (
    message.metadata?.companyReview === true &&
    message.artifacts?.some(
      (artifact) => artifact.kind === "company_proposals" && artifact.proposals?.length
    )
  ) {
    return true;
  }
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
  const fileInputRef = useRef(null);
  const previewRequestId = useRef(0);
  // Committing a new turn while an earlier one is still resolving is allowed
  // (the input stays usable during acting) — this id keeps a superseded
  // turn's late completion from clobbering the newer turn's state. Capture
  // commits (commitCaptureText/commitCaptureFile) share this exact guard.
  const turnIdRef = useRef(0);

  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [selected, setSelected] = useState("answer");
  const [turn, setTurn] = useState(null);
  const [, setTick] = useState(0);

  // Lane B additions — independent of the action/answer machinery above.
  const [captureMode, setCaptureMode] = useState(false);
  const [captureAction, setCaptureAction] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [decideBusyId, setDecideBusyId] = useState(null);
  const [decideError, setDecideError] = useState(null); // { id, message } | null
  const [needsYouOpen, setNeedsYouOpen] = useState(false);
  const needsYou = useNeedsYouCount();

  const placeholder = placeholderForRoute(location.pathname, searchParams);
  const openJobId = location.pathname === "/jobs" ? searchParams.get("open") : null;
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
  // server (previewWorkspaceIntent never writes to the thread). Skipped
  // entirely in capture mode: a pasted JD/email isn't a workspace-agent
  // query, and firing the intent classifier at it would be noise (same
  // "nothing runs on a guess" spirit as the rest of this effect).
  useEffect(() => {
    const trimmed = text.trim();
    if (!trimmed || captureMode) {
      setPreview(null);
      setPreviewPending(false);
      return undefined;
    }
    setPreviewPending(true);
    const requestId = ++previewRequestId.current;
    const timer = setTimeout(async () => {
      try {
        const context = openJobId ? { pathname: location.pathname, jobId: openJobId } : null;
        const res = context
          ? await previewWorkspaceQuery(trimmed, context)
          : await previewWorkspaceQuery(trimmed);
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
  }, [text, captureMode, location.pathname, openJobId]);

  // Live client-side elapsed ticker while a turn is running — reconciled
  // with the server's own elapsedMs the moment the turn completes.
  useEffect(() => {
    if (turn?.status !== "running") return undefined;
    const interval = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [turn?.status]);

  function availableRows() {
    if (captureMode) return ["capture", "answer"];
    return preview?.action ? ["action", "answer"] : ["answer"];
  }

  function handleKeyDown(e) {
    if (e.key === "Enter") {
      if (captureMode && e.shiftKey) return; // newline in the capture surface
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
    if (captureMode) {
      if (selected === "capture") {
        commitCaptureText(trimmed, captureAction);
      } else {
        setCaptureMode(false);
        commitAnswer(trimmed, null);
      }
      return;
    }
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
      request: action,
      retryable: false,
    });
    setText("");
    setPreview(null);

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
      if (!isError) emitDashboardChanged();
      setTurn((t) =>
        t
          ? {
              ...t,
              status: isError ? "error" : "done",
              resultText: isError ? null : last?.text || null,
              error: isError ? last?.text || "The action could not be completed." : null,
              retryable: isError,
              artifacts: last?.artifacts || [],
              metadata: last?.metadata || {},
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
      const resolved = resolveErrorCopy(err);
      setTurn((t) =>
        t
          ? {
              ...t,
              status: "error",
              error: resolved.message,
              retryable: resolved.action?.retry === true,
            }
          : t
      );
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
      request: { text: trimmed, preview: previewAtCommit },
      retryable: false,
    });
    setText("");
    setPreview(null);

    if (previewAtCommit?.engineAvailable === false) {
      setTurn((t) =>
        t
          ? {
              ...t,
              status: "error",
              noEngine: true,
              error: "No AI engine is configured yet. Connect one in Settings.",
              retryable: false,
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
              retryable: isError && !isNoEngine,
            }
          : t
      );
    } catch (err) {
      if (turnIdRef.current !== turnId) return;
      setTurn((t) =>
        t ? { ...t, status: "error", error: describeAskBarError(err), retryable: true } : t
      );
    }
  }

  // --- Lane B: capture commits -------------------------------------------
  // Same shape/guard as commitAction/commitAnswer above (turnIdRef-guarded,
  // single `turn` slot) — a capture is just a third turn kind, carrying a
  // classified intake item instead of an intent/answer result.

  async function commitCaptureText(trimmed, requestedAction = null) {
    const startedAt = Date.now();
    const turnId = ++turnIdRef.current;
    setTurn({
      kind: "capture",
      status: "running",
      label: "Sending to triage…",
      startedAt,
      item: null,
      error: null,
      request: { text: trimmed, requestedAction },
      retryable: false,
    });
    setText("");
    setPreview(null);
    setCaptureMode(false);
    setCaptureAction(null);

    try {
      const { item } = await createIntake({
        text: trimmed,
        ...(requestedAction ? { requestedAction } : {}),
      });
      if (turnIdRef.current !== turnId) return;
      setTurn((t) => (t && t.kind === "capture" ? { ...t, status: "done", item, error: null } : t));
      emitIntakeChanged();
    } catch (err) {
      if (turnIdRef.current !== turnId) return;
      setTurn((t) =>
        t && t.kind === "capture"
          ? { ...t, status: "error", error: describeCaptureError(err), retryable: true }
          : t
      );
    }
  }

  async function commitCaptureFile(file, requestedAction = null) {
    const startedAt = Date.now();
    const turnId = ++turnIdRef.current;
    setTurn({
      kind: "capture",
      status: "running",
      label: `Uploading ${file.name}…`,
      startedAt,
      item: null,
      error: null,
      request: { file, requestedAction },
      retryable: false,
    });
    setText("");
    setPreview(null);
    setFocused(false);
    setCaptureMode(false);
    setCaptureAction(null);

    try {
      const { item } = requestedAction
        ? await uploadIntakeFile(file, { requestedAction })
        : await uploadIntakeFile(file);
      if (turnIdRef.current !== turnId) return;
      setTurn((t) => (t && t.kind === "capture" ? { ...t, status: "done", item, error: null } : t));
      emitIntakeChanged();
    } catch (err) {
      if (turnIdRef.current !== turnId) return;
      setTurn((t) =>
        t && t.kind === "capture"
          ? { ...t, status: "error", error: describeCaptureError(err), retryable: true }
          : t
      );
    }
  }

  // Confirm/Reclassify/Dismiss — ported from the deleted inbox/IntakeCard.jsx.
  // Used both by the just-captured receipt (turn.kind === "capture") and by
  // each row in the expanded NEEDS-YOU list; either way the server response
  // is the source of truth, so a decide success just re-syncs local state
  // and lets emitIntakeChanged() drive everyone else's refetch.
  async function decideIntake(item, action, label) {
    setDecideBusyId(item.id);
    setDecideError(null);
    try {
      const { item: updated } = await action(item.id);
      setTurn((t) =>
        t?.kind === "capture" && t.item?.id === updated.id ? { ...t, item: updated } : t
      );
      emitIntakeChanged();
    } catch (err) {
      setDecideError({ id: item.id, message: describeDecideError(err, label) });
    } finally {
      setDecideBusyId(null);
    }
  }

  const handleConfirmIntake = (item) => decideIntake(item, confirmIntake, "Confirm");
  const handleReclassifyIntake = (item) => decideIntake(item, reclassifyIntake, "Reclassify");
  const handleDismissIntake = (item) => decideIntake(item, dismissIntake, "Dismiss");

  // A paste/drop/attach candidate lands in the bar text (appending to
  // whatever's already there, same as the deleted CaptureBar.jsx did) and,
  // if it reads as a capture, flips capture mode on with CAPTURE
  // pre-selected as the Enter-default.
  function ingestText(content) {
    if (!content) return;
    const typedAction = requestedJobAction(text);
    const merged = typedAction ? content : text.trim() ? `${text}\n${content}` : content;
    const split = splitCaptureInstruction(merged);
    const nextText = split.text;
    const nextAction = typedAction || split.requestedAction;
    setText(nextText);
    setFocused(true);
    if (isCaptureCandidate(nextText)) {
      setCaptureMode(true);
      setCaptureAction(nextAction);
      setSelected("capture");
    }
  }

  async function ingestFile(file) {
    if (!file) return;
    if (isTextFile(file)) {
      try {
        const content = await readFileAsText(file);
        ingestText(content);
      } catch {
        ++turnIdRef.current; // supersede any in-flight capture, same as every other commit path
        setTurn({
          kind: "capture",
          status: "error",
          label: null,
          startedAt: Date.now(),
          item: null,
          error: "Couldn't read that file as text. Try dropping it again.",
        });
      }
      return;
    }
    await commitCaptureFile(file, requestedJobAction(text));
  }

  function handlePaste(e) {
    const pasted = e.clipboardData?.getData("text/plain") || "";
    if (!pasted || !isCaptureCandidate(pasted)) return; // short single-line paste — unchanged default behavior
    e.preventDefault();
    ingestText(pasted);
  }

  async function handleDrop(e) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      await ingestFile(file);
      return;
    }
    const dropped =
      e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
    if (dropped) ingestText(dropped);
  }

  async function handleFileSelection(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await ingestFile(file);
  }

  function retryTurn() {
    if (!turn?.retryable) return;
    if (turn.kind === "answer" && turn.request?.text) {
      void commitAnswer(turn.request.text, turn.request.preview || null);
      return;
    }
    if (turn.kind === "action" && turn.request) {
      void commitAction(turn.request);
      return;
    }
    if (turn.kind === "capture" && turn.request?.text) {
      void commitCaptureText(turn.request.text, turn.request.requestedAction || null);
      return;
    }
    if (turn.kind === "capture" && turn.request?.file) {
      void commitCaptureFile(turn.request.file, turn.request.requestedAction || null);
    }
  }

  const captureRows = Math.min(8, Math.max(3, text.split("\n").length));

  return (
    <div className="ask-bar" ref={rootRef}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag/drop capture surface; the attach button below is the keyboard/click equivalent */}
      <div
        className={`ask-bar__shell${panelOpen ? " ask-bar__shell--active" : ""}${dragActive ? " ask-bar__shell--drag-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        {turn ? (
          <AskBarTurn
            turn={turn}
            decideBusyId={decideBusyId}
            decideError={decideError}
            onConfirm={handleConfirmIntake}
            onReclassify={handleReclassifyIntake}
            onDismiss={handleDismissIntake}
            onRetry={retryTurn}
            onRunAction={commitAction}
          />
        ) : null}
        {needsYouOpen ? (
          <AskBarNeedsYouList
            items={needsYou.items}
            decideBusyId={decideBusyId}
            decideError={decideError}
            onConfirm={handleConfirmIntake}
            onReclassify={handleReclassifyIntake}
            onDismiss={handleDismissIntake}
          />
        ) : null}
        {panelOpen ? (
          <AskBarPreview
            preview={preview}
            pending={previewPending}
            selected={selected}
            onSelect={setSelected}
            captureMode={captureMode}
            captureAction={captureAction}
          />
        ) : null}
        <div className="ask-bar__row">
          {captureMode ? (
            <textarea
              ref={inputRef}
              className="ask-bar__input ask-bar__input--capture"
              rows={captureRows}
              role="combobox"
              aria-expanded={panelOpen}
              aria-haspopup="listbox"
              aria-controls="ask-bar-preview"
              placeholder={placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => setFocused(true)}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
            />
          ) : (
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
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
            />
          )}
          {needsYou.count > 0 ? (
            <button
              type="button"
              className="ask-bar__needs-chip"
              aria-expanded={needsYouOpen}
              onClick={() => setNeedsYouOpen((v) => !v)}
            >
              Needs you · {needsYou.count}
            </button>
          ) : null}
          {!text.trim() ? (
            <span className="ask-bar__kbd" aria-hidden="true">
              ⌘K
            </span>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            className="ask-bar__file-input"
            onChange={handleFileSelection}
            aria-label="Attach a file"
          />
          <IconButton
            label="Attach a file"
            className="ask-bar__attach"
            onClick={() => fileInputRef.current?.click()}
          >
            <PaperclipIcon />
          </IconButton>
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

function AskBarPreview({ preview, pending, selected, onSelect, captureMode, captureAction }) {
  if (!captureMode && pending && !preview) {
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
  if (!captureMode && !preview) return null;

  return (
    <div
      className="ask-bar__preview"
      id="ask-bar-preview"
      role="listbox"
      aria-label="Ask bar suggestions"
    >
      {captureMode ? (
        <button
          type="button"
          role="option"
          aria-selected={selected === "capture"}
          className={`ask-bar__preview-row${selected === "capture" ? " ask-bar__preview-row--selected" : ""}`}
          onClick={() => onSelect("capture")}
        >
          <span className="ask-bar__preview-kind ask-bar__preview-kind--action">Capture</span>
          <span className="ask-bar__preview-label">
            {captureAction === "prepare"
              ? "Capture, evaluate, and prepare this application"
              : captureAction === "evaluate"
                ? "Capture and evaluate this job"
                : "Send to triage"}
          </span>
          <span className="ask-bar__preview-kbd">↵ Send</span>
        </button>
      ) : preview.action ? (
        <button
          type="button"
          role="option"
          aria-selected={selected === "action"}
          className={`ask-bar__preview-row${selected === "action" ? " ask-bar__preview-row--selected" : ""}`}
          onClick={() => onSelect("action")}
        >
          <span className="ask-bar__preview-kind ask-bar__preview-kind--action">Action</span>
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
          {(!captureMode && preview?.answer?.label) || "Ask the workspace agent"}
        </span>
      </button>
      {!captureMode && preview?.engineAvailable === false ? (
        <div className="ask-bar__preview-note">No AI engine is configured yet.</div>
      ) : null}
    </div>
  );
}

// The acting-state spinning ring from DESIGN-SPEC.md's ask bar anatomy —
// reuses Button.jsx/OnboardingShell.jsx's own `.btn__spinner` ring (same
// border/animation), tinted cobalt via the `--action` modifier below.
function ProgressLine({ children }) {
  return (
    <span className="ask-bar__progress">
      <span className="btn__spinner ask-bar__progress-spinner" aria-hidden="true" />
      {children}
    </span>
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

// Stateless by design (see AskBar.test.jsx's own header comment) — every
// bit of mutable state (busy/error) lives in AskBar itself and is threaded
// down as props, same as AskBarPreview above.
function AskBarIntakeReceipt({
  item,
  busy,
  error,
  onConfirm,
  onReclassify,
  onDismiss,
  onRunAction,
}) {
  if (!item) return null;
  const needsUser = item.status === "needs_you";
  // M10: read straight off the API response (src/core/intake/dispatch-summary.mjs,
  // computed server-side once) — no client-side re-derivation.
  const dispatchSummary = item.dispatchSummary;
  const canConfirm = item.status === "proposed";
  const canDismiss = ["proposed", "needs_you", "error"].includes(item.status);
  const canReclassify = ["needs_you", "error"].includes(item.status);
  const savedJobHref = item.result?.applicationId
    ? appActionHref(`/jobs?open=${encodeURIComponent(item.result.applicationId)}`)
    : null;
  const nextIntents = Array.isArray(item.result?.nextActions)
    ? item.result.nextActions.filter((action) => action?.intent)
    : [];
  const resultArtifacts = Array.isArray(item.result?.artifacts) ? item.result.artifacts : [];
  const evaluationArtifact = resultArtifacts.find((artifact) => artifact.kind === "job_evaluation");
  const packetArtifact = resultArtifacts.find((artifact) => artifact.kind === "packet_generation");
  const handoffArtifact = resultArtifacts.find(
    (artifact) => artifact.kind === "application_handoff"
  );
  const handoffUrl = safeExternalHttpUrl(handoffArtifact?.url);

  return (
    <div className="ask-bar__intake">
      <div className="ask-bar__intake-row">
        <span className="badge badge--muted">{kindLabel(item.kind)}</span>
        {item.trackerMatch?.matched ? <span className="badge badge--ok">Tracker match</span> : null}
      </div>
      {item.trackerMatch?.matched ? (
        <p className="ask-bar__summary">{item.trackerMatch.summary}</p>
      ) : null}
      {needsUser ? (
        <p className="ask-bar__error">
          Needs you: {item.classification?.needsUserReason || "review manually."}
        </p>
      ) : item.classification?.proposedAction ? (
        <p className="ask-bar__summary">{item.classification.proposedAction}</p>
      ) : null}
      {dispatchSummary && (item.status === "proposed" || item.status === "confirmed") ? (
        <p className="ask-bar__receipt">Will: {dispatchSummary}</p>
      ) : null}
      {item.status === "running" ? (
        <p className="ask-bar__receipt">
          Running{item.dispatch?.params?.skill ? ` ${item.dispatch.params.skill}` : ""}… this can
          take a minute.
        </p>
      ) : null}
      {item.status === "done" ? (
        <>
          <p className="ask-bar__receipt">{describeIntakeResult(item)}</p>
          {item.result?.evaluation || evaluationArtifact ? (
            <JobEvaluationCard
              artifact={evaluationArtifact || { evaluation: item.result.evaluation }}
            />
          ) : null}
          {packetArtifact ? <PacketStatus artifact={packetArtifact} /> : null}
          {handoffUrl ? (
            <a className="ask-bar__handoff-link" href={handoffUrl} target="_blank" rel="noreferrer">
              Open application site
            </a>
          ) : null}
          {savedJobHref ? (
            <a className="btn btn--secondary" href={savedJobHref}>
              Review this job
            </a>
          ) : null}
          {nextIntents.map((action) => (
            <Button
              variant="secondary"
              key={`${action.intent.type}:${action.intent.entity?.type}:${action.intent.entity?.id}`}
              onClick={() => onRunAction?.(action)}
            >
              {action.label || "Continue"}
            </Button>
          ))}
        </>
      ) : null}
      {item.status === "error" ? (
        <p className="ask-bar__error">{item.error || "The confirmed action failed."}</p>
      ) : null}
      {error ? <p className="ask-bar__error">{error}</p> : null}
      {canConfirm || canDismiss || canReclassify ? (
        <div className="ask-bar__intake-actions">
          {canConfirm ? (
            <Button onClick={() => onConfirm(item)} disabled={busy}>
              {busy ? "Confirming…" : "Confirm"}
            </Button>
          ) : null}
          {canReclassify ? (
            <Button variant="secondary" onClick={() => onReclassify(item)} disabled={busy}>
              {busy ? "Working…" : "Reclassify"}
            </Button>
          ) : null}
          {canDismiss ? (
            <Button variant="secondary" onClick={() => onDismiss(item)} disabled={busy}>
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AskBarNeedsYouList({
  items,
  decideBusyId,
  decideError,
  onConfirm,
  onReclassify,
  onDismiss,
}) {
  return (
    <div className="ask-bar__needs-list">
      {items.length === 0 ? (
        <p className="ask-bar__needs-empty">Nothing needs you right now.</p>
      ) : (
        items.map((item) => (
          <AskBarIntakeReceipt
            key={item.id}
            item={item}
            busy={decideBusyId === item.id}
            error={decideError?.id === item.id ? decideError.message : null}
            onConfirm={onConfirm}
            onReclassify={onReclassify}
            onDismiss={onDismiss}
          />
        ))
      )}
    </div>
  );
}

function AskBarTurn({
  turn,
  decideBusyId,
  decideError,
  onConfirm,
  onReclassify,
  onDismiss,
  onRetry,
  onRunAction,
}) {
  if (turn.kind === "capture") {
    if (turn.status === "running") {
      return (
        <div className="ask-bar__turn">
          <ProgressLine>{turn.label || "Sending to triage…"}</ProgressLine>
        </div>
      );
    }
    if (turn.status === "error") {
      return (
        <div className="ask-bar__turn">
          <p className="ask-bar__error">{turn.error}</p>
          {turn.retryable ? (
            <Button variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      );
    }
    return (
      <div className="ask-bar__turn">
        <AskBarIntakeReceipt
          item={turn.item}
          busy={decideBusyId === turn.item?.id}
          error={decideError?.id === turn.item?.id ? decideError.message : null}
          onConfirm={onConfirm}
          onReclassify={onReclassify}
          onDismiss={onDismiss}
          onRunAction={onRunAction}
        />
      </div>
    );
  }

  if (turn.status === "running") {
    const elapsedMs = Date.now() - turn.startedAt;
    return (
      <div className="ask-bar__turn">
        <ProgressLine>
          Running · {turn.label} · {formatElapsedSeconds(elapsedMs)}
        </ProgressLine>
      </div>
    );
  }

  if (turn.status === "error") {
    return (
      <div className="ask-bar__turn">
        <p className="ask-bar__error">{turn.error}</p>
        {turn.noEngine ? <EngineReceipt noEngine /> : null}
        {turn.retryable ? (
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
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

  const evaluationArtifact = turn.artifacts?.find((artifact) => artifact.kind === "job_evaluation");
  const packetArtifact = turn.artifacts?.find((artifact) => artifact.kind === "packet_generation");
  const handoffArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "application_handoff"
  );
  const companyProposalsArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "company_proposals"
  );
  const boardDiscoveryArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "board_discovery_chat"
  );
  const searchSourceArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "search_source"
  );
  const handoffUrl = safeExternalHttpUrl(handoffArtifact?.url);
  const nextActions = Array.isArray(turn.metadata?.nextActions) ? turn.metadata.nextActions : [];

  return (
    <div className="ask-bar__turn">
      {turn.resultText ? <p className="ask-bar__summary">{turn.resultText}</p> : null}
      {evaluationArtifact ? <JobEvaluationCard artifact={evaluationArtifact} /> : null}
      {packetArtifact ? <PacketStatus artifact={packetArtifact} /> : null}
      {searchSourceArtifact ? <SearchSourceStatus artifact={searchSourceArtifact} /> : null}
      {companyProposalsArtifact ? (
        <CompanyProposalsCard artifact={companyProposalsArtifact} onRunAction={onRunAction} />
      ) : null}
      {boardDiscoveryArtifact ? (
        <ChatPanel
          skill="research-boards"
          initialChatId={boardDiscoveryArtifact.chatId}
          completionLabel="Finish board review"
          onComplete={() => completeDiscoveryStep("research-boards")}
        />
      ) : null}
      {handoffUrl ? (
        <a className="ask-bar__handoff-link" href={handoffUrl} target="_blank" rel="noreferrer">
          Open application site
        </a>
      ) : null}
      {nextActions.length ? (
        <div className="ask-bar__next-actions">
          {nextActions.map((action) => {
            const href = appActionHref(action.href);
            if (href) {
              return (
                <a className="btn btn--secondary" href={href} key={href}>
                  {action.label || "Open"}
                </a>
              );
            }
            return action.intent ? (
              <Button
                variant="secondary"
                key={`${action.intent.type}:${action.intent.entity?.type}:${action.intent.entity?.id}`}
                onClick={() => onRunAction(action)}
              >
                {action.label || "Continue"}
              </Button>
            ) : null;
          })}
        </div>
      ) : null}
      <EngineReceipt engine={turn.engine} elapsedMs={turn.elapsedMs} />
    </div>
  );
}

function SearchSourceStatus({ artifact }) {
  const label = artifact.label || artifact.provider || "Search source";
  const details = [artifact.provider, artifact.sourceType].filter(Boolean).join(" · ");
  return (
    <section className="ask-bar__source-status" aria-label="Search source result">
      <strong>{label}</strong>
      {details ? <span>{details}</span> : null}
      <span className="ask-bar__source-state">
        {artifact.enabled === false ? "Disabled" : "Enabled"}
      </span>
      {artifact.auth === true && artifact.enabled === false ? (
        <span>Browser consent required before use</span>
      ) : null}
    </section>
  );
}

function JobEvaluationCard({ artifact }) {
  const evaluation = artifact.evaluation || {};
  const gate = String(evaluation.gate || "review").toUpperCase();
  const fitReasons = Array.isArray(evaluation.fitReasons)
    ? evaluation.fitReasons
    : Array.isArray(evaluation.roleFit?.why)
      ? evaluation.roleFit.why
      : [];
  const fitRisks = Array.isArray(evaluation.fitRisks)
    ? evaluation.fitRisks
    : Array.isArray(evaluation.roleFit?.risks)
      ? evaluation.roleFit.risks
      : [];
  const compensation =
    typeof evaluation.compensation === "string"
      ? evaluation.compensation
      : evaluation.compensation?.summary || null;

  return (
    <section className="ask-bar__evaluation" aria-label="Job evaluation">
      <div className="ask-bar__evaluation-head">
        <span className={`ask-bar__gate ask-bar__gate--${gate.toLowerCase()}`}>{gate}</span>
        {evaluation.fitScore == null ? null : <strong>{evaluation.fitScore}/100 fit</strong>}
      </div>
      {compensation ? <p>{compensation}</p> : null}
      {fitReasons.map((reason) => (
        <p className="ask-bar__evaluation-signal" key={`why-${reason}`}>
          <span aria-hidden="true">✓</span> {reason}
        </p>
      ))}
      {fitRisks.map((risk) => (
        <p
          className="ask-bar__evaluation-signal ask-bar__evaluation-signal--risk"
          key={`risk-${risk}`}
        >
          <span aria-hidden="true">!</span> {risk}
        </p>
      ))}
    </section>
  );
}

function PacketStatus({ artifact }) {
  const fallbackGapCount = Array.isArray(artifact.gaps) ? artifact.gaps.length : 0;
  const blockingGapCount = Number.isInteger(artifact.blockingGapCount)
    ? Math.max(0, artifact.blockingGapCount)
    : fallbackGapCount;
  return (
    <div className="ask-bar__packet-status">
      <strong>
        Application packet: {artifact.uploadReady ? "ready" : artifact.status || "reviewable"}
      </strong>
      {blockingGapCount ? (
        <span>
          {blockingGapCount} item{blockingGapCount === 1 ? " needs" : "s need"} review.
        </span>
      ) : null}
    </div>
  );
}

function CompanyProposalsCard({ artifact, onRunAction }) {
  const proposals = Array.isArray(artifact.proposals) ? artifact.proposals : [];
  const rejectedCount = Array.isArray(artifact.rejected) ? artifact.rejected.length : 0;
  return (
    <section className="ask-bar__company-proposals" aria-label="Company proposals">
      {proposals.length ? (
        proposals.map((proposal) => {
          const name = proposal.company?.name || proposal.name || "Company";
          const role = proposal.roleSeen || proposal.roleFamily || null;
          return (
            <article className="ask-bar__company-proposal" key={proposal.proposalId}>
              <div className="ask-bar__company-proposal-head">
                <strong>{name}</strong>
                <span className="badge badge--muted">
                  {proposal.confidenceTier === "high-confidence" ? "High confidence" : "Review"}
                </span>
              </div>
              {proposal.why ? <p>{proposal.why}</p> : null}
              {role || proposal.atsProvider ? (
                <span className="ask-bar__company-proposal-meta">
                  {[role, proposal.atsProvider].filter(Boolean).join(" · ")}
                </span>
              ) : null}
              <div className="ask-bar__company-proposal-actions">
                <Button
                  onClick={() =>
                    onRunAction?.({
                      label: `Track ${name}`,
                      intent: {
                        type: "company.proposal-decide",
                        entity: { type: "company-proposal", id: proposal.proposalId },
                        input: {
                          batchId: artifact.batchId,
                          proposalId: proposal.proposalId,
                          action: "approve-supported-ats",
                          expectedVersion: proposal.version,
                          ...(artifact.trigger?.kind === "search-run"
                            ? { searchRunId: artifact.trigger.id }
                            : {}),
                        },
                      },
                    })
                  }
                >
                  Track
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    onRunAction?.({
                      label: `Skip ${name}`,
                      intent: {
                        type: "company.proposal-decide",
                        entity: { type: "company-proposal", id: proposal.proposalId },
                        input: {
                          batchId: artifact.batchId,
                          proposalId: proposal.proposalId,
                          action: "reject",
                          expectedVersion: proposal.version,
                          ...(artifact.trigger?.kind === "search-run"
                            ? { searchRunId: artifact.trigger.id }
                            : {}),
                        },
                      },
                    })
                  }
                >
                  Skip
                </Button>
              </div>
            </article>
          );
        })
      ) : (
        <p className="ask-bar__company-proposals-empty">No company proposals need review.</p>
      )}
      {rejectedCount ? (
        <span className="ask-bar__company-proposal-meta">
          {rejectedCount} compan{rejectedCount === 1 ? "y was" : "ies were"} screened out.
        </span>
      ) : null}
    </section>
  );
}
