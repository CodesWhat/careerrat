import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { Button, IconButton } from "../components/Button.jsx";
import { ArrowUpIcon, PaperclipIcon } from "../components/icons.jsx";
import {
  capturePacketQuestions,
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
  WORKSPACE_ENTITY,
} from "../lib/api.js";
import { buildComposeLinks } from "../lib/commLinks.js";
import { emitDashboardChanged } from "../lib/dashboard-events.js";
import { errorState, resolveErrorCopy } from "../lib/errorCopy.js";
import { emitIntakeChanged } from "../lib/intake-events.js";
import { kindLabel } from "../lib/intake-labels.js";
import { safeExternalHttpUrl } from "../lib/safeExternalUrl.js";
import { useGlobalShortcut } from "../lib/useGlobalShortcut.js";
import { ChatPanel } from "../onboarding/ChatPanel.jsx";
import { ASK_BAR_REQUEST_EVENT } from "./ask-events.js";
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
  const document =
    "(?:(?:my|the)\\s+)?(?:resume|résumé|cv|cover\\s+letter|application\\s+(?:materials?|documents?))";
  if (
    new RegExp(
      `${prefix.source}(?:(?:tailor|customi[sz]e|rewrite|revise|adapt)\\s+${document}|(?:write|draft|create)\\s+(?:a\\s+|the\\s+)?cover\\s+letter)(?:\\s+(?:to|for))?\\s+${target}$`,
      "i"
    ).test(instruction)
  ) {
    return "tailor";
  }
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

  // commitAction only closes over stable setState/ref values plus its own
  // `action` argument, so the mount-time closure this effect captures below
  // behaves identically to a freshly-rendered one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only, see above
  useEffect(() => {
    function onAskRequest(event) {
      // A contextual CTA that already knows exactly which typed intent to
      // run (e.g. the Dashboard's strategy-review trigger) skips the
      // prefill-and-wait-for-Enter step entirely and commits straight
      // through, same as an ACTION preview row would.
      const requestedAction = event?.detail?.action;
      if (requestedAction?.intent?.type) {
        setCaptureMode(false);
        setCaptureAction(null);
        setFocused(false);
        commitAction(requestedAction);
        return;
      }
      const requestedText = String(event?.detail?.text || "").trim();
      if (!requestedText) return;
      setText(requestedText);
      setCaptureMode(false);
      setCaptureAction(null);
      setSelected("answer");
      setFocused(true);
      inputRef.current?.focus();
    }
    document.addEventListener(ASK_BAR_REQUEST_EVENT, onAskRequest);
    return () => document.removeEventListener(ASK_BAR_REQUEST_EVENT, onAskRequest);
  }, []);

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
              : captureAction === "tailor"
                ? "Capture, evaluate, and tailor documents for this job"
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
  const researchChatArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "research_chat"
  );
  const companyResearchArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "company_research"
  );
  const compBenchmarkArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "comp_benchmark"
  );
  const companyHealthArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "company_health"
  );
  const searchSourceArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "search_source"
  );
  const schedulingArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "scheduling_plan"
  );
  const screeningAnswersArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "screening_answers"
  );
  const strategyReviewArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "strategy_review"
  );
  const strategyApplyArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "strategy_apply"
  );
  const strategyStampArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "strategy_review_stamp"
  );
  const communicationNoteArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "communication_note"
  );
  const communicationHandoffArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "communication_handoff"
  );
  const settingsOverviewArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "settings_overview"
  );
  const settingsApplyArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "settings_apply"
  );
  const issueReportArtifact = turn.artifacts?.find((artifact) => artifact.kind === "issue_report");
  const issueFiledArtifact = turn.artifacts?.find((artifact) => artifact.kind === "issue_filed");
  const calendarWriteArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "calendar_write"
  );
  const sourcingHandoffArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "sourcing_handoff"
  );
  const leadReceiptArtifact = turn.artifacts?.find((artifact) => artifact.kind === "lead_receipt");
  const statusSyncHandoffArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "status_sync_handoff"
  );
  const mailSyncHandoff = turn.artifacts?.find((a) => a?.kind === "mail_sync_handoff");
  const messagesSyncHandoff = turn.artifacts?.find((a) => a?.kind === "messages_sync_handoff");
  const statusTransitionProposalArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "status_transition_proposal"
  );
  const statusTransitionReceiptArtifact = turn.artifacts?.find(
    (artifact) => artifact.kind === "status_transition_receipt"
  );
  const nextActions = Array.isArray(turn.metadata?.nextActions) ? turn.metadata.nextActions : [];

  return (
    <div className="ask-bar__turn">
      {turn.resultText ? <p className="ask-bar__summary">{turn.resultText}</p> : null}
      {evaluationArtifact ? <JobEvaluationCard artifact={evaluationArtifact} /> : null}
      {packetArtifact ? <PacketStatus artifact={packetArtifact} /> : null}
      {searchSourceArtifact ? <SearchSourceStatus artifact={searchSourceArtifact} /> : null}
      {schedulingArtifact ? <SchedulingPlanCard artifact={schedulingArtifact} /> : null}
      {screeningAnswersArtifact ? (
        <ScreeningAnswersCard artifact={screeningAnswersArtifact} />
      ) : null}
      {companyProposalsArtifact ? (
        <CompanyProposalsCard artifact={companyProposalsArtifact} onRunAction={onRunAction} />
      ) : null}
      {boardDiscoveryArtifact ? (
        <ResearchChatPanel
          artifact={boardDiscoveryArtifact}
          skill="research-boards"
          completionLabel="Finish board review"
          onComplete={() => completeDiscoveryStep("research-boards")}
        />
      ) : null}
      {researchChatArtifact ? (
        <ResearchChatPanel
          artifact={researchChatArtifact}
          skill={researchChatArtifact.skill}
          headline={researchChatHeadline(researchChatArtifact)}
        />
      ) : null}
      {companyResearchArtifact ? <CompanyResearchCard artifact={companyResearchArtifact} /> : null}
      {compBenchmarkArtifact ? <CompBenchmarkCard artifact={compBenchmarkArtifact} /> : null}
      {companyHealthArtifact ? <CompanyHealthCard artifact={companyHealthArtifact} /> : null}
      {strategyReviewArtifact ? (
        <StrategyReviewCard artifact={strategyReviewArtifact} onRunAction={onRunAction} />
      ) : null}
      {strategyApplyArtifact ? <StrategyApplyCard artifact={strategyApplyArtifact} /> : null}
      {strategyStampArtifact ? <StrategyStampCard artifact={strategyStampArtifact} /> : null}
      {communicationNoteArtifact ? (
        <CommunicationNoteCard artifact={communicationNoteArtifact} />
      ) : null}
      {communicationHandoffArtifact ? (
        <CommunicationHandoffCard artifact={communicationHandoffArtifact} />
      ) : null}
      {settingsOverviewArtifact ? (
        <SettingsOverviewCard artifact={settingsOverviewArtifact} />
      ) : null}
      {settingsApplyArtifact ? <SettingsApplyCard artifact={settingsApplyArtifact} /> : null}
      {issueReportArtifact ? <IssueReportCard artifact={issueReportArtifact} /> : null}
      {issueFiledArtifact ? <IssueFiledCard artifact={issueFiledArtifact} /> : null}
      {calendarWriteArtifact ? <CalendarWriteCard artifact={calendarWriteArtifact} /> : null}
      {sourcingHandoffArtifact ? <SourcingHandoffCard artifact={sourcingHandoffArtifact} /> : null}
      {leadReceiptArtifact ? <LeadReceiptCard artifact={leadReceiptArtifact} /> : null}
      {statusSyncHandoffArtifact ? (
        <StatusSyncHandoffCard artifact={statusSyncHandoffArtifact} />
      ) : null}
      {mailSyncHandoff ? <MailSyncHandoffCard artifact={mailSyncHandoff} /> : null}
      {messagesSyncHandoff ? <MessagesSyncHandoffCard artifact={messagesSyncHandoff} /> : null}
      {statusTransitionProposalArtifact ? (
        <StatusTransitionProposalCard
          artifact={statusTransitionProposalArtifact}
          onRunAction={onRunAction}
        />
      ) : null}
      {statusTransitionReceiptArtifact ? (
        <StatusTransitionReceiptCard artifact={statusTransitionReceiptArtifact} />
      ) : null}
      {handoffArtifact ? <ApplicationHandoffCard artifact={handoffArtifact} /> : null}
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
                key={`${action.intent.type}:${action.intent.entity?.type}:${action.intent.entity?.id}:${action.intent.input?.key || action.label || ""}`}
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

function ApplicationHandoffCard({ artifact }) {
  const [questions, setQuestions] = useState("");
  const [capture, setCapture] = useState(artifact.questionCapture || null);
  const [answersNeedRebuild, setAnswersNeedRebuild] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const handoffUrl = safeExternalHttpUrl(artifact.url);
  const applicationId = String(artifact.applicationId || "").trim();
  const captureRequired = capture?.state === "site-required";
  const inputId = `application-questions-${applicationId || "current"}`;
  const session = artifact.session || null;
  const sessionProvider =
    session?.provider === "orca"
      ? "Orca supervised browser"
      : session?.provider
        ? `${session.provider} browser`
        : null;
  const unresolved = Array.isArray(session?.unresolved) ? session.unresolved : [];
  const blockers = Array.isArray(session?.blockers) ? session.blockers : [];

  async function rebuildAnswers(answerableCount = Number(capture?.answerableCount) || 0) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await runWorkspaceIntent(
        "job.generate-documents",
        { type: "application", id: applicationId },
        { applyIntent: true, formats: ["pdf"] }
      );
      setAnswersNeedRebuild(false);
      setNotice(
        `Captured ${answerableCount} application question${answerableCount === 1 ? "" : "s"} and rebuilt the answers.`
      );
      emitDashboardChanged();
    } catch (err) {
      setError(
        `Questions were saved, but the answers could not be rebuilt: ${resolveErrorCopy(err).message}`
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleQuestionCapture() {
    const manualText = questions.trim();
    if (!manualText || !applicationId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    let answerableCount = 0;
    try {
      const response = await capturePacketQuestions({
        applicationId,
        source: "paste",
        manualText,
        url: handoffUrl || artifact.url || "",
      });
      const result = response?.data || response;
      answerableCount = Array.isArray(result?.questions) ? result.questions.length : 0;
      const excludedCount = Array.isArray(result?.excluded) ? result.excluded.length : 0;
      if (answerableCount + excludedCount === 0) {
        setError("No application questions were recognized. Paste one question per line.");
        setBusy(false);
        return;
      }
      const nextCapture = {
        state: "captured",
        source: "manual",
        answerableCount,
        excludedCount,
        demographicSectionPresent: result?.demographicSectionPresent === true,
      };
      setCapture(nextCapture);
      setAnswersNeedRebuild(true);
      setQuestions("");
      emitDashboardChanged();
    } catch (err) {
      setError(resolveErrorCopy(err).message);
      setBusy(false);
      return;
    }
    setBusy(false);
    await rebuildAnswers(answerableCount);
  }

  return (
    <section className="ask-bar__application-session" aria-label="Application handoff">
      <div className="ask-bar__application-session-head">
        <div>
          <strong>Finish this application</strong>
          <span>CareerRat will not mark it Applied until submission is confirmed.</span>
        </div>
        <span className="badge badge--warn">{session ? "Live" : "Supervised"}</span>
      </div>
      {session ? (
        <div className="ask-bar__application-session-state" aria-live="polite">
          <strong>{sessionProvider || "Supervised browser"}</strong>
          <span>
            {Number(session.filledCount) || 0} field
            {Number(session.filledCount) === 1 ? "" : "s"} filled
          </span>
          {Number(session.uploadedCount) > 0 ? (
            <span>
              {Number(session.uploadedCount)} file
              {Number(session.uploadedCount) === 1 ? "" : "s"} attached
            </span>
          ) : null}
          {unresolved.length ? (
            <>
              <span>
                {unresolved.length} field{unresolved.length === 1 ? "" : "s"} need you:
              </span>
              <ul>
                {unresolved.slice(0, 6).map((field) => (
                  <li key={field.label}>{field.label}</li>
                ))}
              </ul>
            </>
          ) : null}
          {blockers.length ? (
            <span>Stopped on: {blockers.join(", ")}</span>
          ) : (
            <span>Review the form, then submit in the browser. CareerRat will verify it next.</span>
          )}
        </div>
      ) : artifact.executorAvailable ? (
        <p className="ask-bar__application-session-state">
          CareerRat can open the live form, capture its rendered questions, and fill confirmed
          answers in a supervised browser.
        </p>
      ) : null}
      {capture?.state === "captured" ? (
        <p className="ask-bar__application-session-state">
          {capture.answerableCount} application question
          {capture.answerableCount === 1 ? "" : "s"} captured.{" "}
          {answersNeedRebuild
            ? "Rebuild the answer sheet before submitting."
            : "The packet includes the latest answers."}
        </p>
      ) : null}
      {answersNeedRebuild ? (
        <Button disabled={busy || !applicationId} onClick={() => rebuildAnswers()}>
          {busy ? "Rebuilding answers…" : "Retry answer build"}
        </Button>
      ) : null}
      {captureRequired ? (
        <div className="ask-bar__question-capture">
          <p>
            Open the site. When its employer questions appear, paste them here and CareerRat will
            rebuild the answer sheet before you submit.
          </p>
          {capture.attempted && capture.reason ? (
            <p className="field__hint">Automatic capture was unavailable: {capture.reason}</p>
          ) : null}
          <label htmlFor={inputId}>Application questions</label>
          <textarea
            id={inputId}
            aria-label="Application questions"
            rows={3}
            value={questions}
            placeholder="Paste the employer's questions here"
            onChange={(event) => setQuestions(event.target.value)}
          />
          <Button
            disabled={busy || !applicationId || !questions.trim()}
            onClick={handleQuestionCapture}
          >
            {busy ? "Rebuilding answers…" : "Save questions and rebuild answers"}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="ask-bar__error" aria-live="polite">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="ask-bar__application-session-state" aria-live="polite">
          {notice}
        </p>
      ) : null}
      {handoffUrl ? (
        <a className="ask-bar__handoff-link" href={handoffUrl} target="_blank" rel="noreferrer">
          Open application site
        </a>
      ) : null}
    </section>
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

// ResearchChatPanel — the embedded live chat surface for a discovery-style
// session (board discovery, and now research-company/research-comp/
// company-health). Generalizes the board-discovery-only ChatPanel wiring
// that used to live inline in renderTurn: same session fields (chatId etc),
// same completion contract, just an optional plain-language `headline` line
// above the transcript so a candidate glancing at Ask knows what Paul is
// doing without reading the chat itself.
function ResearchChatPanel({
  artifact,
  skill,
  completionLabel = null,
  headline = null,
  onComplete,
}) {
  return (
    <div className="ask-bar__research-chat">
      {headline ? <p className="ask-bar__research-chat-head">{headline}</p> : null}
      <ChatPanel
        skill={skill}
        initialChatId={artifact.chatId}
        completionLabel={completionLabel}
        onComplete={onComplete}
      />
    </div>
  );
}

// research_chat's plain-language headline. The workspace agent already
// composes one per skill onto the artifact (researchChatArtifact in
// workspace-agent.mjs: "Researching Acme", "Market comp research",
// "Company health — Acme") — research_chat carries no separate company/role
// field of its own (those live on the follow-up company_research/
// comp_benchmark/company_health artifacts once the skill finishes), so this
// reuses that title rather than re-deriving one.
function researchChatHeadline(artifact) {
  return String(artifact?.title || "").trim() || "Researching";
}

// "Researched 2 days ago" / "Researched today" — same rough day-bucket math
// as the rest of the app's relative-date helpers (e.g. NetworkPage.jsx's
// formatRelativeDate), duplicated locally rather than shared since none of
// them are exported from a common lib today.
const RELATIVE_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
function formatRelativeDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / dayMs);
  // Future dates (a calendar receipt's event date, for one) read as the
  // absolute date, not "today".
  if (days < 0) return RELATIVE_DATE_FORMAT.format(date);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return RELATIVE_DATE_FORMAT.format(date);
}

// CompanyResearchCard — the `company_research` artifact (research-company
// skill): company name, when it was researched, how many sources backed it,
// and the full cited markdown collapsed behind a <details> (same plain
// pre-wrapped-text treatment as the interview dossier's compact drawer view
// — see InterviewDossierCard.jsx's own header comment on why this stays raw
// markdown rather than server-rendered HTML). The turn's Refresh action (and
// any other nextActions) render through the generic nextActions block below,
// same as every other card here.
function CompanyResearchCard({ artifact }) {
  const company = artifact.company || "This company";
  const researchedLabel = formatRelativeDate(artifact.fetchedAt);
  const sourceCount = Number(artifact.sources) || 0;
  return (
    <section className="ask-bar__research-card" aria-label="Company research">
      <div className="ask-bar__research-head">
        <strong>{company}</strong>
        {artifact.stale ? <span className="badge badge--warn">May be out of date</span> : null}
      </div>
      <p className="ask-bar__research-meta">
        {researchedLabel ? `Researched ${researchedLabel}` : "Researched"}
        {sourceCount
          ? ` · ${sourceCount} source${sourceCount === 1 ? "" : "s"}`
          : " · no sources cited"}
      </p>
      {artifact.markdown ? (
        <details className="ask-bar__research-details">
          <summary>Read the full research</summary>
          <div className="ask-bar__research-markdown">{artifact.markdown}</div>
        </details>
      ) : null}
    </section>
  );
}

function confidenceLabel(value) {
  const text = String(value || "").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

// Never fabricate a $0 for a value the research couldn't find — a missing
// floor/midpoint/ceiling reads as "not enough public data", never a number.
function formatBenchmarkValue(value, currency) {
  if (value == null || value === "") return "not enough public data";
  const number = Number(value);
  if (!Number.isFinite(number)) return "not enough public data";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 0,
    }).format(number);
  } catch {
    return `${currency ? `${currency} ` : ""}${Math.round(number)}`;
  }
}

// CompBenchmarkCard — the `comp_benchmark` artifact (research-comp skill).
function CompBenchmarkCard({ artifact }) {
  const benchmark = artifact.benchmark || {};
  const currency = benchmark.currency || "USD";
  const checkedLabel = formatRelativeDate(artifact.fetchedAt);
  const title = [artifact.role, artifact.location].filter(Boolean).join(" · ") || "Comp benchmark";
  return (
    <section className="ask-bar__research-card" aria-label="Comp benchmark">
      <div className="ask-bar__research-head">
        <strong>{title}</strong>
        {benchmark.confidence ? (
          <span className="badge badge--muted">
            {confidenceLabel(benchmark.confidence)} confidence
          </span>
        ) : null}
      </div>
      <div className="ask-bar__comp-values">
        <span className="ask-bar__comp-value">
          <span>Floor</span>
          <strong>{formatBenchmarkValue(benchmark.floor, currency)}</strong>
        </span>
        <span className="ask-bar__comp-value">
          <span>Midpoint</span>
          <strong>{formatBenchmarkValue(benchmark.midpoint, currency)}</strong>
        </span>
        <span className="ask-bar__comp-value">
          <span>Ceiling</span>
          <strong>{formatBenchmarkValue(benchmark.ceiling, currency)}</strong>
        </span>
      </div>
      {checkedLabel ? <p className="ask-bar__research-meta">Checked {checkedLabel}</p> : null}
      {artifact.markdown ? (
        <details className="ask-bar__research-details">
          <summary>Read the full comp notes</summary>
          <div className="ask-bar__research-markdown">{artifact.markdown}</div>
        </details>
      ) : null}
    </section>
  );
}

// Plain-language phrasing for the raw provenance code — never the word
// "provenance" itself in front of a candidate (copy rule: say what it's
// based on instead).
const HEALTH_PROVENANCE_COPY = {
  "built-from-data": "Based on research CareerRat found",
  "needs-more-info": "Not enough public information yet",
  stale: "Based on older information",
};
function healthProvenanceLabel(provenance) {
  const key = String(provenance || "").trim();
  if (!key) return "";
  return HEALTH_PROVENANCE_COPY[key] || `Based on ${key.replace(/-/g, " ")}`;
}

const HEALTH_DIM_LABEL = {
  layoffRisk: "Layoffs",
  hiringMomentum: "Hiring",
  financial: "Financial",
  sentiment: "Sentiment",
  leadership: "Leadership",
};
function healthDimLabel(key) {
  return (
    HEALTH_DIM_LABEL[key] ||
    String(key)
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (c) => c.toUpperCase())
  );
}

