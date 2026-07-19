// apps/web/src/app-shell/DashboardContext.jsx — the M10 shared
// GET /api/data/dashboard snapshot. One instance, mounted once in AppShell.jsx
// (same "cross-cutting chrome, mounted once" precedent as the docked
// CaptureBar and NavList's needsYouCount badge — see the M10 design doc §2
// point 4), so Home/Jobs/Calendar and the header activity bell all read the
// SAME poll rather than each opening an independent one against a local
// single-user server.
//
// NEVER re-derive CTA/focus/calendar/job-action rules from this data —
// every field here is already the exact output of buildDashboardViewModel
// (src/core/tracker/dashboard-data.js), reused unmodified server-side
// (src/cli/dashboard-route.mjs). Consumers render fields, they don't
// recompute them.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { PREVIEW_MOCK_DATA } from "../design/previewMockData.js";
import { ApiError, getDashboard } from "../lib/api.js";
import { subscribeDashboardChanged } from "../lib/dashboard-events.js";
import { subscribeIntakeChanged } from "../lib/intake-events.js";
import { DASHBOARD_PREVIEW } from "../pages/dashboardPreviewData.js";

// Matches InboxPage's own POLL_MS convention (8-15s band per the M10 design
// doc §2 point 4).
const POLL_MS = 10000;

const DashboardCtx = createContext(null);
const STATIC_PREVIEW_VIEW_MODEL =
  import.meta.env.VITE_STATIC_PREVIEW === "true"
    ? {
        ...DASHBOARD_PREVIEW,
        activity: PREVIEW_MOCK_DATA.dashboard.activity.map((item, index) => ({
          id: `preview-activity-${index}`,
          relTime: item.time,
          summary: item.source,
          title: item.event,
          type: "update",
        })),
        v3: PREVIEW_MOCK_DATA,
      }
    : null;

// A complete-looking readiness shape (every flag true, nothing missing) so
// preview mode never surfaces SetupReadinessCard — it self-hides once
// isComplete(setup) is true, same as a real fully-onboarded candidate.
const STATIC_PREVIEW_SETUP = {
  readiness: {
    search_ready: true,
    gate_ready: true,
    apply_ready: true,
    deep_ingest_complete: true,
  },
  missing: {
    search_ready: [],
    gate_ready: [],
    apply_ready: [],
    deep_ingest_complete: [],
  },
};

export function DashboardProvider({ children }) {
  if (STATIC_PREVIEW_VIEW_MODEL) {
    return <StaticDashboardProvider>{children}</StaticDashboardProvider>;
  }

  return <LiveDashboardProvider>{children}</LiveDashboardProvider>;
}

function StaticDashboardProvider({ children }) {
  return (
    <DashboardCtx.Provider
      value={{
        data: STATIC_PREVIEW_VIEW_MODEL,
        setup: STATIC_PREVIEW_SETUP,
        error: null,
        loading: false,
        noDatabase: false,
        refetch: () => Promise.resolve(STATIC_PREVIEW_VIEW_MODEL),
      }}
    >
      {children}
    </DashboardCtx.Provider>
  );
}

function LiveDashboardProvider({ children }) {
  const [data, setData] = useState(null);
  const [setup, setSetup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [noDatabase, setNoDatabase] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const { data: viewModel, setup: setupPayload } = await getDashboard();
      setData(viewModel);
      setSetup(setupPayload ?? null);
      setError(null);
      setNoDatabase(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Fail-closed no-DB degrade (decision 7, same contract as every other
        // /api/data/* route) — an honest hint, not a generic error banner.
        setNoDatabase(true);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : "Failed to load the dashboard");
      }
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    load();
    // A drawer write calls refetch() directly (immediate), but also fires
    // emitDashboardChanged() — this covers any OTHER mounted DashboardProvider-
    // dependent component reacting to a change it didn't itself cause. Lane-A
    // intake confirms (e.g. an app_set_status dispatch) can also mutate
    // application state without going through a drawer write at all, so this
    // also refetches on any intake-queue change.
    const unsubDashboard = subscribeDashboardChanged(load);
    const unsubIntake = subscribeIntakeChanged(load);
    const interval = setInterval(load, POLL_MS);
    return () => {
      unsubDashboard();
      unsubIntake();
      clearInterval(interval);
    };
  }, [load]);

  return (
    <DashboardCtx.Provider value={{ data, setup, loading, error, noDatabase, refetch: load }}>
      {children}
    </DashboardCtx.Provider>
  );
}

// Throws if used outside DashboardProvider — a real bug (a route mounted
// outside AppShell), not a degrade case to handle silently.
export function useDashboardSnapshot() {
  const ctx = useContext(DashboardCtx);
  if (!ctx) throw new Error("useDashboardSnapshot() must be used inside <DashboardProvider>");
  return ctx;
}
