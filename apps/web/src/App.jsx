import { Route, Routes } from "react-router-dom";
import { AppShell } from "./app-shell/AppShell.jsx";
import { CalendarPage } from "./calendar/CalendarPage.jsx";
import { InboxPage } from "./inbox/InboxPage.jsx";
import { JobsPage } from "./jobs/JobsPage.jsx";
import { LibraryPage } from "./library/LibraryPage.jsx";
import { NetworkPage } from "./network/NetworkPage.jsx";
import { OnboardingPage } from "./onboarding/OnboardingPage.jsx";
import { ComingSoonPage } from "./pages/ComingSoonPage.jsx";
import { HomePage } from "./pages/HomePage.jsx";
import { SettingsPage } from "./settings/SettingsPage.jsx";

// Route map. "/", "/settings", "/onboarding", (M9) "/inbox", (M10)
// "/jobs"/"/calendar", and now "/network"/"/library" are all real pages,
// every one served off the shared GET /api/data/dashboard snapshot (see
// app-shell/DashboardContext.jsx). The legacy dashboard (`/tracker`) remains
// reachable via the nav's Classic link until the retirement gates clear
// (Sankey + demo bundle still render there).
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
        <Route path="/network" element={<NetworkPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route
          path="*"
          element={<ComingSoonPage title="Not found" description="This page doesn't exist yet." />}
        />
      </Routes>
    </AppShell>
  );
}
