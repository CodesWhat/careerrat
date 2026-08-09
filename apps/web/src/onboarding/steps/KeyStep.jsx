import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button.jsx";
import {
  getAutomationSettings,
  getInstalledAiRuntimes,
  openInstalledAiRuntimeTerminal,
  probeInstalledAiRuntime,
  saveCandidateFile,
  selectInstalledAiRuntime,
} from "../../lib/api.js";
import {
  AutomationModeChooser,
  buildAutomationModePatch,
} from "../../settings/AutomationControls.jsx";
import { OnboardingNavButton, OnboardingShell } from "../OnboardingShell.jsx";

function runtimeStatusLabel(runtime) {
  if (runtime.selected) return "Selected";
  if (runtime.ready) return "Ready";
  if (runtime.status === "authentication_required") return "Sign-in needed";
  if (!runtime.available) return "Not installed";
  return "Needs attention";
}

export function InstalledRuntimeChoices({
  state,
  onSelect,
  onRetry,
  onOpenTerminal,
  busyId = null,
  showAdvancedHint = true,
}) {
  const runtimes = Array.isArray(state?.runtimes) ? state.runtimes : [];
  const installed = runtimes.filter((runtime) => runtime.available);

  return (
    <section className="onboarding-runtime" aria-labelledby="onboarding-runtime-title">
      <div className="onboarding-runtime__heading">
        <div>
          <span className="onboarding-runtime__eyebrow">Recommended</span>
          <h2 id="onboarding-runtime-title">Use an AI tool already on this computer</h2>
        </div>
        <span className="badge">No extra API key</span>
      </div>
      <p className="field__hint">
        Rolester uses the tool's existing login and subscription. Credentials stay with that CLI.
      </p>
      {!state ? <p className="field__hint">Checking this computer…</p> : null}
      {state && installed.length === 0 ? (
        <p className="field__hint">
          No supported signed-in AI CLI was found. Manual setup still works.
        </p>
      ) : null}
      {installed.length ? (
        <div className="onboarding-runtime__list">
          {installed.map((runtime) => (
            <article
              className={`onboarding-runtime__choice${runtime.selected ? " onboarding-runtime__choice--selected" : ""}`}
              key={runtime.id}
            >
              <div className="onboarding-runtime__choice-copy">
                <strong>{runtime.name}</strong>
                <code>{runtime.commandShape}</code>
                {runtime.warning ? <span className="field__hint">{runtime.warning}</span> : null}
              </div>
              <div className="onboarding-runtime__choice-action">
                <span className="badge">{runtimeStatusLabel(runtime)}</span>
                {runtime.ready && !runtime.selected ? (
                  <Button
                    variant="secondary"
                    disabled={busyId === runtime.id}
                    onClick={() => onSelect?.(runtime.id)}
                  >
                    {busyId === runtime.id ? "Selecting…" : "Use this tool"}
                  </Button>
                ) : null}
                {!runtime.ready && runtime.action === "open_terminal" ? (
                  <>
                    <Button
                      variant="secondary"
                      disabled={busyId === runtime.id}
                      onClick={() => onOpenTerminal?.(runtime.id)}
                    >
                      Open Terminal to sign in
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busyId === runtime.id}
                      onClick={() => onRetry?.(runtime.id)}
                    >
                      Retry detection
                    </Button>
                  </>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {showAdvancedHint ? (
        <details className="onboarding-runtime__advanced">
          <summary>Advanced · Use a provider API key instead</summary>
          <p className="field__hint">
            Provider keys and managed AI are optional fallbacks. Configure them later in Settings.
          </p>
        </details>
      ) : null}
    </section>
  );
}

function useInstalledRuntimeInventory({ reload }) {
  const [state, setState] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setState(await getInstalledAiRuntimes());
    } catch {
      setState({ selectedId: null, providerFallback: false, runtimes: [] });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const select = useCallback(
    async (runtimeId) => {
      setBusyId(runtimeId);
      try {
        await selectInstalledAiRuntime({ runtimeId });
        await refresh();
        await reload?.();
      } finally {
        setBusyId(null);
      }
    },
    [refresh, reload]
  );

  const retry = useCallback(
    async (runtimeId) => {
      setBusyId(runtimeId);
      try {
        await probeInstalledAiRuntime(runtimeId);
        await refresh();
        await reload?.();
      } finally {
        setBusyId(null);
      }
    },
    [refresh, reload]
  );

  const openTerminal = useCallback(async (runtimeId) => {
    setBusyId(runtimeId);
    try {
      await openInstalledAiRuntimeTerminal(runtimeId);
    } finally {
      setBusyId(null);
    }
  }, []);

  return { state, busyId, select, retry, openTerminal };
}

function useAutomationSetupMode() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getAutomationSettings());
    } catch {
      setStatus({ mode: "basic", liveCount: 0, consent: {}, capabilities: [] });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setMode = useCallback(
    async (mode) => {
      if (!status) return;
      setBusy(true);
      try {
        await saveCandidateFile("automation", buildAutomationModePatch(status, mode));
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh, status]
  );

  return { status, busy, setMode };
}

// Step 1 — local runtime and operating mode: pick up an already-signed-in AI
// CLI on this computer, or fall back to a provider API key in Settings.
export function KeyStep({ goNext, goBack, onProgressSelect, runtimeCapabilities, reload }) {
  const aiAvailable = runtimeCapabilities?.aiAvailable === true;
  const canContinue = aiAvailable;
  const installedRuntimes = useInstalledRuntimeInventory({ reload });
  const automationMode = useAutomationSetupMode();

  return (
    <OnboardingShell
      activeIndex={1}
      className="onboarding-shell--key"
      onProgressSelect={onProgressSelect}
      actions={
        <>
          <OnboardingNavButton direction="back" label="Back" onClick={goBack} />
          <OnboardingNavButton
            direction="next"
            label="Continue"
            onClick={goNext}
            disabled={!canContinue}
          />
        </>
      }
    >
      <div className="onboarding-step-stack">
        <div className="onboarding-step-label">Step 1</div>
        <section
          className="onboarding-step-card onboarding-key onboarding-account"
          aria-labelledby="onboarding-account-title"
        >
          <div className="onboarding-step-card__media onboarding-key__title-side">
            <div className="onboarding-targeting__mark" aria-hidden="true">
              👤
            </div>
            <div className="onboarding-targeting__media-copy">
              <h1 id="onboarding-account-title">Set up Rolester.</h1>
              <p className="onboarding-account__intro">Use your existing AI subscription.</p>
            </div>
          </div>
          <div className="onboarding-step-card__content onboarding-key__action-side onboarding-account__action-side">
            <InstalledRuntimeChoices
              state={installedRuntimes.state}
              busyId={installedRuntimes.busyId}
              onSelect={installedRuntimes.select}
              onRetry={installedRuntimes.retry}
              onOpenTerminal={installedRuntimes.openTerminal}
            />
            <AutomationModeChooser
              status={
                automationMode.status || {
                  mode: "basic",
                  liveCount: 0,
                  consent: {},
                  capabilities: [],
                }
              }
              busy={automationMode.busy || !automationMode.status}
              onSetMode={automationMode.setMode}
            />
          </div>
        </section>
      </div>
    </OnboardingShell>
  );
}
