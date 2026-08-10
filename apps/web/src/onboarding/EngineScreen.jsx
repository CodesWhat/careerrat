import { useEffect, useState } from "react";
import { CheckIcon } from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import {
  getInstalledAiRuntimes,
  openInstalledAiRuntimeTerminal,
  probeInstalledAiRuntime,
  selectCustomAiRuntime,
  selectInstalledAiRuntime,
  testCustomAiRuntime,
} from "../lib/api.js";

// EngineScreen — design frames 3f (2+ ready CLIs, you pick) and 3d (0 ready,
// the only hard gate). Both share the same probe-results list; only the
// header copy and primary CTA differ (mode: "picker" | "gate"). The exactly-
// one-ready case never reaches this component — OnboardingPage.jsx skips
// straight to the interview because GET /api/settings/ai-runtimes already
// auto-selects a lone ready runtime server-side (inspectInstalledRuntimeState).
export function EngineScreen({ mode, onReady }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [pendingId, setPendingId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [customCommand, setCustomCommand] = useState("");
  const [customTest, setCustomTest] = useState(null);
  const [customTesting, setCustomTesting] = useState(false);
  const [starting, setStarting] = useState(false);

  // A fetch failure here (network down, 401/403, server error) is NOT the
  // same product state as a legitimate 200 with zero runtimes — conflating
  // the two used to render the "No AI engine found" gate for both, making an
  // auth/network failure look like a real probe result. Failures get their
  // own error state and an inline alert instead; only a genuinely-empty
  // probe response renders the gate copy.
  async function refresh() {
    try {
      const next = await getInstalledAiRuntimes();
      setState(next);
      setError(null);
      if (next.selectedId) setPendingId(next.selectedId);
    } catch (err) {
      setError(err?.body?.error || "Couldn't reach this computer to check for AI CLIs.");
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only load
  useEffect(() => {
    void refresh();
  }, []);

  const runtimes = (state?.runtimes ?? []).filter((r) => r.id !== "custom");
  const custom = (state?.runtimes ?? []).find((r) => r.id === "custom") || null;

  async function handleRetry(runtimeId) {
    setBusyId(runtimeId);
    try {
      await probeInstalledAiRuntime(runtimeId);
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function handleOpenTerminal(runtimeId) {
    setBusyId(runtimeId);
    try {
      await openInstalledAiRuntimeTerminal(runtimeId);
    } finally {
      setBusyId(null);
    }
  }

  async function handleTestCustom() {
    const command = customCommand.trim();
    if (!command) return;
    setCustomTesting(true);
    setCustomTest(null);
    try {
      const result = await testCustomAiRuntime(command);
      setCustomTest(result);
    } catch (err) {
      setCustomTest({ ok: false, error: err?.body?.error || "Could not run the test." });
    } finally {
      setCustomTesting(false);
    }
  }

  async function handleUseCustom() {
    const command = customCommand.trim();
    if (!command) return;
    await selectCustomAiRuntime(command);
    setPendingId("custom");
    await refresh();
  }

  async function handleContinue() {
    setStarting(true);
    try {
      if (pendingId && pendingId !== "custom" && pendingId !== state?.selectedId) {
        await selectInstalledAiRuntime({ runtimeId: pendingId });
      }
      onReady?.();
    } finally {
      setStarting(false);
    }
  }

  const isGate = mode === "gate";
  const canContinue = isGate || !!pendingId;

  return (
    <div className="onboarding-app">
      <header className="onboarding-app__header">
        <div className="onboarding-app__brand">
          CareerRat<span className="onboarding-app__brand-dot">.</span>
        </div>
        <span className="onboarding-app__status">
          {isGate ? "SETUP · ENGINE REQUIRED" : "SETUP · ENGINE"}
        </span>
      </header>
      <main className="onboarding-engine">
        {error ? (
          <div className="onboarding-engine__intro">
            <h1>Couldn't check this computer.</h1>
            <InlineAlert message={error} />
          </div>
        ) : (
          <>
            <div className="onboarding-engine__intro">
              <h1>{isGate ? "No AI engine found." : "Pick your engine."}</h1>
              <p>
                {isGate
                  ? "The rat probed this machine for installed CLIs and came up empty. Point it at anything that runs — or install one of these."
                  : "The probe found more than one CLI on this machine. The rat runs on whichever you pick — chat unlocks right after."}
              </p>
            </div>

            {runtimes.map((runtime) => (
              <EngineChoiceRow
                key={runtime.id}
                runtime={runtime}
                compact={isGate}
                selected={pendingId === runtime.id}
                busy={busyId === runtime.id}
                onSelect={() => runtime.ready && setPendingId(runtime.id)}
                onRetry={() => handleRetry(runtime.id)}
                onOpenTerminal={() => handleOpenTerminal(runtime.id)}
              />
            ))}
          </>
        )}

        <div
          className={`onboarding-engine__choice onboarding-engine__choice--custom${
            pendingId === "custom" ? " onboarding-engine__choice--selected" : ""
          }`}
        >
          <div className="onboarding-engine__custom-heading">Custom command</div>
          <div className="onboarding-engine__custom-row">
            <input
              type="text"
              className="text-input"
              placeholder={custom?.commandShape || "~/bin/my-agent --chat"}
              value={customCommand}
              onChange={(e) => {
                setCustomCommand(e.target.value);
                setCustomTest(null);
              }}
            />
            <button
              type="button"
              className="btn btn--secondary"
              disabled={!customCommand.trim() || customTesting}
              onClick={handleTestCustom}
            >
              {customTesting ? "Testing…" : "Test"}
            </button>
          </div>
          {customTest?.ok ? (
            <span className="onboarding-engine__custom-receipt onboarding-engine__custom-receipt--ok">
              <CheckIcon /> PASSED · RESPONDED IN {(customTest.elapsedMs / 1000).toFixed(1)}S
            </span>
          ) : null}
          {customTest && !customTest.ok ? (
            <span className="onboarding-engine__custom-receipt onboarding-engine__custom-receipt--error">
              {customTest.error || "Could not reach that command."}
            </span>
          ) : null}
          {customTest?.ok ? (
            <button type="button" className="btn btn--secondary" onClick={handleUseCustom}>
              Use this command
            </button>
          ) : (
            <span className="onboarding-engine__custom-hint">
              ANY COMMAND THAT SPEAKS TEXT IN, TEXT OUT WORKS
            </span>
          )}
        </div>

        <span className="onboarding-engine__hosted-note">
          No CLI at all? CareerRat AI is the hosted option — paid, needs sign-in.
        </span>

        <div className="onboarding-engine__footer">
          {isGate || error ? (
            <button type="button" className="onboarding-engine__link" onClick={refresh}>
              RE-RUN PROBE
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canContinue || starting}
            onClick={handleContinue}
          >
            {starting ? "Starting…" : isGate ? "Continue" : "Start the interview"}
          </button>
        </div>
      </main>
    </div>
  );
}

function EngineChoiceRow({ runtime, compact, selected, busy, onSelect, onRetry, onOpenTerminal }) {
  return (
    <div
      className={`onboarding-engine__choice${selected ? " onboarding-engine__choice--selected" : ""}${
        runtime.available ? "" : " onboarding-engine__choice--unavailable"
      }`}
    >
      {!compact ? (
        <button
          type="button"
          className="onboarding-engine__radio"
          aria-label={`Select ${runtime.name}`}
          disabled={!runtime.ready}
          onClick={onSelect}
        >
          {selected ? <span className="onboarding-engine__radio-dot" /> : null}
        </button>
      ) : null}
      <span className="onboarding-engine__choice-copy">
        <span className="onboarding-engine__choice-name">{runtime.name}</span>
        {runtime.commandShape ? (
          <span className="onboarding-engine__choice-shape">{runtime.commandShape}</span>
        ) : null}
        {runtime.warning ? (
          <span className="onboarding-engine__choice-warning">{runtime.warning}</span>
        ) : null}
      </span>
      {runtime.ready ? (
        <span className="onboarding-engine__receipt onboarding-engine__receipt--ok">DETECTED</span>
      ) : runtime.available ? (
        <span className="onboarding-engine__choice-actions">
          <span className="onboarding-engine__receipt">SIGN-IN NEEDED</span>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={busy}
            onClick={onOpenTerminal}
          >
            Open Terminal
          </button>
          <button type="button" className="btn btn--secondary" disabled={busy} onClick={onRetry}>
            Retry
          </button>
        </span>
      ) : (
        <span className="onboarding-engine__receipt onboarding-engine__receipt--muted">
          NOT FOUND
          {runtime.installUrl ? (
            <>
              {" · "}
              <a
                href={runtime.installUrl}
                target="_blank"
                rel="noreferrer"
                className="onboarding-engine__receipt-link"
              >
                INSTALL GUIDE
              </a>
            </>
          ) : null}
        </span>
      )}
    </div>
  );
}
