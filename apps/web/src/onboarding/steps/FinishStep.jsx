import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDashboardSnapshot } from "../../app-shell/DashboardContext.jsx";
import { Button } from "../../components/Button.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import {
  saveCandidateFile as defaultSaveCandidateFile,
  startFirstSearchRun as defaultStartFirstSearchRun,
} from "../../lib/api.js";
import { OnboardingNavButton, OnboardingShell } from "../OnboardingShell.jsx";

const CADENCE_OPTIONS = [
  { mode: "daily", label: "Daily" },
  { mode: "every-3-days", label: "Every 3 days" },
  { mode: "weekly", label: "Weekly" },
  { mode: "manual", label: "Manual only" },
];

const CADENCE_LABELS = Object.fromEntries(
  CADENCE_OPTIONS.map((option) => [option.mode, option.label])
);

// Daily is today's static recommendation — not server-derived, so it never
// echoes a "recommended from history" line (dropped entirely, see below).
const MOST_POPULAR_CADENCE = "daily";

const FIRST_SEARCH_STATUS = {
  not_started: { label: "Not started", badgeClass: "badge--warn" },
  running: { label: "Running", badgeClass: "badge--warn" },
  completed: { label: "Completed", badgeClass: "badge--ok" },
  failed: { label: "Failed", badgeClass: "badge--error" },
};

const DEFAULT_CADENCE = { mode: "daily", recommended_from: "default" };

// Copy rule: the word "RSS" (or any source-plumbing jargon) never reaches the
// wizard. Any first-search failure — whatever the server actually said —
// renders as this one human line, regardless of message text.
const FIRST_SEARCH_FAILURE_COPY =
  "Couldn't reach any of your companies' job boards yet — retry below, or run a search from the Jobs tab anytime.";

function errorMessage(err, fallback) {
  return err?.body?.error || (err instanceof Error ? err.message : fallback);
}

function normalizeCadenceMode(mode) {
  const value = String(mode || "").trim();
  return CADENCE_LABELS[value] ? value : DEFAULT_CADENCE.mode;
}

function savedCadenceFromState(state) {
  const cadence = state?.data?.targeting?.search_preferences?.cadence;
  if (!cadence || typeof cadence !== "object") return DEFAULT_CADENCE;
  return {
    ...DEFAULT_CADENCE,
    ...cadence,
    mode: normalizeCadenceMode(cadence.mode),
  };
}

function unwrapRun(value) {
  if (!value || typeof value !== "object") return null;
  if (value.run && typeof value.run === "object") return value.run;
  return value;
}

function runFromState(state, localRun = null) {
  return (
    unwrapRun(localRun) ||
    unwrapRun(state?.data?.sourcing?.firstSearchRun) ||
    unwrapRun(state?.data?.firstSearchRun) ||
    unwrapRun(state?.sourcing?.firstSearchRun) ||
    unwrapRun(state?.firstSearchRun)
  );
}

