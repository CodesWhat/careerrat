// DesktopSignInPage.jsx — loaded in the user's SYSTEM browser, never inside
// Electron's embedded Chromium (see apps/desktop/desktop-runtime.mjs's
// DESKTOP_SIGN_IN_PATH carve-out, which is what routes this exact same-origin
// path out to shell.openExternal instead of leaving it in-window). A fresh
// browser tab means a fresh Clerk dev-browser client — ClerkProvider (see
// ../auth/clerkControls.jsx, mounted once at the app root in main.jsx)
// provisions that automatically, no special handling needed here.
//
// This page's only job: once Clerk has loaded, kick off the Google OAuth
// redirect. The eventual redirectUrlComplete lands the browser on
// GET /api/desktop-auth/handoff (src/cli/desktop-auth-route.mjs), which is
// what actually hands the finished session back to the waiting Electron
// window — this page never sees that part of the flow.
import { useClerk } from "@clerk/react";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../components/Button.jsx";
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

// Split from DesktopSignInPage below so useClerk() (which throws if there is
// no <ClerkProvider> ancestor) is only ever called once we already know one
// is mounted — see clerkControls.jsx's RolesterClerkProvider, which skips
// wrapping children in <ClerkProvider> entirely when no publishableKey is
// configured.
function DesktopSignInAuthPage() {
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useRolesterUser();
  const [searchParams] = useSearchParams();
  const nonce = (searchParams.get("nonce") || "").trim();
  const [error, setError] = useState(null);
  const [attempting, setAttempting] = useState(false);

  const startRedirect = useCallback(async () => {
    if (!nonce) {
      setError(
        "This sign-in link is missing its session token. Return to the Rolester app and try again."
      );
      return;
    }
    if (!clerk?.client?.signIn) {
      setError("Sign-in isn't ready yet. Try again in a moment.");
      return;
    }
    const origin = window.location.origin;
    const handoffUrl = `${origin}/api/desktop-auth/handoff?nonce=${encodeURIComponent(nonce)}`;
    setAttempting(true);
    setError(null);
    try {
      await clerk.client.signIn.authenticateWithRedirect({
        strategy: "oauth_google",
        // nonce rides along so the sso-callback page can route the
        // first-time-user transfer (sign-in -> sign-up) to the handoff too —
        // Clerk does not honor redirectUrlComplete on that path.
        redirectUrl: `${origin}/app/desktop-sign-in/sso-callback?nonce=${encodeURIComponent(nonce)}`,
        redirectUrlComplete: handoffUrl,
      });
      // On success the browser navigates away to Google — nothing else to do.
    } catch (err) {
      // Clerk refuses a new sign-in attempt when this browser is already
      // signed in (single-session instance) — but an existing session is
      // exactly what the handoff needs, so skip Google and let the handoff
      // page's cookie fallback pick it up.
      if (err?.errors?.[0]?.code === "session_exists") {
        window.location.replace(handoffUrl);
        return;
      }
      setAttempting(false);
      setError(err instanceof Error ? err.message : "Could not start Google sign-in.");
    }
  }, [clerk, nonce]);

  // Fires once Clerk finishes loading (isLoaded flips false -> true). If the
  // system browser already holds a signed-in Clerk session (a repeat desktop
  // sign-in — very common), there is no Google dance to run at all: go
  // straight to the handoff URL, whose cookie-fallback page hands the
  // existing dev-browser session back to the waiting Electron window.
  // startRedirect itself guards on clerk.client being ready.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-runs only on isLoaded, not on every startRedirect identity change
  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn && nonce) {
      window.location.replace(`/api/desktop-auth/handoff?nonce=${encodeURIComponent(nonce)}`);
      return;
    }
    void startRedirect();
  }, [isLoaded]);

  return (
    <div style={PAGE_STYLE}>
      <div style={CARD_STYLE}>
        <strong>Rolester</strong>
        {error ? (
          <>
            <p>{error}</p>
            <Button variant="primary" onClick={startRedirect} disabled={attempting}>
              Try again
            </Button>
          </>
        ) : (
          <p>Redirecting to Google…</p>
        )}
      </div>
    </div>
  );
}

export function DesktopSignInPage() {
  const { hasClerkProvider } = useRolesterUser();
  return hasClerkProvider ? <DesktopSignInAuthPage /> : <DesktopSignInUnavailable />;
}
