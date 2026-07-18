import { useCallback, useEffect, useRef, useState } from "react";
import {
  RolesterSignInButton,
  RolesterSignUpButton,
  RolesterUserButton,
  useRolesterUser,
} from "../../auth/clerkControls.jsx";
import { useDesktopGoogleSignIn } from "../../auth/useDesktopGoogleSignIn.js";
import { Button } from "../../components/Button.jsx";
import { connectManagedAi } from "../../lib/api.js";
import { OnboardingNavButton, OnboardingShell } from "../OnboardingShell.jsx";

// After the auto-provision effect's first attempt fails, one silent retry
// before surfacing an error — see useManagedAiAutoProvision below.
const AUTO_PROVISION_RETRY_DELAY_MS = 2000;

const ACCOUNT_AVATAR_SIZE = "96px";
const ACCOUNT_USER_BUTTON_APPEARANCE = {
  elements: {
    userButtonTrigger: {
      width: ACCOUNT_AVATAR_SIZE,
      height: ACCOUNT_AVATAR_SIZE,
      minWidth: ACCOUNT_AVATAR_SIZE,
      minHeight: ACCOUNT_AVATAR_SIZE,
      padding: "0",
      borderRadius: "999px",
      overflow: "hidden",
      boxShadow: "none",
    },
    userButtonAvatarBox: {
      width: ACCOUNT_AVATAR_SIZE,
      height: ACCOUNT_AVATAR_SIZE,
      borderRadius: "999px",
      overflow: "hidden",
    },
    avatarBox: {
      width: ACCOUNT_AVATAR_SIZE,
      height: ACCOUNT_AVATAR_SIZE,
      borderRadius: "999px",
      overflow: "hidden",
    },
    avatarImage: {
      width: "100%",
      height: "100%",
      objectFit: "cover",
    },
  },
};

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

// Step 1 — Account. Clerk identifies the user for durable free-tier tracking,
// billing, and future hosted usage metering. Signing in auto-provisions
// managed AI (useManagedAiAutoProvision above); pasting an Anthropic key on
// the Settings page remains the manual fallback for anyone who'd rather not
// use it.
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
              <h1 id="onboarding-account-title">Your Rolester account.</h1>
              <p className="onboarding-account__intro">
                Free tier forever.
                <br />
                No credit card required.
              </p>
            </div>
          </div>
          <div className="onboarding-step-card__content onboarding-key__action-side onboarding-account__action-side">
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
                    Sign in and AI connects automatically, or paste your own Anthropic API key.
                  </p>
                ) : null}
              </div>
            ) : null}

            {isSignedIn ? (
              <div className="onboarding-account__panel onboarding-account__panel--signed-in">
                <span className="onboarding-account__signed-in-label">Signed in as</span>
                <div className="onboarding-account__signed-in-main">
                  <div className="onboarding-account__identity">
                    <div className="onboarding-account__avatar">
                      <RolesterUserButton
                        afterSignOutUrl="/app/onboarding"
                        appearance={ACCOUNT_USER_BUTTON_APPEARANCE}
                      />
                    </div>
                    <div className="onboarding-account__identity-copy">
                      <strong>{accountLabel(user)}</strong>
                      {accountEmail(user) ? <span>{accountEmail(user)}</span> : null}
                    </div>
                  </div>
                  <div className="onboarding-key__confirmation onboarding-account__confirmation">
                    <span className="onboarding-key__check" aria-hidden="true">
                      ✓
                    </span>
                    <span>Account ready</span>
                  </div>
                </div>
                <AccountFinePrint />
                {!aiAvailable ? (
                  <div className="onboarding-account__panel">
                    <p className="onboarding-account__fine-print">
                      {aiConnectStatus === "error"
                        ? "Could not connect managed AI automatically."
                        : "Connecting AI…"}
                    </p>
                    {aiConnectStatus === "error" ? (
                      <Button
                        variant="secondary"
                        className="onboarding-account__cta"
                        onClick={retryAiConnect}
                      >
                        Try again
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </OnboardingShell>
  );
}
