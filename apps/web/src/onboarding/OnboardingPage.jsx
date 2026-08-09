import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
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

// Steps whose completion IS the visit — welcome, account (sign-in is
// currently optional), quick facts, and finish never get a data-derived done
// flag from deriveDoneFlags, so a Continue click is the only signal they have.
// Data steps (resume, targeting, companies, guardrails) must only go green
// when deriveDoneFlags finds real data — never merely from being visited —
// so they are deliberately excluded here.
const VISIT_COMPLETE_STEPS = new Set([0, 1, 6, 7]);

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
    // modes is scaffold-valid from workspace init, so file validity can't
    // signal completion here — Quick facts only completes via explicit goNext.
    false,
    !!state.searchSourcesPresent,
  ];
}

function doneFlagIndexes(doneFlags, { stepCount = STEPS.length } = {}) {
  return (Array.isArray(doneFlags) ? doneFlags : [])
    .map((done, index) => (done ? index : null))
    .filter((index) => index !== null && index < stepCount);
}

// The set of pills that should render as complete: durable visit-completions
// unioned with whatever deriveDoneFlags can prove from real data right now.
// Shared by render (completionIndexesForShell) and pill-jump eligibility
// (goToCompletedStep) so a genuinely-done data step is always reachable even
// if it never went through goNext.
function unionCompletedIndexes({ completedIndexes, state, isSignedIn }) {
  return normalizeCompletedIndexes(
    [
      ...completedIndexes,
      ...doneFlagIndexes(deriveDoneFlags(state, { isSignedIn }), { stepCount: STEPS.length }),
    ],
    { stepCount: STEPS.length }
  );
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
  const [searchParams] = useSearchParams();
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
        const stepParam = searchParams.get("step");
        const stepParamIndex = STEPS.findIndex((s) => s.key === stepParam);
        setStepIndex(stepParamIndex >= 0 ? stepParamIndex : initialStepIndex);
        // Self-heal stale drafts: an older build could persist a data-step
        // index (resume/targeting/companies/guardrails) into completedIndexes
        // just from a Continue click. Drop anything outside
        // VISIT_COMPLETE_STEPS here so a phantom completion never resurrects
        // — stateDoneIndexes below still lights those pills up honestly when
        // the data is actually present.
        const trustedDraftCompletedIndexes = next.onboardingDraft.completedIndexes.filter((index) =>
          VISIT_COMPLETE_STEPS.has(index)
        );
        setCompletedIndexes(
          normalizeCompletedIndexes([...trustedDraftCompletedIndexes, ...stateDoneIndexes], {
            stepCount: STEPS.length,
          })
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
  }, [hasPositioned, isSignedIn, searchParams]);

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
    // Structural guard, ahead of anything step-local: neither the account
    // step nor the resume step may advance without their hard prerequisite,
    // regardless of what a step component's own Continue button did or
    // didn't check — a step-local disabled button is UX, this is the gate.
    const currentStepKey = STEPS[stepIndex].key;
    // An installed signed-in CLI, managed AI, or an explicit Advanced
    // provider fallback can satisfy this gate. Account sign-in alone cannot.
    if (currentStepKey === "account" && !runtimeCapabilities.aiAvailable) {
      showToast(
        "Choose a signed-in AI tool on this computer, or configure an Advanced provider fallback",
        "error"
      );
      return;
    }
    if (currentStepKey === "resume" && !state?.sourceResumePresent) {
      showToast("Import your résumé to continue — Rolester builds every document from it", "error");
      return;
    }
    // Only visit-complete steps get marked done just for being clicked
    // through. Data steps earn their pill from deriveDoneFlags instead (see
    // completionIndexesForShell / unionCompletedIndexes) so an empty
    // targeting/companies/guardrails step never shows green.
    if (VISIT_COMPLETE_STEPS.has(stepIndex)) {
      setCompletedIndexes((current) =>
        normalizeCompletedIndexes([...current, stepIndex], { stepCount: STEPS.length })
      );
    }
    void refreshThenAdvance({ load, setStepIndex, stepCount: STEPS.length });
  }
  function goBack() {
    setStepIndex((i) => Math.max(i - 1, 0));
  }
  function goToCompletedStep(index) {
    const completedSet = new Set(unionCompletedIndexes({ completedIndexes, state, isSignedIn }));
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
  const completionIndexesForShell = unionCompletedIndexes({ completedIndexes, state, isSignedIn });
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
