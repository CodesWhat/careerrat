// useDesktopGoogleSignIn.js — client state machine for the Electron desktop
// shell's system-browser Google OAuth handoff. Google rejects OAuth
// performed inside Electron's embedded Chromium, so this hook never talks to
// Clerk directly: it starts a short-lived nonce on the server
// (src/cli/desktop-auth-route.mjs), opens the sign-in page in the user's
// default browser (Electron's setWindowOpenHandler routes same-origin
// /app/desktop-sign-in to shell.openExternal — see
// apps/desktop/desktop-runtime.mjs's DESKTOP_SIGN_IN_PATH carve-out), polls
// for completion, claims the resulting Clerk dev-browser session jwt exactly
// once, then hands the whole Electron window over to it via a full document
// navigation (never a router nav — clerk-js needs the ?__clerk_db_jwt= param
// on an actual page load to adopt the session).
//
// Phases: idle -> starting -> waiting -> claiming -> adopting (terminal,
// navigates away) | error (retryable via start() again) | cancelled.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelDesktopSignIn,
  claimDesktopSignIn,
  getDesktopSignInStatus,
  startDesktopSignIn,
} from "../lib/api.js";

const POLL_INTERVAL_MS = 1500;
const DEFAULT_ERROR_MESSAGE = "Could not sign in with Google. Try again.";

const STATUS_ERROR_MESSAGES = {
  failed: "Sign-in was cancelled. Try again.",
  expired: "That sign-in link expired. Try again.",
  claimed: "That sign-in was already completed elsewhere. Try again.",
  unknown: "That sign-in session is no longer valid. Try again.",
};

function errorMessageFor(err, fallback = DEFAULT_ERROR_MESSAGE) {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function useDesktopGoogleSignIn() {
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState(null);

  // Refs, not state: these drive imperative control flow (poll timer,
  // in-flight nonce, unmount guard) and must never trigger their own
  // re-render or be stale-closed-over inside the poll loop's setTimeout chain.
  const nonceRef = useRef(null);
  const timerRef = useRef(null);
  const mountedRef = useRef(true);

  const clearPollTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const claimAndAdopt = useCallback(async (nonce) => {
    setPhase("claiming");
    try {
      const result = await claimDesktopSignIn(nonce);
      const jwt = result?.jwt;
      if (!result?.ok || !jwt) {
        throw new Error(DEFAULT_ERROR_MESSAGE);
      }
      if (!mountedRef.current) return;
      setPhase("adopting");
      // Full document navigation, deliberately not a router nav — clerk-js
      // reads __clerk_db_jwt off the URL on page load, adopts that
      // dev-browser client + session, and strips the param itself (see
      // node_modules/@clerk/shared/dist/devBrowser.mjs). ClerkStateBridge in
      // clerkControls.jsx carries a defensive backstop strip in case it
      // somehow doesn't.
      const origin = window.location.origin;
      window.location.replace(`${origin}/app/onboarding?__clerk_db_jwt=${encodeURIComponent(jwt)}`);
    } catch (err) {
      if (!mountedRef.current) return;
      setPhase("error");
      setError(errorMessageFor(err));
    }
  }, []);

  const pollOnce = useCallback(
    async (nonce) => {
      let statusValue;
      try {
        const result = await getDesktopSignInStatus(nonce);
        statusValue = result?.status || "unknown";
      } catch (err) {
        if (!mountedRef.current) return;
        setPhase("error");
        setError(errorMessageFor(err));
        return;
      }

      if (!mountedRef.current || nonceRef.current !== nonce) return;

      if (statusValue === "pending") {
        timerRef.current = setTimeout(() => pollOnce(nonce), POLL_INTERVAL_MS);
        return;
      }

      if (statusValue === "fulfilled") {
        void claimAndAdopt(nonce);
        return;
      }

      setPhase("error");
      setError(STATUS_ERROR_MESSAGES[statusValue] || DEFAULT_ERROR_MESSAGE);
    },
    [claimAndAdopt]
  );

  const start = useCallback(async () => {
    clearPollTimer();
    setError(null);
    setPhase("starting");
    try {
      const result = await startDesktopSignIn();
      if (!result?.ok || !result?.nonce || !result?.signInUrl) {
        throw new Error(DEFAULT_ERROR_MESSAGE);
      }
      if (!mountedRef.current) return;
      nonceRef.current = result.nonce;
      // Opened via window.open (not a plain link) so Electron's
      // setWindowOpenHandler decides where it lands — same-origin
      // /app/desktop-sign-in is carved out to shell.openExternal there.
      window.open(result.signInUrl, "_blank", "noopener,noreferrer");
      setPhase("waiting");
      timerRef.current = setTimeout(() => pollOnce(result.nonce), POLL_INTERVAL_MS);
    } catch (err) {
      if (!mountedRef.current) return;
      setPhase("error");
      setError(errorMessageFor(err));
    }
  }, [clearPollTimer, pollOnce]);

  const cancel = useCallback(() => {
    clearPollTimer();
    const nonce = nonceRef.current;
    nonceRef.current = null;
    setPhase("cancelled");
    setError(null);
    if (nonce) {
      void cancelDesktopSignIn(nonce).catch(() => {
        // best-effort — the pending record's own 10min TTL cleans it up
        // even if this notification never lands.
      });
    }
  }, [clearPollTimer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPollTimer();
    };
  }, [clearPollTimer]);

  return {
    phase,
    error,
    isWaiting: phase === "starting" || phase === "waiting" || phase === "claiming",
    start,
    cancel,
  };
}
