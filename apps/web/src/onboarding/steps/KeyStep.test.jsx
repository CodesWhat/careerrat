import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getAutomationSettings: vi.fn(),
  getInstalledAiRuntimes: vi.fn(),
  openInstalledAiRuntimeTerminal: vi.fn(),
  probeInstalledAiRuntime: vi.fn(),
  selectInstalledAiRuntime: vi.fn(),
  saveCandidateFile: vi.fn(),
}));

vi.mock("../../lib/api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ...api,
}));

import { InstalledRuntimeChoices, KeyStep } from "./KeyStep.jsx";

function renderKeyStep({ aiAvailable = false } = {}) {
  return renderToStaticMarkup(
    <KeyStep
      reload={async () => {}}
      goNext={vi.fn()}
      goBack={vi.fn()}
      showToast={vi.fn()}
      runtimeCapabilities={{ aiAvailable }}
    />
  );
}

function continueButtonMarkup(html) {
  return html.match(/<button[^>]*aria-label="Continue"[^>]*>/)?.[0] || "";
}

beforeEach(() => {
  api.getInstalledAiRuntimes.mockResolvedValue({
    selectedId: null,
    providerFallback: false,
    runtimes: [],
  });
  api.getAutomationSettings.mockResolvedValue({
    mode: "basic",
    liveCount: 0,
    consent: {},
    capabilities: [],
  });
});

describe("Account step", () => {
  it("presents installed AI tools as the primary route and provider credentials as Advanced", () => {
    const html = renderToStaticMarkup(
      <InstalledRuntimeChoices
        state={{
          selectedId: "codex",
          providerFallback: false,
          runtimes: [
            {
              id: "claude",
              name: "Claude Code",
              commandShape: "claude -p --output-format json",
              available: true,
              ready: false,
              status: "authentication_required",
              action: "open_terminal",
              selected: false,
            },
            {
              id: "codex",
              name: "Codex",
              commandShape: "codex exec --json -",
              available: true,
              ready: true,
              status: "ready",
              selected: true,
            },
          ],
        }}
        onSelect={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(html).toContain("Use an AI tool already on this computer");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Open Terminal to sign in");
    expect(html).toContain("Retry detection");
    expect(html).toContain("Codex");
    expect(html).toContain("Selected");
    expect(html).toContain("Use a provider API key instead");
    expect(html).toContain("Advanced");
    expect(html).not.toContain('type="password"');
  });

  it("renders local AI setup with no account/sign-in affordance", () => {
    const html = renderKeyStep();

    expect(html).toContain("Rolester");
    expect(html).toContain("Set up Rolester.");
    expect(html).toContain("Use your existing AI subscription.");
    expect(html).toContain("How hands-on should Rolester be?");
    expect(html).toContain("Nothing turns on automatically");
    expect(html).not.toContain("Create account");
    expect(html).not.toContain("Log in");
    expect(html).not.toContain("Signing in keeps usage tied to you.");
    expect(html).not.toContain("Signed in");
    expect(html).not.toContain("onboarding-account__fine-print");
    expect(html).not.toContain("onboarding-account__actions");
    expect(html).not.toContain("onboarding-account__panel");
    expect(html).toContain('class="onboarding-account__intro"');
    expect(html).toContain("onboarding-key__title-side");
    expect(html).toContain("onboarding-key__action-side");
    expect(html).toContain('class="onboarding-targeting__mark" aria-hidden="true">👤');
    expect(html.indexOf("onboarding-key__title-side")).toBeLessThan(
      html.indexOf("onboarding-key__action-side")
    );
    expect(html).toContain('aria-label="Continue"');
    expect(html).toContain("onboarding-nav-button--next");
    expect(html).not.toContain(">Continue<");
    expect(html).not.toContain("Save key");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Connected (BYOK)");
    expect(html).not.toContain("Seven quick steps");
    expect(html).toContain('disabled=""');
  });

  it("enables Continue once managed/local AI is available", () => {
    const html = renderKeyStep({ aiAvailable: true });

    expect(html).toContain('aria-label="Continue"');
    expect(continueButtonMarkup(html)).not.toContain("disabled");
  });

  it("keeps Continue disabled while no AI route is available", () => {
    const html = renderKeyStep({ aiAvailable: false });

    expect(continueButtonMarkup(html)).toContain("disabled");
  });
});
