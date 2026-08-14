// apps/web/src/App.test.jsx — the canonical /app route table, plus the
// setup gate that sits in front of it. Lane B retired /inbox as a
// destination (universal intake now lives in the docked AskBar — see
// app-shell/AskBar.jsx); this asserts that retirement at the routing level
// rather than relying on InboxPage.jsx simply not existing anymore.
//
// Every page component is mocked to a cheap marker string so this stays a
// routing test, not a full-tree render of AppShell/DashboardProvider/AskBar.
//
// The gate (App.jsx) fetches GET /api/onboard/state on mount and re-checks
// on pathname changes, which makes App an async component for the first
// time. This repo's vitest config runs in the default "node" environment
// (no jsdom, no @testing-library/react — see JobDrawer.test.jsx/
// DashboardContext.test.jsx/AskBar.test.jsx for the house convention this
// file follows): a hand-rolled hook harness replaces useState/useEffect via
// vi.mock("react", ...), react-router-dom is mocked to a minimal stand-in
// (a controllable useLocation plus a Routes/Route pair that matches on the
// exact literal paths App.jsx declares) rather than requiring a real
// Router/DOM, App is invoked as a plain function, and the returned element
// tree is flattened with renderToStaticMarkup for string assertions — same
// "invoke directly, flush effects manually" shape as
// DashboardContext.test.jsx's renderProvider()/flushEffects().
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

const apiMocks = vi.hoisted(() => ({ getOnboardState: vi.fn() }));
const COMPLETE_ONBOARD_STATE = {
  setupProgress: { complete: true },
  data: {
    setup: { readiness: { search_ready: true } },
    sourcing: {
      sourceSetup: { deterministicSources: { attempted: 1 } },
      firstSearchRun: { status: "running", run: { status: "running" } },
    },
  },
};

// Controllable stand-in for the router's current location. Tests mutate
// `routerState.pathname` directly rather than mounting a real Router.
const routerState = vi.hoisted(() => ({ pathname: "/" }));

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

// Minimal stand-in for react-router-dom: useLocation reads the test-controlled
// routerState, Navigate renders a plain marker string (so assertions can see
// both the target and whether `replace` was set), and Routes/Route match on
// the exact literal paths App.jsx's own route table declares — a real router
// isn't needed to prove App.jsx wires the right component to the right path.
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
}));

vi.mock("./lib/api.js", () => ({ getOnboardState: apiMocks.getOnboardState }));

vi.mock("./app-shell/AppShell.jsx", () => ({
  AppShell: ({ children }) => <div data-testid="shell">{children}</div>,
}));
vi.mock("./app-shell/DashboardContext.jsx", () => ({
  DashboardProvider: ({ children }) => <div data-testid="dashboard-provider">{children}</div>,
}));
vi.mock("./calendar/CalendarPage.jsx", () => ({ CalendarPage: () => "calendar-page" }));
vi.mock("./deep-ingest/DeepIngestPage.jsx", () => ({ DeepIngestPage: () => "deep-ingest-page" }));
vi.mock("./jobs/JobsPage.jsx", () => ({ JobsPage: () => "jobs-page" }));
vi.mock("./library/LibraryPage.jsx", () => ({ LibraryPage: () => "library-page" }));
vi.mock("./network/NetworkPage.jsx", () => ({ NetworkPage: () => "network-page" }));
vi.mock("./onboarding/OnboardingPage.jsx", () => ({ OnboardingPage: () => "onboarding-page" }));
vi.mock("./pages/ComingSoonPage.jsx", () => ({
  ComingSoonPage: ({ title }) => `not-found:${title}`,
}));
vi.mock("./pages/DashboardPage.jsx", () => ({ DashboardPage: () => "dashboard-page" }));
vi.mock("./settings/SettingsPage.jsx", () => ({ SettingsPage: () => "settings-page" }));

