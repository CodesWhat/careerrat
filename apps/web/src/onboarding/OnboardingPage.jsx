import { useCallback, useEffect, useState } from "react";
import { PageScaffold } from "../components/PageScaffold.jsx";
import { InlineAlert, Toast } from "../components/Toast.jsx";
import { getOnboardState, getRuntimeConfig } from "../lib/api.js";
import { CompaniesStep } from "./steps/CompaniesStep.jsx";
import { FinishStep } from "./steps/FinishStep.jsx";
import { KeyStep } from "./steps/KeyStep.jsx";
import { PrefsStep } from "./steps/PrefsStep.jsx";
import { ResumeStep } from "./steps/ResumeStep.jsx";
import { TargetingStep } from "./steps/TargetingStep.jsx";
import { WelcomeStep } from "./steps/WelcomeStep.jsx";
import { WizardRail } from "./WizardRail.jsx";

// The 7 steps per the M8 design doc's wizard section. Each step component
// gets the same prop bag (state, runtimeCapabilities, aiEnabled, reload,
// goNext, goBack, showToast) whether or not it needs every one of them —
// one shape, no per-step prop-drilling puzzle. Completion (doneFlags below) is DERIVED
// from GET /api/onboard/state every time, never a separately-tracked
// "wizard progress" file — the wizard has no state of its own beyond "which
// step is focused right now," matching the "resumable via derived state"
// requirement in the build brief.
const STEPS = [
  { key: "welcome", label: "Welcome", Component: WelcomeStep },
  { key: "key", label: "AI key", Component: KeyStep },
  { key: "resume", label: "Resume", Component: ResumeStep },
  { key: "targeting", label: "Targeting", Component: TargetingStep },
  { key: "companies", label: "Companies", Component: CompaniesStep },
  { key: "prefs", label: "Prefs", Component: PrefsStep },
  { key: "finish", label: "Finish", Component: FinishStep },
];

function findFile(state, name) {
  return state?.files?.find((f) => f.name === name) ?? null;
}

function deriveDoneFlags(state) {
  if (!state) return STEPS.map(() => false);
  const targeting = state.data?.targeting ?? {};
  return [
    (state.files ?? []).some((f) => f.exists),
    !!state.keyConfigured,
    !!state.sourceResumePresent,
    (targeting.role_buckets ?? []).some((b) => (b.titles ?? []).length > 0),
    (targeting.tracked_companies ?? []).length > 0,
    !!findFile(state, "modes")?.valid,
    !!state.searchSourcesPresent,
  ];
}

// Resume at the first not-yet-done step on a fresh load (a returning user
// lands where they left off); every step stays reachable from the rail
// regardless, per WizardRail.jsx's own "always clickable" contract.
function computeInitialStep(state) {
  const doneFlags = deriveDoneFlags(state);
  const firstNotDone = doneFlags.findIndex((done) => !done);
  return firstNotDone === -1 ? STEPS.length - 1 : firstNotDone;
}

export async function refreshThenAdvance({ load, setStepIndex, stepCount }) {
  await load?.();
  setStepIndex((i) => Math.min(i + 1, stepCount - 1));
}

function stringList(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
}

function normalizeRuntimeError(err) {
  return err instanceof Error ? err : new Error("Runtime config unavailable");
}

export function deriveRuntimeCapabilities({ onboardState: _onboardState, runtimeConfig } = {}) {
  const skills = stringList(runtimeConfig?.skills);
  const chatSkills = stringList(runtimeConfig?.chatSkills);
  const aiAvailable = runtimeConfig?.ai?.available === true;
  const aiRoute = String(runtimeConfig?.ai?.route || "none").trim() || "none";
  const discovery = runtimeConfig?.discovery || {};

  return {
    aiAvailable,
    aiRoute: aiAvailable ? aiRoute : "none",
    companyProposals: discovery.companyProposals !== false,
    manualCompanySeeds: discovery.manualCompanySeeds !== false,
    discoveryChatHandoffs: aiAvailable && discovery.chatHandoffs === true,
    fullSkillRun: aiAvailable && skills.length > 0,
    skills,
    chatSkills,
  };
}

export async function loadOnboardingRuntimeState({
  getState = getOnboardState,
  getRuntime = getRuntimeConfig,
} = {}) {
  const state = await getState();
  let runtimeConfig = null;
  let runtimeError = null;

  try {
    runtimeConfig = await getRuntime();
  } catch (err) {
    runtimeError = normalizeRuntimeError(err);
  }

  return {
    state,
    runtimeConfig,
    runtimeCapabilities: deriveRuntimeCapabilities({ onboardState: state, runtimeConfig }),
    runtimeError,
  };
}

export function OnboardingPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [state, setState] = useState(null);
  const [runtimeCapabilities, setRuntimeCapabilities] = useState(() => deriveRuntimeCapabilities());
  const [stepIndex, setStepIndex] = useState(0);
  const [hasPositioned, setHasPositioned] = useState(false);
  const [toast, setToast] = useState(null);
  const [draftSeeds, setDraftSeeds] = useState({});

  const load = useCallback(async () => {
    try {
      const next = await loadOnboardingRuntimeState();
      setState(next.state);
      setRuntimeCapabilities(next.runtimeCapabilities);
      setLoadError(next.runtimeError?.message || null);
      if (!hasPositioned) {
        setStepIndex(computeInitialStep(next.state));
        setHasPositioned(true);
      }
      return next.state;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load onboarding state");
      return null;
    }
  }, [hasPositioned]);

  // Mount-only initial load — `load` itself is stable via useCallback and
  // re-runs are triggered explicitly by step components calling `reload()`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only load
  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, []);

  function showToast(message, tone = "success") {
    setToast({ message, tone });
    setTimeout(() => setToast(null), 4000);
  }

  function goNext() {
    void refreshThenAdvance({ load, setStepIndex, stepCount: STEPS.length });
  }
  function goBack() {
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  if (loading) {
    return (
      <PageScaffold title="Onboarding">
        <p>Loading…</p>
      </PageScaffold>
    );
  }

  const doneFlags = deriveDoneFlags(state);
  const { Component } = STEPS[stepIndex];
  const aiEnabled = runtimeCapabilities.aiAvailable;

  return (
    <PageScaffold
      title="Onboarding"
      subtitle="Seven quick steps to build your SQLite-backed profile, targeting, preferences, and search setup."
      actions={
        toast ? (
          <Toast message={toast.message} tone={toast.tone} onDismiss={() => setToast(null)} />
        ) : null
      }
    >
      {loadError ? <InlineAlert message={loadError} /> : null}
      <div style={{ marginBottom: 16 }}>
        <WizardRail
          steps={STEPS}
          activeIndex={stepIndex}
          doneFlags={doneFlags}
          onSelect={setStepIndex}
        />
      </div>
      <Component
        state={state}
        draftSeeds={draftSeeds}
        setDraftSeeds={setDraftSeeds}
        runtimeCapabilities={runtimeCapabilities}
        aiEnabled={aiEnabled}
        reload={load}
        goNext={goNext}
        goBack={goBack}
        showToast={showToast}
      />
    </PageScaffold>
  );
}
