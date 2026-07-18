import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const clerkProps = vi.hoisted(() => ({
  provider: null,
  getToken: vi.fn(async () => "obviously-fake-jwt"),
}));

vi.mock("@clerk/react", () => ({
  ClerkProvider: (props) => {
    clerkProps.provider = props;
    return <div data-clerk-provider>{props.children}</div>;
  },
  SignInButton: ({ children }) => <span data-clerk="sign-in">{children}</span>,
  SignUpButton: ({ children }) => <span data-clerk="sign-up">{children}</span>,
  UserButton: () => <span data-clerk="user-button" />,
  useAuth: () => ({ getToken: clerkProps.getToken }),
  useUser: () => ({ isLoaded: true, isSignedIn: false, user: null }),
}));

import {
  ROLESTER_CLERK_APPEARANCE,
  RolesterClerkProvider,
  useRolesterUser,
} from "./clerkControls.jsx";

function AuthStateProbe() {
  const { getToken } = useRolesterUser();
  return <span data-has-get-token={getToken === clerkProps.getToken ? "yes" : "no"} />;
}

function colorMixPercentage(value) {
  const match = value.match(/color-mix\([^,]+,\s*var\(--[^)]+\)\s+([\d.]+)%/i);
  expect(match).not.toBeNull();
  return Number(match[1]);
}

// Overlay values are exempt from the token rule: they stay theme-independent
// black (see the rationale comment on them in clerkControls.jsx).
const TOKEN_RULE_EXEMPT_KEYS = new Set(["colorModalBackdrop", "colorShadow"]);

function collectColorValues(value, path = "appearance") {
  return Object.entries(value).flatMap(([key, nestedValue]) => {
    const nestedPath = `${path}.${key}`;
    if (nestedValue && typeof nestedValue === "object") {
      return collectColorValues(nestedValue, nestedPath);
    }
    return typeof nestedValue === "string" &&
      nestedValue !== "none" &&
      !TOKEN_RULE_EXEMPT_KEYS.has(key) &&
      /(color|background|border|shadow)$/i.test(key)
      ? [[nestedPath, nestedValue]]
      : [];
  });
}

describe("RolesterClerkProvider", () => {
  it("passes centered Rolester modal styling to Clerk when configured", () => {
    renderToStaticMarkup(
      <RolesterClerkProvider publishableKey="pk_test_rolester">
        <span>App</span>
      </RolesterClerkProvider>
    );

    expect(clerkProps.provider.publishableKey).toBe("pk_test_rolester");
    expect(clerkProps.provider.appearance).toBe(ROLESTER_CLERK_APPEARANCE);
    expect(clerkProps.provider.appearance.variables.colorPrimary).toBe("var(--coral)");
    expect(clerkProps.provider.appearance.variables.borderRadius).toBe("var(--card-radius)");
    expect(clerkProps.provider.appearance.elements.rootBox).toMatchObject({
      width: "100%",
      minHeight: "100%",
      display: "grid",
      placeItems: "center",
    });
    expect(clerkProps.provider.appearance.elements.cardBox).toMatchObject({
      margin: "0 auto",
      width: "min(430px, calc(100vw - 48px))",
    });
    expect(clerkProps.provider.appearance.elements.formButtonPrimary).toMatchObject({
      backgroundColor: "var(--coral)",
      color: "var(--paper-surface)",
    });
  });

  it("keeps social buttons visually distinct from the card", () => {
    const { card, socialButtonsBlockButton: socialButton } = ROLESTER_CLERK_APPEARANCE.elements;

    expect(socialButton.backgroundColor).not.toBe(card.background);
    expect(colorMixPercentage(socialButton.border)).toBeGreaterThan(
      colorMixPercentage(card.border)
    );
  });

  it("keeps the footer background opaque", () => {
    const { background } = ROLESTER_CLERK_APPEARANCE.elements.footer;

    expect(background).not.toMatch(/transparent/i);
    expect(background).not.toMatch(/color-mix\(/i);
  });

  it("keeps appearance colors tied to CSS custom-property tokens", () => {
    const colorValues = collectColorValues(ROLESTER_CLERK_APPEARANCE);

    expect(colorValues.length).toBeGreaterThan(0);
    for (const [path, value] of colorValues) {
      expect(value, path).toMatch(/var\(--[^)]+\)/);
      expect(value, path).not.toMatch(/#[\da-f]{3,8}\b/i);
    }
  });

  it("exposes Clerk getToken through the Rolester auth context", () => {
    const html = renderToStaticMarkup(
      <RolesterClerkProvider publishableKey="pk_test_rolester">
        <AuthStateProbe />
      </RolesterClerkProvider>
    );

    expect(html).toContain('data-has-get-token="yes"');
  });
});