// Loads a fresh App.jsx module instance with VITE_STATIC_PREVIEW stubbed for
// this test, same pattern as DashboardContext.test.jsx's
// loadDashboardContext() — App.jsx reads import.meta.env.VITE_STATIC_PREVIEW
// once at module scope, so the env stub has to be in place before import.
async function loadApp({ staticPreview = false } = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_STATIC_PREVIEW", staticPreview ? "true" : "false");
  return import("./App.jsx");
}

// Invokes App() directly (not via JSX/a mounted tree) so the mocked
// useState/useEffect above actually intercept its hook calls, then flattens
// the returned element tree to a string for assertion. Mirrors
// DashboardContext.test.jsx's renderProvider(); the difference is App has no
// props and no context value to thread through.
function renderApp(module) {
  hooks.reset();
  return renderToStaticMarkup(module.App());
}

// Same shape as DashboardContext.test.jsx's flushEffects(): runs every
// effect queued by the most recent renderApp() call, then drains the
// microtask queue so the getOnboardState().then(...)/.catch(...) chains
// settle before the next renderApp() reads the resulting state.
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
  apiMocks.getOnboardState.mockReset();
  routerState.pathname = "/";
  vi.unstubAllEnvs();
});

describe("App — setup gate", () => {
  it("renders nothing while the initial setup check is in flight", async () => {
    const module = await loadApp();
    routerState.pathname = "/jobs";
    apiMocks.getOnboardState.mockResolvedValueOnce(COMPLETE_ONBOARD_STATE);

    expect(renderApp(module)).toBe("");
  });

  it("redirects a gated route to /onboarding when setup reads incomplete", async () => {
    const module = await loadApp();
    routerState.pathname = "/jobs";
    apiMocks.getOnboardState.mockResolvedValueOnce({ setupProgress: { complete: false } });

    renderApp(module);
    await flushEffects();
    const html = renderApp(module);

    expect(html).toContain("navigate:/onboarding:replace=true");
    expect(html).not.toContain("jobs-page");
  });

  it("keeps a completed candidate in onboarding when source setup has not started", async () => {
    const module = await loadApp();
    routerState.pathname = "/jobs";
    apiMocks.getOnboardState.mockResolvedValueOnce({
      setupProgress: { complete: true },
      data: { setup: { readiness: { search_ready: true } } },
    });

    renderApp(module);
    await flushEffects();
    const html = renderApp(module);

    expect(html).toContain("navigate:/onboarding:replace=true");
    expect(html).not.toContain("jobs-page");
  });

  // /settings is the forms-based way to FINISH setup — the onboarding hero
  // links to it as "PREFER FORMS? OPEN THE CHECKLIST". Gating it sent the one
  // escape hatch for people who don't want the chat interview straight back
  // to the chat interview.
  it("never gates /settings, so the onboarding escape hatch still opens the checklist", async () => {
    const module = await loadApp();
    routerState.pathname = "/settings";
    apiMocks.getOnboardState.mockResolvedValue({ setupProgress: { complete: false } });

    const html = renderApp(module);
    await flushEffects();
    const settled = renderApp(module);

    // Reachable on the very first paint, with no redirect and no blank beat:
    // an ungated route must not wait on the setup check at all.
    expect(html).toContain("settings-page");
    expect(settled).toContain("settings-page");
    expect(settled).not.toContain("navigate:");
    expect(apiMocks.getOnboardState).not.toHaveBeenCalled();
  });

  it("renders the normal route table when setup reads complete", async () => {
    const module = await loadApp();
    routerState.pathname = "/jobs";
    apiMocks.getOnboardState.mockResolvedValueOnce(COMPLETE_ONBOARD_STATE);

    renderApp(module);
    await flushEffects();
    const html = renderApp(module);

    expect(html).toContain("jobs-page");
    expect(html).not.toContain("navigate:");
  });

  it("routes /onboarding outside AppShell, through its own DashboardProvider, whether setup is complete or not", async () => {
    for (const complete of [false, true]) {
      const module = await loadApp();
      routerState.pathname = "/onboarding";
      apiMocks.getOnboardState.mockResolvedValueOnce({ setupProgress: { complete } });

      const html = renderApp(module);

      expect(html).toContain("onboarding-page");
      expect(html).not.toContain('data-testid="shell"');
      expect(html).not.toContain("navigate:");
    }
  });

  it("fails open and renders the route table when the state fetch rejects", async () => {
    const module = await loadApp();
    routerState.pathname = "/jobs";
    apiMocks.getOnboardState.mockRejectedValueOnce(new Error("offline"));

    renderApp(module);
    await flushEffects();
    const html = renderApp(module);

    expect(html).toContain("jobs-page");
    expect(html).not.toContain("navigate:");
  });

  it("skips the gate entirely in static preview mode, even with an incomplete state", async () => {
    const module = await loadApp({ staticPreview: true });
    routerState.pathname = "/jobs";

    const html = renderApp(module);
    await flushEffects();

    expect(html).toContain("jobs-page");
    expect(apiMocks.getOnboardState).not.toHaveBeenCalled();
  });

  it("sticky release: finishing setup and navigating in releases the gate instead of re-trapping on a stale incomplete read", async () => {
    const module = await loadApp();

    routerState.pathname = "/jobs";
    apiMocks.getOnboardState.mockResolvedValueOnce({ setupProgress: { complete: false } });
    renderApp(module);
    await flushEffects();
    expect(renderApp(module)).toContain("navigate:/onboarding:replace=true");

    // User finishes setup and navigates straight into the app (not through
    // /onboarding) — the stale "blocked for /jobs" read must not be reused
    // for "/"; App has to re-check before deciding anything.
    routerState.pathname = "/";
    apiMocks.getOnboardState.mockResolvedValueOnce(COMPLETE_ONBOARD_STATE);
    expect(renderApp(module)).toBe("");

    await flushEffects();
    expect(renderApp(module)).toContain("dashboard-page");
  });

  it("never re-fetches or re-gates once setup has read complete for the life of the mount", async () => {
    const module = await loadApp();

    routerState.pathname = "/";
    apiMocks.getOnboardState.mockResolvedValueOnce(COMPLETE_ONBOARD_STATE);
    renderApp(module);
    await flushEffects();
    expect(renderApp(module)).toContain("dashboard-page");

    routerState.pathname = "/settings";
    const html = renderApp(module);
    await flushEffects();

    expect(html).toContain("settings-page");
    expect(apiMocks.getOnboardState).toHaveBeenCalledTimes(1);
  });
});

