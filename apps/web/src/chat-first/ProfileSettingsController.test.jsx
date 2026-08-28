import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api.js";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  effectDeps: [],
  pendingEffects: [],
  states: [],
  resetRender() {
    this.cursor = 0;
    this.pendingEffects = [];
  },
  clear() {
    this.cursor = 0;
    this.effectDeps = [];
    this.pendingEffects = [];
    this.states = [];
  },
}));

const navigate = vi.hoisted(() => vi.fn());

function dependenciesChanged(previous, next) {
  return (
    !previous ||
    !next ||
    previous.length !== next.length ||
    next.some((value, index) => !Object.is(value, previous[index]))
  );
}

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useEffect(effect, dependencies) {
      const index = hooks.cursor++;
      if (dependenciesChanged(hooks.effectDeps[index], dependencies)) {
        hooks.effectDeps[index] = dependencies;
        hooks.pendingEffects.push(effect);
      }
    },
    useState(initialValue) {
      const index = hooks.cursor++;
      if (!(index in hooks.states)) {
        hooks.states[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      const setValue = (nextValue) => {
        hooks.states[index] =
          typeof nextValue === "function" ? nextValue(hooks.states[index]) : nextValue;
      };
      return [hooks.states[index], setValue];
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
  };
});

vi.mock("react-router-dom", () => ({
  useLocation: () => ({ state: { activeTab: "settings" } }),
  useNavigate: () => navigate,
}));

vi.mock("./ProfileSettings.jsx", () => ({ ProfileSettings: () => null }));

function createApi() {
  let enabled = true;
  return {
    runWorkspaceIntent: vi.fn().mockResolvedValue({ status: "completed" }),
    getAiPreferences: vi.fn().mockResolvedValue({
      quality: "automatic",
      reasoning: "automatic",
      source: "default",
      updatedAt: null,
    }),
    getAutomationSettings: vi.fn().mockResolvedValue({ capabilities: [] }),
    getInstalledAiRuntimes: vi.fn().mockResolvedValue({ runtimes: [] }),
    getOnboardState: vi.fn(async () => ({
      data: {},
      publicSyncPreference: { enabled, source: enabled ? "default" : "user", updatedAt: null },
    })),
    getSourceMaintenance: vi.fn().mockResolvedValue({ searches: [], companies: [] }),
    saveCandidateFile: vi.fn().mockResolvedValue({ ok: true }),
    saveAiPreferences: vi.fn(async ({ quality, reasoning }) => ({
      quality,
      reasoning,
      source: "saved",
      updatedAt: "2026-08-27T16:00:00.000Z",
    })),
    setAutomationSessionProvider: vi.fn().mockResolvedValue({ ok: true }),
    setPublicSyncPreference: vi.fn(async (nextEnabled) => {
      enabled = nextEnabled;
      return { ok: true };
    }),
  };
}

async function flushEffects() {
  for (const effect of hooks.pendingEffects.splice(0)) effect();
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

function renderController(module, api) {
  hooks.resetRender();
  return module.ProfileSettingsController({ api });
}

function settingsProps(view) {
  const children = Array.isArray(view.props.children) ? view.props.children : [view.props.children];
  return children.at(-1).props;
}

function controllerAlertText(view) {
  const children = Array.isArray(view.props.children) ? view.props.children : [view.props.children];
  return children[0]?.props?.children || null;
}

beforeEach(() => {
  hooks.clear();
  vi.clearAllMocks();
});

describe("ProfileSettingsController error copy", () => {
  it("does not render raw settings-load exceptions", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    const raw = "SQLITE_ERROR: no such table at /Users/person/private/careerrat.db";
    api.getOnboardState.mockRejectedValue(new Error(raw));

    renderController(module, api);
    await flushEffects();
    const view = renderController(module, api);

    expect(controllerAlertText(view)).toBe("CareerRat couldn't load Settings. Try again.");
    expect(controllerAlertText(view)).not.toContain(raw);
  });

  it("preserves mapped typed errors when a settings action fails", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.setAutomationSessionProvider.mockRejectedValue(
      new ApiError(409, { code: "NO_AI_ROUTE", error: "provider route missing" })
    );

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    await settingsProps(view).onBrowserProviderChange("playwright");
    view = renderController(module, api);

    expect(controllerAlertText(view)).toBe("No AI engine is connected yet. Open Settings.");
    expect(controllerAlertText(view)).not.toContain("provider route missing");
  });

  it("preserves mapped HTTP recovery instead of replacing it with a call-site fallback", async () => {
    const { profileSettingsErrorMessage } = await import("./ProfileSettingsController.jsx");

    expect(
      profileSettingsErrorMessage(new ApiError(401, { error: "raw auth failure" }), "Retry.")
    ).toBe("CareerRat couldn't complete that request safely. Reload CareerRat, then try again.");
  });

  it("shows a people-shaped recovery when saving a profile section returns 500", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    const raw = "SQLITE_BUSY: database is locked at /Users/person/private/careerrat.db";
    api.getOnboardState.mockResolvedValue({
      data: {
        targeting: {
          role_buckets: [
            { name: "Primary targets", priority: "primary", titles: ["Staff Engineer"] },
          ],
        },
      },
      publicSyncPreference: { enabled: true, source: "default", updatedAt: null },
    });
    api.saveCandidateFile.mockRejectedValue(new ApiError(500, { error: raw }));

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    settingsProps(view).onEditSection("targets");
    view = renderController(module, api);
    await settingsProps(view).onSaveEditor();
    view = renderController(module, api);

    expect(controllerAlertText(view)).toBe(
      "CareerRat hit a problem while doing that. Try again. If it keeps happening, restart CareerRat."
    );
    expect(controllerAlertText(view)).not.toContain(raw);
  });

  it("shows intentional section validation while hiding unexpected implementation details", async () => {
    const { profileSettingsErrorMessage } = await import("./ProfileSettingsController.jsx");
    const { profileSectionSavePlan } = await import("./profile-settings-controller.js");
    const fallback = "CareerRat couldn't save that profile section. Check it and try again.";
    let validationError;

    try {
      profileSectionSavePlan("targets", { titles: "" });
    } catch (cause) {
      validationError = cause;
    }

    expect(profileSettingsErrorMessage(validationError, fallback)).toBe(
      "Add at least one target role."
    );
    expect(
      profileSettingsErrorMessage(
        new Error("SQLITE_ERROR: no such table at /Users/person/private/careerrat.db"),
        fallback
      )
    ).toBe(fallback);
  });
});

