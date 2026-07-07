import { ClerkProvider, SignInButton, SignUpButton, UserButton, useUser } from "@clerk/react";
import { createContext, useContext } from "react";

const DEFAULT_AUTH_STATE = {
  isLoaded: true,
  isSignedIn: false,
  user: null,
  hasClerkProvider: false,
};

const RolesterAuthContext = createContext(DEFAULT_AUTH_STATE);

export const ROLESTER_CLERK_APPEARANCE = {
  variables: {
    colorPrimary: "#e8553d",
    colorPrimaryForeground: "#fffaf2",
    colorDanger: "#e8553d",
    colorSuccess: "#6ca623",
    colorWarning: "#c77a2c",
    colorForeground: "#231f1c",
    colorMutedForeground: "#6b6058",
    colorBackground: "#fffaf2",
    colorInput: "#fffaf2",
    colorInputForeground: "#231f1c",
    colorBorder: "rgba(107, 96, 88, 0.2)",
    colorRing: "rgba(232, 85, 61, 0.24)",
    colorModalBackdrop: "rgba(22, 20, 15, 0.74)",
    colorShadow: "rgba(35, 31, 28, 0.22)",
    fontFamily: '"Geist", Inter, ui-sans-serif, system-ui, sans-serif',
    fontFamilyButtons: '"Geist", Inter, ui-sans-serif, system-ui, sans-serif',
    borderRadius: "8px",
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
      border: "1px solid rgba(107, 96, 88, 0.16)",
      borderRadius: "8px",
      background: "#fffaf2",
      boxShadow: "0 26px 60px rgba(35, 31, 28, 0.22)",
    },
    headerTitle: {
      color: "#231f1c",
      fontFamily: '"Fraunces", Georgia, serif',
      fontSize: "24px",
      fontWeight: "900",
      letterSpacing: "0",
    },
    headerSubtitle: {
      color: "#6b6058",
      fontSize: "14px",
      lineHeight: "1.45",
    },
    socialButtonsBlockButton: {
      minHeight: "44px",
      borderColor: "rgba(107, 96, 88, 0.18)",
      borderRadius: "8px",
      backgroundColor: "#fffaf2",
      color: "#231f1c",
      fontWeight: "800",
    },
    formFieldLabel: {
      color: "#231f1c",
      fontSize: "13px",
      fontWeight: "800",
    },
    formFieldInput: {
      minHeight: "46px",
      borderColor: "rgba(107, 96, 88, 0.22)",
      borderRadius: "8px",
      backgroundColor: "#fffaf2",
      color: "#231f1c",
      boxShadow: "none",
    },
    formButtonPrimary: {
      minHeight: "46px",
      borderRadius: "999px",
      backgroundColor: "#e8553d",
      color: "#fffaf2",
      fontSize: "14px",
      fontWeight: "900",
      boxShadow: "0 16px 34px rgba(232, 85, 61, 0.22)",
    },
    dividerLine: {
      backgroundColor: "rgba(107, 96, 88, 0.16)",
    },
    dividerText: {
      color: "#6b6058",
      fontWeight: "700",
    },
    footer: {
      borderTopColor: "rgba(107, 96, 88, 0.12)",
      background: "rgba(245, 238, 229, 0.62)",
    },
    footerActionText: {
      color: "#6b6058",
      fontWeight: "700",
    },
    footerActionLink: {
      color: "#e8553d",
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
  if (!publishableKey) {
    return <RolesterAuthStateProvider>{children}</RolesterAuthStateProvider>;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} appearance={ROLESTER_CLERK_APPEARANCE}>
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
