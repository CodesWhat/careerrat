// apps/web/src/app-shell/useNeedsYouCount.js — the live feed behind AskBar's
// NEEDS-YOU chip (../app-shell/AskBar.jsx). Originally written for the /inbox
// nav badge (M9), repurposed for Lane B universal intake: /inbox is retired
// as a destination, so this is now the only surface that shows pending
// needs_you intake items — it carries the full item list (not just a count)
// so the chip can expand inline with the same Confirm/Reclassify/Dismiss
// actions AskBar's own capture receipt uses.
//
// Polls GET /api/intake/list?status=needs_you on an interval (catches
// server-side transitions the client didn't cause itself — e.g. a Lane B/C
// confirm resolving in the background) and also re-fetches immediately on
// any local intake mutation via intake-events.js's pub/sub, so confirming or
// dismissing an item updates the chip without waiting out the interval.
import { useEffect, useState } from "react";
import { listIntake } from "../lib/api.js";
import { subscribeIntakeChanged } from "../lib/intake-events.js";

const POLL_MS = 15000;
// No-DB / legacy workspaces and no-key AI-degrade both still resolve this
// list fine (list is a plain read, and needs_you rows are captured
// regardless of AI availability) — a fetch failure here (no DB at all) just
// leaves the chip silently hidden rather than erroring the whole bar.
const LIST_LIMIT = 100;

export function useNeedsYouCount() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const { items: fetched } = await listIntake({ status: "needs_you", limit: LIST_LIMIT });
        if (!cancelled) setItems(fetched);
      } catch {
        if (!cancelled) setItems([]);
      }
    }

    refresh();
    const unsubscribe = subscribeIntakeChanged(refresh);
    const interval = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(interval);
    };
  }, []);

  return { items, count: items.length };
}
