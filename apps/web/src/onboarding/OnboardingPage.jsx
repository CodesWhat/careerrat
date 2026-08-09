import { useEffect, useState } from "react";
import { getInstalledAiRuntimes } from "../lib/api.js";
import { EngineScreen } from "./EngineScreen.jsx";
import { InterviewSurface } from "./InterviewSurface.jsx";

// OnboardingPage — W4's chat-first onboarding entry point. Replaces the old
// 8-step form wizard entirely (OnboardingShell/WizardRail/steps/* deleted;
// their editor internals were ported into FilePane.jsx's inline editors, per
// the W4 spec). Own chrome, mounted outside AppShell — see App.jsx's
// `location.pathname === "/onboarding"` branch, unchanged by this rewrite.
//
// Engine gate (design frames 3f/3d): probe on entry via the same
// GET /api/settings/ai-runtimes inspectInstalledRuntimeState() the Settings
// page uses. It already auto-selects a lone ready runtime server-side, so
// this component only ever has to render a screen for the 0-ready (gate) and
// 2+-ready (picker) cases — the exactly-one case resolves itself before this
// ever renders anything but a brief loading state.
export function OnboardingPage() {
  const [phase, setPhase] = useState("loading");
  const [runtimeState, setRuntimeState] = useState(null);

  async function loadEngineState() {
    setPhase("loading");
    try {
      const next = await getInstalledAiRuntimes();
      setRuntimeState(next);
      const selected = (next.runtimes ?? []).find(
        (r) => r.id === next.selectedId && !next.providerFallback
      );
      if (selected) {
        setPhase("interview");
        return;
      }
      const readyCount = (next.runtimes ?? []).filter((r) => r.ready).length;
      setPhase(readyCount === 0 ? "gate" : "picker");
    } catch {
      // A probe failure shouldn't strand the user — fall through to the
      // gate screen, which has its own re-run-probe affordance.
      setRuntimeState({ selectedId: null, providerFallback: false, runtimes: [] });
      setPhase("gate");
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only load
  useEffect(() => {
    void loadEngineState();
  }, []);

  // The engine screen's own CTA (Continue / Start the interview) is the
  // explicit user action that unlocks the interview — it always proceeds
  // once pressed, even from the 3d gate with nothing actually selected
  // (nothing here hard-gates app routes; a still-missing engine surfaces as
  // a recoverable inline error the moment InterviewSurface tries to start
  // the chat, not as a screen loop back to this gate).
  async function handleEngineReady() {
    try {
      setRuntimeState(await getInstalledAiRuntimes());
    } catch {
      // Best-effort refresh only — proceed regardless.
    }
    setPhase("interview");
  }

  if (phase === "loading") {
    return (
      <div className="onboarding-app">
        <div className="onboarding-loading">Checking this computer…</div>
      </div>
    );
  }

  if (phase === "gate" || phase === "picker") {
    return <EngineScreen mode={phase} onReady={handleEngineReady} />;
  }

  const selectedRuntime = (runtimeState?.runtimes ?? []).find(
    (r) => r.id === runtimeState?.selectedId
  );
  return <InterviewSurface runtime={selectedRuntime} />;
}