function numberFrom(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function firstSearchCounts(run) {
  const summary = run?.summary || {};
  return {
    sourcesAttempted: numberFrom(
      summary.sourcesAttempted,
      summary.attemptedSources,
      summary.deterministicSources?.attempted
    ),
    rolesFound: numberFrom(summary.rolesFound, summary.new, summary.offerCount),
  };
}

export function deterministicSourceAttemptsFromState(state) {
  const values = [
    state?.data?.sourcing?.sourceSetup?.deterministicSources?.attempted,
    state?.data?.sourcing?.deterministicSources?.attempted,
    state?.deterministicSources?.attempted,
  ];
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

export function isSourceSetupReady({ state, firstSearchRun } = {}) {
  const attempted = deterministicSourceAttemptsFromState(state);
  const run = unwrapRun(firstSearchRun);
  if (attempted != null) {
    return attempted > 0 || run?.status === "running" || run?.status === "completed";
  }
  if (state?.searchSourcesPresent === true) return true;
  return run?.status === "running" || run?.status === "completed";
}

// Pure status/detail derivation kept intact for its own sake (retry gating,
// counts, error text) even though the Finish step no longer renders most of
// these fields directly — this is still the shared shape other call sites in
// this module reason about.
export function buildFirstSearchTask({ state, run, sourceSetupReady } = {}) {
  const searchReady = state?.data?.setup?.readiness?.search_ready === true;
  const sourcesReady = sourceSetupReady ?? isSourceSetupReady({ state, firstSearchRun: run });
  const currentRun = unwrapRun(run);
  const status = currentRun?.status || "not_started";
  const normalizedStatus = FIRST_SEARCH_STATUS[status] ? status : "not_started";
  const statusMeta = FIRST_SEARCH_STATUS[normalizedStatus];
  const counts = firstSearchCounts(currentRun);
  const runError =
    currentRun?.error?.message ||
    currentRun?.error ||
    currentRun?.failure?.message ||
    currentRun?.summary?.error ||
    "";

  if (normalizedStatus === "running") {
    return {
      status: normalizedStatus,
      label: statusMeta.label,
      badgeClass: statusMeta.badgeClass,
      detail: "Searching deterministic public sources...",
      counts,
      canStart: false,
      canRetry: false,
      canDefer: false,
    };
  }

  if (normalizedStatus === "completed") {
    const zeroResultDetail =
      "Search completed. No matching roles found yet; refine titles or add a source, then search again from Jobs.";
    return {
      status: normalizedStatus,
      label: statusMeta.label,
      badgeClass: statusMeta.badgeClass,
      detail:
        counts.rolesFound > 0
          ? "Search completed. Review sourced roles from Jobs."
          : zeroResultDetail,
      counts,
      canStart: false,
      canRetry: false,
      canDefer: false,
      showSourcedLink: counts.rolesFound > 0,
    };
  }

  if (normalizedStatus === "failed") {
    return {
      status: normalizedStatus,
      label: statusMeta.label,
      badgeClass: statusMeta.badgeClass,
      detail: "First search failed. Review the source setup message, fix the issue, then retry.",
      error: typeof runError === "string" ? runError : "",
      counts,
      canStart: false,
      canRetry: true,
      canDefer: false,
    };
  }

  return {
    status: normalizedStatus,
    label: statusMeta.label,
    badgeClass: statusMeta.badgeClass,
    detail: !searchReady
      ? "Complete Search setup before starting the first deterministic search."
      : sourcesReady
        ? "Complete Search setup, choose a cadence, then start the first deterministic search."
        : "Add an RSS source or supported public ATS company before starting the first deterministic search.",
    counts,
    canStart: searchReady && sourcesReady,
    canRetry: false,
    canDefer: searchReady && sourcesReady,
  };
}

function cadencePatch({ mode, existingSearchPreferences = {}, recommendedFrom = "default", now }) {
  return {
    search_preferences: {
      ...existingSearchPreferences,
      cadence: {
        mode: normalizeCadenceMode(mode),
        recommended_from: recommendedFrom === "history" ? "history" : "default",
        saved_at: now(),
      },
    },
  };
}

export async function saveCadencePreference({
  mode,
  existingSearchPreferences = {},
  recommendedFrom = "default",
  saveCandidateFile = defaultSaveCandidateFile,
  now = () => new Date().toISOString(),
} = {}) {
  return saveCandidateFile(
    "targeting",
    cadencePatch({ mode, existingSearchPreferences, recommendedFrom, now })
  );
}

export async function saveCadenceAndStartFirstSearch({
  mode,
  existingSearchPreferences = {},
  recommendedFrom = "default",
  saveCandidateFile = defaultSaveCandidateFile,
  startFirstSearchRun = defaultStartFirstSearchRun,
  setFirstSearchRun,
  now = () => new Date().toISOString(),
} = {}) {
  await saveCadencePreference({
    mode,
    existingSearchPreferences,
    recommendedFrom,
    saveCandidateFile,
    now,
  });
  const result = await startFirstSearchRun();
  const run = unwrapRun(result);
  if (run) setFirstSearchRun?.(run);
  return result;
}

export async function retryFirstSearch({
  startFirstSearchRun = defaultStartFirstSearchRun,
  setFirstSearchRun,
} = {}) {
  const result = await startFirstSearchRun({ retry: true });
  const run = unwrapRun(result);
  if (run) setFirstSearchRun?.(run);
  return result;
}

// Compact, three-state summary line for the auto-triggered first search.
// Never surfaces raw server text on failure — see FIRST_SEARCH_FAILURE_COPY.
function firstSearchStatusView({ quickStarting, task, triggerError }) {
  if (quickStarting) {
    return { tone: "pending", text: "Starting your first search…", canRetry: false };
  }
  if (task.status === "failed" || triggerError) {
    return { tone: "error", text: FIRST_SEARCH_FAILURE_COPY, canRetry: true };
  }
  if (task.status === "running") {
    return {
      tone: "pending",
      text: "First search is running — fresh roles will land in Jobs.",
      canRetry: false,
    };
  }
  if (task.status === "completed") {
    return {
      tone: "success",
      text:
        task.counts.rolesFound > 0
          ? "First search is done — fresh roles are in Jobs."
          : "First search is done. No matches yet — Roland keeps watching on your cadence.",
      canRetry: false,
    };
  }
  return { tone: "pending", text: "Starting your first search…", canRetry: false };
}

// Step 7 — Finish. No diagnostics, no readiness checklist (that lives on the
// separate SetupReadinessCard dashboard surface, untouched by this step). By
// this point in the wizard, Targeting/Companies/Quick facts have already
// collected everything the first search and the gate need — this step's job
// is completion + launch + the deep-ingest handoff, nothing else.
export function FinishStep({ state, reload, goBack, onProgressSelect }) {
  const navigate = useNavigate();
  const dashboard = useDashboardSnapshot();
  const [quickStarting, setQuickStarting] = useState(false);
  const [firstSearchTriggerError, setFirstSearchTriggerError] = useState(null);
  const [localFirstSearchRun, setLocalFirstSearchRun] = useState(() => runFromState(state));
  const [selectedCadence, setSelectedCadence] = useState(() => savedCadenceFromState(state).mode);
  const [savingCadence, setSavingCadence] = useState(false);
  const [cadenceError, setCadenceError] = useState(null);

  const autoStartRequestedRef = useRef(false);

  const firstSearchRun = runFromState(state, localFirstSearchRun);
  const firstSearchTask = buildFirstSearchTask({ state, run: firstSearchRun });
  const existingSearchPreferences = state?.data?.targeting?.search_preferences || {};
  const statusView = firstSearchStatusView({
    quickStarting,
    task: firstSearchTask,
    triggerError: firstSearchTriggerError,
  });
  const retryAction =
    firstSearchTask.status === "failed" ? handleRetryFirstSearch : handleStartFirstSearch;

  useEffect(() => {
    setLocalFirstSearchRun(runFromState(state));
    setSelectedCadence(savedCadenceFromState(state).mode);
  }, [state]);

  async function refreshWorkspace() {
    await reload?.();
    await dashboard.refetch?.();
  }

  async function handleStartFirstSearch() {
    setQuickStarting(true);
    setFirstSearchTriggerError(null);
    try {
      await saveCadenceAndStartFirstSearch({
        mode: selectedCadence,
        existingSearchPreferences,
        recommendedFrom: "default",
        setFirstSearchRun: setLocalFirstSearchRun,
      });
      await refreshWorkspace();
      return true;
    } catch (err) {
      setFirstSearchTriggerError(errorMessage(err, "Could not start the first search"));
      return false;
    } finally {
      setQuickStarting(false);
    }
  }

  async function handleRetryFirstSearch() {
    setQuickStarting(true);
    setFirstSearchTriggerError(null);
    try {
      await retryFirstSearch({ setFirstSearchRun: setLocalFirstSearchRun });
      await refreshWorkspace();
    } catch (err) {
      setFirstSearchTriggerError(errorMessage(err, "Could not retry the first search"));
    } finally {
      setQuickStarting(false);
    }
  }

  // Auto-trigger the same call the old "Search now?" control made — the
  // server builds sources from tracked companies + titles as part of the
  // run, so this deliberately does not pre-check stored sources client-side.
  // Guarded by a ref (StrictMode double-mount) AND by the server-known run
  // status (remounts/revisits never re-fire once a run has been started).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only trigger, guarded above
  useEffect(() => {
    if (autoStartRequestedRef.current) return;
    const run = runFromState(state, localFirstSearchRun);
    const status = run?.status || "not_started";
    if (status !== "not_started") return;
    autoStartRequestedRef.current = true;
    void handleStartFirstSearch();
  }, []);

  async function handleSelectCadence(mode) {
    if (mode === selectedCadence || savingCadence) return;
    const previous = selectedCadence;
    setSelectedCadence(mode);
    setSavingCadence(true);
    setCadenceError(null);
    try {
      await saveCadencePreference({ mode, existingSearchPreferences, recommendedFrom: "default" });
    } catch (err) {
      setSelectedCadence(previous);
      setCadenceError(errorMessage(err, "Could not save cadence"));
    } finally {
      setSavingCadence(false);
    }
  }

  function handleFinish() {
    navigate("/");
  }

  return (
    <OnboardingShell
      activeIndex={7}
      className="onboarding-shell--targeting"
      onProgressSelect={onProgressSelect}
      actions={
        <>
          <OnboardingNavButton direction="back" label="Back" onClick={goBack} />
          <OnboardingNavButton direction="next" label="Finish" onClick={handleFinish} />
        </>
      }
    >
      <div className="onboarding-step-stack onboarding-step-stack--targeting">
        <div className="onboarding-step-label">Step 7</div>
        <section
          className="onboarding-step-card onboarding-targeting onboarding-finish"
          aria-labelledby="finish-title"
        >
          <section
            className="onboarding-step-card__media onboarding-targeting__media"
            aria-label="Finish setup"
          >
            <div className="onboarding-targeting__mark" aria-hidden="true">
              📊
            </div>
            <div className="onboarding-targeting__media-copy">
              <h1 id="finish-title">You're all set</h1>
              <p>Roland is kicking off your first search. Here's how to make it hit harder.</p>
            </div>
          </section>

          <div className="onboarding-step-card__content onboarding-step-card__content--dense onboarding-targeting__content onboarding-finish__content">
            <p className="onboarding-finish__status-line" aria-live="polite">
              {statusView.text}{" "}
              {statusView.canRetry ? (
                <button
                  type="button"
                  className="onboarding-inline-link"
                  onClick={retryAction}
                  disabled={quickStarting}
                >
                  Try again
                </button>
              ) : null}
            </p>

            <section
              className="onboarding-targeting__signal-panel onboarding-targeting__signal-panel--quiet onboarding-finish__hero"
              aria-labelledby="finish-hero-title"
            >
              <h2 id="finish-hero-title">Go deeper while Roland searches</h2>
              <p>
                A guided ingest of your work history makes packets and applications much stronger.
              </p>
              <div className="onboarding-step-card__action-group">
                <Button onClick={() => navigate("/deep-ingest")}>Start deep ingest</Button>
                <button type="button" className="onboarding-inline-link" onClick={handleFinish}>
                  I'll do it later — finish
                </button>
              </div>
            </section>

            <section className="onboarding-step-card__section onboarding-finish__cadence">
              <span className="field__label">Search cadence</span>
              <div
                className="onboarding-guardrails__preset-grid"
                role="radiogroup"
                aria-label="Search cadence"
              >
                {CADENCE_OPTIONS.map((option) => {
                  const active = selectedCadence === option.mode;
                  return (
                    <button
                      key={option.mode}
                      type="button"
                      className={`onboarding-guardrails__preset${active ? " onboarding-guardrails__preset--selected" : ""}`}
                      aria-pressed={active}
                      disabled={savingCadence}
                      onClick={() => handleSelectCadence(option.mode)}
                    >
                      {option.label}
                      {option.mode === MOST_POPULAR_CADENCE ? (
                        <span className="badge badge--muted">Most popular</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              {cadenceError ? <InlineAlert message={cadenceError} /> : null}
            </section>
          </div>
        </section>
      </div>
    </OnboardingShell>
  );
}
