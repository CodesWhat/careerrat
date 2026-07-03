import { useState } from "react";
import { Button } from "../components/Button.jsx";
import { TextArea } from "../components/form.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { closeChat, sendChatMessage, startChat } from "../lib/api.js";
import { useEventSource } from "../lib/sse.js";

// ChatPanel — an embedded live-transcript chat session over the existing
// chat runtime (src/cli/chat-route.mjs). Ported from
// src/core/onboarding/chat-page.mjs's own extractAssistantText/wireEvents
// pattern to React (assistant/tool_use/tool_result/chat_state/error SSE
// frames), not a new protocol.
//
// DEVIATION FROM THE M8 DESIGN DOC'S "accept/reject chips" framing (noted
// here per the build brief's own instruction to call this out loudly): the
// discover-companies skill does not yet emit a parseable fenced-JSON summary
// alongside its human-readable table (the design doc flagged that as
// "optional for v1, not committed" — and it wasn't, in the committed M8
// backend). Parsing row-level accept/reject chips out of free-form assistant
// prose would be unreliable and isn't something this build should invent by
// changing the skill. This panel instead ships the documented fallback in
// its fuller form: a real embedded session (start/stream/reply/close) where
// confirm-first happens through natural language in the same panel, rather
// than dropping the panel entirely for a bare "continue in /chat" link.
// Functionally equivalent (the skill's own STEP 4 confirm-first gate still
// runs, unchanged), just not chip-shaped.
//
// `initialChatId` (M9 addition) — when the caller already knows a live
// session exists (the Inbox's Lane-C confirm: src/cli/intake-route.mjs's
// executeLaneC already called chatRuntime.startSession/postMessage
// server-side and handed the resulting chatId back on the confirmed intake
// item), the panel skips its own "Start"-button/startChat() call entirely
// and subscribes straight to that session's SSE stream. Every existing
// caller (CompaniesStep's "Ask Roland to find companies") omits this prop
// and keeps its original start-from-scratch behavior unchanged.
export function ChatPanel({ skill, kickoffLabel, initialChatId = null }) {
  const [chatId, setChatId] = useState(initialChatId);
  const [chatState, setChatState] = useState(initialChatId ? "running" : null);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");
  const [starting, setStarting] = useState(false);
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
      const text = extractAssistantText(data);
      if (text) setMessages((m) => [...m, { role: "assistant", text }]);
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
        setError(err?.body?.error || (err instanceof Error ? err.message : "Could not start"));
      }
    } finally {
      setStarting(false);
    }
  }

  async function handleSend() {
    const text = inputText.trim();
    if (!text || !chatId) return;
    setInputText("");
    setMessages((m) => [...m, { role: "user", text }]);
    try {
      await sendChatMessage(chatId, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Message failed to send");
    }
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

  if (!chatId) {
    return (
      <div className="chat-panel">
        {error ? <InlineAlert message={error} /> : null}
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

  return (
    <div className="chat-panel">
      {error ? <InlineAlert message={error} /> : null}
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
              {m.text}
            </div>
          )
        )}
      </div>
      <div className="chat-input-row">
        <TextArea
          value={inputText}
          onChange={setInputText}
          rows={2}
          placeholder="Reply to Roland…"
          disabled={busy}
        />
        <Button onClick={handleSend} disabled={busy || !inputText.trim()}>
          Send
        </Button>
      </div>
      <div className="wizard-actions">
        <span className="field__hint">{statusText}</span>
        <Button variant="secondary" onClick={handleClose}>
          End session
        </Button>
      </div>
    </div>
  );
}
