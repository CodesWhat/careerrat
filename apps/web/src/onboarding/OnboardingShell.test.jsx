import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RolesterAuthStateProvider } from "../auth/clerkControls.jsx";

const clerkState = vi.hoisted(() => ({
  signedIn: false,
}));

vi.mock("@clerk/react", () => ({
  SignInButton: ({ children }) => <span data-clerk="sign-in">{children}</span>,
  UserButton: () => <span data-clerk="user-button" />,
}));

import {
  getOnboardingProgressFooterClassName,
  OnboardingNavButton,
  OnboardingShell,
  OnboardingTopBar,
} from "./OnboardingShell.jsx";

beforeEach(() => {
  clerkState.signedIn = false;
});

describe("OnboardingNavButton", () => {
  it("renders accessible arrow controls without visible text labels", () => {
    const back = renderToStaticMarkup(
      <OnboardingNavButton direction="back" label="Back" onClick={vi.fn()} />
    );
    const next = renderToStaticMarkup(
      <OnboardingNavButton direction="next" label="Continue" onClick={vi.fn()} disabled />
    );

    expect(back).toContain('aria-label="Back"');
    expect(back).toContain('title="Back"');
    expect(back).toContain("onboarding-nav-button--back");
    expect(back).not.toContain(">Back<");
    expect(next).toContain('aria-label="Continue"');
    expect(next).toContain('disabled=""');
    expect(next).toContain("onboarding-nav-button--next");
    expect(next).not.toContain(">Continue<");
  });
});

describe("OnboardingTopBar", () => {
  function renderTopBar() {
    return renderToStaticMarkup(
      <RolesterAuthStateProvider
        value={{
          isLoaded: true,
          isSignedIn: clerkState.signedIn,
          user: clerkState.signedIn ? {} : null,
          hasClerkProvider: true,
        }}
      >
        <OnboardingTopBar />
      </RolesterAuthStateProvider>
    );
  }

  it("keeps onboarding chrome clean while offering Clerk login when signed out", () => {
    const html = renderTopBar();

    expect(html).toContain("onboarding-shell__header");
    expect(html).toContain("onboarding-shell__brand-lockup");
    expect(html).toContain("Rolester");
    expect(html).toContain("onboarding-shell__theme");
    expect(html).toContain('aria-label="Switch to dark mode"');
    expect(html).toContain('title="Switch to dark mode"');
    expect(html).not.toContain("onboarding-shell__brand-logo");
    expect(html).not.toContain('src="/assets/logo.png"');
    expect(html).not.toContain("Dashboard");
    expect(html).not.toContain("Jobs");
    expect(html).not.toContain("Calendar");
    expect(html).not.toContain("Network");
    expect(html).not.toContain("Library");
    expect(html).not.toContain('aria-label="Activity"');
    expect(html).not.toContain('aria-label="Settings"');
    expect(html).not.toContain("onboarding-shell__brand-divider");
    expect(html).not.toContain("onboarding-shell__primary-nav");
    expect(html).not.toContain("onboarding-shell__utilities");
    expect(html).toContain("Log in");
    expect(html).toContain('data-clerk="sign-in"');
  });

  it("shows the Clerk avatar control in the top right after sign-in", () => {
    clerkState.signedIn = true;

    const html = renderTopBar();

    expect(html).toContain("onboarding-shell__account");
    expect(html).toContain('data-clerk="user-button"');
    expect(html).not.toContain("Log in");
    expect(html.indexOf("onboarding-shell__theme")).toBeLessThan(
      html.indexOf("onboarding-shell__account")
    );
  });
});

describe("OnboardingShell action placement", () => {
  it("keeps wizard arrows in the card frame instead of a separate row below it", () => {
    const html = renderToStaticMarkup(
      <OnboardingShell
        activeIndex={1}
        actions={
          <>
            <OnboardingNavButton direction="back" label="Back" onClick={vi.fn()} />
            <OnboardingNavButton direction="next" label="Continue" onClick={vi.fn()} />
          </>
        }
      >
        <section className="onboarding-step-card">Card</section>
      </OnboardingShell>
    );

    expect(html).toContain('class="onboarding-shell__frame"');
    expect(html).toContain('class="onboarding-shell__actions"');
    expect(html.indexOf('class="onboarding-shell__frame"')).toBeLessThan(
      html.indexOf("onboarding-step-card")
    );
    expect(html.indexOf("onboarding-step-card")).toBeLessThan(
      html.indexOf('class="onboarding-shell__actions"')
    );
  });
});

