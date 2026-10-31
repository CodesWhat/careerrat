import { Route, Routes, useLocation } from "react-router-dom";
import { DashboardProvider } from "./chat-first/dashboard-context.jsx";
import { ProfileSettingsController } from "./chat-first/ProfileSettingsController.jsx";
import { DashboardApp } from "./dashboard/DashboardApp.jsx";
import { App as LegacyWorkspace } from "./LegacyWorkspace.jsx";

export function App() {
  const { pathname } = useLocation();
  if (pathname === "/conversation") return <LegacyWorkspace homePath="/conversation" />;
  return (
    <DashboardProvider>
      <Routes>
        <Route path="/settings" element={<ProfileSettingsController />} />
        <Route path="*" element={<DashboardApp />} />
      </Routes>
    </DashboardProvider>
  );
}
