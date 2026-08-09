import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  previewBoards: vi.fn(async () => ({})),
  saveCandidateFile: vi.fn(async () => ({ ok: true })),
  suggestAssist: vi.fn(async () => ({ suggestions: [] })),
}));

vi.mock("../../lib/api.js", () => apiMocks);

import { assistErrorMessage, TargetingStep } from "./TargetingStep.jsx";

const BASE_STATE = {
  data: {
    profile: {
      candidate: { headline: "Product-minded infrastructure engineer" },
      location: { home: "Brooklyn, NY", remote: true },
      compensation: { minimum_base: 180000 },
    },
    targeting: {
      role_buckets: [
        {
          name: "Primary",
          priority: "primary",
          titles: ["Staff Platform Engineer"],
          notes: "Platform-heavy roles",
          fit_signals: ["developer tools"],
          down_signals: ["frontend-only"],
        },
      ],
      keep_signals: ["developer tools"],
      cut_signals: ["crypto"],
    },
  },
};

function renderTargetingStep(props = {}) {
  return renderToStaticMarkup(
    <TargetingStep
      state={BASE_STATE}
      draftSeeds={{}}
      aiEnabled={false}
      goNext={() => {}}
      goBack={() => {}}
      showToast={() => {}}
      {...props}
    />
  );
}

describe("TargetingStep shell layout", () => {
  it("renders AI-picked role lanes as a review step instead of a raw targeting form", () => {
    const html = renderTargetingStep({
      state: { data: { profile: BASE_STATE.data.profile, targeting: {} } },
      draftSeeds: {
        targeting: {
          role_buckets: [
            {
              name: "Platform + AI",
              priority: "primary",
              titles: ["Staff Platform Engineer", "AI Infrastructure Engineer"],
              notes: "Strongest match from resume",
              fit_signals: ["production AI systems", "LLM implementation"],
              down_signals: ["pure ML research", "frontend-only"],
            },
          ],
          keep_signals: ["developer tools", "AI infrastructure"],
          cut_signals: ["heavy travel"],
        },
      },
    });

    expect(html).toContain('class="onboarding-shell');
    expect(html).toContain('class="onboarding-step-label">Step 3');
    expect(html).toContain('class="onboarding-step-card onboarding-targeting');
    expect(html).toContain('class="onboarding-shell__actions"');
    expect(html).toContain('aria-label="Back"');
    expect(html).toContain('aria-label="Continue"');
    expect(html).toContain("onboarding-nav-button--back");
    expect(html).toContain("onboarding-nav-button--next");
    expect(html).not.toContain(">Back<");
    expect(html).not.toContain("Save &amp; continue");
    expect(html).toContain(
      'class="onboarding-targeting__media-copy"><h1 id="onboarding-targeting-title">Choose your roles</h1>'
    );
    expect(html).not.toContain("onboarding-targeting__stats");
    expect(html).toContain("Platform + AI");
    expect(html).toContain("Staff Platform Engineer");
    expect(html).toContain("AI Infrastructure Engineer");
    expect(html).toContain("Strongest match from resume");
    expect(html).toContain(
      'class="onboarding-targeting__summary-card onboarding-targeting__summary-card--role"'
    );
    expect(html).toContain(
      'class="onboarding-targeting__lanes onboarding-targeting__lanes--anchored"'
    );
    expect(html).toContain(
      'class="onboarding-targeting__priority-pill onboarding-targeting__priority-pill--corner"'
    );
    expect(html).toContain('class="onboarding-targeting__summary-main"');
    expect(html).toContain('aria-label="Edit Platform + AI"');
    expect(html).toContain('class="onboarding-targeting__edit-emoji" aria-hidden="true">✏️');
    expect(html).toContain("Add another lane");
    expect(html).toContain(
      'class="onboarding-targeting__lane-actions onboarding-targeting__lane-actions--bottom"'
    );
    expect(html).toContain('class="onboarding-targeting__add-icon" aria-hidden="true"');
    expect(html.indexOf("AI Infrastructure Engineer")).toBeLessThan(
      html.indexOf("Strongest match from resume")
    );
    expect(html).toContain('class="onboarding-targeting__tag-copy"');
    expect(html).toContain("Good fit");
    expect(html).toContain("Bad fit");
    expect(html).not.toContain("Good fit signals");
    expect(html).not.toContain("Downrank signals");
    expect(html).toContain("production AI systems");
    expect(html).toContain("LLM implementation");
    expect(html).toContain("pure ML research");
    expect(html).toContain("frontend-only");
    expect(html).toContain("onboarding-targeting__summary-signals");
    expect(html).toContain("onboarding-targeting__summary-signal-row");
    expect(html).toContain("onboarding-targeting__summary-pill-list");
    expect(html).toContain("onboarding-targeting__signal-pill");
    expect(html).toContain('aria-label="Remove production AI systems from Good fit"');
    expect(html).toContain('aria-label="Remove frontend-only from Bad fit"');
    expect(html).not.toContain("production AI systems, LLM implementation");
    expect(html).not.toContain("pure ML research, frontend-only");
    expect(html).toContain("onboarding-targeting__tag-box onboarding-targeting__tag-box--good");
    expect(html).toContain("onboarding-targeting__tag-box onboarding-targeting__tag-box--bad");
    expect(html).not.toContain("Go with Roland");
    expect(html).not.toContain("Roland picked these from your resume");
    expect(html).not.toContain("Roland took a pass");
    expect(html).not.toContain("Skip signals");
    expect(html).not.toContain("heavy travel");
    expect(html).not.toContain("onboarding-targeting__signal-panel");
    expect(html).not.toContain("Search tracks");
    expect(html).not.toContain("Keep signals");
    expect(html).not.toContain("Cut signals");
    expect(html).not.toContain("Lane name");
    expect(html).not.toContain("wizard-actions");
  });

  it("describes unavailable role suggestions without asking for an AI key", () => {
    expect(assistErrorMessage({ status: 501 })).toBe(
      "CareerRat suggestions are unavailable right now — add or edit roles manually."
    );
  });

  it("uses a compact wand tool for role-title suggestions in edit mode", () => {
    const html = renderTargetingStep({
      aiEnabled: true,
      initialEditingBucket: 0,
    });

    expect(html).toContain("Edit Primary");
    expect(html).toContain('aria-label="Find more titles"');
    expect(html).toContain("onboarding-targeting__field-tool");
    expect(html).toContain("onboarding-targeting__field-tool-glyph");
    expect(html).toContain("✨");
    expect(html).toContain('class="onboarding-targeting__tool-tip" role="tooltip"');
    expect(html).toContain("Find more titles");
    expect(html).not.toContain(">More role ideas<");
  });

  it("ISSUE-006: blocks Continue while any visible role lane has no job titles", () => {
    const html = renderTargetingStep({
      state: { data: { profile: BASE_STATE.data.profile, targeting: {} } },
      draftSeeds: {
        targeting: {
          role_buckets: [
            { name: "Platform", priority: "primary", titles: ["Staff Platform Engineer"] },
            { name: "Another lane", priority: "secondary", titles: [] },
          ],
        },
      },
    });

    const continueTag = html.match(/<button[^>]*aria-label="Continue"[^>]*>/)?.[0] || "";
    expect(continueTag).toContain("disabled");
    expect(html).toContain("Every role lane needs at least one job title.");
  });
});