describe("ProfileSettingsController public metadata preference", () => {
  it("writes the existing API and reloads the canonical preference after opt-out", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    expect(settingsProps(view).publicSyncPreference.enabled).toBe(true);

    await settingsProps(view).onPublicSyncChange(false);

    expect(api.setPublicSyncPreference).toHaveBeenCalledWith(false);
    expect(api.getOnboardState).toHaveBeenCalledTimes(2);
    view = renderController(module, api);
    expect(settingsProps(view).publicSyncPreference).toMatchObject({
      enabled: false,
      source: "user",
    });
    expect(settingsProps(view).publicSyncBusy).toBe(false);
  });
});

describe("ProfileSettingsController AI preferences", () => {
  it("loads local preferences and saves a merged provider-neutral choice", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getAiPreferences.mockResolvedValue({
      quality: "balanced",
      reasoning: "medium",
      source: "saved",
      updatedAt: "2026-08-27T15:00:00.000Z",
    });

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    expect(settingsProps(view).aiPreferences).toMatchObject({
      quality: "balanced",
      reasoning: "medium",
      source: "saved",
    });

    await settingsProps(view).onAiPreferenceChange("reasoning", "high");

    expect(api.saveAiPreferences).toHaveBeenCalledWith({
      quality: "balanced",
      reasoning: "high",
    });
    expect(api.saveCandidateFile).not.toHaveBeenCalled();
    view = renderController(module, api);
    expect(settingsProps(view).aiPreferences).toMatchObject({
      quality: "balanced",
      reasoning: "high",
      source: "saved",
    });
    expect(settingsProps(view).aiPreferencesBusy).toBe(false);
    expect(settingsProps(view).aiPreferencesStatus).toBe("Saved on this computer");
  });

  it("surfaces a people-shaped save error without losing the last saved choice", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.saveAiPreferences.mockRejectedValue(
      new ApiError(400, {
        code: "AI_PREFERENCES_INVALID",
        error: "Paul quality must be Automatic, Faster, Balanced, or Best.",
      })
    );

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    await settingsProps(view).onAiPreferenceChange("quality", "broken");
    view = renderController(module, api);

    expect(controllerAlertText(view)).toBe(
      "CareerRat couldn't save that AI setting. Choose one of the options and try again."
    );
    expect(settingsProps(view).aiPreferences.quality).toBe("automatic");
  });
});

describe("ProfileSettingsController browser automation provider", () => {
  it("writes the dedicated provider endpoint and reloads canonical automation state", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();

    renderController(module, api);
    await flushEffects();
    const view = renderController(module, api);

    await settingsProps(view).onBrowserProviderChange("playwright");

    expect(api.setAutomationSessionProvider).toHaveBeenCalledWith("playwright");
    expect(api.getAutomationSettings).toHaveBeenCalledTimes(2);
    expect(settingsProps(renderController(module, api)).browserProviderBusy).toBe(false);
  });
});

