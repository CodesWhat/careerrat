import { ClerkProvider, SignInButton, SignUpButton, UserButton, useUser } from "@clerk/react";
import { createContext, useContext } from "react";
import { getStaticPreviewAuthState, isStaticPreviewApi } from "../preview/staticPreviewApi.js";

const DEFAULT_AUTH_STATE = {
  isLoaded: true,
  isSignedIn: false,
  user: null,
  hasClerkProvider: false,
};

const RolesterAuthContext = createContext(DEFAULT_AUTH_STATE);

// Colors/radii below are read straight from tokens.css custom properties (via
// CSS var()/color-mix() strings, Clerk's documented mechanism for theming
// its appearance prop) rather than concrete values, so the widget tracks the
// app's [data-theme="dark"] flip automatically with no JS re-render needed.
export const ROLESTER_CLERK_APPEARANCE = {
  variables: {
    colorPrimary: "var(--coral)",
    colorPrimaryForeground: "var(--paper-surface)",
    colorDanger: "var(--coral)",
    colorSuccess: "var(--teal)",
    colorWarning: "var(--mustard)",
    colorForeground: "var(--ink)",
    colorMutedForeground: "var(--ink-soft)",
    colorBackground: "var(--paper-surface)",
    colorInput: "var(--paper-surface)",
    colorInputForeground: "var(--ink)",
    colorBorder: "color-mix(in srgb, var(--ink-soft) 20%, transparent)",
    colorRing: "color-mix(in srgb, var(--coral) 24%, transparent)",
    colorModalBackdrop: "rgba(0, 0, 0, 0.74)",
    colorShadow: "rgba(0, 0, 0, 0.22)",
    fontFamily: '"Geist Sans", Inter, ui-sans-serif, system-ui, sans-serif',
    fontFamilyButtons: '"Geist Sans", Inter, ui-sans-serif, system-ui, sans-serif',
    borderRadius: "var(--card-radius)",
    spacing: "0.92rem",
  },
  elements: {
    rootBox: {
      width: "100%",
      minHeight: "100%",
      display: "grid",
      placeItems: "center",
    },
    cardBox: {
      margin: "0 auto",
      width: "min(430px, calc(100vw - 48px))",
    },
    card: {
      width: "100%",
      border: "1px solid color-mix(in srgb, var(--ink-soft) 16%, transparent)",
      borderRadius: "var(--card-radius)",
      background: "var(--paper-surface)",
      boxShadow: "var(--card-shadow)",
    },
    headerTitle: {
      color: "var(--ink)",
      fontFamily: '"Fraunces", Georgia, serif',
      fontSize: "24px",
      fontWeight: "900",
      letterSpacing: "0",
    },
    headerSubtitle: {
      color: "var(--ink-soft)",
      fontSize: "14px",
      lineHeight: "1.45",
    },
    socialButtonsBlockButton: {
      minHeight: "44px",
      border: "1px solid var(--paper-edge-strong)",
      borderRadius: "999px",
      backgroundColor: "var(--paper-surface)",
      color: "var(--ink)",
      fontWeight: "600",
    },
    socialButtonsBlockButtonText: {
      fontFamily: '"Geist Sans", Inter, ui-sans-serif, system-ui, sans-serif',
      fontWeight: "600",
      color: "var(--ink)",
    },
    formFieldLabel: {
      color: "var(--ink)",
      fontSize: "13px",
      fontWeight: "800",
    },
    formFieldInput: {
      minHeight: "46px",
      borderColor: "color-mix(in srgb, var(--ink-soft) 22%, transparent)",
      borderRadius: "var(--card-radius)",
      backgroundColor: "var(--paper-surface)",
      color: "var(--ink)",
      boxShadow: "none",
    },
    formButtonPrimary: {
      minHeight: "46px",
      borderRadius: "999px",
      backgroundColor: "var(--coral)",
      color: "var(--paper-surface)",
      fontSize: "14px",
      fontWeight: "900",
      boxShadow: "0 16px 34px color-mix(in srgb, var(--coral) 22%, transparent)",
    },
    dividerLine: {
      backgroundColor: "color-mix(in srgb, var(--ink-soft) 16%, transparent)",
    },
    dividerText: {
      color: "var(--ink-soft)",
      fontWeight: "700",
    },
    footer: {
      borderTopColor: "color-mix(in srgb, var(--ink-soft) 12%, transparent)",
      background: "color-mix(in srgb, var(--paper-band) 62%, transparent)",
    },
    footerActionText: {
      color: "var(--ink-soft)",
      fontWeight: "700",
    },
    footerActionLink: {
      color: "var(--coral)",
      fontWeight: "900",
    },
  },
};

export function RolesterAuthStateProvider({ value = {}, children }) {
  return (
    <RolesterAuthContext.Provider value={{ ...DEFAULT_AUTH_STATE, ...value }}>
      {children}
    </RolesterAuthContext.Provider>
  );
}

function ClerkStateBridge({ children }) {
  const clerkUser = useUser();

  return (
    <RolesterAuthStateProvider value={{ ...clerkUser, hasClerkProvider: true }}>
      {children}
    </RolesterAuthStateProvider>
  );
}

export function RolesterClerkProvider({ publishableKey, children }) {
  if (isStaticPreviewApi()) {
    return (
      <RolesterAuthStateProvider value={getStaticPreviewAuthState()}>
        {children}
      </RolesterAuthStateProvider>
    );
  }

  if (!publishableKey) {
    return <RolesterAuthStateProvider>{children}</RolesterAuthStateProvider>;
  }

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      appearance={ROLESTER_CLERK_APPEARANCE}
      // Clerk's default post-auth redirect lands on the app ORIGIN ROOT
      // (e.g. http://127.0.0.1:PORT/?__clerk_db_jwt=...), which has no
      // product route mounted there (see tracker-dev.mjs — only /app/* is
      // the SPA). Pin the fallback (used when the sign-in/up flow itself
      // didn't already carry a `redirect_url`) back into the SPA so
      // completing auth never leaves /app/*. These are the current (v6)
      // Clerk prop names — the predecessor afterSignInUrl/afterSignUpUrl are
      // gone in this SDK version (see apps/web/package.json).
      signInFallbackRedirectUrl="/app/onboarding"
      signUpFallbackRedirectUrl="/app/onboarding"
    >
      <ClerkStateBridge>{children}</ClerkStateBridge>
    </ClerkProvider>
  );
}

export function useRolesterUser() {
  return useContext(RolesterAuthContext);
}

export function RolesterSignInButton({ children, mode = "modal" }) {
  const { hasClerkProvider } = useRolesterUser();
  return hasClerkProvider ? <SignInButton mode={mode}>{children}</SignInButton> : children;
}

export function RolesterSignUpButton({ children, mode = "modal" }) {
  const { hasClerkProvider } = useRolesterUser();
  return hasClerkProvider ? <SignUpButton mode={mode}>{children}</SignUpButton> : children;
}

export function RolesterUserButton(props) {
  const { hasClerkProvider } = useRolesterUser();
  return hasClerkProvider ? <UserButton {...props} /> : <span aria-hidden="true">👤</span>;
}
