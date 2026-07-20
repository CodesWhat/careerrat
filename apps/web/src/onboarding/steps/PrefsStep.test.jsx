import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  saveCandidateFile: vi.fn(async () => ({ ok: true })),
}));
const captured = vi.hoisted(() => ({ chipInputs: [] }));

vi.mock("../../lib/api.js", () => apiMocks);
vi.mock("../../components/form.jsx", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ChipInput: (props) => {
      captured.chipInputs.push(props);
      return actual.ChipInput(props);
    },
  };
});

import * as prefsStepModule from "./PrefsStep.jsx";
import {
  buildQuickFactsSavePayload,
  LINK_PREFIXES,
  PrefsStep,
  prefixedLinkBackspaceValue,
  prefixedLinkFocusValue,
  prefixedLinkPasteValue,
  seedQuickFactsLinks,
} from "./PrefsStep.jsx";

const BASE_STATE = {
  data: {
    modes: {
      usage_mode: "standard",
      application_mode: "balanced",
    },
    "form-defaults": {
      auto_submit: false,
      expected_base: 190000,
      current_employer: "Acme",
      current_title: "Staff Engineer",
      eeo_default: "Prefer not to say",
      linkedin: "https://linkedin.com/in/example",
      github: "https://github.com/example",
      portfolio: "https://example.com",
      additional_links: [{ label: "X", url: "https://x.com/example" }],
    },
    profile: {
      candidate: {
        linkedin: "https://linkedin.com/in/profile-source",
        github: "https://github.com/profile-source",
        portfolio: "https://profile-source.example",
        additional_links: [{ label: "Blog", url: "https://blog.example" }],
      },
    },
    targeting: {
      cut_signals: ["heavy travel", "low autonomy"],
    },
  },
};

function countOccurrences(value, token) {
  return (value.match(new RegExp(token, "g")) || []).length;
}

function renderPrefsStep(props = {}) {
  captured.chipInputs = [];
  return renderToStaticMarkup(
    <PrefsStep
      state={BASE_STATE}
      goNext={() => {}}
      goBack={() => {}}
      showToast={() => {}}
      {...props}
    />
  );
}

