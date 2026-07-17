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
  const retryPath = nonce
    ? `/desktop-sign-in?nonce=${encodeURIComponent(nonce)}`
    : "/desktop-sign-in";

  return (
    <div style={PAGE_STYLE}>
      <div style={CARD_STYLE}>
        <strong>Rolester</strong>
        <p>Something went wrong finishing Google sign-in.</p>
        <Link to={retryPath}>
          <Button variant="primary">Try again</Button>
        </Link>
      </div>
    </div>
  );
}
