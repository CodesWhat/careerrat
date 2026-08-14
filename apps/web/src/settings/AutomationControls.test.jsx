import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AutomationConsentMatrix,
  AutomationModeChooser,
  buildAutomationModePatch,
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
  it("explains that Basic is the recommended hard-off mode and Advanced enables nothing by itself", () => {
    const html = renderToStaticMarkup(
      <AutomationModeChooser
        status={{ ...STATUS, mode: "basic", liveCount: 0 }}
        onSetMode={vi.fn()}
      />
    );
    expect(html).toContain("Basic");
    expect(html).toContain("Recommended");
    expect(html).toContain("read-only and manual");
    expect(html).toContain("Advanced");
    expect(html).toContain("Nothing turns on automatically");
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
  });

  it("builds a Basic patch that revokes every visible switch and consent", () => {
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
