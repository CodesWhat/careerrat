import { ArrowTopRightIcon } from "@radix-ui/react-icons";
import { useEffect, useState } from "react";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon } from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import {
  getInstalledAiRuntimes,
  openInstalledAiRuntimeTerminal,
  probeInstalledAiRuntime,
  requestHostedInterest,
  selectCustomAiRuntime,
  selectInstalledAiRuntime,
  testCustomAiRuntime,
} from "../lib/api.js";
import { ProviderIcon } from "./ProviderIcon.jsx";

// Basic email-shape check for the hosted card's inline capture — deliberately
// not full RFC5322, just enough to catch an obviously-incomplete address
// before it round-trips to the server (which re-checks the same shape).
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  claude: "Uses your existing Claude subscription, no extra cost",
  codex: "Uses your OpenAI plan",
  gemini: "Uses your Google account",
  opencode: "Open-source, works with any provider you've configured",
  copilot: "Uses your GitHub Copilot subscription",
  qwen: "Uses your Qwen account",
  antigravity: "Uses your Google account",
  hermes: "Uses your Nous Research account",
  amp: "Uses your Amp account",
  goose: "Open-source, works with any provider you've configured",
  droid: "Uses your Factory account",
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
  // The not-installed card's own disclosure state — collapsed by default so
  // a long tail of absent CLIs stays a single header row rather than an
  // always-open chip wall. Independent of customExpanded; picking a runtime
  // or switching to the custom row never touches this.
  const [notFoundOpen, setNotFoundOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  // The hosted "CareerRat AI" card's REQUEST ACCESS CTA — not an engine
  // selection (no radio, nothing persisted to the installed-runtime
  // selection file), just a one-way interest ping to
  // POST /api/hosted-interest. Clicking REQUEST ACCESS doesn't submit
  // anything by itself: it transforms the button in place into an email
  // input + send control (`hostedEditing`); only the send control actually
  // posts. `requested` then collapses that back to a disabled "REQUESTED ✓"
  // state; a failure keeps the input in place (with an inline error) so the
  // user can retry without retyping the click.
  const [hostedInterest, setHostedInterest] = useState({ requested: false, error: null });
  const [hostedEditing, setHostedEditing] = useState(false);
  const [hostedEmail, setHostedEmail] = useState("");

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
  // Everything the probe genuinely couldn't find (runtime.available false —
  // the literal "NOT FOUND" case) collapses into a single card-stack entry
  // with its own header-row disclosure (notFoundOpen) rather than either a
  // full card each or an always-visible floating strip; ready and
  // sign-in-needed runtimes keep rendering as EngineChoiceRow exactly as
  // before, unchanged.
  const cardRuntimes = runtimes.filter((r) => r.available);
  const notFoundRuntimes = runtimes.filter((r) => !r.available);
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

  // Escape or blurring away without sending resets the card to its plain
  // "REQUEST ACCESS" button — no half-typed email or stale error left
  // showing next time it's opened.
  function cancelHostedEditing() {
    setHostedEditing(false);
    setHostedEmail("");
    setHostedInterest((prev) => ({ ...prev, error: null }));
  }

  async function handleHostedSubmit() {
    if (!EMAIL_SHAPE_RE.test(hostedEmail.trim())) return;
    setHostedInterest((prev) => ({ ...prev, error: null }));
    try {
      await requestHostedInterest(hostedEmail.trim());
      setHostedEditing(false);
      setHostedEmail("");
      setHostedInterest({ requested: true, error: null });
    } catch (err) {
      setHostedInterest({
        requested: false,
        error: err?.body?.error || "Could not send that. Try again.",
      });
    }
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
                  ? "We looked for AI tools already on this computer and didn't find any. Add one below, or install one of these to get going."
                  : isRevisit
                    ? "Pick a different AI tool to run the rat on, or keep the one you're already using."
                    : `We found ${readyCount} AI tool${readyCount === 1 ? "" : "s"} on this computer. Pick one and Paul gets to work. Chat unlocks right after.`}
              </p>
            </div>

            {cardRuntimes.map((runtime) => (
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

            {notFoundRuntimes.length > 0 ? (
              <div className="onboarding-engine__choice onboarding-engine__choice--not-found">
                <button
                  type="button"
                  className="onboarding-engine__not-found-toggle"
                  aria-expanded={notFoundOpen}
                  onClick={() => setNotFoundOpen((open) => !open)}
                >
                  <span className="onboarding-engine__not-found-label">
                    NOT INSTALLED · {notFoundRuntimes.length}
                  </span>
                  <ChevronDownIcon
                    aria-hidden="true"
                    width={13}
                    height={13}
                    className={`onboarding-engine__not-found-chevron${
                      notFoundOpen ? " onboarding-engine__not-found-chevron--open" : ""
                    }`}
                  />
                </button>
                {notFoundOpen ? (
                  <div className="onboarding-engine__not-found-chips">
                    {notFoundRuntimes.map((runtime) =>
                      runtime.installUrl ? (
                        <a
                          key={runtime.id}
                          href={runtime.installUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="onboarding-engine__not-found-chip"
                        >
                          <ProviderIcon runtimeId={runtime.id} name={runtime.name} size={14} />
                          {runtime.name}
                          <ArrowTopRightIcon aria-hidden="true" width={11} height={11} />
                        </a>
                      ) : (
                        <span key={runtime.id} className="onboarding-engine__not-found-chip">
                          <ProviderIcon runtimeId={runtime.id} name={runtime.name} size={14} />
                          {runtime.name}
                        </span>
                      )
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
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

        {!error ? (
          <>
            <div className="onboarding-engine__choice onboarding-engine__choice--unavailable">
              <span className="onboarding-engine__choice-copy">
                <span className="onboarding-engine__choice-name">CareerRat AI</span>
                <span className="onboarding-engine__choice-shape">
                  No installs, no setup. We run the AI for you.
                </span>
              </span>
              <span className="onboarding-engine__choice-actions">
                <span className="onboarding-engine__receipt onboarding-engine__receipt--muted">
                  COMING SOON
                </span>
                {hostedInterest.requested ? (
                  <button type="button" className="btn btn--secondary" disabled>
                    REQUESTED ✓
                  </button>
                ) : hostedEditing ? (
                  <span className="onboarding-engine__hosted-email">
                    <input
                      type="email"
                      inputMode="email"
                      // User-initiated transform (the REQUEST ACCESS click), not a page-load
                      // autofocus — the cursor should land straight in the field that just
                      // replaced the button.
                      // biome-ignore lint/a11y/noAutofocus: see comment above
                      autoFocus
                      className="text-input onboarding-engine__hosted-email-input"
                      placeholder="you@email.com"
                      value={hostedEmail}
                      onChange={(e) => setHostedEmail(e.target.value)}
                      onBlur={cancelHostedEditing}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") cancelHostedEditing();
                        if (e.key === "Enter" && EMAIL_SHAPE_RE.test(hostedEmail.trim())) {
                          handleHostedSubmit();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="onboarding-engine__hosted-send"
                      aria-label="Send"
                      disabled={!EMAIL_SHAPE_RE.test(hostedEmail.trim())}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={handleHostedSubmit}
                    >
                      <ArrowRightIcon width={14} height={14} />
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => setHostedEditing(true)}
                  >
                    REQUEST ACCESS
                  </button>
                )}
              </span>
            </div>
            {hostedInterest.requested ? (
              <span className="onboarding-engine__hosted-confirm">
                Thanks, we'll email you when it's ready.
              </span>
            ) : null}
            {hostedInterest.error ? (
              <span className="onboarding-engine__hosted-error">{hostedInterest.error}</span>
            ) : null}
          </>
        ) : null}

        <div className="onboarding-engine__footer">
          {isGate || error ? (
            <button type="button" className="onboarding-engine__link" onClick={refresh}>
              CHECK AGAIN
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
  // Whole-card click-to-select — only for non-compact rows, the ones that
  // actually carry a radio (3f/revisit). 3d's compact gate rows have no
  // radio at all and stay click-inert here, same as before. Reuses the same
  // onSelect the radio itself calls, which already no-ops for a runtime
  // that isn't ready — clicking a sign-in-needed row's body is harmless.
  //
  // The radio button just below stays the real accessible control (its own
  // aria-label, native keyboard/Enter/Space support) — this div's onClick is
  // a mouse-only convenience layered on top, not a replacement widget, so
  // there's no matching onKeyDown/role to add here.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: see comment above
    // biome-ignore lint/a11y/useKeyWithClickEvents: see comment above
    <div
      className={`onboarding-engine__choice${selected ? " onboarding-engine__choice--selected" : ""}${
        runtime.available ? "" : " onboarding-engine__choice--unavailable"
      }${!compact ? " onboarding-engine__choice--clickable" : ""}`}
      onClick={!compact ? onSelect : undefined}
    >
      {!compact ? (
        <button
          type="button"
          className="onboarding-engine__radio"
          aria-label={`Select ${runtime.name}`}
          disabled={!runtime.ready}
          onClick={(e) => {
            e?.stopPropagation?.();
            onSelect();
          }}
        >
          {selected ? <span className="onboarding-engine__radio-dot" /> : null}
        </button>
      ) : null}
      {compact ? (
        <span className="onboarding-engine__choice-id">{runtime.id}</span>
      ) : (
        <span className="onboarding-engine__choice-copy">
          <span className="onboarding-engine__choice-name-row">
            <ProviderIcon runtimeId={runtime.id} name={runtime.name} size={20} />
            <span className="onboarding-engine__choice-name">{runtime.name}</span>
          </span>
          {descriptor ? (
            <span className="onboarding-engine__choice-shape">{descriptor}</span>
          ) : null}
        </span>
      )}
      {/* cardRuntimes (this row's only caller) already filters to
       * runtime.available === true — a genuinely-not-found runtime never
       * reaches this component at all, it renders in the not-found chip
       * strip instead. So this row only ever has two receipt states. */}
      {runtime.ready ? (
        <span className="onboarding-engine__receipt onboarding-engine__receipt--ok">DETECTED</span>
      ) : (
        <span className="onboarding-engine__choice-actions">
          <span className="onboarding-engine__receipt">SIGN-IN NEEDED</span>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={busy}
            onClick={(e) => {
              e?.stopPropagation?.();
              onOpenTerminal();
            }}
          >
            Open Terminal
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={busy}
            onClick={(e) => {
              e?.stopPropagation?.();
              onRetry();
            }}
          >
            Retry
          </button>
        </span>
      )}
    </div>
  );
}