describe("App — canonical route table", () => {
  it("falls through /inbox to the catch-all 'Not found' page", async () => {
    const module = await loadApp();
    const html = await renderAtWhenComplete(module, "/inbox");

    expect(html).toContain("not-found:Not found");
    expect(html).not.toContain("inbox-page");
  });

  it("still routes every surviving product page", async () => {
    const module = await loadApp();

    expect(await renderAtWhenComplete(module, "/")).toContain("dashboard-page");
    expect(await renderAtWhenComplete(module, "/jobs")).toContain("jobs-page");
    expect(await renderAtWhenComplete(module, "/calendar")).toContain("calendar-page");
    expect(await renderAtWhenComplete(module, "/network")).toContain("network-page");
    expect(await renderAtWhenComplete(module, "/library")).toContain("library-page");
    expect(await renderAtWhenComplete(module, "/settings")).toContain("settings-page");
    expect(await renderAtWhenComplete(module, "/deep-ingest")).toContain("deep-ingest-page");
  });

  it("routes /onboarding outside AppShell, through its own DashboardProvider", async () => {
    const module = await loadApp();
    routerState.pathname = "/onboarding";
    apiMocks.getOnboardState.mockResolvedValueOnce(COMPLETE_ONBOARD_STATE);

    const html = renderApp(module);

    expect(html).toContain("onboarding-page");
    expect(html).not.toContain('data-testid="shell"');
  });
});
