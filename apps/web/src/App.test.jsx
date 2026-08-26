import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  effectDeps: [],
  pendingEffects: [],
  states: [],
  reset() {
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

const apiMocks = vi.hoisted(() => ({ finishOnboarding: vi.fn(), getOnboardState: vi.fn() }));
const firstRun = vi.hoisted(() => ({ props: null }));
const routerState = vi.hoisted(() => ({ pathname: "/" }));
const navigate = vi.hoisted(() => vi.fn());
const COMPLETE_ONBOARD_STATE = {
  setupProgress: { complete: true },
  data: {
    "form-defaults": {
      voluntary_self_identification: {
        confirmed_at: "2026-08-25T12:00:00.000Z",
      },
    },
    setup: { readiness: { search_ready: true } },
    sourcing: {
      sourceSetup: { deterministicSources: { attempted: 1 } },
      firstSearchRun: { status: "running", run: { status: "running" } },
    },
  },
};

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
  };
});

vi.mock("react-router-dom", () => ({
  Navigate: ({ to, replace }) => `navigate:${to}:replace=${!!replace}`,
  Route: () => null,
  Routes: ({ children }) => {
    const routes = Array.isArray(children) ? children : [children];
    const exact = routes.find((route) => route.props.path === routerState.pathname);
    if (exact) return exact.props.element;
    const fallback = routes.find((route) => route.props.path === "*");
    return fallback ? fallback.props.element : null;
  },
  useLocation: () => ({ pathname: routerState.pathname }),
  useNavigate: () => navigate,
}));

vi.mock("./lib/api.js", () => ({
  finishOnboarding: apiMocks.finishOnboarding,
  getOnboardState: apiMocks.getOnboardState,
}));
vi.mock("./chat-first/dashboard-context.jsx", () => ({
  DashboardProvider: ({ children }) => <div data-testid="dashboard-provider">{children}</div>,
}));
vi.mock("./chat-first/ChatFirstApp.jsx", () => ({ ChatFirstApp: () => "chat-first-app" }));
vi.mock("./chat-first/FirstRunController.jsx", () => ({
  FirstRunController: (props) => {
    firstRun.props = props;
    return `first-run-controller:in-workspace=${String(props.inWorkspace)}`;
  },
}));
vi.mock("./chat-first/ProfileSettingsController.jsx", () => ({
  ProfileSettingsController: () => "profile-settings-controller",
}));

async function loadApp() {
  vi.resetModules();
  return import("./App.jsx");
}

function renderApp(module) {
  hooks.reset();
  return renderToStaticMarkup(module.App());
}

