import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  saveCandidateFile: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../lib/api.js", () => apiMocks);

import {
  GUARDRAIL_PRESETS,
  GUARDRAIL_SUGGESTIONS,
  GuardrailsStep,
  guardrailSuggestionsForDraft,
  toggleGuardrailSignal,
} from "./GuardrailsStep.jsx";

const BASE_STATE = {
  data: {
    targeting: {
      role_buckets: [
        {
          name: "Platform + AI",
          priority: "primary",
          titles: ["Staff Platform Engineer"],
          fit_signals: ["developer tools"],
          down_signals: ["pure ML research"],
        },
      ],
      cut_signals: ["heavy travel", "low autonomy"],
    },
  },
};

function renderGuardrailsStep(props = {}) {
  return renderToStaticMarkup(
    <GuardrailsStep
      state={BASE_STATE}
      draftSeeds={{}}
      goNext={() => {}}
      goBack={() => {}}
      showToast={() => {}}
      {...props}
    />
  );
}

describe("GuardrailsStep shell layout", () => {
  it("renders person-wide guardrails without showing lane-specific role signals", () => {
    const html = renderGuardrailsStep();

    expect(html).toContain('class="onboarding-shell onboarding-shell--targeting"');
    expect(html).toContain('class="onboarding-step-label">Step 5');
    expect(html).toContain("Guardrails");
    expect(html).toContain('class="onboarding-targeting__mark" aria-hidden="true">🚫');
    expect(html).not.toContain('class="onboarding-targeting__mark" aria-hidden="true">🤝');
    expect(html).not.toContain('class="onboarding-targeting__mark" aria-hidden="true">🛡️');
    expect(html).toContain("Custom guardrails");
    expect(html).toContain("heavy travel");
    expect(html).toContain("low autonomy");
    expect(html).toContain('class="onboarding-guardrails__side-note"');
    expect(html).toContain("These apply across every role lane");
    expect(html).not.toContain("Set the person-wide no-go signals");
    expect(html).not.toContain(">Global guardrails</h2>");
    expect(html).not.toContain("developer tools");
    expect(html).not.toContain("pure ML research");
    expect(html).not.toContain("Tune role signals");
    expect(html).not.toContain("Choose your roles");
  });

  it("renders quick-pick guardrail pills before the custom input", () => {
    const html = renderGuardrailsStep();

    expect(GUARDRAIL_PRESETS.length).toBeGreaterThanOrEqual(10);
    expect(GUARDRAIL_SUGGESTIONS.length).toBeGreaterThanOrEqual(55);
    expect(html).toContain('aria-label="Common guardrails"');
    expect(html).toContain("Pick common guardrails");
    expect(html).toContain("🧳");
    expect(html).toContain("Heavy travel");
    expect(html).toContain("🏢");
    expect(html).toContain("Onsite-only");
    expect(html).toContain(
      'class="field onboarding-custom-entry onboarding-guardrails__custom-field"'
    );
    expect(html).toContain("Custom guardrails");
    expect(html).not.toContain("Custom avoids");
    expect(html).not.toContain("another no-go");
    expect(html.indexOf("Pick common guardrails")).toBeLessThan(html.indexOf("Custom guardrails"));
  });

  it("offers a deeper emoji suggestion catalog for typed custom avoids", () => {
    const remoteSuggestions = guardrailSuggestionsForDraft("remote", []);
    const visaSuggestions = guardrailSuggestionsForDraft("visa", []);

    expect(remoteSuggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ emoji: "🏠", label: "Remote unavailable" }),
      ])
    );
    expect(visaSuggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ emoji: "🛂", label: "Visa sponsorship unavailable" }),
      ])
    );
    expect(guardrailSuggestionsForDraft("travel", ["Heavy travel"])).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Heavy travel" })])
    );
    expect(GUARDRAIL_SUGGESTIONS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ emoji: "💵", label: "No salary range" }),
        expect.objectContaining({ emoji: "🌀", label: "Interview chaos" }),
        expect.objectContaining({ emoji: "📝", label: "Large unpaid take-home" }),
        expect.objectContaining({ emoji: "🔇", label: "Poor communication" }),
      ])
    );
  });

  it("uses a neutral guardrails panel instead of the shared green signal panel", () => {
    const html = renderGuardrailsStep();

    expect(html).toContain("onboarding-guardrails__panel");
    expect(html).not.toContain("onboarding-targeting__signal-panel");
  });

  it("limits presets to inferable signals and explains where they come from", () => {
    const html = renderGuardrailsStep();
    const allowedSources = new Set(["job_text", "company_scan", "interview_signal"]);

    expect(GUARDRAIL_PRESETS.every((preset) => allowedSources.has(preset.source))).toBe(true);
    expect(GUARDRAIL_PRESETS.some((preset) => preset.value === "Layoff risk")).toBe(true);
    expect(GUARDRAIL_PRESETS.some((preset) => preset.value === "Shrinking team")).toBe(false);
    expect(html).toContain("Layoff risk");
    expect(html).not.toContain("Shrinking team");
    expect(html).toContain('aria-label="How CareerRat detects guardrails"');
    expect(html).toContain("job posts");
    expect(html).toContain("company sentiment scanning");
    expect(html).toContain("interviews");
    expect(html).toContain('title="Detected from: Company scan"');
    expect(html).toContain('title="Detected from: Job text"');
  });

  it("links role-specific bad-fit guidance back to the Roles step", () => {
    const html = renderGuardrailsStep({ onProgressSelect: vi.fn() });

    expect(html).toContain("Want to mark something role-specific as a bad fit?");
    expect(html).toContain("Go back to");
    expect(html).toContain('class="onboarding-inline-link"');
    expect(html).toContain('aria-label="Go back to Roles"');
    expect(html).toContain('data-step-index="3"');
    expect(html).toContain(">Roles</button>");
    expect(html.indexOf("onboarding-guardrails__side-note")).toBeLessThan(
      html.indexOf("onboarding-targeting__content")
    );
    expect(html).not.toContain("Roles page.");
  });

  it("marks saved preset guardrails as selected", () => {
    const html = renderGuardrailsStep();

    expect(html).toContain(
      'aria-pressed="true" title="Detected from: Job text"><span aria-hidden="true">🧳</span>Heavy travel'
    );
    expect(html).toContain(
      'aria-pressed="true" title="Detected from: Interview signal"><span aria-hidden="true">🧭</span>Low autonomy'
    );
  });
});

describe("toggleGuardrailSignal", () => {
  it("adds and removes preset signals case-insensitively without disturbing custom avoids", () => {
    expect(toggleGuardrailSignal(["heavy travel", "custom concern"], "Heavy travel")).toEqual([
      "custom concern",
    ]);
    expect(toggleGuardrailSignal(["custom concern"], "Heavy travel")).toEqual([
      "custom concern",
      "Heavy travel",
    ]);
  });
});
