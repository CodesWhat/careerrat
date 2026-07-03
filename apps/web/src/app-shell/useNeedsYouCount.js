// apps/web/src/app-shell/useNeedsYouCount.js — the live count behind the
// /inbox nav item's badge (NavList.jsx). Per the M9 decisions memo, this is
// deliberately NOT routed through the existing Activity-Pulse-derived CTA
// system — a needs_you intake item is pre-domain data (see
// src/core/db/verbs/intake.mjs's own header comment), so it gets this small
// nav-local poll instead of teaching the CTA system a second, intake-shaped
// source of truth.
//
// Polls GET /api/intake/list?status=needs_you on an interval (catches
// server-side transitions the client didn't cause itself — e.g. a Lane B/C
// confirm resolving in the background) and also re-fetches immediately on
// any local intake mutation via intake-events.js's pub/sub, so confirming or
// dismissing an item updates the badge without waiting out the interval.
import { useEffect, useState } from "react";
import { listIntake } from "../lib/api.js";
import { subscribeIntakeChanged } from "../lib/intake-events.js";

const POLL_MS = 15000;
// No-DB / legacy workspaces and no-key AI-degrade both still resolve this
// list fine (list is a plain read, and needs_you rows are captured
// regardless of AI availability) — a fetch failure here (no DB at all) just
// leaves the badge silently at 0 rather than erroring the whole nav.
const LIST_LIMIT = 100;

export function useNeedsYouCount() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const { items } = await listIntake({ status: "needs_you", limit: LIST_LIMIT });
        if (!cancelled) setCount(items.length);
      } catch {
        if (!cancelled) setCount(0);
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

  return count;
}
