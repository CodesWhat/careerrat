// The chat-first workspace's shared GET /api/data/dashboard snapshot. One
// provider feeds the workspace so every conversation and browser surface
// reads the same local state.
//
// NEVER re-derive CTA/focus/calendar/job-action rules from this data —
// every field here is already the exact output of buildDashboardViewModel
// (src/core/tracker/dashboard-data.js), reused unmodified server-side
// (src/cli/dashboard-route.mjs). Consumers render fields, they don't
// recompute them.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiError, getDashboard } from "../lib/api.js";
import { resolveErrorCopy } from "../lib/errorCopy.js";
import { useEventSource } from "../lib/sse.js";

const POLL_MS = 10000;

const DashboardCtx = createContext(null);

export function DashboardProvider({ children }) {
  return <LiveDashboardProvider>{children}</LiveDashboardProvider>;
}

function LiveDashboardProvider({ children }) {
  const [data, setData] = useState(null);
  const [setup, setSetup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [noDatabase, setNoDatabase] = useState(false);
  const inFlight = useRef(false);
  const noDatabaseRef = useRef(false);
  // A re-entrant load() call (e.g. an SSE event arriving mid-fetch) latches
  // one pending refresh instead of being dropped — otherwise the response
  // already in flight when the write happened could commit stale data over
  // the newer one, and the UI would sit stale until the next POLL_MS tick.
  // One latch, not a queue: any number of re-entrant calls while in flight
  // collapse into a single follow-up load().
  const pendingReload = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) {
      pendingReload.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const { data: viewModel, setup: setupPayload } = await getDashboard();
      setData(viewModel);
      setSetup(setupPayload ?? null);
      setError(null);
      setNoDatabase(false);
      noDatabaseRef.current = false;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Fail-closed no-DB degrade (decision 7, same contract as every other
        // /api/data/* route) — an honest hint, not a generic error banner.
        setNoDatabase(true);
        noDatabaseRef.current = true;
        setError(null);
      } else {
        // Keep raw technical detail available without showing it as the main
        // workspace error. `load` is the retry for a failed dashboard fetch.
        const resolved = resolveErrorCopy(err);
        setError(
          resolved.action?.retry
            ? { ...resolved, action: { ...resolved.action, onRetry: load } }
            : resolved
        );
      }
    } finally {
      setLoading(false);
      inFlight.current = false;
      if (pendingReload.current) {
        pendingReload.current = false;
        load();
      }
    }
  }, []);

  useEffect(() => {
    load();
    // While the server reports no database (fresh install still in
    // onboarding), a 10s poll just streams 409s into the console. Probe every
    // 10th tick instead; server events and direct refetch() calls still recover
    // immediately.
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
      if (noDatabaseRef.current && ticks % 10 !== 0) return;
      load();
    }, POLL_MS);
    return () => {
      clearInterval(interval);
    };
  }, [load]);

  // The dev server already broadcasts tracker-update/activity-update over
  // /__livereload (src/cli/tracker-dev.mjs) whenever workspace/tracker.json
  // or workspace/activity.jsonl changes on disk — a CLI/agent write, not
  // just an in-app one. Without this, an open tab only picked those up on
  // the next POLL_MS tick (up to 10s stale); this closes that gap the same
  // way direct refetch() does for in-app writes. The interval above stays as
  // the fallback for a dropped
  // connection — EventSource reconnects on its own, but a page open through
  // a proxy that buffers SSE would otherwise go stale silently.
  useEventSource("/__livereload", {
    types: ["tracker-update", "activity-update"],
    onEvent: load,
  });

  return (
    <DashboardCtx.Provider value={{ data, setup, loading, error, noDatabase, refetch: load }}>
      {children}
    </DashboardCtx.Provider>
  );
}

// Throws if used outside DashboardProvider. That is a wiring bug, not a
// degrade case to handle silently.
export function useDashboardSnapshot() {
  const ctx = useContext(DashboardCtx);
  if (!ctx) throw new Error("useDashboardSnapshot() must be used inside <DashboardProvider>");
  return ctx;
}
