import { Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./app-shell/AppShell.jsx";
import { DashboardProvider } from "./app-shell/DashboardContext.jsx";
import { CalendarPage } from "./calendar/CalendarPage.jsx";
import { DeepIngestPage } from "./deep-ingest/DeepIngestPage.jsx";
import { JobsPage } from "./jobs/JobsPage.jsx";
import { LibraryPage } from "./library/LibraryPage.jsx";
import { NetworkPage } from "./network/NetworkPage.jsx";
import { OnboardingPage } from "./onboarding/OnboardingPage.jsx";
import { ComingSoonPage } from "./pages/ComingSoonPage.jsx";
import { DashboardPage } from "./pages/DashboardPage.jsx";
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
