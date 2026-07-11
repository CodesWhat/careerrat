import { useCallback, useEffect, useState } from "react";
import { useRolesterUser } from "../auth/clerkControls.jsx";
import { PageScaffold } from "../components/PageScaffold.jsx";
import { InlineAlert, Toast } from "../components/Toast.jsx";
import {
  getOnboardingDraft,
  getOnboardState,
  getRuntimeConfig,
  saveOnboardingDraft,
} from "../lib/api.js";
import { OnboardingCompletionProvider } from "./OnboardingShell.jsx";
import { CompaniesStep } from "./steps/CompaniesStep.jsx";
import { FinishStep } from "./steps/FinishStep.jsx";
import { GuardrailsStep } from "./steps/GuardrailsStep.jsx";
import { KeyStep } from "./steps/KeyStep.jsx";
import { PrefsStep } from "./steps/PrefsStep.jsx";
import { ResumeStep } from "./steps/ResumeStep.jsx";
import { TargetingStep } from "./steps/TargetingStep.jsx";
import { WelcomeStep } from "./steps/WelcomeStep.jsx";
import { WizardRail } from "./WizardRail.jsx";

// The 8 steps per the current onboarding flow. Each step component
// gets the same prop bag (state, runtimeCapabilities, aiEnabled, reload,
// goNext, goBack, showToast) whether or not it needs every one of them —
// one shape, no per-step prop-drilling puzzle. Completion (doneFlags below) is
// still DERIVED from GET /api/onboard/state; the separate draft route only
// preserves UI-only wizard focus and unsaved seeds across app restarts.
const STEPS = [
  { key: "welcome", label: "Welcome", Component: WelcomeStep, fullBleed: true },
  { key: "account", label: "Account", Component: KeyStep, fullBleed: true },
  { key: "resume", label: "Resume", Component: ResumeStep, fullBleed: true },
  { key: "targeting", label: "Targeting", Component: TargetingStep, fullBleed: true },
  { key: "companies", label: "Companies", Component: CompaniesStep, fullBleed: true },
  { key: "guardrails", label: "Guardrails", Component: GuardrailsStep, fullBleed: true },
  { key: "prefs", label: "Quick facts", Component: PrefsStep, fullBleed: true },
  { key: "finish", label: "Finish", Component: FinishStep, fullBleed: true },
];

function findFile(state, name) {
  return state?.files?.find((f) => f.name === name) ?? null;
}

function deriveDoneFlags(state, { isSignedIn = false } = {}) {
  if (!state) return STEPS.map(() => false);
  const targeting = state.data?.targeting ?? {};
  return [
    (state.files ?? []).some((f) => f.exists),
    !!isSignedIn,
    !!state.sourceResumePresent,
    (targeting.role_buckets ?? []).some((b) => (b.titles ?? []).length > 0),
    (targeting.tracked_companies ?? []).length > 0,
    (targeting.cut_signals ?? []).length > 0,
    !!findFile(state, "modes")?.valid,
    !!state.searchSourcesPresent,
  ];
}

function doneFlagIndexes(doneFlags, { stepCount = STEPS.length } = {}) {
  return (Array.isArray(doneFlags) ? doneFlags : [])
    .map((done, index) => (done ? index : null))
    .filter((index) => index !== null && index < stepCount);
}

function previousStepIndexes(stepIndex, { stepCount = STEPS.length } = {}) {
  const maxStep = Math.max(0, stepCount - 1);
  const numericStep = Number(stepIndex);
  const focusedStep = Number.isFinite(numericStep)
    ? Math.max(0, Math.min(maxStep, Math.trunc(numericStep)))
    : 0;
  return Array.from({ length: focusedStep }, (_, index) => index);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeOnboardingDraft(raw = {}, { stepCount = STEPS.length } = {}) {
  const numericStep = Number(raw?.stepIndex);
  const maxStep = Math.max(0, stepCount - 1);
  const stepIndex = Number.isFinite(numericStep)
    ? Math.max(0, Math.min(maxStep, Math.trunc(numericStep)))
    : 0;
  return {
    stepIndex,
    completedIndexes: normalizeCompletedIndexes(raw?.completedIndexes, { stepCount }),
    draftSeeds: isPlainObject(raw?.draftSeeds) ? raw.draftSeeds : {},
    updatedAt: typeof raw?.updatedAt === "string" && raw.updatedAt.trim() ? raw.updatedAt : null,
  };
}

export function normalizeCompletedIndexes(values = [], { stepCount = STEPS.length } = {}) {
  const maxStep = Math.max(0, stepCount - 1);
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value >= 0)
        .map((value) => Math.min(maxStep, Math.trunc(value)))
    )
  ).sort((a, b) => a - b);
}

