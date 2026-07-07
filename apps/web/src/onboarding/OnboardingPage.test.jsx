import { describe, expect, it } from "vitest";
import { getRuntimeConfig } from "../lib/api.js";
import {
  deriveRuntimeCapabilities,
  loadOnboardingRuntimeState,
  normalizeOnboardingDraft,
  refreshThenAdvance,
  resolveInitialStep,
} from "./OnboardingPage.jsx";

describe("refreshThenAdvance", () => {
  it("refreshes derived onboarding state before advancing to the next step", async () => {
    const calls = [];
    let updater = null;
    await refreshThenAdvance({
      load: async () => {
        calls.push("load");
      },
      setStepIndex: (fn) => {
        calls.push("advance");
        updater = fn;
      },
      stepCount: 7,
    });

    expect(calls).toEqual(["load", "advance"]);
    expect(updater(5)).toBe(6);
    expect(updater(6)).toBe(6);
  });
});

describe("deriveRuntimeCapabilities", () => {
  it("uses runtime config AI availability instead of the onboarding key flag", () => {
    const capabilities = deriveRuntimeCapabilities({
      onboardState: { keyConfigured: false },
      runtimeConfig: {
        skills: ["evaluate-job"],
        chatSkills: ["discover-companies"],
        ai: { available: true, route: "proxy" },
        discovery: {
          companyProposals: true,
          manualCompanySeeds: true,
          chatHandoffs: true,
        },
      },
    });

    expect(capabilities).toEqual({
      aiAvailable: true,
      aiRoute: "proxy",
      companyProposals: true,
      manualCompanySeeds: true,
      discoveryChatHandoffs: true,
      fullSkillRun: true,
      skills: ["evaluate-job"],
      chatSkills: ["discover-companies"],
    });
  });

  it("keeps local and manual discovery available when no AI route is configured", () => {
    const capabilities = deriveRuntimeCapabilities({
      onboardState: { keyConfigured: true },
      runtimeConfig: {
        skills: [],
        chatSkills: [],
        ai: { available: false, route: "none" },
        discovery: {
          companyProposals: true,
          manualCompanySeeds: true,
          chatHandoffs: false,
        },
      },
    });

    expect(capabilities).toMatchObject({
      aiAvailable: false,
      aiRoute: "none",
      companyProposals: true,
      manualCompanySeeds: true,
      discoveryChatHandoffs: false,
      fullSkillRun: false,
    });
  });
});

describe("loadOnboardingRuntimeState", () => {
  it("loads onboarding state, runtime config, and durable draft once each", async () => {
    const calls = [];
    const onboardState = { keyConfigured: false, files: [] };
    const runtimeConfig = {
      skills: ["evaluate-job"],
      chatSkills: ["discover-companies"],
      ai: { available: true, route: "proxy" },
      discovery: {
        companyProposals: true,
        manualCompanySeeds: true,
        chatHandoffs: true,
      },
    };

    const result = await loadOnboardingRuntimeState({
      getState: async () => {
        calls.push("state");
        return onboardState;
      },
      getRuntime: async () => {
        calls.push("runtime");
        return runtimeConfig;
      },
      getDraft: async () => {
        calls.push("draft");
        return {
          draft: {
            stepIndex: 3,
            draftSeeds: { targeting: { role_buckets: [{ titles: ["Applied AI Engineer"] }] } },
            updatedAt: "2026-07-06T20:30:00.000Z",
          },
        };
      },
    });

    expect(calls).toEqual(["state", "runtime", "draft"]);
    expect(result.state).toBe(onboardState);
    expect(result.runtimeConfig).toBe(runtimeConfig);
    expect(result.onboardingDraft.stepIndex).toBe(3);
    expect(result.onboardingDraft.draftSeeds.targeting.role_buckets[0].titles).toEqual([
      "Applied AI Engineer",
    ]);
    expect(result.runtimeCapabilities.aiAvailable).toBe(true);
    expect(result.runtimeCapabilities.companyProposals).toBe(true);
  });

  it("keeps onboarding usable with conservative capabilities when runtime config fails", async () => {
    const result = await loadOnboardingRuntimeState({
      getState: async () => ({ keyConfigured: true, files: [] }),
      getRuntime: async () => {
        throw new Error("runtime config unavailable");
      },
      getDraft: async () => ({ draft: { stepIndex: 4, draftSeeds: {} } }),
    });

    expect(result.state).toEqual({ keyConfigured: true, files: [] });
    expect(result.runtimeConfig).toBe(null);
    expect(result.runtimeCapabilities).toMatchObject({
      aiAvailable: false,
      aiRoute: "none",
      companyProposals: true,
      manualCompanySeeds: true,
      discoveryChatHandoffs: false,
      fullSkillRun: false,
    });
    expect(result.runtimeError.message).toBe("runtime config unavailable");
    expect(result.onboardingDraft.stepIndex).toBe(4);
  });

  it("keeps onboarding usable with a blank durable draft when draft loading fails", async () => {
    const result = await loadOnboardingRuntimeState({
      getState: async () => ({ keyConfigured: false, files: [] }),
      getRuntime: async () => ({ ai: { available: false, route: "none" } }),
      getDraft: async () => {
        throw new Error("draft unavailable");
      },
    });

    expect(result.onboardingDraft).toEqual({
      stepIndex: 0,
      completedIndexes: [],
      draftSeeds: {},
      updatedAt: null,
    });
  });
});

describe("onboarding draft normalization", () => {
  it("resumes from a valid persisted step", () => {
    const draft = normalizeOnboardingDraft({
      stepIndex: 6,
      completedIndexes: [1, 2, 3, 4, 99, -1, 3.8, "5"],
      draftSeeds: { targeting: { role_buckets: [{ titles: ["Staff Engineer"] }] } },
      updatedAt: "2026-07-06T20:30:00.000Z",
    });

    expect(resolveInitialStep({ draft, stepCount: 8 })).toBe(6);
    expect(draft.completedIndexes).toEqual([1, 2, 3, 4, 5, 7]);
    expect(draft.draftSeeds.targeting.role_buckets[0].titles).toEqual(["Staff Engineer"]);
  });

  it("clamps invalid persisted drafts to the safe welcome step", () => {
    expect(
      normalizeOnboardingDraft({ stepIndex: 200, draftSeeds: null }, { stepCount: 8 })
    ).toEqual({
      stepIndex: 7,
      completedIndexes: [],
      draftSeeds: {},
      updatedAt: null,
    });
    expect(resolveInitialStep({ draft: { stepIndex: -1 }, stepCount: 8 })).toBe(0);
  });
});

describe("getRuntimeConfig", () => {
  it("is exported as the runtime config API wrapper", () => {
    expect(typeof getRuntimeConfig).toBe("function");
  });
});
