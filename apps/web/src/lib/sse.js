// React-friendly wrapper for GET SSE endpoints such as /api/chat/events.

import { useEffect, useRef } from "react";

// GET SSE endpoints. Only named events the caller lists in `types` are
// subscribed (plus the unnamed "message" event); onEvent(type, rawData,
// metadata) is called for each. metadata.lastEventId is the browser's stable
// SSE identity and lets consumers reconcile a reconnect with persisted UI.
export function useEventSource(url, { types = [], onEvent, enabled = true } = {}) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // `types` is a caller-provided literal array; re-subscribing per render is
  // wasteful and not needed for M8/M9's fixed event-name lists.
  // biome-ignore lint/correctness/useExhaustiveDependencies: types is stable
  useEffect(() => {
    if (!enabled || !url) return undefined;
    const es = new EventSource(url);
    const handler = (event) =>
      onEventRef.current?.(event.type, event.data, {
        lastEventId: event.lastEventId || null,
      });
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
