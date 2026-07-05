import { describe, expect, it } from "vitest";
import { getRuntimeConfig } from "../lib/api.js";
import {
  deriveRuntimeCapabilities,
  loadOnboardingRuntimeState,
  refreshThenAdvance,
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
  it("loads onboarding state and runtime config once each", async () => {
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
    });

    expect(calls).toEqual(["state", "runtime"]);
    expect(result.state).toBe(onboardState);
    expect(result.runtimeConfig).toBe(runtimeConfig);
    expect(result.runtimeCapabilities.aiAvailable).toBe(true);
    expect(result.runtimeCapabilities.companyProposals).toBe(true);
  });

  it("keeps onboarding usable with conservative capabilities when runtime config fails", async () => {
    const result = await loadOnboardingRuntimeState({
      getState: async () => ({ keyConfigured: true, files: [] }),
      getRuntime: async () => {
        throw new Error("runtime config unavailable");
      },
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
  });
});

describe("getRuntimeConfig", () => {
  it("is exported as the runtime config API wrapper", () => {
    expect(typeof getRuntimeConfig).toBe("function");
  });
});
