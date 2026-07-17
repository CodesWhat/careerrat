// DesktopSignInCallbackPage.jsx — the OAuth redirect target
// (redirectUrl="/app/desktop-sign-in/sso-callback" from DesktopSignInPage.jsx's
// authenticateWithRedirect call). Loaded in the same system-browser tab as
// DesktopSignInPage.jsx, after Google hands control back to Clerk's frontend
// API. <AuthenticateWithRedirectCallback /> completes the sign-in (including
// the sign-in<->sign-up "transfer" case for first-time Google users — see its
// `transferable` prop, left at its Clerk-default `true` here on purpose) and
// then navigates the browser on to redirectUrlComplete
// (GET /api/desktop-auth/handoff, set by DesktopSignInPage.jsx) — this
// component's own render is only ever visible for an instant while that
// finishes.
import { AuthenticateWithRedirectCallback } from "@clerk/react";
import { useRolesterUser } from "./clerkControls.jsx";

const PAGE_STYLE = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  background: "var(--paper-surface)",
  color: "var(--ink)",
  fontFamily: '"Geist Sans", Inter, ui-sans-serif, system-ui, sans-serif',
  padding: "24px",
  textAlign: "center",
};

const CARD_STYLE = {
  display: "grid",
  gap: "16px",
  justifyItems: "center",
  maxWidth: "360px",
};

function DesktopSignInUnavailable() {
  return (
    <div style={PAGE_STYLE}>
      <div style={CARD_STYLE}>
        <strong>Rolester</strong>
        <p>Sign-in isn't configured for this build. Return to the Rolester app.</p>
      </div>
    </div>
  );
}

// Split from the default export below so <AuthenticateWithRedirectCallback />
// (which requires a <ClerkProvider> ancestor) is only ever mounted once we
// already know one is present — same defensive split as
// DesktopSignInPage.jsx's DesktopSignInAuthPage/DesktopSignInUnavailable.
function DesktopSignInCallbackAuthPage() {
  return (
    <div style={PAGE_STYLE}>
      <div style={CARD_STYLE}>
        <strong>Rolester</strong>
        <p>Finishing sign-in…</p>
      </div>
      {/* signInFallbackRedirectUrl/signUpFallbackRedirectUrl are a defensive
          net only — the normal path never reaches them, since
          DesktopSignInPage.jsx always sets redirectUrlComplete explicitly. */}
      <AuthenticateWithRedirectCallback
        signInFallbackRedirectUrl="/app/desktop-sign-in/error"
        signUpFallbackRedirectUrl="/app/desktop-sign-in/error"
      />
    </div>
  );
}

export function DesktopSignInCallbackPage() {
  const { hasClerkProvider } = useRolesterUser();
  return hasClerkProvider ? <DesktopSignInCallbackAuthPage /> : <DesktopSignInUnavailable />;
}
