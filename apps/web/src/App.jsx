import { Route, Routes } from "react-router-dom";
import { AppShell } from "./app-shell/AppShell.jsx";
import { ComingSoonPage } from "./pages/ComingSoonPage.jsx";
import { HomePage } from "./pages/HomePage.jsx";
import { SettingsPage } from "./settings/SettingsPage.jsx";

// M7 route map. Only "/" and "/settings" are real M7 deliverables — the rest
// are working stub pages for the M8-M10 route map (see the M7 design memo's
// route migration table), landed now so the left nav never links to a 404.
export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route
          path="/onboarding"
          element={
            <ComingSoonPage
              title="Onboarding"
              milestone="M8"
              description="A guided key → resume drop → suggestion wizard replaces the legacy /onboard + /chat pages here."
            />
          }
        />
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
