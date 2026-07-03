import { Route, Routes } from "react-router-dom";
import { AppShell } from "./app-shell/AppShell.jsx";
import { InboxPage } from "./inbox/InboxPage.jsx";
import { OnboardingPage } from "./onboarding/OnboardingPage.jsx";
import { ComingSoonPage } from "./pages/ComingSoonPage.jsx";
import { HomePage } from "./pages/HomePage.jsx";
import { SettingsPage } from "./settings/SettingsPage.jsx";

// M7/M8/M9 route map. "/", "/settings", "/onboarding", and (M9) "/inbox" are
// real deliverables now — /jobs, /library, /calendar remain working stub
// pages for the M10 route map (see the M7 design memo's route migration
// table), landed now so the left nav never links to a 404. /inbox ships now
// rather than waiting on M10 because the docked capture bar (AppShell.jsx)
// needs somewhere real to hand its queue off to.
export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route
          path="/jobs"
          element={
            <ComingSoonPage
              title="Jobs"
              milestone="M10"
              description="Tracker views on the SQLite data layer (src/cli/data-route.mjs) land here."
            />
          }
        />
        <Route
          path="/library"
          element={
            <ComingSoonPage
              title="Library"
              milestone="M10"
              description="The full evidence + story bank browser lands here."
            />
          }
        />
        <Route
          path="/calendar"
          element={
            <ComingSoonPage
              title="Calendar"
              milestone="M10"
              description="Interview, assessment, and follow-up scheduling views land here."
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
