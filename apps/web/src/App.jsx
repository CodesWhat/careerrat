import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ChatFirstApp } from "./chat-first/ChatFirstApp.jsx";
import { DashboardProvider } from "./chat-first/dashboard-context.jsx";
import { FirstRunController } from "./chat-first/FirstRunController.jsx";
import { ProfileSettingsController } from "./chat-first/ProfileSettingsController.jsx";
import { getOnboardState } from "./lib/api.js";
import { setupCanGraduate } from "./onboarding/onboardingSetup.js";

const CHECKING = { status: "checking", forPath: null };
const RELEASED = { status: "released", forPath: null };
const UNGATED_PATHS = new Set(["/settings"]);

export function App() {
  const location = useLocation();
  const ungated = UNGATED_PATHS.has(location.pathname);
  const [gate, setGate] = useState(CHECKING);

  useEffect(() => {
    if (ungated || gate.status === "released") return;
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
        if (!cancelled) setGate({ status: "blocked", forPath: location.pathname });
      });
    return () => {
      cancelled = true;
    };
  }, [gate.forPath, gate.status, location.pathname, ungated]);

  if (!ungated && gate.status === "checking") return null;
  if (!ungated && gate.status === "blocked") {
    return <FirstRunController inWorkspace onComplete={() => setGate(RELEASED)} />;
  }

  return (
    <DashboardProvider>
      <Routes>
        <Route path="/" element={<ChatFirstApp />} />
        <Route path="/settings" element={<ProfileSettingsController />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </DashboardProvider>
  );
}
