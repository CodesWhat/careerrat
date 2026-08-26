import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ChatFirstApp } from "./chat-first/ChatFirstApp.jsx";
import { DashboardProvider } from "./chat-first/dashboard-context.jsx";
import { FirstRunController } from "./chat-first/FirstRunController.jsx";
import { ProfileSettingsController } from "./chat-first/ProfileSettingsController.jsx";
import { finishOnboarding, getOnboardState } from "./lib/api.js";
import { setupCanRelease } from "./onboarding/onboardingSetup.js";

const CHECKING = { status: "checking", forPath: null };
const RELEASED = { status: "released", forPath: null };
const UNGATED_PATHS = new Set(["/settings"]);

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const ungated = UNGATED_PATHS.has(location.pathname);
  const [gate, setGate] = useState(CHECKING);
  const [workspaceMounted, setWorkspaceMounted] = useState(false);

  useEffect(() => {
    const desktop = globalThis.careerratDesktopApp;
    if (!desktop?.onNavigate) return undefined;
    return desktop.onNavigate((route) => navigate(route));
  }, [navigate]);

  useEffect(() => {
    if (ungated || gate.status === "released") return;
    if (gate.status === "blocked" && gate.forPath === location.pathname) return;

    let cancelled = false;
    getOnboardState()
      .then(async (state) => {
        if (cancelled) return;
        if (setupCanRelease(state)) {
          const completion = await finishOnboarding();
          if (cancelled) return;
          setWorkspaceMounted(true);
          setGate(RELEASED);
          if (completion?.handoff?.reused === false) {
            navigate("/", {
              replace: true,
              state: { browse: "search", onboardingComplete: true },
            });
          }
        } else {
          setGate({ status: "blocked", forPath: location.pathname, onboardState: state });
        }
      })
      .catch(() => {
        if (!cancelled) setGate({ status: "blocked", forPath: location.pathname });
      });
    return () => {
      cancelled = true;
    };
  }, [gate.forPath, gate.status, location.pathname, navigate, ungated]);

  if (!ungated && gate.status === "checking") return null;
  if (!ungated && gate.status === "blocked") {
    return (
      <FirstRunController
        inWorkspace
        initialOnboardState={gate.onboardState}
        onComplete={() => {
          setWorkspaceMounted(true);
          setGate(RELEASED);
          navigate("/", {
            replace: true,
            state: { browse: "search", onboardingComplete: true },
          });
        }}
      />
    );
  }

  return (
    <DashboardProvider>
      {workspaceMounted && gate.status === "released" ? (
        <div hidden={location.pathname !== "/"}>
          <ChatFirstApp />
        </div>
      ) : null}
      <Routes>
        <Route path="/" element={null} />
        <Route path="/settings" element={<ProfileSettingsController />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </DashboardProvider>
  );
}