function healthRatingBadgeClass(rating) {
  if (rating === "healthy") return "badge--ok";
  if (rating === "risky") return "badge--error";
  return "badge--warn";
}

function healthRatingLabel(rating) {
  if (rating === "healthy") return "Healthy";
  if (rating === "risky") return "Risky";
  return "Watch";
}

// CompanyHealthCard — the `company_health` artifact (company-health skill).
// Internal signal only: this never phrases the rating as advice to
// withdraw, only context (see the skill's own SKILL.md).
function CompanyHealthCard({ artifact }) {
  const dims =
    artifact.dimensions && typeof artifact.dimensions === "object" ? artifact.dimensions : {};
  const dimEntries = Object.entries(dims).filter(([, detail]) => detail);
  const crossCut = Array.isArray(artifact.crossCut) ? artifact.crossCut.filter(Boolean) : [];
  const fitDelta = Number(artifact.fitDelta) || 0;
  const title = [artifact.company, artifact.role].filter(Boolean).join(" · ") || "Company health";
  return (
    <section className="ask-bar__research-card" aria-label="Company health">
      <div className="ask-bar__research-head">
        <strong>{title}</strong>
        <span className={`badge ${healthRatingBadgeClass(artifact.rating)}`}>
          {healthRatingLabel(artifact.rating)}
        </span>
      </div>
      <p className="ask-bar__research-meta">
        {[
          artifact.forFunction ? `for ${artifact.forFunction}` : null,
          healthProvenanceLabel(artifact.provenance),
          artifact.asOf ? `as of ${artifact.asOf}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {dimEntries.length ? (
        <div className="ask-bar__health-dims">
          {dimEntries.map(([key, detail]) => {
            // dimensions is the raw persisted companyHealth shape (see
            // validateCompanyHealth in src/core/db/verbs/company-health.mjs):
            // each entry is normally { level, note, functionHit?, trend? },
            // but a legacy flat string level still falls through here.
            const level = detail?.level ?? detail;
            const levelText =
              typeof level === "string" || typeof level === "number" ? String(level) : "";
            const note = detail?.note;
            if (!levelText) return null;
            return (
              <span
                className="ask-bar__health-dim"
                data-level={levelText}
                key={key}
                title={note || undefined}
              >
                {healthDimLabel(key)}: {levelText}
              </span>
            );
          })}
        </div>
      ) : null}
      {artifact.rationale ? <p className="ask-bar__research-meta">{artifact.rationale}</p> : null}
      {crossCut.length ? (
        <p className="ask-bar__research-meta">
          Touches what you said you need: {crossCut.join(", ")}
        </p>
      ) : null}
      {fitDelta ? (
        <p className="ask-bar__health-fit-note">
          Lowered this job's fit by {Math.abs(fitDelta)} point{Math.abs(fitDelta) === 1 ? "" : "s"}{" "}
          because it touches what you said you need.
        </p>
      ) : null}
    </section>
  );
}

// StrategyReviewCard/StrategyApplyCard — the `strategy_review`/`strategy_apply`
// artifacts (reevaluate-strategy skill, routed through Ask by the Dashboard's
// strategy panel — see DashboardPage.jsx's StrategyCta). `type` on a
// recommendation is a machine token (rerank/keep-signal/.../writing-style);
// STRATEGY_RECOMMENDATION_TYPE_LABEL is the one place that maps it to the
// plain-language chip a candidate reads.
const STRATEGY_RECOMMENDATION_TYPE_LABEL = {
  rerank: "Re-rank",
  "keep-signal": "Targeting",
  "cut-signal": "Targeting",
  "exclude-company": "Targeting",
  "comp-target": "Compensation",
  "comp-floor": "Compensation",
  "fit-bands": "Fit bands",
  learning: "Learning note",
  "writing-style": "Writing style",
  other: "Other",
};

// A few recommendation types change something with real reach (a re-scored
// board, a new comp anchor) — their Apply row spells that out before the
// click, rather than the click just being "Apply" with no stated effect.
const STRATEGY_RECOMMENDATION_CONSEQUENCE = {
  "comp-target": "Updates the comp target future evaluations compare against.",
  "comp-floor": "Updates the comp floor future evaluations gate on.",
  "fit-bands": "Re-scores every job on your board.",
};

// writing-style/other recommendations describe a change CareerRat can't make
// on its own (a phrasing habit, a miscellaneous note) — they show the
// proposal text and no button, same "manual" contract company-health and
// screening-answers already use for a step that needs the candidate.
const STRATEGY_MANUAL_RECOMMENDATION_TYPES = new Set(["writing-style", "other"]);

function strategyRecommendationLabel(type) {
  return STRATEGY_RECOMMENDATION_TYPE_LABEL[type] || "Other";
}

function strategyApplyResultText(result) {
  if (typeof result === "string") return result.trim() || null;
  if (result && typeof result === "object") {
    return result.summary || result.message || result.label || null;
  }
  return null;
}

function StrategyReviewCard({ artifact, onRunAction }) {
  const findings = Array.isArray(artifact.findings) ? artifact.findings : [];
  const recommendations = Array.isArray(artifact.recommendations) ? artifact.recommendations : [];
  const isFresh = artifact.state === "fresh";
  const isManual = artifact.state === "manual";
  return (
    <section className="ask-bar__strategy-review" aria-label="Strategy review">
      <div className="ask-bar__strategy-review-head">
        <strong>{artifact.headline || "Strategy review"}</strong>
        {isManual ? <span className="badge badge--muted">No AI available</span> : null}
      </div>
      {isManual ? (
        <p className="ask-bar__strategy-note">
          An AI engine was not available for this review, so these come from CareerRat's
          deterministic tracker rules instead.
        </p>
      ) : null}
      {findings.length ? (
        <ul className="ask-bar__strategy-findings">
          {findings.map((finding) => (
            <li key={finding.id || finding.title}>
              <strong>{finding.title}</strong>
              {finding.evidence ? <span>{finding.evidence}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {recommendations.length ? (
        <div className="ask-bar__strategy-recommendations">
          {recommendations.map((recommendation) => (
            <StrategyRecommendationRow
              key={recommendation.id || recommendation.title}
              recommendation={recommendation}
              onRunAction={onRunAction}
            />
          ))}
        </div>
      ) : null}
      {!isFresh && !isManual && !findings.length && !recommendations.length ? (
        <p className="ask-bar__strategy-note">Nothing to review yet.</p>
      ) : null}
    </section>
  );
}

function StrategyRecommendationRow({ recommendation, onRunAction }) {
  const manual = STRATEGY_MANUAL_RECOMMENDATION_TYPES.has(recommendation.type);
  const consequence = STRATEGY_RECOMMENDATION_CONSEQUENCE[recommendation.type];
  const evidenceCount = Number(recommendation.evidenceCount) || 0;
  return (
    <article className="ask-bar__strategy-recommendation">
      <div className="ask-bar__strategy-recommendation-head">
        <span className="badge badge--muted">
          {strategyRecommendationLabel(recommendation.type)}
        </span>
        <strong>{recommendation.title}</strong>
      </div>
      {recommendation.rationale ? <p>{recommendation.rationale}</p> : null}
      {evidenceCount ? (
        <span className="ask-bar__strategy-recommendation-meta">
          Based on {evidenceCount} outcome{evidenceCount === 1 ? "" : "s"}
        </span>
      ) : null}
      {manual ? (
        <span className="ask-bar__strategy-recommendation-meta">
          Manual:{" "}
          {recommendation.proposal?.text || "Review this yourself; CareerRat cannot apply it."}
        </span>
      ) : (
        <>
          {consequence ? <p className="ask-bar__strategy-consequence">{consequence}</p> : null}
          <Button
            variant="secondary"
            onClick={() =>
              onRunAction?.({
                label: `Apply: ${recommendation.title}`,
                intent: {
                  type: "strategy.apply",
                  entity: WORKSPACE_ENTITY,
                  input: { recommendation },
                },
              })
            }
          >
            Apply
          </Button>
        </>
      )}
    </article>
  );
}

function StrategyApplyCard({ artifact }) {
  const resultText = strategyApplyResultText(artifact.result);
  return (
    <section className="ask-bar__strategy-apply" aria-label="Strategy update applied">
      <div className="ask-bar__strategy-review-head">
        <strong>{artifact.title || "Strategy updated"}</strong>
        <span className="badge badge--ok">{strategyRecommendationLabel(artifact.type)}</span>
      </div>
      {resultText ? <p>{resultText}</p> : null}
    </section>
  );
}

function StrategyStampCard({ artifact }) {
  const snapshot = artifact.snapshot || {};
  const counts = [
    ["applied", snapshot.applied],
    ["advanced", snapshot.advanced],
    ["rejected", snapshot.rejected],
  ].filter(([, value]) => typeof value === "number");
  return (
    <section className="ask-bar__strategy-apply" aria-label="Strategy review recorded">
      <div className="ask-bar__strategy-review-head">
        <strong>Review recorded</strong>
        {artifact.lastReviewedAt ? (
          <span className="ask-bar__strategy-recommendation-meta">
            {artifact.lastReviewedAt.slice(0, 10)}
          </span>
        ) : null}
      </div>
      {counts.length ? (
        <p>Snapshot at review: {counts.map(([label, value]) => `${value} ${label}`).join(", ")}.</p>
      ) : null}
    </section>
  );
}

// communication_note (email-comms free-text note capture) — same card
// chrome as StrategyStampCard: a plain receipt, no left-edge accent.
function CommunicationNoteCard({ artifact }) {
  const title = [artifact.company, artifact.role].filter(Boolean).join(" — ") || "This thread";
  return (
    <section className="ask-bar__strategy-apply" aria-label="Note added to thread">
      <div className="ask-bar__strategy-review-head">
        <strong>{title}</strong>
        <span className="badge badge--muted">Note saved</span>
      </div>
      {artifact.note ? <p>{artifact.note}</p> : null}
    </section>
  );
}

// communication_handoff (email-comms skill, the supervised send handoff) —
// same card chrome as CommunicationNoteCard above. The server owns recipient
// resolution and ships to/subject/body on the artifact; the compose hrefs are
// built here from those parts (literal scheme/host + encodeURIComponent'd
// values), never rendered from the artifact's pre-built link strings, so a
// tampered durable artifact can't smuggle an arbitrary URL into an anchor.
// The "I sent this" confirm is not rendered here — it arrives as a generic
// metadata.nextActions entry and renders through the shared block below this
// card.
function CommunicationHandoffCard({ artifact }) {
  const title = [artifact.company, artifact.role].filter(Boolean).join(" — ") || "This thread";
  const ready = artifact.state === "ready";
  const links = buildComposeLinks({
    to: artifact.to,
    subject: artifact.subject,
    body: artifact.body,
  });
  const mailtoHref = ready ? links.mailto : null;
  const gmailHref = ready ? links.gmail : null;
  const outlookHref = ready ? links.outlook : null;
  return (
    <section className="ask-bar__strategy-apply" aria-label="Prepared reply">
      <div className="ask-bar__strategy-review-head">
        <strong>{title}</strong>
        <span className={`badge ${ready ? "badge--ok" : "badge--warn"}`}>
          {ready ? "Ready to send" : "Needs an address"}
        </span>
      </div>
      {artifact.subject ? <p>{artifact.subject}</p> : null}
      {ready ? (
        <div className="ask-bar__company-proposal-actions">
          {mailtoHref ? (
            <a className="ask-bar__handoff-link" href={mailtoHref}>
              Open in email app
            </a>
          ) : null}
          {gmailHref ? (
            <a
              className="ask-bar__handoff-link"
              href={gmailHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              Gmail
            </a>
          ) : null}
          {outlookHref ? (
            <a
              className="ask-bar__handoff-link"
              href={outlookHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              Outlook
            </a>
          ) : null}
        </div>
      ) : (
        <p className="ask-bar__strategy-note">
          Add the contact's email address to this thread, then CareerRat can prepare the send.
        </p>
      )}
    </section>
  );
}

// settings_overview/settings_apply (configure skill) share formatting helpers
// below. Config values arrive as raw snake_case tokens (usage_mode:
// "co_pilot" and the like) — humanizeSettingsToken() turns those into plain
// words, same spirit as healthDimLabel()'s camelCase fallback above.
function humanizeSettingsToken(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const SETTINGS_PLATFORM_LABEL = {
  linkedin: "LinkedIn",
  indeed: "Indeed",
  wellfound: "Wellfound",
  gmail: "Gmail",
  outlook: "Outlook",
};
function settingsPlatformLabel(key) {
  return SETTINGS_PLATFORM_LABEL[key] || humanizeSettingsToken(key);
}

// "Status polling: on for LinkedIn, Indeed" / "One-click apply: off" — a
// consented-false platform that's otherwise enabled reads as needing consent
// rather than silently omitted.
function settingsCapabilityLine(capability) {
  const label = capability.label || humanizeSettingsToken(capability.key);
  if (!capability.enabled) return `${label}: off`;
  const platforms = Array.isArray(capability.platforms) ? capability.platforms : [];
  const enabledPlatforms = platforms.filter((platform) => platform.enabled);
  if (!enabledPlatforms.length) return `${label}: on`;
  const names = enabledPlatforms.map((platform) =>
    platform.consent === false
      ? `${settingsPlatformLabel(platform.key)} (needs consent in Settings)`
      : settingsPlatformLabel(platform.key)
  );
  return `${label}: on for ${names.join(", ")}`;
}

function formatSettingsDollarAmount(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return `$${number.toLocaleString()}`;
}

// First 5 + "and N more" — same truncation spirit as savedJobAmbiguityMessage
// (errorCopy.js) for a list that could otherwise run unbounded.
function joinSettingsSignals(list) {
  const items = (Array.isArray(list) ? list : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!items.length) return "";
  if (items.length <= 5) return items.join(", ");
  return `${items.slice(0, 5).join(", ")} and ${items.length - 5} more`;
}

// settings_overview (configure skill) — a read-only receipt of current
// settings. Sections render only for the non-null groups the server sent;
// never a field outside the documented contract.
function SettingsOverviewCard({ artifact }) {
  const modes = artifact.modes || null;
  const automation = artifact.automation || null;
  const gates = artifact.gates || null;
  const capabilities = Array.isArray(automation?.capabilities) ? automation.capabilities : [];
  // The server sends a count here, never the list itself.
  const excludedCount = Number(gates?.excluded_companies) || 0;
  const cutSignals = joinSettingsSignals(gates?.cut_signals);
  const keepSignals = joinSettingsSignals(gates?.keep_signals);
  const doNotClaim = joinSettingsSignals(gates?.do_not_claim);
  const compFloor = formatSettingsDollarAmount(gates?.comp_floor);
  const compTarget = formatSettingsDollarAmount(gates?.comp_target);
  const compExpected = formatSettingsDollarAmount(gates?.comp_expected);
  const settingsHref = appActionHref("/settings");

  return (
    <section className="ask-bar__research-card" aria-label="Settings overview">
      <div className="ask-bar__research-head">
        <strong>Current settings</strong>
      </div>
      {modes ? (
        <>
          <p className="ask-bar__research-meta">Modes</p>
          {modes.usage_mode ? <p>Usage mode: {humanizeSettingsToken(modes.usage_mode)}</p> : null}
          {modes.application_mode ? (
            <p>Application mode: {humanizeSettingsToken(modes.application_mode)}</p>
          ) : null}
          {modes.agent_voice ? (
            <p>Agent voice: {humanizeSettingsToken(modes.agent_voice)}</p>
          ) : null}
        </>
      ) : null}
      {automation ? (
        <>
          <p className="ask-bar__research-meta">Automation</p>
          {automation.setup_mode ? (
            <p>Setup mode: {humanizeSettingsToken(automation.setup_mode)}</p>
          ) : null}
          {capabilities.map((capability) => (
            <p key={capability.key}>{settingsCapabilityLine(capability)}</p>
          ))}
        </>
      ) : null}
      {gates ? (
        <>
          <p className="ask-bar__research-meta">Gates</p>
          {compFloor ? <p>Comp floor: {compFloor}</p> : null}
          {compTarget ? <p>Comp target: {compTarget}</p> : null}
          {compExpected ? <p>Comp expected: {compExpected}</p> : null}
          {excludedCount ? <p>Excluded companies: {excludedCount}</p> : null}
          {cutSignals ? <p>Cut signals: {cutSignals}</p> : null}
          {keepSignals ? <p>Keep signals: {keepSignals}</p> : null}
          {doNotClaim ? <p>Do not claim: {doNotClaim}</p> : null}
        </>
      ) : null}
      {settingsHref ? (
        <a className="btn btn--secondary" href={settingsHref}>
          Open Settings
        </a>
      ) : null}
    </section>
  );
}

function settingsApplyValueText(value) {
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

// "Was: <from>. Now: <to>." — no arrows, no em dashes, only when both sides
// are present and scalar (append-type gate changes send the prior list as
// `from`; the summary sentence already covers those).
function settingsApplyFromToLine(from, to) {
  if (from == null || to == null) return null;
  if (Array.isArray(from) || Array.isArray(to)) return null;
  return `Was: ${settingsApplyValueText(from)}. Now: ${settingsApplyValueText(to)}.`;
}

// settings_apply (configure skill) — a write receipt, same chrome as
// StrategyStampCard/CommunicationNoteCard above (plain receipt, no left-edge
// accent).
function SettingsApplyCard({ artifact }) {
  // changed: false only arrives from a gate no-op ("Already saved"); absent
  // means the write happened.
  const changed = artifact.changed !== false;
  const fromToLine = changed ? settingsApplyFromToLine(artifact.from, artifact.to) : null;
  return (
    <section
      className="ask-bar__strategy-apply"
      aria-label={changed ? "Setting updated" : "Setting unchanged"}
    >
      <div className="ask-bar__strategy-review-head">
        <strong>{artifact.label || "Setting updated"}</strong>
        <span className={`badge ${changed ? "badge--ok" : "badge--muted"}`}>
          {changed ? "Setting updated" : "No change"}
        </span>
      </div>
      {artifact.summary ? <p>{artifact.summary}</p> : null}
      {fromToLine ? <p>{fromToLine}</p> : null}
    </section>
  );
}

// clipboard.writeText is the primary path; a hidden-textarea + execCommand
// fallback covers browsers/contexts where the async Clipboard API is
// unavailable or blocked (non-secure context, permission denial). Ported
// from LibraryPage.jsx's own copyTextToClipboard() (not shared — that file
// is out of scope here) so "Copy full report" still works rather than
// silently failing.
async function copyTextToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy fallback below.
  }
  if (typeof document === "undefined") return false;
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

// issue_report (report-issue skill) — the drafted GitHub bug-report artifact.
// The "I filed it" confirm is not rendered here — it arrives as a generic
// metadata.nextActions entry and renders through the shared block, same
// contract as CommunicationHandoffCard/ApplicationHandoffCard above.
function IssueReportCard({ artifact }) {
  const [copied, setCopied] = useState(false);
  const title = artifact.title || "Bug report draft";
  const body = artifact.body || "";
  const url = safeExternalHttpUrl(artifact.url);

  async function copyDraft() {
    setCopied(await copyTextToClipboard(`${title}\n\n${body}`));
  }

  return (
    <section className="ask-bar__research-card" aria-label="Bug report draft">
      <div className="ask-bar__research-head">
        <strong>Bug report draft</strong>
        <span className="badge badge--ok">Ready to file</span>
      </div>
      {artifact.configHint ? (
        <p className="ask-bar__strategy-note">
          This looks like it might be a setup problem. Checking Settings or running careerrat doctor
          may fix it faster than filing a bug.
        </p>
      ) : null}
      <strong>{title}</strong>
      <div className="ask-bar__research-markdown">{body}</div>
      {artifact.compFlagged ? (
        <p className="ask-bar__health-fit-note">
          This might include a pay figure. Review the draft carefully before filing.
        </p>
      ) : null}
      {artifact.errorMessageDropped ? (
        <p className="ask-bar__strategy-note">
          The raw error text was left out because it referenced workspace data.
        </p>
      ) : null}
      {artifact.truncated ? (
        <p className="ask-bar__strategy-note">
          The prefilled form is shortened. Copy the full report below if you need all of it.
        </p>
      ) : null}
      <div className="ask-bar__company-proposal-actions">
        {url ? (
          <a className="ask-bar__handoff-link" href={url} target="_blank" rel="noreferrer">
            Open GitHub to file
          </a>
        ) : null}
        <Button variant="secondary" onClick={copyDraft}>
          {copied ? "Copied" : "Copy full report"}
        </Button>
      </div>
    </section>
  );
}

// Strict shape check (defense in depth alongside whatever the server already
// validated) — a durable artifact rendering an arbitrary URL as a link is
// exactly the risk CommunicationHandoffCard's own header comment calls out.
// The repo slug is intentionally a literal here, independent of the server's
// bugs.url-derived validator: an allowlist the artifact itself could vary
// would be no allowlist at all. A fork that rebrands the upstream repo
// updates this one constant (worst case before then: the receipt renders as
// plain text instead of a link).
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/CodesWhat\/careerrat\/issues\/\d+\/?$/;
function safeIssueUrl(value) {
  const url = String(value || "").trim();
  return ISSUE_URL_PATTERN.test(url) ? url : null;
}

// issue_filed (report-issue skill) — a receipt, same chrome as
// SettingsApplyCard/CommunicationNoteCard above (plain receipt, no
// left-edge accent).
function IssueFiledCard({ artifact }) {
  const issueUrl = safeIssueUrl(artifact.url);
  return (
    <section className="ask-bar__strategy-apply" aria-label="Issue filed">
      <div className="ask-bar__strategy-review-head">
        <strong>Bug report filed</strong>
        <span className="badge badge--ok">Issue filed</span>
      </div>
      {issueUrl ? (
        <a className="ask-bar__handoff-link" href={issueUrl} target="_blank" rel="noreferrer">
          {issueUrl}
        </a>
      ) : (
        <p>This issue was recorded.</p>
      )}
    </section>
  );
}

// calendar_write (calendar-sync skill) — a receipt, same chrome as
// IssueFiledCard above (plain receipt, no left-edge accent).
const CALENDAR_PROVIDER_LABELS = {
  google_calendar: "Google Calendar",
  outlook_calendar: "Outlook Calendar",
  apple_calendar: "Apple Calendar",
  automation_tools: "Automation tools",
};
function calendarWriteProviderLabel(provider) {
  return CALENDAR_PROVIDER_LABELS[provider] || "Calendar";
}

function CalendarWriteCard({ artifact }) {
  const isManual = artifact.provenance === "manual";
  const companyRole = [artifact.company, artifact.role].filter(Boolean).join(" — ");
  const dateLabel = formatRelativeDate(artifact.eventIso || artifact.at);
  return (
    <section className="ask-bar__strategy-apply" aria-label="Calendar event recorded">
      <div className="ask-bar__strategy-review-head">
        <strong>Calendar event recorded</strong>
        <span className="badge badge--ok">{isManual ? "Recorded" : "Synced"}</span>
      </div>
      <p>{artifact.title}</p>
      {companyRole ? <p>{companyRole}</p> : null}
      <p className="ask-bar__screening-note">
        {[calendarWriteProviderLabel(artifact.provider), dateLabel].filter(Boolean).join(" · ")}
      </p>
    </section>
  );
}

// sourcing_handoff (relationship-sourcing skill) — an acknowledgment that the
// request was recorded, not a result (nothing has succeeded yet), so the
// badge stays neutral rather than badge--ok. Same receipt chrome as
// CalendarWriteCard above, no left-edge accent.
function SourcingHandoffCard({ artifact }) {
  const platforms = Array.isArray(artifact.platforms) ? artifact.platforms : [];
  let note =
    "Run the relationship-sourcing skill from your agent or terminal. New leads land in the Network tab for your review.";
  if (artifact.ctaRecorded) {
    note += " A reminder was added to this job's next action.";
  }
  return (
    <section className="ask-bar__strategy-apply" aria-label="Sourcing requested">
      <div className="ask-bar__strategy-review-head">
        <strong>Sourcing requested</strong>
        <span className="badge badge--muted">Handoff</span>
      </div>
      {artifact.company ? <p>{artifact.company}</p> : null}
      {platforms.map((platform) => (
        <p key={platform.platform}>
          {[
            settingsPlatformLabel(platform.platform),
            platform.allowed ? "Allowed" : "Off in Settings",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ))}
      <p className="ask-bar__screening-note">{note}</p>
    </section>
  );
}

// lead_receipt (relationship-sourcing skill) — a candidate-reviewed lead
// landed in Network; same receipt chrome, badge--warn to match
// ScreeningAnswersCard's "needs your review" signal.
function LeadReceiptCard({ artifact }) {
  return (
    <section className="ask-bar__strategy-apply" aria-label="Contact recorded">
      <div className="ask-bar__strategy-review-head">
        <strong>Contact recorded</strong>
        <span className="badge badge--warn">Review first</span>
      </div>
      <p>{artifact.name}</p>
      <p>{[artifact.type, artifact.company].filter(Boolean).join(" at ")}</p>
      <p className="ask-bar__screening-note">
        {[settingsPlatformLabel(artifact.platform), "Approve or reject it in the Network tab."]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </section>
  );
}

// status_sync_handoff (sync-status skill) — an acknowledgment that the check
// was requested, not a result, so the badge stays neutral. Same receipt
// chrome as SourcingHandoffCard above, no left-edge accent.
function StatusSyncHandoffCard({ artifact }) {
  const platforms = Array.isArray(artifact.platforms) ? artifact.platforms : [];
  return (
    <section className="ask-bar__strategy-apply" aria-label="Status check requested">
      <div className="ask-bar__strategy-review-head">
        <strong>Status check requested</strong>
        <span className="badge badge--muted">Handoff</span>
      </div>
      {platforms.map((platform) => {
        const eligible = Number(platform.eligible) || 0;
        const statusText = platform.allowed
          ? eligible > 0
            ? `Allowed, ${eligible} to check`
            : "Allowed"
          : "Off in Settings";
        return (
          <p key={platform.platform}>
            {[settingsPlatformLabel(platform.platform), statusText].filter(Boolean).join(" · ")}
          </p>
        );
      })}
      <p className="ask-bar__screening-note">
        Run the sync-status skill from your agent or terminal to read your job portals. Updates come
        back here for your review.
      </p>
    </section>
  );
}

// mail_sync_handoff (mail.sync-request intent, ingest-mail skill) — same
// acknowledgment shape as StatusSyncHandoffCard above: the request landed,
// the actual mail read happens in the agent/terminal skill run, not here.
const MAIL_SYNC_SOURCE_LABEL = {
  "apple-mail": "Apple Mail (this device)",
  "gmail-webmail": "Gmail",
  "outlook-webmail": "Outlook",
};
function mailSyncSourceLabel(source) {
  return MAIL_SYNC_SOURCE_LABEL[source.id] || settingsPlatformLabel(source.platform);
}
function mailSyncNeedsReplyLine(count) {
  const needsReply = Number(count) || 0;
  if (needsReply === 0) return "No email threads are waiting on a reply.";
  if (needsReply === 1) return "1 email thread is waiting on a reply.";
  return `${needsReply} email threads are waiting on a reply.`;
}
function MailSyncHandoffCard({ artifact }) {
  const sources = Array.isArray(artifact.sources) ? artifact.sources : [];
  return (
    <section className="ask-bar__strategy-apply" aria-label="Mail sync requested">
      <div className="ask-bar__strategy-review-head">
        <strong>Mail sync requested</strong>
        <span className="badge badge--muted">Handoff</span>
      </div>
      {sources.map((source) => {
        const statusText = [
          source.allowed ? null : "Off in Settings",
          source.lastRunAt
            ? `Last checked ${formatRelativeDate(source.lastRunAt)}`
            : "Never checked",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <p key={source.id}>
            {[mailSyncSourceLabel(source), statusText].filter(Boolean).join(" · ")}
          </p>
        );
      })}
      <p>{mailSyncNeedsReplyLine(artifact.needsReply)}</p>
      <p className="ask-bar__screening-note">
        Run the ingest-mail skill from your agent or terminal to read your mail. Updates come back
        here for your review.
      </p>
    </section>
  );
}

// messages_sync_handoff (messages.sync-request intent, ingest-messages skill)
// — same acknowledgment shape as MailSyncHandoffCard above: the request
// landed, the actual message read happens in the agent/terminal skill run,
// not here. needsReply is LinkedIn-scoped only: Wellfound threads share the
// portal channel with ATS messages, so they aren't counted here.
const MESSAGES_SYNC_SOURCE_LABEL = {
  "linkedin-messages": "LinkedIn",
  "wellfound-messages": "Wellfound",
};
function messagesSyncSourceLabel(source) {
  return MESSAGES_SYNC_SOURCE_LABEL[source.id] || settingsPlatformLabel(source.platform);
}
function messagesSyncNeedsReplyLine(count) {
  const needsReply = Number(count) || 0;
  if (needsReply === 0) return "No LinkedIn message threads are waiting on a reply.";
  if (needsReply === 1) return "1 LinkedIn message thread is waiting on a reply.";
  return `${needsReply} LinkedIn message threads are waiting on a reply.`;
}
function MessagesSyncHandoffCard({ artifact }) {
  const sources = Array.isArray(artifact.sources) ? artifact.sources : [];
  return (
    <section className="ask-bar__strategy-apply" aria-label="Message sync requested">
      <div className="ask-bar__strategy-review-head">
        <strong>Message sync requested</strong>
        <span className="badge badge--muted">Handoff</span>
      </div>
      {sources.map((source) => {
        const statusText = [
          source.allowed ? null : "Off in Settings",
          source.lastRunAt
            ? `Last checked ${formatRelativeDate(source.lastRunAt)}`
            : "Never checked",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <p key={source.id}>
            {[messagesSyncSourceLabel(source), statusText].filter(Boolean).join(" · ")}
          </p>
        );
      })}
      <p>{messagesSyncNeedsReplyLine(artifact.needsReply)}</p>
      <p className="ask-bar__screening-note">
        Run the ingest-messages skill from your agent or terminal to read your messages. Updates
        come back here for your review.
      </p>
    </section>
  );
}

// status_transition_proposal (sync-status skill) — a portal-read status that
// doesn't match a safe auto-apply rule, so it needs a candidate click before
// it lands in the tracker. Same review-card chrome as StrategyReviewCard's
// recommendation rows, badge--warn to match ScreeningAnswersCard/LeadReceiptCard's
// "needs your review" signal.
function StatusTransitionProposalCard({ artifact, onRunAction }) {
  const companyRole = [artifact.company, artifact.role].filter(Boolean).join(" at ");
  const canApply = typeof onRunAction === "function" && Boolean(artifact.to);
  return (
    <section className="ask-bar__strategy-apply" aria-label="Status update to review">
      <div className="ask-bar__strategy-review-head">
        <strong>Status update to review</strong>
        <span className="badge badge--warn">Review first</span>
      </div>
      {companyRole ? <p>{companyRole}</p> : null}
      <p>{`The portal shows "${artifact.rawStatus}".`}</p>
      <p>{`Tracked as ${artifact.from || "not started"}, proposed ${artifact.to}.`}</p>
      <p className="ask-bar__screening-note">
        {artifact.direction === "regress"
          ? "This is a step backward from where the application is tracked, so CareerRat won't record it without you."
          : "CareerRat isn't sure this matches a tracked stage, so it won't record it without you."}
      </p>
      {canApply ? (
        <Button
          variant="secondary"
          onClick={() =>
            onRunAction({
              label: "Apply status update",
              intent: {
                type: "status.apply-transition",
                entity: { type: "application", id: artifact.applicationId },
                input: {
                  from: artifact.from,
                  to: artifact.to,
                  rawStatus: artifact.rawStatus,
                  round: artifact.round,
                },
              },
            })
          }
        >
          Apply
        </Button>
      ) : null}
    </section>
  );
}

// status_transition_receipt (sync-status skill, via track-outcomes) — the
// outcome of an applied or skipped status transition. Same receipt chrome as
// CalendarWriteCard above, no left-edge accent.
function StatusTransitionReceiptCard({ artifact }) {
  const companyRole = [artifact.company, artifact.role].filter(Boolean).join(" at ");
  if (artifact.applied) {
    return (
      <section className="ask-bar__strategy-apply" aria-label="Status recorded">
        <div className="ask-bar__strategy-review-head">
          <strong>Status recorded</strong>
          <span className="badge badge--ok">Recorded</span>
        </div>
        {companyRole ? <p>{companyRole}</p> : null}
        <p>{`${artifact.from || "not started"} to ${artifact.to}`}</p>
        {artifact.rawStatus ? (
          <p className="ask-bar__screening-note">{`The portal shows "${artifact.rawStatus}".`}</p>
        ) : null}
      </section>
    );
  }
  if (!artifact.changed) {
    return (
      <section className="ask-bar__strategy-apply" aria-label="No change">
        <div className="ask-bar__strategy-review-head">
          <strong>No change</strong>
          <span className="badge badge--muted">No change</span>
        </div>
        {companyRole ? <p>{companyRole}</p> : null}
        <p className="ask-bar__screening-note">The portal matches what CareerRat already has.</p>
      </section>
    );
  }
  return null;
}

function screeningAnswerSourceLabel(source) {
  const labels = {
    screening_answers: "Reused a saved application answer",
    evidence: "Grounded in evidence",
    profile: "Grounded in profile",
    mixed: "Grounded in profile and evidence",
    "needs-you": "Needs your input",
  };
  return labels[source] || "Grounded in candidate context";
}

function ScreeningAnswersCard({ artifact }) {
  const answers = Array.isArray(artifact?.answers) ? artifact.answers : [];
  const excluded = Array.isArray(artifact?.excluded) ? artifact.excluded : [];
  return (
    <section className="ask-bar__screening-answers" aria-label="Screening answers">
      <div className="ask-bar__screening-head">
        <strong>{answers.length === 1 ? "Screening answer" : "Screening answers"}</strong>
        <span className="badge badge--warn">Review first</span>
      </div>
      {answers.map((answer, index) => (
        <article
          className="ask-bar__screening-answer"
          key={answer.key || answer.question || `answer-${index}`}
        >
          <strong>{answer.question}</strong>
          <p>{answer.answer}</p>
          <div className="ask-bar__screening-meta">
            <span>{screeningAnswerSourceLabel(answer.source)}</span>
            {answer.durable && answer.uploadReady ? (
              <span className="badge badge--muted">Reusable</span>
            ) : null}
          </div>
        </article>
      ))}
      {excluded.length ? (
        <p className="ask-bar__screening-note">
          CareerRat skipped {excluded.length} self-identification question
          {excluded.length === 1 ? "" : "s"}.
        </p>
      ) : null}
      <p className="ask-bar__screening-note">Nothing was submitted.</p>
    </section>
  );
}

function schedulingMissingLabel(values) {
  const rows = (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!rows.length) return "a little more scheduling context";
  if (rows.length === 1) return rows[0];
  return `${rows.slice(0, -1).join(", ")} and ${rows.at(-1)}`;
}

function safeSchedulingHold(hold) {
  const filename = String(hold?.filename || "").trim();
  const ics = String(hold?.ics || "");
  if (!/^[a-z0-9][a-z0-9._-]{0,119}\.ics$/i.test(filename)) return null;
  if (!ics.startsWith("BEGIN:VCALENDAR") || ics.length > 100_000) return null;
  return {
    filename,
    href: `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`,
  };
}

function SchedulingPlanCard({ artifact }) {
  const plan = artifact?.plan;
  const hold = safeSchedulingHold(artifact?.hold);
  const slots = Array.isArray(plan?.slots) ? plan.slots.slice(0, 6) : [];
  const needsUser = artifact?.status !== "ready" || !plan;
  return (
    <section className="ask-bar__scheduling-plan" aria-label="Interview scheduling plan">
      <div className="ask-bar__scheduling-head">
        <strong>{needsUser ? "Scheduling needs you" : "Scheduling reply ready"}</strong>
        <span className={`badge ${needsUser ? "badge--warn" : "badge--ok"}`}>
          {needsUser ? "Needs you" : "Review first"}
        </span>
      </div>
      <p className="ask-bar__scheduling-state">
        {artifact?.calendarChecked
          ? "Calendar conflicts checked"
          : "Calendar conflicts not checked"}
        {plan?.timezone ? ` · ${plan.timezone}` : ""}
      </p>
      {needsUser ? (
        <p>Needs your {schedulingMissingLabel(artifact?.missing)}.</p>
      ) : (
        <>
          {slots.length ? (
            <ul className="ask-bar__scheduling-slots">
              {slots.map((slot) => (
                <li key={`${slot.startIso || "slot"}:${slot.endIso || ""}`}>
                  {slot.label || slot.startIso}
                </li>
              ))}
            </ul>
          ) : null}
          {plan.subject ? (
            <strong className="ask-bar__scheduling-subject">{plan.subject}</strong>
          ) : null}
          {plan.body ? <p className="ask-bar__scheduling-draft">{plan.body}</p> : null}
          <p className="ask-bar__scheduling-state">Nothing has been sent or booked.</p>
          {hold ? (
            <a className="btn btn--secondary" href={hold.href} download={hold.filename}>
              Download tentative hold (.ics)
            </a>
          ) : null}
        </>
      )}
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
  const label = artifact.purpose === "tailoring" ? "Tailored documents" : "Application packet";
  return (
    <div className="ask-bar__packet-status">
      <strong>
        {label}: {artifact.uploadReady ? "ready" : artifact.status || "reviewable"}
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
