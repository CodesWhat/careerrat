import { useEffect, useRef } from "react";

// A single document-level keydown listener for a ⌘-key/Ctrl-key combo — used
// by app-shell/AskBar.jsx to focus the ask bar from anywhere in the app
// (⌘K/Ctrl+K). Deliberately the only global keydown listener in this
// codebase: every other keydown handler (CaptureBar's old textarea handler,
// ActivityBell's Escape-to-close) stays scoped to its own element or an
// already-open popover, never `document` — a global listener for an ordinary
// key would leak into every text input elsewhere in the app. A single-letter
// combo tied to a modifier key doesn't have that problem.
//
// `onTrigger` is read through a ref so callers can pass an inline arrow
// function without re-subscribing the listener on every render.
export function useGlobalShortcut(key, onTrigger) {
  const handlerRef = useRef(onTrigger);
  useEffect(() => {
    handlerRef.current = onTrigger;
  });

  useEffect(() => {
    const targetKey = String(key || "").toLowerCase();
    if (!targetKey) return undefined;

    function handleKeyDown(event) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== targetKey) return;
      event.preventDefault();
      handlerRef.current?.(event);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [key]);
}
