import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./app-shell/AppShell.jsx";
import { DashboardProvider } from "./app-shell/DashboardContext.jsx";
import { CalendarPage } from "./calendar/CalendarPage.jsx";
import { DeepIngestPage } from "./deep-ingest/DeepIngestPage.jsx";
import { JobsPage } from "./jobs/JobsPage.jsx";
import { getOnboardState } from "./lib/api.js";
import { LibraryPage } from "./library/LibraryPage.jsx";
import { NetworkPage } from "./network/NetworkPage.jsx";
import { OnboardingPage } from "./onboarding/OnboardingPage.jsx";
import { setupCanGraduate } from "./onboarding/onboardingSetup.js";
import { ComingSoonPage } from "./pages/ComingSoonPage.jsx";
import { DashboardPage } from "./pages/DashboardPage.jsx";
import { SettingsPage } from "./settings/SettingsPage.jsx";

// Static preview (screenshot pipeline, scripts/shot-*.mjs) serves a
// deliberately INCOMPLETE onboard state from src/preview/staticPreviewApi.js
// — the setup gate below must never apply there, or every preview screenshot
// would land on the onboarding screen instead of the page being shot.
const STATIC_PREVIEW = import.meta.env.VITE_STATIC_PREVIEW === "true";

// The setup gate's own state machine, tracked outside render so a stale
// "blocked" read for one path never gets reused as the answer for a
// different one:
//   - "checking": no confirmed answer yet for the current pathname — render
//     nothing rather than flash the gated page or bounce to /onboarding.
//   - "blocked": setup was confirmed incomplete for `forPath`. Only good for
//     a redirect while location.pathname still equals forPath; a pathname
//     change re-opens the question instead of trusting the stale read.
//   - "released": setup was confirmed complete at least once. Sticky for the
//     life of the mount — no more fetches, no more gating.
const CHECKING = { status: "checking", forPath: null };
const RELEASED = { status: "released", forPath: null };

// Canonical /app route map. Every normal product route lives in this React SPA,
// with data-backed pages served from the shared GET /api/data/dashboard snapshot
// through app-shell/DashboardContext.jsx.
//
// Setup gate: whenever GET /api/onboard/state reads incomplete, every route
// other than /onboarding itself redirects there instead of rendering a
// broken/empty page. See CHECKING/RELEASED above for the state machine and
// the module doc for the static-preview and fail-open carve-outs.
// Routes the gate must never redirect away from, because each one is itself a
// way to FINISH setup. /settings is the forms-based alternative to the chat
// interview — the onboarding hero links straight to it ("PREFER FORMS? OPEN
// THE CHECKLIST"), so gating it would bounce the one escape hatch for anyone
// who doesn't want to answer questions in chat right back to the chat.
const UNGATED_PATHS = new Set(["/settings"]);

export function App() {
  const location = useLocation();
  const onOnboarding = location.pathname === "/onboarding";
  const ungated = UNGATED_PATHS.has(location.pathname);

  const [gate, setGate] = useState(CHECKING);

  useEffect(() => {
    if (STATIC_PREVIEW) return;
    if (ungated) return;
    if (gate.status === "released") return;
    if (gate.status === "blocked" && gate.forPath === location.pathname) return;

    let cancelled = false;
    getOnboardState()
      .then((state) => {
        if (cancelled) return;
        setGate(
          setupCanGraduate(state) ? RELEASED : { status: "blocked", forPath: location.pathname }
        );
      })
      .catch(() => {
        // Fail open: a broken/restarting server must not trap an already
        // onboarded user in onboarding forever. Pages already have their own
        // no-database/error degrades.
        if (cancelled) return;
        setGate(RELEASED);
      });
    return () => {
      cancelled = true;
    };
  }, [location.pathname, gate.status, gate.forPath, ungated]);

  if (onOnboarding) {
    return (
      <DashboardProvider>
        <OnboardingPage />
      </DashboardProvider>
    );
  }

  if (!STATIC_PREVIEW && !ungated && gate.status !== "released") {
    if (gate.status === "blocked" && gate.forPath === location.pathname) {
      return <Navigate to="/onboarding" replace />;
    }
    // Still checking (or re-checking after a pathname change while blocked)
    // — never render the shell and then yank it out from under the user.
    return null;
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/network" element={<NetworkPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/deep-ingest" element={<DeepIngestPage />} />
        <Route
          path="*"
          element={<ComingSoonPage title="Not found" description="This page doesn't exist yet." />}
        />
      </Routes>
    </AppShell>
  );
}
