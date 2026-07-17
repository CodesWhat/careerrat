import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../lib/api.js";
import {
  deriveRuntimeCapabilities,
  loadOnboardingRuntimeState,
  normalizeOnboardingDraft,
  refreshThenAdvance,
  resolveInitialStep,
} from "./OnboardingPage.jsx";

async function mountGoNextHarness({ stepIndex, state, isSignedIn, aiAvailable }) {
  vi.resetModules();
  const captured = { props: null };
  const setters = Array.from({ length: 9 }, () => vi.fn());
  const initialStates = [false, null, state, { aiAvailable }, stepIndex, true, null, {}, []];
  let stateIndex = 0;

  vi.doMock("react", async () => {
    const actual = await vi.importActual("react");
    return {
      ...actual,
      useCallback: (fn) => fn,
      useEffect: () => {},
      useState: () => {
        const index = stateIndex++;
        return [initialStates[index], setters[index]];
      },
    };
  });
  vi.doMock("../auth/clerkControls.jsx", () => ({
    useRolesterUser: () => ({ isSignedIn }),
  }));
  const captureStep = (props) => {
    captured.props = props;
    return null;
  };
  vi.doMock("./steps/KeyStep.jsx", () => ({ KeyStep: captureStep }));
  vi.doMock("./steps/ResumeStep.jsx", () => ({ ResumeStep: captureStep }));
  vi.doMock("../lib/api.js", () => ({
    getOnboardState: vi.fn(async () => state),
    getRuntimeConfig: vi.fn(async () => ({ ai: { available: aiAvailable, route: "test" } })),
    getOnboardingDraft: vi.fn(async () => ({ draft: { stepIndex, completedIndexes: [] } })),
    saveOnboardingDraft: vi.fn(async () => ({ ok: true })),
  }));

  const { OnboardingPage } = await import("./OnboardingPage.jsx");
  renderToStaticMarkup(<OnboardingPage />);
  expect(captured.props).toBeTruthy();
  return { goNext: captured.props.goNext, setters };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("react");
  vi.doUnmock("../auth/clerkControls.jsx");
  vi.doUnmock("./steps/KeyStep.jsx");
  vi.doUnmock("./steps/ResumeStep.jsx");
  vi.doUnmock("../lib/api.js");
});

describe("OnboardingPage goNext prerequisites", () => {
  it("blocks the account step and shows an error toast without sign-in or AI", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => 0);
    const { goNext, setters } = await mountGoNextHarness({
      stepIndex: 1,
      state: { sourceResumePresent: true },
      isSignedIn: false,
      aiAvailable: false,
    });

    goNext();

    expect(setters[4]).not.toHaveBeenCalled();
    expect(setters[6]).toHaveBeenCalledWith({
      message: "Rolester needs AI to work — sign in or add your Anthropic key to continue",
      tone: "error",
    });
    timeout.mockRestore();
  });

  it("advances the account step when signed in or AI is available", async () => {
    for (const auth of [
      { isSignedIn: true, aiAvailable: false },
      { isSignedIn: false, aiAvailable: true },
    ]) {
      const { goNext, setters } = await mountGoNextHarness({
        stepIndex: 1,
        state: { sourceResumePresent: true },
        ...auth,
      });
      goNext();
      await vi.waitFor(() => expect(setters[4]).toHaveBeenCalled());
      const advance = setters[4].mock.calls.at(-1)[0];
      expect(advance(1)).toBe(2);
      expect(setters[6]).not.toHaveBeenCalled();
    }
  });

  it("blocks the resume step and shows an error toast without a source resume", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => 0);
    const { goNext, setters } = await mountGoNextHarness({
      stepIndex: 2,
      state: { sourceResumePresent: false },
      isSignedIn: true,
      aiAvailable: true,
    });

    goNext();

    expect(setters[4]).not.toHaveBeenCalled();
    expect(setters[6]).toHaveBeenCalledWith({
      message: "Import your résumé to continue — Rolester builds every document from it",
      tone: "error",
    });
    timeout.mockRestore();
  });

  it("advances the resume step when a source resume exists", async () => {
    const { goNext, setters } = await mountGoNextHarness({
      stepIndex: 2,
      state: { sourceResumePresent: true },
      isSignedIn: true,
      aiAvailable: true,
    });

    goNext();
    await vi.waitFor(() => expect(setters[4]).toHaveBeenCalled());
    const advance = setters[4].mock.calls.at(-1)[0];
    expect(advance(2)).toBe(3);
    expect(setters[6]).not.toHaveBeenCalled();
  });
});

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
