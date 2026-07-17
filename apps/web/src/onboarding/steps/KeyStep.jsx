import {
  RolesterSignInButton,
  RolesterSignUpButton,
  RolesterUserButton,
  useRolesterUser,
} from "../../auth/clerkControls.jsx";
import { useDesktopGoogleSignIn } from "../../auth/useDesktopGoogleSignIn.js";
import { Button } from "../../components/Button.jsx";
import { OnboardingNavButton, OnboardingShell } from "../OnboardingShell.jsx";

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

// Step 1 — Account. Clerk identifies the user for durable free-tier tracking,
// billing, and future hosted usage metering. AI credentials are no longer part
// of v1 onboarding; inference is routed through the product backend.
export function KeyStep({ goNext, goBack, onProgressSelect }) {
  const { isLoaded, isSignedIn, user, desktopAuthAvailable } = useRolesterUser();
  const canContinue = isLoaded && isSignedIn;

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
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </OnboardingShell>
  );
}
