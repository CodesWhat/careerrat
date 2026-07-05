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

// Canonical /app route map. Every normal product route lives in this React SPA,
// with data-backed pages served from the shared GET /api/data/dashboard snapshot
// through app-shell/DashboardContext.jsx.
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
