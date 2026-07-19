import { beforeEach, describe, expect, it, vi } from "vitest";

const hookHarness = vi.hoisted(() => ({
  callbacks: [],
  callbackDeps: [],
  contextValue: null,
  cursor: 0,
  effectDeps: [],
  pendingEffects: [],
  refs: [],
  states: [],
  reset() {
    this.cursor = 0;
    this.pendingEffects = [];
  },
  clear() {
    this.callbacks = [];
    this.callbackDeps = [];
    this.contextValue = null;
    this.cursor = 0;
    this.effectDeps = [];
    this.pendingEffects = [];
    this.refs = [];
    this.states = [];
  },
}));

const apiMocks = vi.hoisted(() => ({
  getDashboard: vi.fn(),
}));

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
    useCallback(callback, dependencies) {
      const index = hookHarness.cursor++;
      if (dependenciesChanged(hookHarness.callbackDeps[index], dependencies)) {
        hookHarness.callbacks[index] = callback;
        hookHarness.callbackDeps[index] = dependencies;
      }
      return hookHarness.callbacks[index];
    },
    useContext() {
      return hookHarness.contextValue;
    },
    useEffect(effect, dependencies) {
      const index = hookHarness.cursor++;
      if (dependenciesChanged(hookHarness.effectDeps[index], dependencies)) {
        hookHarness.effectDeps[index] = dependencies;
        hookHarness.pendingEffects.push(effect);
      }
    },
    useRef(initialValue) {
      const index = hookHarness.cursor++;
      if (!hookHarness.refs[index]) hookHarness.refs[index] = { current: initialValue };
      return hookHarness.refs[index];
    },
    useState(initialValue) {
      const index = hookHarness.cursor++;
      if (!(index in hookHarness.states)) {
        hookHarness.states[index] =
          typeof initialValue === "function" ? initialValue() : initialValue;
      }
      const setValue = (nextValue) => {
        hookHarness.states[index] =
          typeof nextValue === "function" ? nextValue(hookHarness.states[index]) : nextValue;
      };
      return [hookHarness.states[index], setValue];
    },
  };
});

vi.mock("../lib/api.js", () => ({
  ApiError: class ApiError extends Error {},
  getDashboard: apiMocks.getDashboard,
}));

vi.mock("../lib/dashboard-events.js", () => ({
  subscribeDashboardChanged: vi.fn(() => vi.fn()),
}));

vi.mock("../lib/intake-events.js", () => ({
  subscribeIntakeChanged: vi.fn(() => vi.fn()),
}));

async function loadDashboardContext({ staticPreview = false } = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_STATIC_PREVIEW", staticPreview ? "true" : "false");
  return import("./DashboardContext.jsx");
}

function renderProvider(module) {
  hookHarness.reset();
  const providerElement = module.DashboardProvider({ children: "dashboard child" });
  return providerElement.type(providerElement.props);
}

async function flushEffects() {
  const effects = hookHarness.pendingEffects.splice(0);
  for (const effect of effects) effect();
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  hookHarness.clear();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubGlobal(
    "setInterval",
    vi.fn(() => 1)
  );
  vi.stubGlobal("clearInterval", vi.fn());
});

describe("DashboardContext", () => {
  it("exposes dashboard data and setup, then updates setup on refetch", async () => {
    const first = {
      data: { stats: { active: 2 } },
      setup: { readiness: { search_ready: true, gate_ready: false } },
    };
    const second = {
      data: { stats: { active: 3 } },
      setup: { readiness: { search_ready: true, gate_ready: true } },
    };
    apiMocks.getDashboard.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const dashboardContext = await loadDashboardContext();

    renderProvider(dashboardContext);
    await flushEffects();
    let provider = renderProvider(dashboardContext);
    hookHarness.contextValue = provider.props.value;
    let snapshot = dashboardContext.useDashboardSnapshot();

    expect(snapshot.data).toEqual(first.data);
    expect(snapshot.setup).toEqual(first.setup);

    await snapshot.refetch();
    provider = renderProvider(dashboardContext);
    hookHarness.contextValue = provider.props.value;
    snapshot = dashboardContext.useDashboardSnapshot();

    expect(snapshot.data).toEqual(second.data);
    expect(snapshot.setup).toEqual(second.setup);
  });

  it("provides fully complete readiness in static preview mode", async () => {
    const dashboardContext = await loadDashboardContext({ staticPreview: true });
    const provider = renderProvider(dashboardContext);
    hookHarness.contextValue = provider.props.value;

    expect(dashboardContext.useDashboardSnapshot().setup).toEqual({
      readiness: {
        search_ready: true,
        gate_ready: true,
        apply_ready: true,
        deep_ingest_complete: true,
      },
      missing: {
        search_ready: [],
        gate_ready: [],
        apply_ready: [],
        deep_ingest_complete: [],
      },
    });
    expect(apiMocks.getDashboard).not.toHaveBeenCalled();
  });
});
