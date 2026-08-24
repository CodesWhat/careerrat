import { describe, expect, it } from "vitest";
import {
  buildProfileSettingsModel,
  permissionPatch,
  profileSectionSavePlan,
} from "./profile-settings-controller.js";

describe("profile settings controller mapping", () => {
  it("maps canonical candidate, engine, source, and permission state into the handoff", () => {
    const model = buildProfileSettingsModel({
      onboard: {
        publicSyncPreference: {
          enabled: false,
          source: "user",
          updatedAt: "2026-08-23T12:30:00Z",
        },
        data: {
          profile: {
            candidate: { name: "Scott" },
            compensation: { oe_min_base: 210000, expected_base: 230000 },
            location: {
              home: "NYC",
              remote: true,
              hybrid: true,
              onsite: true,
              relocation: [],
              mode_preferences_confirmed: true,
            },
          },
          targeting: {
            role_buckets: [{ titles: ["Staff Software Engineer", "Engineering Lead"] }],
            cut_signals: ["Fully onsite"],
            keep_signals: ["Platform ownership"],
            fit_bands: { fit_floor: 74 },
            search_preferences: { cadence: { mode: "every-3-days" } },
          },
          evidence: { claims: [{ id: "e1" }, { id: "e2" }] },
          deepIngest: {
            confirmed: {
              evidence: [
                { id: "claim-1", role: "Staff Engineer" },
                { id: "claim-2", role: "Engineering Lead", promotion: true },
              ],
              storyBank: [{ id: "story-1" }, { id: "story-2" }, { id: "story-3" }],
              writingVoice: [
                {
                  id: "voice-1",
                  summary: "Short sentences, concrete verbs",
                  doPhrases: ["Lead with the result"],
                  avoidPhrases: ["Excited to apply"],
                },
              ],
              roleSignals: [],
            },
            sources: [{ id: "resume-1", fileName: "resume.pdf" }],
            counts: { confirmed: 6 },
          },
          honesty: { claims: { do_not_fabricate: ["No invented metrics"] } },
          modes: { agent_name: "Scout" },
        },
      },
      runtimes: {
        selectedId: "codex",
        runtimes: [
          { id: "codex", name: "Codex", ready: true },
          { id: "custom", name: "Custom command", ready: false, available: false },
        ],
      },
      automation: {
        capabilities: [
          { capability: "authenticated_search", enabled: true },
          { capability: "authenticated_apply_preparation", enabled: false },
          { capability: "mail_access", enabled: false },
        ],
        session: {
          provider: "auto",
          effectiveProvider: "extension",
          presence: {
            status: "unverified",
            detail: "Google Chrome detected. Confirm the extension is signed in.",
          },
          options: [
            {
              id: "auto",
              label: "Automatic browser connection",
              automatedApply: false,
            },
            {
              id: "extension",
              label: "Chrome extension",
              automatedApply: false,
            },
            {
              id: "playwright",
              label: "Playwright persistent profile",
              automatedApply: true,
            },
          ],
          tooling: {
            playwright: {
              packageInstalled: true,
              browserInstalled: true,
              ready: true,
              detail: "Playwright and Chromium are installed.",
            },
          },
        },
      },
      sources: {
        searches: [
          { enabled: true, lastRunAt: "2026-08-23T11:00:00Z" },
          { enabled: true, lastRunAt: "2026-08-23T12:00:00Z" },
        ],
        companies: [
          { enabled: true, lastRunAt: "2026-08-23T10:00:00Z" },
          { enabled: false, status: "blocked" },
        ],
      },
    });

    expect(model.profile).toMatchObject({
      targets: ["Staff Software Engineer", "Engineering Lead"],
      compensation: { floor: "$210k", target: "$230k" },
      dealbreakers: ["Fully onsite"],
      locationPolicy: {
        home: "NYC",
        remoteRegion: "United States",
        hybrid: true,
        onsite: true,
        confirmed: true,
        summary: "NYC local + US remote",
        boundary: "On-site limited to NYC",
      },
      evidence: { roles: 2, promotions: 1, stories: 3 },
      searchRules: ["1 board pinned", "Sweeps every 3 days", "Shows only fit 74+"],
    });
    expect(model.profile.editors).toMatchObject({
      targets: {
        title: "Edit targets",
        fields: [{ id: "titles", value: "Staff Software Engineer\nEngineering Lead" }],
      },
      compensation: {
        fields: [
          { id: "minimumBase", value: "210000" },
          { id: "targetBase", value: "230000" },
        ],
      },
      "writing-style": {
        itemId: "voice-1",
        fields: [
          { id: "summary", value: "Short sentences, concrete verbs" },
          { id: "doPhrases", value: "Lead with the result" },
          { id: "avoidPhrases", value: "Excited to apply" },
        ],
      },
      "search-rules": {
        fields: [
          { id: "keepSignals", value: "Platform ownership" },
          { id: "cadence", value: "every-3-days" },
          { id: "fitFloor", value: "74" },
        ],
      },
    });
    expect(model.engine).toMatchObject({ name: "Codex", connected: true, selectedId: "codex" });
    expect(model.agentName).toBe("Scout");
    expect(
      model.permissions.find((row) => row.id === "authenticated_apply_preparation")?.description
    ).toBe("Scout fills authenticated forms, you press every submit");
    expect(model.engine.choices.map((choice) => choice.id)).toEqual(["codex", "custom"]);
    expect(model.permissions.map((row) => [row.id, row.enabled])).toEqual([
      ["draft_documents", true],
      ["authenticated_search", true],
      ["authenticated_apply_preparation", false],
      ["mail_access", false],
    ]);
    expect(model.browser).toEqual({
      providerId: "auto",
      provider: "Automatic browser connection",
      effectiveProviderId: "extension",
      effectiveProvider: "Chrome extension",
      presenceStatus: "unverified",
      presenceDetail: "Google Chrome detected. Confirm the extension is signed in.",
      automaticFillSupported: false,
      options: [
        {
          id: "auto",
          label: "Automatic browser connection",
          needs: "",
          automatedApply: false,
        },
        {
          id: "extension",
          label: "Chrome extension",
          needs: "",
          automatedApply: false,
        },
        {
          id: "playwright",
          label: "Playwright persistent profile",
          needs: "",
          automatedApply: true,
        },
      ],
      playwright: {
        packageInstalled: true,
        browserInstalled: true,
        ready: true,
        detail: "Playwright and Chromium are installed.",
      },
    });
    expect(model.sources).toMatchObject({
      scannedCount: 3,
      pinnedCount: 1,
      blockedCount: 1,
      lastSweep: "2026-08-23T12:00:00Z",
    });
    expect(model.publicSyncPreference).toEqual({
      enabled: false,
      source: "user",
      updatedAt: "2026-08-23T12:30:00Z",
    });
  });

  it("builds the existing automation config patch and keeps draft documents always on", () => {
    expect(permissionPatch("authenticated_apply_preparation", true)).toEqual({
      setup_mode: "advanced",
      capabilities: { authenticated_apply_preparation: { enabled: true } },
    });
    expect(permissionPatch("draft_documents", false)).toBeNull();
  });

  it("marks draft documents as an honest fixed capability instead of a switch", () => {
    const model = buildProfileSettingsModel();

    expect(model.permissions.find((row) => row.id === "draft_documents")).toMatchObject({
      enabled: true,
      mutable: false,
      statusLabel: "Always on",
    });
    expect(
      model.permissions.filter((row) => row.id !== "draft_documents").every((row) => row.mutable)
    ).toBe(true);
    expect(model.publicSyncPreference).toEqual({
      enabled: true,
      source: "default",
      updatedAt: null,
    });
  });

  it("turns every editable profile section into a canonical whole-section write", () => {
    expect(
      profileSectionSavePlan("targets", { titles: "Staff Engineer\nEngineering Lead" })
    ).toEqual([
      {
        kind: "candidate",
        name: "targeting",
        patch: {
          role_buckets: [
            {
              name: "Primary targets",
              priority: "primary",
              titles: ["Staff Engineer", "Engineering Lead"],
            },
          ],
        },
      },
    ]);
    expect(
      profileSectionSavePlan("compensation", { minimumBase: "210000", targetBase: "235000" })
    ).toEqual([
      {
        kind: "candidate",
        name: "profile",
        patch: { compensation: { minimum_base: 210000, target_base: 235000 } },
      },
    ]);
    expect(
      profileSectionSavePlan("location-policy", {
        home: "New York, NY",
        remote: true,
        hybrid: true,
        onsite: false,
        relocation: "Boston, MA\nSeattle, WA",
      })
    ).toEqual([
      {
        kind: "candidate",
        name: "profile",
        patch: {
          candidate: { location: "New York, NY" },
          location: {
            home: "New York, NY",
            remote: true,
            hybrid: true,
            onsite: false,
            relocation: ["Boston, MA", "Seattle, WA"],
            mode_preferences_confirmed: true,
          },
        },
      },
    ]);
    expect(
      profileSectionSavePlan(
        "writing-style",
        {
          summary: "Plain, direct, concrete.",
          doPhrases: "Lead with the result",
          avoidPhrases: "Excited to apply\nThrilled",
        },
        { itemId: "voice-1" }
      )
    ).toEqual([
      {
        kind: "deep-ingest",
        lane: "writing_voice",
        id: "voice-1",
        fields: {
          summary: "Plain, direct, concrete.",
          doPhrases: ["Lead with the result"],
          avoidPhrases: ["Excited to apply", "Thrilled"],
        },
      },
    ]);
    expect(
      profileSectionSavePlan("search-rules", {
        keepSignals: "Platform ownership\nDeveloper tools",
        cadence: "weekly",
        fitFloor: "76",
      })
    ).toEqual([
      {
        kind: "candidate",
        name: "targeting",
        patch: {
          keep_signals: ["Platform ownership", "Developer tools"],
          fit_bands: { fit_floor: 76 },
          search_preferences: { cadence: { mode: "weekly" } },
        },
      },
    ]);
  });

  it("preserves every target bucket name, priority, and signal while editing its titles", () => {
    const roleBuckets = [
      {
        name: "Core platform",
        priority: "primary",
        titles: ["Staff Engineer"],
        fit_signals: ["distributed systems"],
      },
      {
        name: "Applied AI",
        priority: "stretch",
        titles: ["AI Platform Lead"],
        fit_signals: ["agent workflows"],
      },
      {
        name: "Operator roles",
        priority: "oe",
        titles: ["Fractional CTO"],
      },
    ];

    expect(
      profileSectionSavePlan(
        "targets",
        {
          titles: "Principal Platform Engineer",
          "titles:1": "Applied AI Engineering Lead",
          "titles:2": "Fractional CTO",
        },
        { roleBuckets }
      )[0].patch.role_buckets
    ).toEqual([
      { ...roleBuckets[0], titles: ["Principal Platform Engineer"] },
      { ...roleBuckets[1], titles: ["Applied AI Engineering Lead"] },
      roleBuckets[2],
    ]);
  });

  it("rejects incomplete or unsafe section drafts before writing", () => {
    expect(() => profileSectionSavePlan("targets", { titles: "" })).toThrow(
      "Add at least one target role"
    );
    expect(() =>
      profileSectionSavePlan("compensation", { minimumBase: "230000", targetBase: "210000" })
    ).toThrow("Target base must be at least the floor");
    expect(() => profileSectionSavePlan("search-rules", { fitFloor: "101" })).toThrow(
      "Fit floor must be between 0 and 100"
    );
  });
});
