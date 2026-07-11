import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const clerkProps = vi.hoisted(() => ({
  provider: null,
}));

vi.mock("@clerk/react", () => ({
  ClerkProvider: (props) => {
    clerkProps.provider = props;
    return <div data-clerk-provider>{props.children}</div>;
  },
  SignInButton: ({ children }) => <span data-clerk="sign-in">{children}</span>,
  SignUpButton: ({ children }) => <span data-clerk="sign-up">{children}</span>,
  UserButton: () => <span data-clerk="user-button" />,
  useUser: () => ({ isLoaded: true, isSignedIn: false, user: null }),
}));

import { ROLESTER_CLERK_APPEARANCE, RolesterClerkProvider } from "./clerkControls.jsx";

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
});
