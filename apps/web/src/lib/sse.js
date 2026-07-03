// apps/web/src/lib/sse.js — React-friendly wrappers around this codebase's
// two existing, deliberate SSE client patterns:
//   - GET SSE endpoints (e.g. /api/chat/events) → native EventSource. See
//     src/core/onboarding/chat-page.mjs's own header comment: "GET
//     /api/chat/events is a plain GET — so this page uses the browser's
//     native EventSource."
//   - POST SSE endpoints (e.g. /api/skill/run) → fetch() +
//     response.body.getReader() + TextDecoder, hand-parsing
//     "event: <type>\ndata: <json>\n\n" frames split on "\n\n". See
//     src/core/ai/evaluate-page.mjs / answer-page.mjs / packet-page.mjs, all
//     with the same header comment: "EventSource can't POST, so the client
//     hand-parses…".
//
// M7 itself has no SSE consumer (Settings is plain request/response) — this
// lands now because M8's onboarding wizard and M9's intake dock both will,
// and the framing logic isn't worth writing a third time.

import { useEffect, useRef } from "react";

// GET SSE endpoints. Only named events the caller lists in `types` are
// subscribed (plus the unnamed "message" event); onEvent(type, rawData) is
// called for each.
export function useEventSource(url, { types = [], onEvent, enabled = true } = {}) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // `types` is a caller-provided literal array; re-subscribing per render is
  // wasteful and not needed for M8/M9's fixed event-name lists.
  // biome-ignore lint/correctness/useExhaustiveDependencies: types is stable
  useEffect(() => {
    if (!enabled || !url) return undefined;
    const es = new EventSource(url);
    const handler = (event) => onEventRef.current?.(event.type, event.data);
    es.addEventListener("message", handler);
    for (const type of types) es.addEventListener(type, handler);
    es.onerror = () => {
      /* EventSource auto-reconnects on its own; nothing extra to do here */
    };
    return () => {
      es.removeEventListener("message", handler);
      for (const type of types) es.removeEventListener(type, handler);
      es.close();
    };
  }, [url, enabled]);
}

// POST SSE endpoints. Resolves once the stream ends; onEvent(type, data) is
// called per frame (data is JSON-parsed when it parses, else the raw string).
export async function postSSE(url, body, { onEvent, signal } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`postSSE ${url} failed: ${res.status} ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      if (!frame.trim()) continue;
      const eventMatch = frame.match(/^event:\s*(.*)$/m);
      const dataMatch = frame.match(/^data:\s*(.*)$/m);
      const type = eventMatch?.[1]?.trim() || "message";
      const raw = dataMatch?.[1] ?? "";
      let data = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        /* not JSON — pass the raw string through as-is */
      }
      onEvent?.(type, data);
    }
  }
}
