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
