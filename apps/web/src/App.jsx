import { Route, Routes } from "react-router-dom";
import { AppShell } from "./app-shell/AppShell.jsx";
import { CalendarPage } from "./calendar/CalendarPage.jsx";
import { InboxPage } from "./inbox/InboxPage.jsx";
import { JobsPage } from "./jobs/JobsPage.jsx";
import { OnboardingPage } from "./onboarding/OnboardingPage.jsx";
import { ComingSoonPage } from "./pages/ComingSoonPage.jsx";
import { HomePage } from "./pages/HomePage.jsx";
import { SettingsPage } from "./settings/SettingsPage.jsx";

// M7-M10 route map. "/", "/settings", "/onboarding", (M9) "/inbox", and (M10)
// "/jobs"/"/calendar" are all real pages now, every one served off the shared
// GET /api/data/dashboard snapshot (see app-shell/DashboardContext.jsx).
// "/library" stays a route here only as a safety net for a stale bookmark —
// NavList.jsx's own Library nav item is now a genuine external link to the
// legacy dashboard (`/tracker`), not this stub (M10 design doc §1: Network
// and Library are legacy-only, occasional-use reference tools, not part of
// the weekly loop this milestone ships).
export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route
          path="/library"
          element={
            <ComingSoonPage
              title="Library"
              description="The full evidence + story bank browser lives in the legacy dashboard for now — open it at /tracker."
            />
          }
        />
        <Route
          path="*"
          element={<ComingSoonPage title="Not found" description="This page doesn't exist yet." />}
        />
      </Routes>
    </AppShell>
  );
}
