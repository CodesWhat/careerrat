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

const sse = vi.hoisted(() => ({ calls: [] }));
vi.mock("../lib/sse.js", () => ({
  useEventSource: (url, opts) => {
    sse.calls.push({ url, opts });
  },
}));

async function loadDashboardContext() {
  vi.resetModules();
  return import("./dashboard-context.jsx");
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
  sse.calls = [];
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

  it("resolves a failed non-409 dashboard fetch into a friendly {message, action, detail} error, with retry wired to load", async () => {
    const dashboardContext = await loadDashboardContext();
    const { ApiError } = await import("../lib/api.js");
    const err = Object.assign(new ApiError("boom"), {
      status: 500,
      body: { error: "SQLite table applications is locked at /Users/x/workspace" },
    });
    apiMocks.getDashboard
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ data: { stats: { active: 5 } }, setup: null });

    renderProvider(dashboardContext);
    await flushEffects();
    let provider = renderProvider(dashboardContext);
    hookHarness.contextValue = provider.props.value;
    let snapshot = dashboardContext.useDashboardSnapshot();

    expect(snapshot.error.message).toBe(
      "CareerRat hit a problem while doing that. Try again. If it keeps happening, restart CareerRat."
    );
    expect(snapshot.error.message).not.toContain("SQLite");
    expect(snapshot.error.message).not.toContain("/Users/x/workspace");
    expect(snapshot.error.detail).toBe("SQLite table applications is locked at /Users/x/workspace");
    expect(snapshot.error.action.retry).toBe(true);
    expect(typeof snapshot.error.action.onRetry).toBe("function");

    await snapshot.error.action.onRetry();
    provider = renderProvider(dashboardContext);
    hookHarness.contextValue = provider.props.value;
    snapshot = dashboardContext.useDashboardSnapshot();

    expect(snapshot.error).toBeNull();
    expect(snapshot.data).toEqual({ stats: { active: 5 } });
  });

  it("subscribes to the dev server's livereload SSE and refetches on tracker/activity events", async () => {
    const first = { data: { stats: { active: 1 } }, setup: null };
    const second = { data: { stats: { active: 9 } }, setup: null };
    apiMocks.getDashboard.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const dashboardContext = await loadDashboardContext();

    renderProvider(dashboardContext);
    await flushEffects();

    expect(sse.calls).toHaveLength(1);
    expect(sse.calls[0].url).toBe("/__livereload");
    expect(sse.calls[0].opts.types).toEqual(["tracker-update", "activity-update"]);

    // Simulate the server broadcasting a tracker-update (a CLI/agent write to
    // workspace/tracker.json, not one made through this tab) by invoking the
    // captured onEvent handler directly.
    await sse.calls[0].opts.onEvent("tracker-update", "1");

    const provider = renderProvider(dashboardContext);
    hookHarness.contextValue = provider.props.value;
    const snapshot = dashboardContext.useDashboardSnapshot();

    expect(snapshot.data).toEqual(second.data);
    expect(apiMocks.getDashboard).toHaveBeenCalledTimes(2);
  });

  it("latches a pending refresh instead of dropping an SSE event that arrives mid-fetch", async () => {
    let resolveFirst;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const first = { data: { stats: { active: 1 } }, setup: null };
    const second = { data: { stats: { active: 9 } }, setup: null };
    apiMocks.getDashboard.mockReturnValueOnce(firstPromise).mockResolvedValueOnce(second);
    const dashboardContext = await loadDashboardContext();

    renderProvider(dashboardContext);
    // Run the mount effect by hand (rather than flushEffects, which awaits
    // several microtask turns) so the first fetch is left deliberately
    // in-flight when the SSE event below fires.
    const mountEffects = hookHarness.pendingEffects.splice(0);
    for (const effect of mountEffects) effect();
    await Promise.resolve();

    expect(apiMocks.getDashboard).toHaveBeenCalledTimes(1);
    expect(sse.calls).toHaveLength(1);

    // The dev server's livereload SSE fires while the mount fetch above is
    // still unresolved. Fixed load() latches a pending reload here instead
    // of silently dropping it.
    await sse.calls[0].opts.onEvent("tracker-update", "1");
    expect(apiMocks.getDashboard).toHaveBeenCalledTimes(1);

    resolveFirst(first);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    expect(apiMocks.getDashboard).toHaveBeenCalledTimes(2);

    const provider = renderProvider(dashboardContext);
    hookHarness.contextValue = provider.props.value;
    const snapshot = dashboardContext.useDashboardSnapshot();

    expect(snapshot.data).toEqual(second.data);
  });
});
