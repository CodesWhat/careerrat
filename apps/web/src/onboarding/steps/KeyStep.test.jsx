import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  signedIn: false,
  user: {
    primaryEmailAddress: { emailAddress: "test@rolester.test" },
    fullName: "Test User",
  },
}));

vi.mock("@clerk/react", () => ({
  SignInButton: ({ children }) => <span data-clerk="sign-in">{children}</span>,
  SignUpButton: ({ children }) => <span data-clerk="sign-up">{children}</span>,
  UserButton: ({ appearance }) => (
    <span
      data-clerk="user-button"
      data-trigger-width={appearance?.elements?.userButtonTrigger?.width || ""}
      data-trigger-height={appearance?.elements?.userButtonTrigger?.height || ""}
      data-avatar-width={appearance?.elements?.userButtonAvatarBox?.width || ""}
      data-avatar-height={appearance?.elements?.userButtonAvatarBox?.height || ""}
    />
  ),
}));

import { RolesterAuthStateProvider } from "../../auth/clerkControls.jsx";
import { KeyStep } from "./KeyStep.jsx";

function renderKeyStep() {
  return renderToStaticMarkup(
    <RolesterAuthStateProvider
      value={{
        isLoaded: true,
        isSignedIn: clerkState.signedIn,
        user: clerkState.signedIn ? clerkState.user : null,
        hasClerkProvider: true,
      }}
    >
      <KeyStep reload={async () => {}} goNext={vi.fn()} goBack={vi.fn()} showToast={vi.fn()} />
    </RolesterAuthStateProvider>
  );
}

beforeEach(() => {
  clerkState.signedIn = false;
});

describe("Account step", () => {
  it("renders as a focused signup screen instead of an AI-key entry screen", () => {
    const html = renderKeyStep();

    expect(html).toContain("Rolester");
    expect(html).toContain("Your Rolester account.");
    expect(html).toContain("Free tier forever.");
    expect(html).toContain("No 💳 required!");
    expect(html).toContain("Create account");
    expect(html).toContain("Log in");
    expect(html).toContain("Signing in keeps usage tied to you.");
    expect(html).not.toContain("Create or log in to your Rolester account.");
    expect(html).not.toContain("Free to start, no credit card required.");
    expect(html).not.toContain("Create your Rolester account.");
    expect(html).not.toContain("Get started for free. No credit card required.");
    expect(html).toContain('class="onboarding-account__intro"');
    expect(html).toContain('class="onboarding-account__fine-print"');
    expect(html).toContain(
      'class="onboarding-account__fine-print-marker" aria-hidden="true">*</span>'
    );
    expect(html).not.toContain('class="onboarding-account__hero-copy"');
    expect(html).not.toContain("Start with the free plan");
    expect(html).not.toContain("Signing in starts your free tier");
    expect(html).not.toContain("billing tied");
    expect(html).not.toContain("Free gets you started");
    expect(html).not.toContain("instead of this Mac");
    expect(html).not.toContain("Clerk handles identity");
    expect(html).not.toContain("caps and billing live");
    expect(html).toContain("onboarding-key__title-side");
    expect(html).toContain("onboarding-key__action-side");
    expect(html).toContain('class="onboarding-targeting__mark" aria-hidden="true">👤');
    expect(html).not.toContain("onboarding-key__visual");
    expect(html).not.toContain("onboarding-key__badge");
    expect(html).not.toContain("onboarding-key__provider-name");
    expect(html).not.toContain("onboarding-key__lock");
    expect(html.indexOf("onboarding-key__title-side")).toBeLessThan(
      html.indexOf("onboarding-key__action-side")
    );
    expect(html.indexOf("onboarding-key__action-side")).toBeLessThan(
      html.indexOf("Signing in keeps usage tied to you.")
    );
    expect(html.indexOf("onboarding-account__actions")).toBeLessThan(
      html.indexOf("Signing in keeps usage tied to you.")
    );
    expect(html).toContain('aria-label="Continue"');
    expect(html).toContain("onboarding-nav-button--next");
    expect(html).not.toContain(">Continue<");
    expect(html).not.toContain("Save key");
    expect(html).not.toContain("Anthropic");
    expect(html).not.toContain("API key");
    expect(html).not.toContain("Connected (BYOK)");
    expect(html).not.toContain("Seven quick steps");
    expect(html).toContain('disabled=""');
  });

  it("unlocks continue and shows the signed-in identity after Clerk signs in", () => {
    clerkState.signedIn = true;

    const html = renderKeyStep();

    expect(html).toContain("Test User");
    expect(html).toContain("test@rolester.test");
    expect(html).toContain("Account ready");
    expect(html).toContain("Signing in keeps usage tied to you.");
    expect(html).toContain(
      'class="onboarding-account__fine-print-marker" aria-hidden="true">*</span>'
    );
    expect(html).toContain('class="onboarding-account__signed-in-label"');
    expect(html).toContain("Signed in as");
    expect(html).toContain('class="onboarding-account__identity"');
    expect(html).toContain('class="onboarding-account__avatar"');
    expect(html).toContain('class="onboarding-account__identity-copy"');
    expect(html.indexOf("Signed in as")).toBeLessThan(html.indexOf("onboarding-account__identity"));
    expect(html.indexOf("onboarding-account__avatar")).toBeLessThan(html.indexOf("Test User"));
    expect(html).toContain('data-trigger-width="96px"');
    expect(html).toContain('data-trigger-height="96px"');
    expect(html).toContain('data-avatar-width="96px"');
    expect(html).toContain('data-avatar-height="96px"');
    expect(html).not.toContain('class="onboarding-account__ready-card"');
    expect(html).not.toContain('class="onboarding-account__ready-copy"');
    expect(html).not.toContain("onboarding-account__signed-in-header");
    expect(html).toContain('data-clerk="user-button"');
    expect(html).not.toContain("Create account");
    expect(html).not.toContain('disabled=""');
  });
});
