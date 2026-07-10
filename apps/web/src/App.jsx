import { Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./app-shell/AppShell.jsx";
import { DashboardProvider } from "./app-shell/DashboardContext.jsx";
import { CalendarPage } from "./calendar/CalendarPage.jsx";
import { CalendarV2Page } from "./calendar/CalendarV2Page.jsx";
import { CalendarV3Page } from "./calendar/CalendarV3Page.jsx";
import { InboxPage } from "./inbox/InboxPage.jsx";
import { JobsPage } from "./jobs/JobsPage.jsx";
import { JobsV2Page } from "./jobs/JobsV2Page.jsx";
import { JobsV3Page } from "./jobs/JobsV3Page.jsx";
import { LibraryPage } from "./library/LibraryPage.jsx";
import { LibraryV2Page } from "./library/LibraryV2Page.jsx";
import { LibraryV3Page } from "./library/LibraryV3Page.jsx";
import { NetworkPage } from "./network/NetworkPage.jsx";
import { NetworkV2Page } from "./network/NetworkV2Page.jsx";
import { NetworkV3Page } from "./network/NetworkV3Page.jsx";
import { OnboardingPage } from "./onboarding/OnboardingPage.jsx";
import { ComingSoonPage } from "./pages/ComingSoonPage.jsx";
import { DashboardV2Page } from "./pages/DashboardV2Page.jsx";
import { SettingsPage } from "./settings/SettingsPage.jsx";

// Canonical /app route map. Every normal product route lives in this React SPA,
// with data-backed pages served from the shared GET /api/data/dashboard snapshot
// through app-shell/DashboardContext.jsx.
export function App() {
  const location = useLocation();

  if (location.pathname === "/onboarding") {
    return (
      <DashboardProvider>
        <OnboardingPage />
      </DashboardProvider>
    );
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardV2Page />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/jobs-v2" element={<JobsV2Page />} />
        <Route path="/jobs-v3" element={<JobsV3Page />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/calendar-v2" element={<CalendarV2Page />} />
        <Route path="/calendar-v3" element={<CalendarV3Page />} />
        <Route path="/network" element={<NetworkPage />} />
        <Route path="/network-v2" element={<NetworkV2Page />} />
        <Route path="/network-v3" element={<NetworkV3Page />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/library-v2" element={<LibraryV2Page />} />
        <Route path="/library-v3" element={<LibraryV3Page />} />
        <Route
          path="*"
          element={<ComingSoonPage title="Not found" description="This page doesn't exist yet." />}
        />
      </Routes>
    </AppShell>
  );
}