describe("PrefsStep shell layout", () => {
  it("renders Step 6 as quick facts instead of app preferences", () => {
    const html = renderPrefsStep();

    expect(html).toContain('class="onboarding-shell onboarding-shell--targeting"');
    expect(countOccurrences(html, "onboarding-progress__case--filled")).toBe(7);
    expect(html).toContain('class="onboarding-step-stack onboarding-step-stack--targeting"');
    expect(html).toContain('class="onboarding-step-label">Step 6');
    expect(html).toContain("Quick facts");
    expect(html).toContain("LinkedIn");
    expect(html).toContain("GitHub");
    expect(html).toContain("Website");
    expect(html).not.toContain("Portfolio");
    expect(html).toContain("Add more");
    expect(html).toContain("https://linkedin.com/in/profile-source");
    expect(html).toContain("https://github.com/profile-source");
    expect(html).toContain("https://profile-source.example");
    expect(html).toContain("https://blog.example");
    expect(html).not.toContain("Preferences");
    expect(html).not.toContain("Modes");
    expect(html).not.toContain("Form defaults");
    expect(html).not.toContain("Usage mode");
    expect(html).not.toContain("Application mode");
    expect(html).not.toContain("Auto-submit");
    expect(html).not.toContain("Expected base");
    expect(html).not.toContain("Current employer");
    expect(html).not.toContain("Current title");
    expect(html).not.toContain("EEO default");
    expect(html).not.toContain("Acme");
    expect(html).not.toContain("Staff Engineer");
    expect(html).not.toContain("190000");
    expect(html).not.toContain("Prefer not to say");
    expect(html).not.toContain("Global guardrails");
    expect(html).not.toContain("Profile links");
    expect(html).not.toContain(
      "These usually come from the resume. Keep the ones you want Rolester to show."
    );
    expect(html).not.toContain("heavy travel");
    expect(html).not.toContain("low autonomy");
    expect(html).toContain('aria-label="Back"');
    expect(html).toContain('aria-label="Continue"');
  });

  it("keeps legacy wide-card preferences out of onboarding", () => {
    const html = renderPrefsStep();

    expect(html).toContain(
      'class="onboarding-step-card onboarding-targeting onboarding-quick-facts"'
    );
    expect(html).toContain('class="onboarding-shell__actions"');
    expect(html).toContain("onboarding-nav-button--back");
    expect(html).toContain("onboarding-nav-button--next");
    expect(html).not.toContain(">Back<");
    expect(html).not.toContain("Save &amp; continue");
    expect(html).not.toContain("wizard-actions");
  });

  it("renders profile links as icon-led rows", () => {
    const html = renderPrefsStep();

    expect(html).toContain(
      'class="onboarding-quick-facts__link-row onboarding-quick-facts__link-row--linkedin"'
    );
    expect(html).toContain(
      'class="onboarding-quick-facts__link-row onboarding-quick-facts__link-row--github"'
    );
    expect(html).toContain(
      'class="onboarding-quick-facts__link-row onboarding-quick-facts__link-row--portfolio"'
    );
    expect(html).toContain(
      'class="onboarding-quick-facts__link-icon onboarding-quick-facts__link-icon--linkedin"'
    );
    expect(html).toContain(
      'class="onboarding-quick-facts__link-icon onboarding-quick-facts__link-icon--github"'
    );
    expect(html).toContain(
      'class="onboarding-quick-facts__link-icon onboarding-quick-facts__link-icon--website"'
    );
    expect(html).toContain('class="field onboarding-quick-facts__link-field"');
  });

  it("keeps additional public links as a bottom add-more area", () => {
    const html = renderPrefsStep();

    expect(html).toContain('class="onboarding-quick-facts__add-area"');
    expect(html).toContain('class="onboarding-quick-facts__custom-link"');
    expect(html).toContain('aria-label="Remove Blog"');
    expect(html).toContain('placeholder="Label"');
    expect(html).toContain('placeholder="https://example.com"');
    expect(html).toContain('class="onboarding-quick-facts__add-button"');
    expect(html).toContain("+");
    expect(html).toContain("Add more");
  });

  it("renders slug-friendly link fields without ellipsis URL placeholders", () => {
    const html = renderPrefsStep({
      state: {
        data: {
          modes: {},
          "form-defaults": {},
          profile: { candidate: {} },
        },
      },
    });

    expect(html).toContain(`data-link-prefix="${LINK_PREFIXES.linkedin}"`);
    expect(html).toContain(`data-link-prefix="${LINK_PREFIXES.github}"`);
    expect(html).toContain(`data-link-prefix="${LINK_PREFIXES.portfolio}"`);
    expect(html).toContain('placeholder="your-slug"');
    expect(html).toContain('placeholder="username"');
    expect(html).toContain('placeholder="your-site.com"');
    expect(html).not.toContain("https://linkedin.com/in/...");
    expect(html).not.toContain("https://github.com/...");
    expect(html).not.toContain("https://...");
  });

  it("renders the Remote, Hybrid, and On-site work-mode pills", () => {
    const html = renderPrefsStep();

    expect(html).toContain('aria-label="Work mode"');
    expect(html).toContain(">Remote</button>");
    expect(html).toContain(">Hybrid</button>");
    expect(html).toContain(">On-site</button>");
    expect(html).toContain("Required — pick one.");
  });

  it("keeps commas inside relocation cities and documents Enter as the commit key", () => {
    const html = renderPrefsStep();
    const relocationInput = captured.chipInputs.find(
      (props) => props.id === "quick-facts-relocation"
    );

    expect(relocationInput).toBeDefined();
    expect(relocationInput.commitOnComma).toBe(false);
    expect(html).toContain("Press Enter to add another city.");
    expect(html).not.toContain("Press Enter or comma to add another city.");
  });

  it("prefills home base from profile.location.home before candidate.location", () => {
    const html = renderPrefsStep({
      state: {
        ...BASE_STATE,
        data: {
          ...BASE_STATE.data,
          profile: {
            ...BASE_STATE.data.profile,
            location: { home: "Brooklyn, NY" },
            candidate: {
              ...BASE_STATE.data.profile.candidate,
              location: "Queens, NY",
            },
          },
        },
      },
    });

    expect(html).toContain('id="quick-facts-home-base"');
    expect(html).toContain('value="Brooklyn, NY"');
    expect(html).not.toContain('value="Queens, NY"');
  });

  it("falls back to candidate.location when profile.location.home is absent", () => {
    const html = renderPrefsStep({
      state: {
        ...BASE_STATE,
        data: {
          ...BASE_STATE.data,
          profile: {
            ...BASE_STATE.data.profile,
            candidate: {
              ...BASE_STATE.data.profile.candidate,
              location: "Queens, NY",
            },
          },
        },
      },
    });

    expect(html).toContain('value="Queens, NY"');
  });
});

