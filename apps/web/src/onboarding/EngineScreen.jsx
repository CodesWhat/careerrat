import { useEffect, useState } from "react";
import { ArrowRightIcon, CheckIcon } from "../components/icons.jsx";
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
//
// mode: "revisit" — the engine re-entry path (InterviewSurface's ENGINE
// chip, after its own confirm dialog). Reuses the picker's selectable-row
// layout and existing selection flow verbatim; the only differences are the
// intro copy and a `onBack` "KEEP <CURRENT>" action next to Continue, so a
// user who opened this screen by mistake — or just wanted to check — isn't
// forced to pick something to get back. onBack never calls any API: picking
// a *different* engine still goes through handleContinue's normal
// selectInstalledAiRuntime + onReady() path, unchanged.
//
// Landing rule (server-owned in installed-runtime-route.mjs's
// inspectInstalledRuntimeState): auto-select only ever fires for an
// unambiguous exactly-one-ready CLI. Two or more ready CLIs land here in
// "picker" mode instead of silently picking one — this screen is where that
// choice actually gets made.
//
// Short, human taglines for the known registry entries (frontend-owned —
// the registry itself only carries the technical commandShape). Falls back
// to commandShape for any runtime this map doesn't know about, so a future
// registry addition never renders a blank descriptor line.
const RUNTIME_DESCRIPTIONS = {
  claude: "Uses your existing Claude subscription — no extra cost",
  codex: "Uses your OpenAI plan",
  gemini: "Uses your Google account",
  opencode: "Open-source — works with any provider you've configured",
  copilot: "Uses your GitHub Copilot subscription",
  qwen: "Uses your Qwen account",
  antigravity: "Uses your Google account",
  grok: "Uses your xAI account",
};

export function EngineScreen({ mode, onReady, onBack }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [pendingId, setPendingId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [customCommand, setCustomCommand] = useState("");
  const [customTest, setCustomTest] = useState(null);
  const [customTesting, setCustomTesting] = useState(false);
  // The "ADD →" collapsed/expanded custom-command row (design's own naming
  // for this affordance — see installed-runtime-route.mjs's customRuntimeEntry
  // comment). Collapses back to the trigger row whenever a detected runtime
  // gets picked instead — see selectRuntime()'s erase-on-switch below.
  const [customExpanded, setCustomExpanded] = useState(false);
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
  const readyCount = runtimes.filter((r) => r.ready).length;
  // The re-entry footer's "KEEP <CURRENT>" label — the runtime this browser
  // session actually landed on before the user opted to change it.
  const currentRuntime = runtimes.find((r) => r.id === state?.selectedId) || null;

  // Selecting a detected runtime always wins over an in-progress, unsaved
  // custom-command edit — erase-on-switch: the typed command and any test
  // result are cleared and the row collapses back to its "ADD →" trigger,
  // the same way the server already nulls a persisted customCommand once a
  // detected runtime is selected instead (installed-runtime-route.mjs).
  function selectRuntime(runtimeId) {
    setPendingId(runtimeId);
    setCustomExpanded(false);
    setCustomCommand("");
    setCustomTest(null);
  }

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
  const isRevisit = mode === "revisit";
  const canContinue = isGate || !!pendingId;
  // 3d (gate) always shows the custom row expanded — it's the only viable
  // path when the probe found nothing, so there's nothing to collapse behind
  // an "ADD →" trigger. 3f/revisit collapse it by default (design's "ADD →"
  // affordance) unless it's already the pending choice or the user opened it.
  const customCollapsed = !isGate && pendingId !== "custom" && !customExpanded;
  // 3d emphasizes the custom row with the same accent border 3f uses for an
  // actual selection — it's the one thing a user with no detected CLI can
  // still do, so it reads as the highlighted path even before they've typed
  // anything into it.
  const customSelected = pendingId === "custom" || isGate;

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
                  : isRevisit
                    ? "Pick a different CLI to run the rat on, or keep the one you're already using."
                    : `The probe found ${readyCount} CLI${readyCount === 1 ? "" : "s"} on this machine. The rat runs on whichever you pick — chat unlocks right after.`}
              </p>
            </div>

            {runtimes.map((runtime) => (
              <EngineChoiceRow
                key={runtime.id}
                runtime={runtime}
                compact={isGate}
                selected={pendingId === runtime.id}
                busy={busyId === runtime.id}
                onSelect={() => runtime.ready && selectRuntime(runtime.id)}
                onRetry={() => handleRetry(runtime.id)}
                onOpenTerminal={() => handleOpenTerminal(runtime.id)}
              />
            ))}
          </>
        )}

        <div
          className={`onboarding-engine__choice${customCollapsed ? "" : " onboarding-engine__choice--custom"}${
            customSelected ? " onboarding-engine__choice--selected" : ""
          }`}
        >
          {customCollapsed ? (
            <>
              <span className="onboarding-engine__choice-copy">
                <span className="onboarding-engine__choice-name">Custom command</span>
                <span className="onboarding-engine__choice-shape">
                  Any text-in, text-out command works
                </span>
              </span>
              <button
                type="button"
                className="onboarding-engine__add-link"
                onClick={() => setCustomExpanded(true)}
              >
                ADD →
              </button>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>

        <span className="onboarding-engine__hosted-note">
          {isGate ? "No CLI at all?" : "No CLI?"} CareerRat AI is the hosted option — paid, needs
          sign-in.
        </span>

        <div className="onboarding-engine__footer">
          {isGate || error ? (
            <button type="button" className="onboarding-engine__link" onClick={refresh}>
              RE-RUN PROBE
            </button>
          ) : isRevisit && onBack ? (
            <button type="button" className="onboarding-engine__link" onClick={onBack}>
              KEEP {(currentRuntime?.name || "CURRENT").toUpperCase()}
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
            {starting ? "Starting…" : isGate || isRevisit ? "Continue" : "Start the interview"}
            {starting ? null : <ArrowRightIcon width={13} height={13} />}
          </button>
        </div>
      </main>
    </div>
  );
}

function EngineChoiceRow({ runtime, compact, selected, busy, onSelect, onRetry, onOpenTerminal }) {
  // Compact (3d gate) rows are a flat, radio-less list where the custom
  // command is the only real action — the id alone (mono, lowercase, like
  // the raw binary name) is enough there. The full name + human descriptor
  // is 3f/revisit's picker-row treatment, where the choice itself matters.
  // A descriptor never renders for a runtime the probe couldn't find at all
  // (nothing to say about a CLI that isn't installed).
  const descriptor = runtime.available
    ? RUNTIME_DESCRIPTIONS[runtime.id] || runtime.commandShape
    : null;
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
      {compact ? (
        <span className="onboarding-engine__choice-id">{runtime.id}</span>
      ) : (
        <span className="onboarding-engine__choice-copy">
          <span className="onboarding-engine__choice-name">{runtime.name}</span>
          {descriptor ? (
            <span className="onboarding-engine__choice-shape">{descriptor}</span>
          ) : null}
          {runtime.warning ? (
            <span className="onboarding-engine__choice-warning">{runtime.warning}</span>
          ) : null}
        </span>
      )}
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