describe("ProfileSettingsController source setup", () => {
  it("adds a board through the durable workspace chat so login questions appear there", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    settingsProps(view).onAddSource();
    view = renderController(module, api);
    settingsProps(view).onSourceDraftChange("https://www.linkedin.com/jobs/search/?keywords=ops");
    view = renderController(module, api);
    await settingsProps(view).onSubmitSource();

    expect(api.runWorkspaceIntent).toHaveBeenCalledWith(
      "source.add",
      { type: "workspace", id: "workspace-main" },
      { url: "https://www.linkedin.com/jobs/search/?keywords=ops" }
    );
    expect(navigate).toHaveBeenCalledWith("/");
  });
});

describe("ProfileSettingsController permission consent", () => {
  it("does not expose a job-source login Settings write path", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getAutomationSettings.mockResolvedValue({
      capabilities: [
        { capability: "source_login", enabled: true },
        { capability: "authenticated_apply_preparation", enabled: true },
        { capability: "mail_access", enabled: false },
      ],
    });

    renderController(module, api);
    await flushEffects();
    const view = renderController(module, api);
    await settingsProps(view).onPermissionChange("source_login", false);

    expect(api.saveCandidateFile).not.toHaveBeenCalled();
  });

  it("does not preserve consent for a hidden job-source permission", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getAutomationSettings.mockResolvedValue({
      capabilities: [
        { capability: "source_login", enabled: true },
        { capability: "authenticated_apply_preparation", enabled: true },
      ],
    });

    renderController(module, api);
    await flushEffects();
    const view = renderController(module, api);
    await settingsProps(view).onPermissionChange("authenticated_apply_preparation", false);

    expect(api.saveCandidateFile).toHaveBeenCalledWith(
      "automation",
      expect.objectContaining({ consent: expect.objectContaining({ linkedin: false }) })
    );
  });
});

describe("ProfileSettingsController local application defaults", () => {
  it("saves the voluntary-question policy locally while preserving private answers", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getOnboardState.mockResolvedValue({
      data: {
        "form-defaults": {
          voluntary_self_identification: {
            enabled: false,
            default_action: "leave_blank",
            confirmed_at: "2026-08-20T12:00:00.000Z",
            answers: {
              disability: {
                value: "Saved private answer",
                confirmed_at: "2026-08-19T12:00:00.000Z",
              },
            },
          },
        },
      },
      publicSyncPreference: { enabled: true, source: "default", updatedAt: null },
    });

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    settingsProps(view).onEditSection("application-defaults");

    view = renderController(module, api);
    expect(settingsProps(view).profileEditor).toMatchObject({
      id: "application-defaults",
      localOnly: true,
    });
    settingsProps(view).onEditorChange("policy", "decline_when_available");

    view = renderController(module, api);
    await settingsProps(view).onSaveEditor();

    expect(api.saveCandidateFile).toHaveBeenCalledWith("form-defaults", {
      voluntary_self_identification: {
        enabled: true,
        default_action: "decline_when_available",
        confirmed_at: expect.any(String),
        answers: {
          disability: {
            value: "Saved private answer",
            confirmed_at: "2026-08-19T12:00:00.000Z",
          },
        },
      },
    });
    const saved = api.saveCandidateFile.mock.calls[0][1].voluntary_self_identification;
    expect(Number.isNaN(Date.parse(saved.confirmed_at))).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("ProfileSettingsController engine inventory", () => {
  it("passes settings only accepted runtimes and excludes diagnostic adapters", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getInstalledAiRuntimes.mockResolvedValue({
      selectedId: "hermes",
      runtimes: [
        {
          id: "claude",
          name: "Claude Code",
          supported: true,
          available: true,
          ready: true,
          selectable: false,
          capabilityTier: "detected_unverified",
          capabilities: { completion: false },
        },
        {
          id: "codex",
          name: "Codex",
          supported: true,
          available: false,
          ready: false,
          selectable: false,
          capabilityTier: "unavailable",
          capabilities: { completion: false },
        },
        {
          id: "hermes",
          name: "Hermes Agent",
          supported: false,
          available: true,
          ready: true,
          selectable: true,
          capabilityTier: "task_tools",
          capabilities: { completion: true, taskTools: true, research: true },
        },
      ],
    });

    renderController(module, api);
    await flushEffects();
    const choices = settingsProps(renderController(module, api)).engine.choices;

    expect(choices.map((choice) => choice.id)).toEqual(["claude", "codex"]);
    expect(choices.find((choice) => choice.id === "claude")).toMatchObject({
      selectable: false,
      presentationState: "unavailable",
    });
    expect(choices.find((choice) => choice.id === "hermes")).toBeUndefined();
  });
});
