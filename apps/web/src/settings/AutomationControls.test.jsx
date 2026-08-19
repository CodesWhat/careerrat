import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AutomationConsentMatrix,
  AutomationModeChooser,
  AutomationSessionChooser,
  buildAutomationModePatch,
  buildAutomationSessionPatch,
} from "./AutomationControls.jsx";

const STATUS = {
  mode: "advanced",
  liveCount: 1,
  consent: { linkedin: true, gmail: false },
  capabilities: [
    {
      capability: "messaging",
      label: "In-platform messaging",
      summary: "read in-platform DMs into communications[]",
      enabled: true,
      liveCount: 1,
      platforms: [
        { platform: "linkedin", enabled: true, consent: true, allowed: true },
        { platform: "wellfound", enabled: false, consent: false, allowed: false },
      ],
    },
    {
      capability: "mail_access",
      label: "Session webmail access",
      summary: "read opted-in webmail recruiting updates",
      enabled: false,
      liveCount: 0,
      platforms: [{ platform: "gmail", enabled: false, consent: false, allowed: false }],
    },
  ],
};

describe("automation mode and consent controls", () => {
  it("defaults the browser connection to automatic and explains the effective browser", () => {
    const html = renderToStaticMarkup(
      <AutomationSessionChooser
        session={{
          provider: "auto",
          effectiveProvider: "orca",
          presence: { status: "ready", detail: "Orca workspace detected" },
          options: [
            { id: "auto", label: "Automatic browser connection" },
            { id: "orca", label: "Orca supervised browser" },
          ],
        }}
        onChange={vi.fn()}
      />
    );
    expect(html).toContain("Browser connection");
    expect(html).toContain("Automatic browser connection");
    expect(html).toContain("Using Orca");
    expect(html).toContain("Ready");
    expect(buildAutomationSessionPatch("orca")).toEqual({ session: { provider: "orca" } });
  });

  it("marks the browser extension option as unavailable for automatic apply", () => {
    const html = renderToStaticMarkup(
      <AutomationSessionChooser
        session={{
          provider: "extension",
          effectiveProvider: "extension",
          presence: {
            status: "unverified",
            detail:
              "Google Chrome detected. Confirm the extension is installed and signed in (can't be verified from outside the browser). Automatic apply isn't available on this provider yet; `careerrat automation status` lists the providers that support it.",
          },
          options: [
            { id: "auto", label: "Automatic browser connection", automatedApply: true },
            {
              id: "extension",
              label: "Chrome extension (Claude-in-Chrome / Codex)",
              automatedApply: false,
            },
            { id: "playwright", label: "Playwright persistent profile", automatedApply: true },
          ],
        }}
        onChange={vi.fn()}
      />
    );
    expect(html).toContain("Chrome extension (Claude-in-Chrome / Codex) (no automatic apply yet)");
    expect(html).not.toContain("Automatic browser connection (no automatic apply yet)");
    expect(html).not.toContain("Playwright persistent profile (no automatic apply yet)");
    expect(html).toContain("Automatic apply isn&#x27;t available on this provider yet");
    // The hint must NOT name a replacement provider: which provider to switch to
    // is the candidate's choice, not something this layer asserts (AGENTS.md
    // domain-neutral rule). It points at the provider list instead.
    expect(html).not.toContain("Playwright provider");
    expect(html).toContain("careerrat automation status");
  });

  it("explains permission defaults without asking users to understand setup modes", () => {
    const html = renderToStaticMarkup(
      <AutomationModeChooser
        status={{ ...STATUS, mode: "basic", liveCount: 0 }}
        onSetMode={vi.fn()}
      />
    );
    expect(html).toContain("Keep everything off");
    expect(html).toContain("Recommended");
    expect(html).toContain("specific connection when it becomes useful");
    expect(html).toContain("Choose individual connections");
    expect(html).toContain("Nothing turns on until you approve that connection");
    expect(html).not.toContain(">Basic<");
    expect(html).not.toContain(">Advanced<");
  });

  it("renders the canonical capability, platform, and ToS consent matrix", () => {
    const html = renderToStaticMarkup(
      <AutomationConsentMatrix
        status={STATUS}
        onCapabilityChange={vi.fn()}
        onPlatformChange={vi.fn()}
        onConsentChange={vi.fn()}
      />
    );
    expect(html).toContain("In-platform messaging");
    expect(html).toContain("Session webmail access");
    expect(html).toContain("linkedin");
    expect(html).toContain("Platform enabled");
    expect(html).toContain("I accept this platform&#x27;s automation terms");
    expect(html).toContain("1 live capability × platform pair");
    expect(html).toContain("Connection permissions");
    expect(html).not.toContain("Advanced permissions");
  });

  it("builds a hard-off patch that revokes every visible switch and consent", () => {
    expect(buildAutomationModePatch(STATUS, "basic")).toEqual({
      setup_mode: "basic",
      consent: { linkedin: false, gmail: false },
      capabilities: {
        messaging: {
          enabled: false,
          platforms: { linkedin: false, wellfound: false },
        },
        mail_access: {
          enabled: false,
          platforms: { gmail: false },
        },
      },
    });
    expect(buildAutomationModePatch(STATUS, "advanced")).toEqual({ setup_mode: "advanced" });
  });
});
