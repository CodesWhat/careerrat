import { useCallback, useEffect, useRef, useState } from "react";
import {
  RolesterSignInButton,
  RolesterSignUpButton,
  useRolesterUser,
} from "../../auth/clerkControls.jsx";
import { useDesktopGoogleSignIn } from "../../auth/useDesktopGoogleSignIn.js";
import { Button } from "../../components/Button.jsx";
import {
  connectManagedAi,
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

// After the auto-provision effect's first attempt fails, one silent retry
// before surfacing an error — see useManagedAiAutoProvision below.
const AUTO_PROVISION_RETRY_DELAY_MS = 2000;

function accountLabel(user) {
  return (
    user?.fullName ||
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.username ||
    user?.primaryEmailAddress?.emailAddress ||
    "your Rolester account"
  );
}

function accountEmail(user) {
  const email = user?.primaryEmailAddress?.emailAddress;
  return email && email !== accountLabel(user) ? email : null;
}

function AccountFinePrint() {
  return (
    <p className="onboarding-account__fine-print">
      <span className="onboarding-account__fine-print-marker" aria-hidden="true">
        *
      </span>
      <span>Signing in keeps usage tied to you.</span>
    </p>
  );
}

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

// Electron desktop shell only — see useDesktopGoogleSignIn.js's header
// comment for the full system-browser handoff flow this drives. Rendered
// above the existing Create account/Log in row (KeyStep below), never in
// place of it: Google is the fast path, Clerk's own modal (email, other
// providers) stays available underneath. Clerk's own in-modal social button
// is hidden whenever this is shown — see ROLESTER_CLERK_APPEARANCE_DESKTOP in
// ../../auth/clerkControls.jsx — so there is exactly one Google entry point,
// not two that behave differently.
function DesktopGoogleSignIn() {
  const { phase, error, isWaiting, start, cancel } = useDesktopGoogleSignIn();

  return (
    <>
      <div className="onboarding-account__actions">
        {isWaiting ? (
          <>
            <Button variant="secondary" className="onboarding-account__cta" disabled>
              Waiting for Google sign-in…
            </Button>
            <Button variant="secondary" className="onboarding-account__cta" onClick={cancel}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="primary" className="onboarding-account__cta" onClick={start}>
            Continue with Google
          </Button>
        )}
      </div>
      {phase === "error" && error ? (
        <p className="onboarding-account__fine-print">{error}</p>
      ) : null}
    </>
  );
}

// Auto-provisions managed AI the instant Clerk sign-in completes: hands the
// Clerk session JWT to src/cli/ai-provision-route.mjs, which exchanges it
// server-to-server for a minted proxy token (see that route's own header
// comment for the full flow and privacy invariant — the raw JWT and token
// never linger anywhere this hook can see past the in-flight call). Runs at
// most once per mount (firedRef), independent of React's render count;
// `reload` re-fetches GET /api/runtime/config so a successful connect flips
// runtimeCapabilities.aiAvailable without a page refresh.
function useManagedAiAutoProvision({ isLoaded, isSignedIn, aiAvailable, getToken, reload }) {
  const [status, setStatus] = useState("idle"); // idle | connecting | error
  const firedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const attempt = useCallback(
    async (isRetry) => {
      setStatus("connecting");
      try {
        const jwt = await getToken?.();
        if (!jwt) throw new Error("no session token available");
        const result = await connectManagedAi(jwt);
        if (!result?.ok) throw new Error("managed AI connect failed");
        if (!mountedRef.current) return;
        await reload?.();
        if (!mountedRef.current) return;
        setStatus("idle");
      } catch {
        if (!mountedRef.current) return;
        if (!isRetry) {
          // One silent retry before surfacing anything to the user — most
          // failures here are transient (a cold local server, a slow
          // exchange round trip), not a real problem worth an error state.
          setTimeout(() => {
            if (mountedRef.current) void attempt(true);
          }, AUTO_PROVISION_RETRY_DELAY_MS);
          return;
        }
        setStatus("error");
      }
    },
    [getToken, reload]
  );

  useEffect(() => {
    if (!isLoaded || !isSignedIn || aiAvailable) return;
    if (firedRef.current) return;
    firedRef.current = true;
    void attempt(false);
  }, [isLoaded, isSignedIn, aiAvailable, attempt]);

  // "Try again" re-fires the same flow (attempt + its own silent retry),
  // not just a single bare call — see the header comment above.
  const retry = useCallback(() => {
    void attempt(false);
  }, [attempt]);

  return { status, retry };
}

// Step 1 — local runtime and operating mode. A Rolester account is optional;
// signing in auto-provisions managed AI as an Advanced fallback.
export function KeyStep({ goNext, goBack, onProgressSelect, runtimeCapabilities, reload }) {
  const { isLoaded, isSignedIn, user, desktopAuthAvailable, getToken } = useRolesterUser();
  const aiAvailable = runtimeCapabilities?.aiAvailable === true;
  const { status: aiConnectStatus, retry: retryAiConnect } = useManagedAiAutoProvision({
    isLoaded,
    isSignedIn,
    aiAvailable,
    getToken,
    reload,
  });
  // GATE CHANGE (product owner): sign-in alone no longer unlocks Continue —
  // managed AI must actually be live. Provisioning normally flips
  // runtimeCapabilities.aiAvailable within seconds of sign-in; see
  // OnboardingPage's goNext structural guard, which enforces this same rule
  // server-side of the click.
  const canContinue = isLoaded && aiAvailable;
  const blockedReason = !isSignedIn && !aiAvailable;
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
              <p className="onboarding-account__intro">
                Use your existing AI subscription.
                <br />A Rolester account is optional.
              </p>
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
            {!isSignedIn ? (
              <div className="onboarding-account__panel">
                {desktopAuthAvailable ? <DesktopGoogleSignIn /> : null}
                <div className="onboarding-account__actions">
                  <RolesterSignUpButton mode="modal">
                    <Button variant="primary" className="onboarding-account__cta">
                      Create account
                    </Button>
                  </RolesterSignUpButton>
                  <RolesterSignInButton mode="modal">
                    <Button variant="secondary" className="onboarding-account__cta">
                      Log in
                    </Button>
                  </RolesterSignInButton>
                </div>
                <AccountFinePrint />
                {blockedReason ? (
                  <p className="onboarding-account__fine-print">
                    Sign in for managed AI, or sign in to one of the detected AI tools above.
                  </p>
                ) : null}
              </div>
            ) : null}

            {isSignedIn && !aiAvailable ? (
              <div className="onboarding-account__panel onboarding-account__panel--signed-in">
                <div className="onboarding-account__signed-in-main">
                  <div className="onboarding-account__identity-copy">
                    <span className="onboarding-account__signed-in-label">
                      Optional Rolester account
                    </span>
                    <strong>{accountLabel(user)}</strong>
                    {accountEmail(user) ? <span>{accountEmail(user)}</span> : null}
                  </div>
                  <div className="onboarding-key__confirmation onboarding-account__confirmation">
                    <span className="onboarding-key__check" aria-hidden="true">
                      ✓
                    </span>
                    <span>Signed in</span>
                  </div>
                </div>
                <AccountFinePrint />
                <div className="onboarding-account__managed-status">
                  <p className="onboarding-account__fine-print">
                    {aiConnectStatus === "error"
                      ? "Could not connect managed AI automatically."
                      : "Connecting managed AI…"}
                  </p>
                  {aiConnectStatus === "error" ? (
                    <Button variant="secondary" onClick={retryAiConnect}>
                      Try again
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </OnboardingShell>
  );
}