describe("OnboardingShell progress footer", () => {
  it("uses an account icon for the signup footer step", () => {
    const html = renderToStaticMarkup(
      <OnboardingShell activeIndex={1}>
        <div>Account step</div>
      </OnboardingShell>
    );

    expect(html).toContain("Account");
    expect(html).toContain("👤");
    expect(html).not.toContain("Connect AI");
    expect(html).not.toContain("🔑");
  });

  it("orders Companies after Roles and before Guardrails in the footer trail", () => {
    const html = renderToStaticMarkup(
      <OnboardingShell activeIndex={5}>
        <div>Current step</div>
      </OnboardingShell>
    );

    expect(html.indexOf("Roles")).toBeLessThan(html.indexOf("Companies"));
    expect(html.indexOf("Companies")).toBeLessThan(html.indexOf("Guardrails"));
    expect(html.indexOf("Guardrails")).toBeLessThan(html.indexOf("Quick facts"));
    expect(html.indexOf("Quick facts")).toBeLessThan(html.indexOf("Track"));
    expect(html).toContain("🏢");
    expect(html).toContain("🪪");
    expect(html).not.toContain("Matches");
    expect(html).not.toContain("Prefs");
  });

  it("uses a no-entry icon for the Guardrails footer step", () => {
    const html = renderToStaticMarkup(
      <OnboardingShell activeIndex={4}>
        <div>Guardrails step</div>
      </OnboardingShell>
    );

    expect(html).toContain("Guardrails");
    expect(html).toContain("🚫");
    expect(html).not.toContain("🤝");
    expect(html).not.toContain("🛡️");
  });

  it("separates persistent visibility from the one-time reveal animation", () => {
    expect(
      getOnboardingProgressFooterClassName({ activeIndex: 0, shouldAnimateReveal: false })
    ).toBe("onboarding-progress-footer onboarding-progress-footer--hidden");
    expect(
      getOnboardingProgressFooterClassName({ activeIndex: 1, shouldAnimateReveal: true })
    ).toBe(
      "onboarding-progress-footer onboarding-progress-footer--visible onboarding-progress-footer--reveal"
    );
    expect(
      getOnboardingProgressFooterClassName({ activeIndex: 2, shouldAnimateReveal: false })
    ).toBe("onboarding-progress-footer onboarding-progress-footer--visible");
  });

  it("renders progress as a hidden footer on the welcome step", () => {
    const html = renderToStaticMarkup(
      <OnboardingShell activeIndex={0} className="onboarding-shell--welcome">
        <div>Welcome</div>
      </OnboardingShell>
    );

    expect(html).toContain("<footer");
    expect(html).toContain("onboarding-progress-footer");
    expect(html).toContain("onboarding-progress-footer--hidden");
    expect(html).not.toContain("onboarding-progress-footer--visible");
  });

  it("slides the progress footer in after Get Started advances the flow", () => {
    const html = renderToStaticMarkup(
      <OnboardingShell activeIndex={1}>
        <div>Key step</div>
      </OnboardingShell>
    );

    expect(html).toContain("<footer");
    expect(html).toContain("onboarding-progress-footer--visible");
    expect(html).not.toContain("onboarding-progress-footer--hidden");
  });

  it("renders completed footer steps as navigation buttons without making future steps clickable", () => {
    const html = renderToStaticMarkup(
      <OnboardingShell activeIndex={4} onProgressSelect={vi.fn()}>
        <div>Companies step</div>
      </OnboardingShell>
    );

    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-label="Go to Resume"');
    expect(html).toContain('data-step-index="2"');
    expect(html).toContain("onboarding-progress__case--clickable");
    expect(html).toContain(
      '<span class="onboarding-progress__case onboarding-progress__case--filled onboarding-progress__case--active"'
    );
    expect(html).toContain(">Guardrails</span>");
    expect(html).not.toContain('aria-label="Go to Companies"');
    expect(html).not.toContain('aria-label="Go to Guardrails"');
  });

  it("keeps cleared future steps filled and clickable after navigating backward", () => {
    const html = renderToStaticMarkup(
      <OnboardingShell activeIndex={2} completedIndexes={[1, 2, 3, 4]} onProgressSelect={vi.fn()}>
        <div>Back on resume</div>
      </OnboardingShell>
    );

    expect(html).toContain('aria-label="Go to Roles"');
    expect(html).toContain('data-step-index="3"');
    expect(html).toContain('aria-label="Go to Companies"');
    expect(html).toContain('data-step-index="4"');
    expect(html).not.toContain('aria-label="Go to Guardrails"');
    expect(countOccurrences(html, "onboarding-progress__case--filled")).toBe(4);
  });
});

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}