// Fresh visits still start on the welcome screen; a stored draft means the
// user already entered the flow, so restore the focused step.
export function resolveInitialStep({ draft, stepCount = STEPS.length } = {}) {
  return normalizeOnboardingDraft(draft, { stepCount }).stepIndex;
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
  getDraft = getOnboardingDraft,
} = {}) {
  const state = await getState();
  let runtimeConfig = null;
  let runtimeError = null;
  let onboardingDraft = normalizeOnboardingDraft();

  try {
    runtimeConfig = await getRuntime();
  } catch (err) {
    runtimeError = normalizeRuntimeError(err);
  }

  try {
    const draftEnvelope = await getDraft();
    onboardingDraft = normalizeOnboardingDraft(draftEnvelope?.draft ?? draftEnvelope);
  } catch {
    onboardingDraft = normalizeOnboardingDraft();
  }

  return {
    state,
    runtimeConfig,
    onboardingDraft,
    runtimeCapabilities: deriveRuntimeCapabilities({ onboardState: state, runtimeConfig }),
    runtimeError,
  };
}

export function OnboardingPage() {
  const { isSignedIn } = useRolesterUser();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [state, setState] = useState(null);
  const [runtimeCapabilities, setRuntimeCapabilities] = useState(() => deriveRuntimeCapabilities());
  const [stepIndex, setStepIndex] = useState(0);
  const [hasPositioned, setHasPositioned] = useState(false);
  const [toast, setToast] = useState(null);
  const [draftSeeds, setDraftSeeds] = useState({});
  const [completedIndexes, setCompletedIndexes] = useState([]);

  const load = useCallback(async () => {
    try {
      const next = await loadOnboardingRuntimeState();
      setState(next.state);
      setRuntimeCapabilities(next.runtimeCapabilities);
      setLoadError(next.runtimeError?.message || null);
      const stateDoneIndexes = doneFlagIndexes(deriveDoneFlags(next.state, { isSignedIn }), {
        stepCount: STEPS.length,
      });
      if (!hasPositioned) {
        setDraftSeeds(next.onboardingDraft.draftSeeds);
        const initialStepIndex = resolveInitialStep({
          state: next.state,
          draft: next.onboardingDraft,
        });
        setStepIndex(initialStepIndex);
        setCompletedIndexes(
          normalizeCompletedIndexes(
            [
              ...previousStepIndexes(initialStepIndex, { stepCount: STEPS.length }),
              ...next.onboardingDraft.completedIndexes,
              ...stateDoneIndexes,
            ],
            { stepCount: STEPS.length }
          )
        );
        setHasPositioned(true);
      } else {
        setCompletedIndexes((current) =>
          normalizeCompletedIndexes([...current, ...stateDoneIndexes], { stepCount: STEPS.length })
        );
      }
      return next.state;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load onboarding state");
      return null;
    }
  }, [hasPositioned, isSignedIn]);

  // Mount-only initial load — `load` itself is stable via useCallback and
  // re-runs are triggered explicitly by step components calling `reload()`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only load
  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!hasPositioned || loading) return;
    void saveOnboardingDraft({ stepIndex, completedIndexes, draftSeeds }).catch(() => {
      /* best-effort durability; saving core candidate data still uses step routes */
    });
  }, [hasPositioned, loading, stepIndex, completedIndexes, draftSeeds]);

  function showToast(message, tone = "success") {
    setToast({ message, tone });
    setTimeout(() => setToast(null), 4000);
  }

  function goNext() {
    setCompletedIndexes((current) =>
      normalizeCompletedIndexes([...current, stepIndex], { stepCount: STEPS.length })
    );
    void refreshThenAdvance({ load, setStepIndex, stepCount: STEPS.length });
  }
  function goBack() {
    setStepIndex((i) => Math.max(i - 1, 0));
  }
  function goToCompletedStep(index) {
    const completedSet = new Set(completedIndexes);
    setStepIndex((current) => {
      const target = Math.max(0, Math.min(Number(index) || 0, STEPS.length - 1));
      return target < current || completedSet.has(target) ? target : current;
    });
  }

  if (loading) {
    return <WelcomeStep goNext={() => {}} loading />;
  }

  const { Component, fullBleed } = STEPS[stepIndex];
  const aiEnabled = runtimeCapabilities.aiAvailable;
  const completionIndexesForShell = normalizeCompletedIndexes(
    [
      ...completedIndexes,
      ...doneFlagIndexes(deriveDoneFlags(state, { isSignedIn }), { stepCount: STEPS.length }),
    ],
    { stepCount: STEPS.length }
  );
  const stepProps = {
    state,
    draftSeeds,
    setDraftSeeds,
    runtimeCapabilities,
    aiEnabled,
    reload: load,
    goNext,
    goBack,
    onProgressSelect: goToCompletedStep,
    showToast,
  };

  if (fullBleed) {
    return (
      <OnboardingCompletionProvider completedIndexes={completionIndexesForShell}>
        <Component {...stepProps} />
      </OnboardingCompletionProvider>
    );
  }

  const doneFlags = deriveDoneFlags(state, { isSignedIn });

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
      <OnboardingCompletionProvider completedIndexes={completionIndexesForShell}>
        <Component {...stepProps} />
      </OnboardingCompletionProvider>
    </PageScaffold>
  );
}
