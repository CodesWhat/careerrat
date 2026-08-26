import { beforeEach, describe, expect, it, vi } from "vitest";

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
    addBoard: vi.fn(),
    getAutomationSettings: vi.fn().mockResolvedValue({ capabilities: [] }),
    getInstalledAiRuntimes: vi.fn().mockResolvedValue({ runtimes: [] }),
    getOnboardState: vi.fn(async () => ({
      data: {},
      publicSyncPreference: { enabled, source: enabled ? "default" : "user", updatedAt: null },
    })),
    getSourceMaintenance: vi.fn().mockResolvedValue({ searches: [], companies: [] }),
    saveCandidateFile: vi.fn().mockResolvedValue({ ok: true }),
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

beforeEach(() => {
  hooks.clear();
  vi.clearAllMocks();
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

describe("ProfileSettingsController permission consent", () => {
  it("does not revoke LinkedIn consent while another enabled permission still uses it", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getAutomationSettings.mockResolvedValue({
      capabilities: [
        { capability: "authenticated_search", enabled: true },
        { capability: "authenticated_apply_preparation", enabled: true },
        { capability: "mail_access", enabled: false },
      ],
    });

    renderController(module, api);
    await flushEffects();
    const view = renderController(module, api);
    await settingsProps(view).onPermissionChange("authenticated_search", false);

    expect(api.saveCandidateFile).toHaveBeenCalledWith(
      "automation",
      expect.objectContaining({
        consent: {
          linkedin: true,
          indeed: false,
          wellfound: false,
          glassdoor: false,
        },
      })
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
