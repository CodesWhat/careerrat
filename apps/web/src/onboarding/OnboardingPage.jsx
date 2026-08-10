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
// page uses. Landing rule (server-owned): it auto-selects only an
// unambiguous exactly-one-ready runtime; two or more ready lands on the
// picker (3f) instead of silently choosing one, so this component renders a
// screen for the 0-ready (gate) and 1+-ready-but-unresolved (picker) cases —
// the exactly-one case resolves itself before this ever renders anything but
// a brief loading state.
//
// Engine re-entry (forceEngineScreen): once in the interview, InterviewSurface's
// ENGINE chip (after its own confirm dialog) can ask to revisit this gate
// without losing setup progress — see handleRequestEngineScreen below. This
// flag layers on top of `phase` rather than replacing it: phase stays
// "interview" the whole time, so turning it back off just re-renders
// InterviewSurface exactly where it left off.
export function OnboardingPage() {
  const [phase, setPhase] = useState("loading");
  const [runtimeState, setRuntimeState] = useState(null);
  const [forceEngineScreen, setForceEngineScreen] = useState(false);

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
    setForceEngineScreen(false);
    setPhase("interview");
  }

  // Re-entry "keep current" — no API call at all, so a user who opened the
  // engine screen by mistake (or just wanted to check) loses nothing: not
  // the interview transcript's session, not a single setup answer, and not
  // an engine write. See EngineScreen's own "KEEP <CURRENT>" footer action.
  function handleEngineBack() {
    setForceEngineScreen(false);
  }

  function handleRequestEngineScreen() {
    setForceEngineScreen(true);
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

  if (forceEngineScreen) {
    return <EngineScreen mode="revisit" onReady={handleEngineReady} onBack={handleEngineBack} />;
  }

  const selectedRuntime = (runtimeState?.runtimes ?? []).find(
    (r) => r.id === runtimeState?.selectedId
  );
  return (
    <InterviewSurface runtime={selectedRuntime} onRequestEngineScreen={handleRequestEngineScreen} />
  );
}
