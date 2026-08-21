import { isTerminalActionMessage } from "./ask-terminal.js";

// apps/web/src/app-shell/ask-rehydrate.js
//
// G-09: the workspace thread already survives a reload server-side (see
// src/core/agent/workspace-thread.mjs — GET /api/workspace/thread returns
// every persisted message), but AskBar.jsx used to mount with its own
// `turn` state as a bare `useState(null)` — nothing ever read the thread
// back in, so a completed result card and its follow-up actions vanished
// the moment the page reloaded even though the server never lost them.
//
// This is the pure decision logic AskBar's mount effect uses to rebuild a
// `turn` object from the persisted messages, shaped exactly like the object
// commitAction/commitAnswer (AskBar.jsx) leave behind once a live turn
// finishes — so the same render branches, and the same onRunAction ->
// commitAction wiring for follow-up actions, work whether the turn just
// finished live or was rehydrated from a past session.
//
// Only a turn that's actually DONE gets rehydrated. A turn still running
// server-side (a search action's action_result with searchTerminal: false
// and no later completion message yet) or one that ended in an error is
// left alone — the bar keeps mounting empty for those, same as it did
// before this fix, rather than faking a result the server never produced
// or silently discarding a failure.
//
// The server writes the user-side half of a turn (workspaceIntentAppend —
// workspace-agent.mjs:2312 — or the bare user text append at :7455) BEFORE
// it produces the result. A reload landing in that exact window leaves the
// thread's literal last message as a dangling, unanswered user/intent
// record — that's not a fresh turn to skip past, it's mid-flight work
// hiding the genuinely completed turn one message earlier. See
// isDanglingUserRecord below for how that gets stepped over.

function isFromOnboardingImport(message) {
  // workspaceOnboardingHandoff (workspace-thread.mjs) imports the onboarding
  // transcript into this same thread as ordinary role:user/assistant kind:text
  // messages. If nothing has used Ask since, those are the newest messages in
  // the thread — but they're the onboarding chat, not an Ask turn, so they
  // never count as "the last completed turn".
  return message?.metadata?.source === "onboarding";
}

// A user-side record the server always appends before doing any work: a
// typed intent (workspaceIntentAppend, kind: "intent") or a bare free-text
// query (kind: "text", role: "user") before its reply lands. If either one
// is still literally the last message in the thread, the matching
// result/reply hasn't been appended yet — the server is either still
// working, or was interrupted before it could.
function isDanglingUserRecord(message) {
  if (message?.role !== "user") return false;
  return message.kind === "intent" || message.kind === "text";
}

function actionTurnFromResult(last, messages) {
  if (!isTerminalActionMessage(last)) return null; // still running server-side
  const intentMessage = last.metadata?.intentMessageId
    ? messages.find((message) => message.id === last.metadata.intentMessageId)
    : null;
  return {
    kind: "action",
    status: "done",
    label: intentMessage?.text || null,
    startedAt: null,
    elapsedMs: typeof last.metadata?.elapsedMs === "number" ? last.metadata.elapsedMs : null,
    engine: last.metadata?.engine || null,
    resultText: last.text || null,
    error: null,
    noEngine: false,
    // Reused verbatim as commitAction's own `action` argument if a follow-up
    // card's Apply/Track/Skip button ends up retried — same shape a live
    // preview.action carries (label + intent.type/entity/input).
    request:
      intentMessage?.intent && Object.keys(intentMessage.intent).length
        ? { label: intentMessage.text || null, intent: intentMessage.intent }
        : null,
    retryable: false,
    artifacts: last.artifacts || [],
    metadata: last.metadata || {},
  };
}

function answerTurnFromReply(last, messages) {
  const userMessage = messages.find(
    (message) =>
      message.sequence === last.sequence - 1 &&
      message.role === "user" &&
      !isFromOnboardingImport(message)
  );
  return {
    kind: "answer",
    status: "done",
    label: userMessage?.text || null,
    startedAt: null,
    elapsedMs: typeof last.metadata?.elapsedMs === "number" ? last.metadata.elapsedMs : null,
    engine: last.metadata?.engine || null,
    resultText: last.text || null,
    error: null,
    noEngine: false,
    request: { text: userMessage?.text || "", preview: null },
    retryable: false,
  };
}

// Returns an AskBar `turn` ready to render as already-done, or null when the
// thread is empty or its last message isn't a completed Ask turn (an
// in-progress action, a failed action/answer, an onboarding-imported
// message, or anything else that isn't the terminal half of an
// action/answer pair).
export function deriveLastCompletedTurn(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  let last = messages[messages.length - 1];
  let scope = messages;

  if (isDanglingUserRecord(last)) {
    // Step back exactly one message and evaluate it with the same logic
    // below, same as any other candidate last message. One step is the
    // designed limit: two dangling user/intent records back to back means
    // an earlier turn never got its result either (a crash mid-turn, or a
    // second request fired before the first resolved) — genuinely unclear
    // state, and an empty mount is the safe failure, not a guess about which
    // still-earlier message was really "last completed".
    const previous = messages[messages.length - 2];
    if (!previous || isDanglingUserRecord(previous)) return null;
    last = previous;
    scope = messages.slice(0, -1);
  }

  if (!last || isFromOnboardingImport(last)) return null;
  if (last.kind === "action_result") return actionTurnFromResult(last, scope);
  if (last.kind === "text" && last.role === "assistant") return answerTurnFromReply(last, scope);
  return null;
}
