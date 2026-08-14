import { describe, expect, it } from "vitest";
import { buildQuickFactsSavePayload } from "./quickFacts.js";

// Moved verbatim from the deleted onboarding/steps/PrefsStep.test.jsx —
// these test cases exercise buildQuickFactsSavePayload, the one export from
// the dead PrefsStep wizard step that survived (settings/SettingsPage.jsx
// still uses it). Test cases exercising the dead PrefsStep component or its
// other unused helpers were deleted along with the component.
describe("buildQuickFactsSavePayload", () => {
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

  it("ISSUE-009: normalizes a fully qualified custom URL instead of saving a double scheme", () => {
    const payload = buildQuickFactsSavePayload({
      links: {
        additional_links: [
          {
            label: "Writing",
            url: "https://https://morgan-hale.example.invalid/writing",
          },
        ],
      },
    });

    expect(payload.profile.candidate.additional_links).toEqual([
      {
        label: "Writing",
        url: "https://morgan-hale.example.invalid/writing",
      },
    ]);
    expect(payload.formDefaults.additional_links).toEqual(
      payload.profile.candidate.additional_links
    );
  });

  it("includes the exact location patch only when location signals are present", () => {
    const payload = buildQuickFactsSavePayload({
      workModes: ["remote", "hybrid", "onsite"],
      homeBase: " New York, NY ",
      relocationList: [" Boston, MA ", ""],
      commuteRadiusMiles: 25,
    });

    expect(payload.profile.location).toEqual({
      remote: true,
      hybrid: true,
      onsite: true,
      home: "New York, NY",
      relocation: ["Boston, MA"],
      commute_radius_miles: 25,
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
