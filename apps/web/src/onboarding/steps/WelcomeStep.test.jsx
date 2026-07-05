import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WelcomeStep } from "./WelcomeStep.jsx";

function renderWelcome() {
  return renderToStaticMarkup(<WelcomeStep state={{ files: [] }} goNext={vi.fn()} />);
}

describe("WelcomeStep", () => {
  it("keeps onboarding inside the canonical React app flow", () => {
    const html = renderWelcome();

    expect(html).toContain("Get started");
    expect(html).not.toContain('href="/onboard"');
    expect(html).not.toContain("Prefer the classic step-by-step page?");
  });
});
