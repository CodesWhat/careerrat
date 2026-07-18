import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  authenticateWithRedirect: vi.fn(),
  effects: [],
  hookIndex: 0,
  isLoaded: true,
  isSignedIn: false,
  slots: [],
}));

vi.mock("react", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    useCallback: (callback) => callback,
    useEffect: (effect) => {
      testState.effects.push(effect);
    },
    useState: (initialValue) => {
      const index = testState.hookIndex;
      testState.hookIndex += 1;
      if (!(index in testState.slots)) {
        testState.slots[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      return [
        testState.slots[index],
        (nextValue) => {
          testState.slots[index] =
            typeof nextValue === "function" ? nextValue(testState.slots[index]) : nextValue;
        },
      ];
    },
  };
});

vi.mock("@clerk/react", () => ({
  useClerk: () => ({
    client: {
      signIn: { authenticateWithRedirect: testState.authenticateWithRedirect },
    },
  }),
}));

vi.mock("./clerkControls.jsx", () => ({
  useRolesterUser: () => ({
    hasClerkProvider: true,
    isLoaded: testState.isLoaded,
    isSignedIn: testState.isSignedIn,
  }),
}));

import { DesktopSignInPage } from "./DesktopSignInPage.jsx";

function renderPage(path) {
  testState.hookIndex = 0;
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <DesktopSignInPage />
    </MemoryRouter>
  );
}

describe("DesktopSignInPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.authenticateWithRedirect.mockResolvedValue(undefined);
    testState.effects = [];
    testState.hookIndex = 0;
    testState.isLoaded = true;
    testState.isSignedIn = false;
    testState.slots = [];
    globalThis.window = {
      location: {
        origin: "http://localhost",
        replace: vi.fn(),
      },
    };
  });

  afterEach(() => {
    delete globalThis.window;
  });

  it("starts Google sign-in with the nonce on both callback and handoff URLs", async () => {
    renderPage("/app/desktop-sign-in?nonce=obviously-fake-nonce");

    await testState.effects[0]();

    expect(testState.authenticateWithRedirect).toHaveBeenCalledOnce();
    expect(testState.authenticateWithRedirect).toHaveBeenCalledWith({
      strategy: "oauth_google",
      redirectUrl: "http://localhost/app/desktop-sign-in/sso-callback?nonce=obviously-fake-nonce",
      redirectUrlComplete: "http://localhost/api/desktop-auth/handoff?nonce=obviously-fake-nonce",
    });
  });

  it("shows the missing-token error and never starts Clerk without a nonce", async () => {
    renderPage("/app/desktop-sign-in");

    await testState.effects[0]();
    const html = renderPage("/app/desktop-sign-in");

    expect(html).toContain("This sign-in link is missing its session token.");
    expect(testState.authenticateWithRedirect).not.toHaveBeenCalled();
  });
});