async function flushEffects() {
  const effects = hooks.pendingEffects.splice(0);
  for (const effect of effects) effect();
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

async function renderAtWhenComplete(module, path) {
  routerState.pathname = path;
  apiMocks.getOnboardState.mockResolvedValueOnce(COMPLETE_ONBOARD_STATE);
  renderApp(module);
  await flushEffects();
  return renderApp(module);
}

beforeEach(() => {
  hooks.clear();
  apiMocks.finishOnboarding.mockReset().mockResolvedValue({ ok: true });
  apiMocks.getOnboardState.mockReset();
  routerState.pathname = "/";
  firstRun.props = null;
  navigate.mockReset();
  delete globalThis.careerratDesktopApp;
});

describe("App chat-first flip", () => {
  it("keeps a completed fresh setup gated until local application defaults are confirmed", async () => {
    const module = await loadApp();
    apiMocks.getOnboardState.mockResolvedValueOnce({
      ...COMPLETE_ONBOARD_STATE,
      data: {
        ...COMPLETE_ONBOARD_STATE.data,
        "form-defaults": {
          voluntary_self_identification: {
            enabled: false,
            default_action: "leave_blank",
            confirmed_at: null,
            answers: {},
          },
        },
      },
    });

    expect(renderApp(module)).toBe("");
    await flushEffects();
    const html = renderApp(module);

    expect(html).toContain("first-run-controller:in-workspace=true");
    expect(firstRun.props.initialOnboardState).toMatchObject({
      setupProgress: { complete: true },
      data: {
        "form-defaults": {
          voluntary_self_identification: { confirmed_at: null },
        },
      },
    });
    expect(apiMocks.finishOnboarding).not.toHaveBeenCalled();
  });

  it("keeps a completed workspace gated when its saved confirmation timestamp is malformed", async () => {
    const module = await loadApp();
    const malformedState = {
      ...COMPLETE_ONBOARD_STATE,
      data: {
        ...COMPLETE_ONBOARD_STATE.data,
        "form-defaults": {
          voluntary_self_identification: {
            enabled: false,
            default_action: "leave_blank",
            confirmed_at: "not-a-date",
            answers: {},
          },
        },
      },
    };
    apiMocks.getOnboardState.mockResolvedValueOnce(malformedState);

    renderApp(module);
    await flushEffects();
    const html = renderApp(module);

    expect(html).toContain("first-run-controller:in-workspace=true");
    expect(firstRun.props.initialOnboardState).toBe(malformedState);
    expect(apiMocks.finishOnboarding).not.toHaveBeenCalled();
  });

  it("routes a native-menu request through React Router without resetting live renderer state", async () => {
    let routeRequest;
    const unsubscribe = vi.fn();
    globalThis.careerratDesktopApp = {
      onNavigate: vi.fn((callback) => {
        routeRequest = callback;
        return unsubscribe;
      }),
    };
    const module = await loadApp();
    const workspace = await renderAtWhenComplete(module, "/");
    await flushEffects();

    expect(workspace).toContain("chat-first-app");
    expect(globalThis.careerratDesktopApp.onNavigate).toHaveBeenCalledOnce();
    routeRequest("/settings");
    expect(navigate).toHaveBeenCalledWith("/settings");

    routerState.pathname = "/settings";
    const settings = renderApp(module);
    expect(settings).toContain("profile-settings-controller");
    expect(settings).toContain("chat-first-app");
    expect(settings).toContain('hidden=""');
  });

  it("keeps the first-run controller as the hard setup gate", async () => {
    const module = await loadApp();
    apiMocks.getOnboardState.mockResolvedValueOnce({ setupProgress: { complete: false } });

    expect(renderApp(module)).toBe("");
    await flushEffects();

    const html = renderApp(module);
    expect(html).toContain("first-run-controller:in-workspace=true");
    expect(html).not.toContain("navigate:/onboarding");
  });

  it("mounts the chat-first workspace at the only normal app destination", async () => {
    const module = await loadApp();
    const html = await renderAtWhenComplete(module, "/");

    expect(html).toContain("chat-first-app");
    expect(html).toContain("dashboard-provider");
  });

  it("repairs the completed onboarding handoff before releasing the workspace", async () => {
    const module = await loadApp();
    apiMocks.getOnboardState.mockResolvedValueOnce(COMPLETE_ONBOARD_STATE);
    apiMocks.finishOnboarding.mockResolvedValueOnce({
      ok: true,
      handoff: { reused: false },
    });

    expect(renderApp(module)).toBe("");
    await flushEffects();
    const html = renderApp(module);

    expect(apiMocks.finishOnboarding).toHaveBeenCalledOnce();
    expect(html).toContain("chat-first-app");
    expect(navigate).toHaveBeenCalledWith("/", {
      replace: true,
      state: { browse: "search", onboardingComplete: true },
    });
  });

  it("keeps a routine launch in the workspace when the onboarding handoff was already reused", async () => {
    const module = await loadApp();
    apiMocks.getOnboardState.mockResolvedValueOnce(COMPLETE_ONBOARD_STATE);
    apiMocks.finishOnboarding.mockResolvedValueOnce({
      ok: true,
      handoff: { reused: true },
    });

    renderApp(module);
    await flushEffects();
    const html = renderApp(module);

    expect(apiMocks.finishOnboarding).toHaveBeenCalledOnce();
    expect(html).toContain("chat-first-app");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("foregrounds Search as the unmistakable next step after onboarding completes", async () => {
    const module = await loadApp();
    apiMocks.getOnboardState.mockResolvedValueOnce({ setupProgress: { complete: false } });

    renderApp(module);
    await flushEffects();
    renderApp(module);
    firstRun.props.onComplete();

    expect(navigate).toHaveBeenCalledWith("/", {
      replace: true,
      state: { browse: "search", onboardingComplete: true },
    });
  });

  it("exposes the chat-first profile at /settings without gating it", async () => {
    const module = await loadApp();
    routerState.pathname = "/settings";

    const html = renderApp(module);

    expect(html).toContain("profile-settings-controller");
    expect(apiMocks.getOnboardState).not.toHaveBeenCalled();
  });

  it.each(["/jobs", "/calendar", "/network", "/library", "/deep-ingest", "/onboarding"])(
    "retires classic route %s and redirects it into the workspace",
    async (path) => {
      const module = await loadApp();
      const html = await renderAtWhenComplete(module, path);

      expect(html).toContain("navigate:/:replace=true");
      expect(html).not.toContain("-page");
    }
  );
});
