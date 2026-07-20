import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WelcomeStep } from "./WelcomeStep.jsx";

function renderWelcome() {
  return renderToStaticMarkup(<WelcomeStep state={{ files: [] }} goNext={vi.fn()} />);
}

describe("WelcomeStep", () => {
  it("keeps onboarding inside the canonical React app flow", () => {
    const html = renderWelcome();

    expect(html).toContain("Rolester");
    expect(html).not.toContain("onboarding-shell__brand-logo");
    expect(html).toContain("onboarding-hero__mark");
    expect(html).not.toContain("Dashboard");
    expect(html).not.toContain("Jobs");
    expect(html).not.toContain("Calendar");
    expect(html).not.toContain("Log in");
    expect(html).toContain("onboarding-shell__account");
    expect(html).toContain("Get Started");
    expect(html).toContain("onboarding-hero--wash");
    expect(html).not.toContain('href="/onboard"');
    expect(html).not.toContain("Prefer the classic step-by-step page?");
  });

  it("uses the website sidekick tagline with a hand-drawn underline", () => {
    const html = renderWelcome();

    expect(html).toContain("A");
    expect(html).toContain("sidekick");
    expect(html).toContain("for");
    expect(html).toContain('aria-label="A sidekick for your job search."');
    expect(html).toContain("your job");
    expect(html).toContain("search.");
    expect(html).toContain("onboarding-hero__underline-word");
    expect(html).toContain("onboarding-hero__underline");
    expect(html).not.toContain("Get your job search moving.");
  });

  it("keeps for with your job on the second headline line", () => {
    const html = renderWelcome();

    expect(html).toContain('<span class="onboarding-hero__line">for your job</span>');
    expect(html).not.toContain("for<br/>your job search.");
  });
});
