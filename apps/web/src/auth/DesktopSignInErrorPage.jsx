// DesktopSignInErrorPage.jsx — defensive net for the system-browser Google
// OAuth handoff (see DesktopSignInPage.jsx's header comment for the full
// flow). Clerk's signInFallbackRedirectUrl/signUpFallbackRedirectUrl on
// DesktopSignInCallbackPage.jsx point here; the normal path never reaches
// it, since DesktopSignInPage.jsx always sets an explicit
// redirectUrlComplete. No Clerk hooks needed here — just a static message
// and a way back in.
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../components/Button.jsx";

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

export function DesktopSignInErrorPage() {
  const [searchParams] = useSearchParams();
  const nonce = (searchParams.get("nonce") || "").trim();

  // Without a nonce a retry can't complete the desktop handoff (the sign-in
  // page would just dead-end on its own missing-session-token error), so
  // don't offer a Try again loop that can never work — send the user back to
  // the app's Sign in button, which mints a fresh nonce.
  return (
    <div style={PAGE_STYLE}>
      <div style={CARD_STYLE}>
        <strong>Rolester</strong>
        <p>Something went wrong finishing Google sign-in.</p>
        {nonce ? (
          <Link to={`/desktop-sign-in?nonce=${encodeURIComponent(nonce)}`}>
            <Button variant="primary">Try again</Button>
          </Link>
        ) : (
          <p>Return to the Rolester app and click Sign in again.</p>
        )}
      </div>
    </div>
  );
}