describe("quick facts data shaping", () => {
  it("requires a home base or Remote before Continue can save", () => {
    expect(prefsStepModule.hasPrefsSearchLocation({ homeBase: "", workModes: [] })).toBe(false);
    expect(prefsStepModule.hasPrefsSearchLocation({ homeBase: "Lisbon", workModes: [] })).toBe(
      true
    );
    expect(prefsStepModule.hasPrefsSearchLocation({ homeBase: "", workModes: ["remote"] })).toBe(
      true
    );
    expect(
      prefsStepModule.hasPrefsSearchLocation({ homeBase: "", workModes: ["hybrid", "onsite"] })
    ).toBe(false);
  });

  it("seeds links from profile before duplicated form defaults", () => {
    expect(seedQuickFactsLinks(BASE_STATE.data)).toEqual({
      linkedin: "https://linkedin.com/in/profile-source",
      github: "https://github.com/profile-source",
      portfolio: "https://profile-source.example",
      additional_links: [{ label: "Blog", url: "https://blog.example" }],
    });
  });

  it("saves public links while setting hidden defaults without current role, base, or EEO prompts", () => {
    const payload = buildQuickFactsSavePayload({
      links: {
        linkedin: "https://linkedin.com/in/person",
        github: "",
        portfolio: "https://person.example",
        additional_links: [
          { label: " Blog ", url: " https://blog.example " },
          { label: "Empty", url: "" },
          { label: "", url: "https://speakerdeck.com/person" },
        ],
      },
      modesData: {},
      formDefaultsData: { eeo_default: "" },
    });

    expect(payload).toEqual({
      profile: {
        candidate: {
          linkedin: "https://linkedin.com/in/person",
          github: "",
          portfolio: "https://person.example",
          additional_links: [
            { label: "Blog", url: "https://blog.example" },
            { label: "Link", url: "https://speakerdeck.com/person" },
          ],
        },
      },
      modes: {
        usage_mode: "standard",
        application_mode: "balanced",
        agent_voice: "standard",
      },
      formDefaults: {
        auto_submit: false,
        eeo_default: "Prefer not to answer",
        linkedin: "https://linkedin.com/in/person",
        github: "",
        portfolio: "https://person.example",
        additional_links: [
          { label: "Blog", url: "https://blog.example" },
          { label: "Link", url: "https://speakerdeck.com/person" },
        ],
      },
    });
    expect(payload.formDefaults).not.toHaveProperty("current_employer");
    expect(payload.formDefaults).not.toHaveProperty("current_title");
    expect(payload.formDefaults).not.toHaveProperty("expected_base");
  });

  it("includes the exact location patch only when location signals are present", () => {
    const payload = buildQuickFactsSavePayload({
      workModes: ["remote", "hybrid", "onsite"],
      homeBase: " New York, NY ",
      relocationList: [" Boston, MA ", ""],
    });

    expect(payload.profile.location).toEqual({
      remote: true,
      home: "New York, NY",
      relocation: ["Boston, MA"],
    });
  });

  it("omits profile.location entirely when all location signals are empty", () => {
    const payload = buildQuickFactsSavePayload({
      workModes: [],
      homeBase: " ",
      relocationList: [""],
    });

    expect(payload.profile).not.toHaveProperty("location");
  });

  it("backfills candidate.location from home base only while the candidate value is empty", () => {
    const emptyCandidate = buildQuickFactsSavePayload({
      homeBase: "New York, NY",
      existingCandidateLocation: "",
    });
    const existingCandidate = buildQuickFactsSavePayload({
      homeBase: "New York, NY",
      existingCandidateLocation: "Jersey City, NJ",
    });

    expect(emptyCandidate.profile.candidate.location).toBe("New York, NY");
    expect(existingCandidate.profile.candidate).not.toHaveProperty("location");
  });
});

describe("prefixed quick-facts link input behavior", () => {
  it("starts an empty field with the URL prefix on focus", () => {
    expect(prefixedLinkFocusValue("", LINK_PREFIXES.linkedin)).toBe(LINK_PREFIXES.linkedin);
    expect(prefixedLinkFocusValue("https://example.com", LINK_PREFIXES.portfolio)).toBe(
      "https://example.com"
    );
  });

  it("clears an untouched prefix with one Backspace but leaves typed values alone", () => {
    expect(
      prefixedLinkBackspaceValue({
        value: LINK_PREFIXES.github,
        prefix: LINK_PREFIXES.github,
        selectionStart: LINK_PREFIXES.github.length,
        selectionEnd: LINK_PREFIXES.github.length,
      })
    ).toBe("");
    expect(
      prefixedLinkBackspaceValue({
        value: `${LINK_PREFIXES.github}octocat`,
        prefix: LINK_PREFIXES.github,
        selectionStart: `${LINK_PREFIXES.github}octocat`.length,
        selectionEnd: `${LINK_PREFIXES.github}octocat`.length,
      })
    ).toBe(null);
  });

  it("replaces the whole field on paste, preserving full URLs and prefixing slugs", () => {
    expect(prefixedLinkPasteValue("octocat", LINK_PREFIXES.github)).toBe(
      `${LINK_PREFIXES.github}octocat`
    );
    expect(
      prefixedLinkPasteValue("https://www.linkedin.com/in/person", LINK_PREFIXES.linkedin)
    ).toBe("https://www.linkedin.com/in/person");
  });
});
