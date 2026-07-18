import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clerkMock = vi.hoisted(() => ({
  callbackProps: null,
  hasClerkProvider: true,
}));

vi.mock("@clerk/react", () => ({
  AuthenticateWithRedirectCallback: (props) => {
    clerkMock.callbackProps = props;
    return <span data-clerk-redirect-callback />;
  },
}));

vi.mock("./clerkControls.jsx", () => ({
  useRolesterUser: () => ({ hasClerkProvider: clerkMock.hasClerkProvider }),
}));

import { DesktopSignInCallbackPage } from "./DesktopSignInCallbackPage.jsx";

function renderPage(path) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <DesktopSignInCallbackPage />
    </MemoryRouter>
  );
}

describe("DesktopSignInCallbackPage", () => {
  beforeEach(() => {
    clerkMock.callbackProps = null;
    clerkMock.hasClerkProvider = true;
  });

  it("routes every Clerk completion path to the nonce-bound desktop handoff", () => {
    renderPage("/app/desktop-sign-in/sso-callback?nonce=abc");

    expect(clerkMock.callbackProps).toMatchObject({
      signUpForceRedirectUrl: "/api/desktop-auth/handoff?nonce=abc",
      signInFallbackRedirectUrl: "/api/desktop-auth/handoff?nonce=abc",
      signUpFallbackRedirectUrl: "/api/desktop-auth/handoff?nonce=abc",
    });
  });

  it("routes every Clerk completion path to the error page without a nonce", () => {
    renderPage("/app/desktop-sign-in/sso-callback");

    expect(clerkMock.callbackProps).toMatchObject({
      signUpForceRedirectUrl: "/app/desktop-sign-in/error",
      signInFallbackRedirectUrl: "/app/desktop-sign-in/error",
      signUpFallbackRedirectUrl: "/app/desktop-sign-in/error",
    });
  });

  it("renders unavailable copy without mounting Clerk when no provider is configured", () => {
    clerkMock.hasClerkProvider = false;

    const html = renderPage("/app/desktop-sign-in/sso-callback?nonce=abc");

    expect(html).toContain("Sign-in isn&#x27;t configured for this build.");
    expect(html).toContain("Return to the Rolester app.");
    expect(clerkMock.callbackProps).toBeNull();
    expect(html).not.toContain("data-clerk-redirect-callback");
  });
});
