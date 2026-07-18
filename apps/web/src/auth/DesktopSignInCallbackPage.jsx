// DesktopSignInCallbackPage.jsx — the OAuth redirect target
// (redirectUrl="/app/desktop-sign-in/sso-callback?nonce=…" from
// DesktopSignInPage.jsx's authenticateWithRedirect call). Loaded in the same
// system-browser tab as DesktopSignInPage.jsx, after Google hands control
// back to Clerk's frontend API. <AuthenticateWithRedirectCallback />
// completes the sign-in and navigates on to redirectUrlComplete
// (GET /api/desktop-auth/handoff) — EXCEPT for first-time Google users,
// where Clerk "transfers" the sign-in into a sign-up and completes that via
// the sign-UP redirect props instead, ignoring redirectUrlComplete. That
// transfer case is why the nonce rides the callback URL: with it we can
// point the sign-up redirect at the same handoff, so brand-new users finish
// exactly like returning ones (the handoff's cookie-fallback page covers a
// dev instance not appending __clerk_db_jwt to this URL). Without a nonce
// (stale/hand-typed link) the sign-up path falls back to the error page.
import { AuthenticateWithRedirectCallback } from "@clerk/react";
import { useSearchParams } from "react-router-dom";
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
  const [searchParams] = useSearchParams();
  const nonce = (searchParams.get("nonce") || "").trim();
  const handoffUrl = nonce ? `/api/desktop-auth/handoff?nonce=${encodeURIComponent(nonce)}` : null;
  const errorUrl = nonce
    ? `/app/desktop-sign-in/error?nonce=${encodeURIComponent(nonce)}`
    : "/app/desktop-sign-in/error";
  return (
    <div style={PAGE_STYLE}>
      <div style={CARD_STYLE}>
        <strong>Rolester</strong>
        <p>Finishing sign-in…</p>
      </div>
      {/* The sign-UP force redirect is the load-bearing one: Clerk's
          first-time-user transfer completes as a sign-up and ignores
          redirectUrlComplete, so without this a new Google account dead-ends
          on the error page. Returning users still ride redirectUrlComplete;
          the fallbacks stay as the defensive net. */}
      <AuthenticateWithRedirectCallback
        signUpForceRedirectUrl={handoffUrl || errorUrl}
        signInFallbackRedirectUrl={handoffUrl || errorUrl}
        signUpFallbackRedirectUrl={handoffUrl || errorUrl}
      />
    </div>
  );
}

export function DesktopSignInCallbackPage() {
  const { hasClerkProvider } = useRolesterUser();
  return hasClerkProvider ? <DesktopSignInCallbackAuthPage /> : <DesktopSignInUnavailable />;
}
