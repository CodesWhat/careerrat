import { useState } from "react";
import { Button } from "../components/Button.jsx";
import { TextArea } from "../components/form.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { addBoard, closeChat, saveCompanyBoard, sendChatMessage, startChat } from "../lib/api.js";
import { errorState, withRetryAction } from "../lib/errorCopy.js";
import { useEventSource } from "../lib/sse.js";
import { renderChatMarkdown } from "./chatMarkdown.jsx";
import { parseDiscoveryBlocks } from "./discoveryBlocks.js";

// ChatPanel — an embedded live-transcript chat session over the existing
// chat runtime (src/cli/chat-route.mjs). Ported from
// src/core/onboarding/chat-page.mjs's own extractAssistantText/wireEvents
// pattern to React (assistant/tool_use/tool_result/chat_state/error SSE
// frames), not a new protocol.
//
// Discovery skills emit typed proposal blocks alongside readable prose. Those
// blocks become explicit Add/Track/Skip controls here, and the controls call
// the existing validated source APIs instead of treating chat prose as a write.
//
// `initialChatId` (M9 addition) — when the caller already knows a live
// session exists (the Inbox's Lane-C confirm: src/cli/intake-route.mjs's
// executeLaneC already called chatRuntime.startSession/postMessage
// server-side and handed the resulting chatId back on the confirmed intake
// item), the panel skips its own "Start"-button/startChat() call entirely
// and subscribes straight to that session's SSE stream. Every existing
// callers that omit this prop keep the original start-from-scratch behavior
// unchanged.
export function ChatPanel({
  skill,
  kickoffLabel,
  initialChatId = null,
  completionLabel = null,
  onComplete = null,
}) {
  const [chatId, setChatId] = useState(initialChatId);
  const [chatState, setChatState] = useState(initialChatId ? "running" : null);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");
  const [starting, setStarting] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState(null);

  function extractAssistantText(data) {
    const content = data?.message?.content;
    if (!Array.isArray(content) || !content.length) return "";
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }

  function handleEvent(type, raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (type === "assistant") {
      const raw = extractAssistantText(data);
      if (raw) {
        const { text, blocks } = parseDiscoveryBlocks(raw);
        if (text || blocks.length) {
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              text,
              blocks: blocks.map((block) =>
                block.kind.endsWith("_proposal") ? { ...block, status: "pending" } : block
              ),
            },
          ]);
        }
      }
    } else if (type === "tool_use") {
      setMessages((m) => [...m, { role: "activity", text: `tool: ${data?.name || "unknown"}` }]);
    } else if (type === "tool_result") {
      setMessages((m) => [
        ...m,
        { role: "activity", text: `result: ${data?.isError ? "error" : "ok"}` },
      ]);
    } else if (type === "chat_state") {
      if (data?.state) setChatState(data.state);
    } else if (type === "error") {
      setError(data?.message || "The session reported an error.");
    }
  }

  useEventSource(chatId ? `/api/chat/events?id=${encodeURIComponent(chatId)}` : null, {
    types: ["assistant", "tool_use", "tool_result", "chat_state", "error"],
    onEvent: handleEvent,
    enabled: !!chatId,
  });

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      const session = await startChat(skill);
      setChatId(session.chatId);
      setChatState(session.state);
    } catch (err) {
      if (err?.status === 409 && err.body?.chatId) {
        // A live session for this skill already exists — reconnect to it
        // rather than erroring (mirrors chat-page.mjs's own resume path).
        setChatId(err.body.chatId);
        setChatState("running");
      } else {
        setError(withRetryAction(errorState(err, "Could not start"), handleStart));
      }
    } finally {
      setStarting(false);
    }
  }

  // Same shape as InterviewSurface.jsx's own sendMessageWithErrorHandling —
  // a dedicated helper (rather than inlining the catch in handleSend) so the
  // retry callback can re-post the exact text that failed.
  async function sendMessageWithErrorHandling(id, text) {
    // Cleared here (not just by handleSend) so a retry click — this same
    // function, wired as the error's action.onRetry — doesn't leave a stale
    // banner showing through a successful resend.
    setError(null);
    try {
      await sendChatMessage(id, text);
    } catch (err) {
      setError(
        withRetryAction(errorState(err, "Message failed to send."), () =>
          sendMessageWithErrorHandling(id, text)
        )
      );
    }
  }

  async function handleSend() {
    const text = inputText.trim();
    if (!text || !chatId) return;
    setInputText("");
    setMessages((m) => [...m, { role: "user", text }]);
    await sendMessageWithErrorHandling(chatId, text);
  }

  async function handleClose() {
    if (chatId) {
      try {
        await closeChat(chatId);
      } catch {
        // best-effort — clear local state regardless
      }
    }
    setChatId(null);
    setChatState(null);
    setMessages([]);
  }

  function updateProposal(messageIndex, blockIndex, patch) {
    setMessages((current) =>
      current.map((message, index) =>
        index !== messageIndex
          ? message
          : {
              ...message,
              blocks: message.blocks.map((block, candidateIndex) =>
                candidateIndex === blockIndex ? { ...block, ...patch } : block
              ),
            }
      )
    );
  }

  async function decideProposal(messageIndex, blockIndex, block, decision) {
    if (decision === "skip") {
      updateProposal(messageIndex, blockIndex, { status: "resolved", result: "Skipped" });
      return;
    }
    updateProposal(messageIndex, blockIndex, { status: "saving", error: null });
    try {
      if (block.kind === "source_proposal") {
        await addBoard({ label: block.label, url: block.url });
        updateProposal(messageIndex, blockIndex, { status: "resolved", result: "Added" });
      } else {
        await saveCompanyBoard({ name: block.name, url: block.url, enabled: true });
        updateProposal(messageIndex, blockIndex, { status: "resolved", result: "Tracked" });
      }
    } catch (err) {
      updateProposal(messageIndex, blockIndex, {
        status: "error",
        error: errorState(err, "Save failed.").message,
      });
    }
  }

  async function handleComplete() {
    if (!onComplete) return;
    setCompleting(true);
    setError(null);
    try {
      await onComplete({ skill });
      await closeChat(chatId).catch(() => {});
    } catch (err) {
      setError(withRetryAction(errorState(err, "Could not continue discovery."), handleComplete));
    } finally {
      setCompleting(false);
    }
  }

  if (!chatId) {
    return (
      <div className="chat-panel">
        {error ? (
          <InlineAlert message={error.message} action={error.action} detail={error.detail} />
        ) : null}
        <Button variant="secondary" onClick={handleStart} disabled={starting}>
          {starting ? "Starting…" : kickoffLabel}
        </Button>
      </div>
    );
  }

  const busy = chatState === "running" || chatState === "closed";
  const statusText =
    chatState === "running"
      ? "Thinking…"
      : chatState === "closed"
        ? "Session ended"
        : "Waiting for your reply";
  const proposalBlocks = messages
    .flatMap((message) => message.blocks || [])
    .filter((block) => block.kind?.endsWith("_proposal"));
  const hasCompletionMarker = messages.some((message) =>
    (message.blocks || []).some(
      (block) => block.kind === "discovery_complete" && block.step === skill
    )
  );
  const proposalsResolved = proposalBlocks.every((block) => block.status === "resolved");
  const canComplete =
    Boolean(onComplete && completionLabel && hasCompletionMarker) &&
    proposalsResolved &&
    chatState === "idle";

  return (
    <div className="chat-panel">
      {error ? (
        <InlineAlert message={error.message} action={error.action} detail={error.detail} />
      ) : null}
      <div className="chat-transcript">
        {messages.map((m, i) =>
          m.role === "activity" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript log
            <div key={i} className="chat-activity-line">
              {m.text}
            </div>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript log
            <div key={i} className={`chat-bubble chat-bubble--${m.role}`}>
              {m.text ? (
                <div className="chat-bubble__content">{renderChatMarkdown(m.text)}</div>
              ) : null}
              {(m.blocks || []).map((block, blockIndex) =>
                block.kind.endsWith("_proposal") ? (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: model turn blocks are append-only
                    key={blockIndex}
                    className="chat-proposal"
                  >
                    <strong>{block.kind === "source_proposal" ? block.label : block.name}</strong>
                    {block.why ? <span>{block.why}</span> : null}
                    <a href={block.url} target="_blank" rel="noreferrer">
                      Review source
                    </a>
                    {block.status === "resolved" ? (
                      <span>{block.result}</span>
                    ) : (
                      <div className="chat-proposal__actions">
                        <Button
                          onClick={() => decideProposal(i, blockIndex, block, "add")}
                          disabled={block.status === "saving"}
                        >
                          {block.kind === "source_proposal" ? "Add source" : "Track company"}
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => decideProposal(i, blockIndex, block, "skip")}
                          disabled={block.status === "saving"}
                        >
                          Skip
                        </Button>
                        {block.error ? <span>{block.error}</span> : null}
                      </div>
                    )}
                  </div>
                ) : null
              )}
            </div>
          )
        )}
      </div>
      <div className="chat-input-row">
        <TextArea
          value={inputText}
          onChange={setInputText}
          rows={2}
          placeholder="Reply to CareerRat…"
          disabled={busy}
        />
        <Button onClick={handleSend} disabled={busy || !inputText.trim()}>
          Send
        </Button>
      </div>
      <div className="wizard-actions">
        <span className="field__hint">{statusText}</span>
        {canComplete ? (
          <Button onClick={handleComplete} disabled={completing}>
            {completing ? "Continuing…" : completionLabel}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={handleClose}>
          End session
        </Button>
      </div>
    </div>
  );
}
