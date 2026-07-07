import {
  RolesterSignInButton,
  RolesterSignUpButton,
  RolesterUserButton,
  useRolesterUser,
} from "../../auth/clerkControls.jsx";
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

// Step 1 — Account. Clerk identifies the user for durable free-tier tracking,
// billing, and future hosted usage metering. AI credentials are no longer part
// of v1 onboarding; inference is routed through the product backend.
export function KeyStep({ goNext, goBack, onProgressSelect }) {
  const { isLoaded, isSignedIn, user } = useRolesterUser();
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
                No 💳 required!
              </p>
            </div>
          </div>
          <div className="onboarding-step-card__content onboarding-key__action-side onboarding-account__action-side">
            {!isSignedIn ? (
              <div className="onboarding-account__panel">
                <div className="onboarding-account__actions">
                  <RolesterSignUpButton mode="modal">
                    <button type="button" className="btn btn--primary onboarding-account__cta">
                      Create account
                    </button>
                  </RolesterSignUpButton>
                  <RolesterSignInButton mode="modal">
                    <button type="button" className="btn btn--secondary onboarding-account__cta">
                      Log in
                    </button>
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
