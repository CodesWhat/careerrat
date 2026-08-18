// apps/web/src/pages/DashboardStrategyPanel.test.jsx
// vitest coverage for DashboardPage.jsx's StrategyPanel — the dashboard-side
// view into the reevaluate-strategy domain (data.strategy, buildStrategyInsights
// in dashboard-data.js). Split into its own file rather than appended to
// DashboardPage.test.jsx: that file renders with react-dom/server's
// renderToStaticMarkup + a real MemoryRouter, which can never execute an
// onClick (there's no reconciler pass over the string it returns), so it can't
// cover StrategyCta's requestAskAction dispatch. This file instead borrows
// AskBar.test.jsx's hand-rolled "react" hook harness and calls DashboardPage()
// directly as a plain function, then walks the returned element tree,
// selectively invoking only the Strategy*-named function components
// (StrategyPanel/StrategyMetrics/StrategyHeadline/StrategyCta/...) to surface
// their generated content. Everything else (Link, Button, icons, PanelHeader)
// is left un-invoked as a bare element reference — those either need real
// router/DOM context this harness doesn't provide, or (Button) simply don't
// need to run: their props (including onClick) are already sitting on the
// element description once the Strategy* component that renders them runs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Minimal hook harness — only useState is exercised on the path this file
// drives (DashboardPage's own useDeepIngestNudge call), but useRef/useEffect
// are included too so nothing here throws if a future change adds one.
// ---------------------------------------------------------------------------

const hooks = vi.hoisted(() => ({
  cursor: 0,
  states: [],
  refs: [],
  reset() {
    this.cursor = 0;
    this.states = [];
    this.refs = [];
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useState(initial) {
      const index = hooks.cursor++;
      if (!(index in hooks.states)) {
        hooks.states[index] = typeof initial === "function" ? initial() : initial;
      }
      const setValue = (next) => {
        hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next;
      };
      return [hooks.states[index], setValue];
    },
    useRef(initial) {
      const index = hooks.cursor++;
      if (!(index in hooks.refs)) hooks.refs[index] = { current: initial };
      return hooks.refs[index];
    },
    useEffect() {
      // Not exercised on this render path (no mount effects run without a
      // real reconciler) — a no-op is correct here, not a stand-in gap.
    },
    // DashboardPage's own useDeepIngestNudge call (SetupReadinessCard.jsx)
    // reads its shared dismissal via useSyncExternalStore against a
    // module-level store. This harness never simulates a real
    // subscription-driven re-render (every hook here relies on the test
    // calling DashboardPage() again after a state change), so a plain
    // getSnapshot() read is enough.
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
  };
});

const dashboardContext = vi.hoisted(() => ({ useDashboardSnapshot: vi.fn() }));
vi.mock("../app-shell/DashboardContext.jsx", () => dashboardContext);

const askEvents = vi.hoisted(() => ({ requestAskAction: vi.fn(), requestAskBar: vi.fn() }));
vi.mock("../app-shell/ask-events.js", () => askEvents);

import { DashboardPage } from "./DashboardPage.jsx";

// ---------------------------------------------------------------------------
// Targeted tree walk — visit()/textOf() read .props.children verbatim (no
// invocation needed, JSX children are set at element-creation time); expand()
// additionally invokes ONLY Strategy*-named function components, since those
// are the sole pure/hook-free layer this file needs to see the generated
// output of (metrics, row groups, the CTA). Link/Button/icons/PanelHeader stay
// as un-invoked element references — exactly what's needed to read a Button
// element's props.onClick without ever calling Button() itself.
// ---------------------------------------------------------------------------

function expand(node) {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node.type === "function" && node.type.name?.startsWith("Strategy")) {
    return expand(node.type(node.props));
  }
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
}

function visit(node, predicate, found = []) {
  if (node == null || typeof node === "boolean") return found;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, predicate, found);
    return found;
  }
  if (typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  visit(node.props?.children, predicate, found);
  return found;
}

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.props?.children);
}

function hasClass(node, cls) {
  const className = node.props?.className;
  return typeof className === "string" && className.split(" ").includes(cls);
}

function byClass(tree, cls) {
  return visit(tree, (n) => hasClass(n, cls))[0];
}

function byComponentName(tree, name) {
  return visit(tree, (n) => n.type?.name === name)[0];
}

// ---------------------------------------------------------------------------
// Fixture — real contracted shape from buildStrategyInsights (dashboard-data.js):
// metrics.{topSource,bestLane,staleCount} carry {label,value,rate}; sources/
// roles/fitBands rows carry {label,bar,meta}; stale/stageAges rows carry
// {id,title,meta,detailId}; cadence rows add {tone,badge}; learning carries
// {windowLabel,trends,history,signals,reviewTrigger,reevaluation}.
// ---------------------------------------------------------------------------

const STRATEGY_FIXTURE = {
  metrics: {
    topSource: { label: "LinkedIn", rate: "42%", value: "LinkedIn" },
    bestLane: { label: "Applied AI Engineer", rate: "38%", value: "Applied AI Engineer" },
    staleCount: { label: "Quiet", value: 2, rate: "2 quiet" },
  },
  sources: [
    {
      key: "linkedin",
      label: "LinkedIn",
      bar: 100,
      meta: "3/7 advanced · 42% response",
      rate: "42%",
    },
  ],
  roles: [
    {
      key: "applied-ai-engineer",
      label: "Applied AI Engineer",
      bar: 80,
      meta: "3/8 advanced · 38% response",
      rate: "38%",
    },
  ],
  fitBands: [{ key: "high", label: "High fit", bar: 60, meta: "2/3 advanced · 66% response" }],
  stale: [
    {
      id: "app-acme",
      title: "Acme Freight",
      meta: "14d quiet · Applied AI Engineer",
      detailId: "app-acme",
    },
  ],
  stageAges: [],
  cadence: [
    {
      id: "app-riverside",
      title: "Riverside Health",
      meta: "Follow up on the recruiter screen",
      tone: "overdue",
      detailId: "app-riverside",
      badge: "Overdue",
    },
  ],
  learning: {
    windowLabel: "Last 30d",
    trends: [{ id: "applied", label: "Applied", value: 8, deltaLabel: "+3 vs prior 30d" }],
    history: [{ label: "Jul", applied: 5, responseRate: 40 }],
    signals: [{ id: "remote-first", label: "remote-first", meta: "42% response" }],
    reviewTrigger: {
      ready: true,
      title: "Enough signal to review strategy",
      summary:
        "Last 30d: 8 applications, 3 advanced, 2 rejected. Run reevaluate-strategy before changing volume or channel mix.",
      ctaLabel: "Run strategy review",
      ctaAction: "strategy-review",
    },
    reevaluation: null,
  },
  recommendation: {
    title: "Double down on LinkedIn",
    summary:
      "LinkedIn is producing 42% response across 7 tracked roles. Keep adding roles that resemble Applied AI Engineer.",
    ctaLabel: "Open Jobs",
    ctaAction: "jobs",
  },
};

const DASHBOARD_DATA = {
  focus: { kind: "action" },
  allNextSteps: [],
  latestRoles: [],
  sourcedRoles: [],
  reviewHoldRoles: [],
  calendar: { upcoming: { events: [] } },
  jobs: { rail: {}, visibleCount: 0 },
  strategy: STRATEGY_FIXTURE,
};

function renderDashboard(data = DASHBOARD_DATA) {
  hooks.reset();
  dashboardContext.useDashboardSnapshot.mockReturnValue({
    data,
    setup: null,
    loading: false,
    error: null,
    noDatabase: false,
  });
  return expand(DashboardPage());
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DashboardPage StrategyPanel", () => {
  it("renders metrics, the recommendation/review-trigger headline, and the collapsed breakdown/attention/cadence/learning sections", () => {
    const tree = renderDashboard();
    const panel = byClass(tree, "dashboard__panel--strategy");
    expect(panel).toBeTruthy();

    // Metric chips.
    const metrics = byClass(panel, "dashboard__strategy-metrics");
    expect(textOf(metrics)).toContain("LinkedIn");
    expect(textOf(metrics)).toContain("42%");
    expect(textOf(metrics)).toContain("Applied AI Engineer");
    expect(textOf(metrics)).toContain("Quiet");
    expect(textOf(metrics)).toContain("2 quiet");

    // Both the recommendation callout and the review-trigger callout render.
    const headline = byClass(panel, "dashboard__strategy-headline");
    expect(textOf(headline)).toContain("Double down on LinkedIn");
    expect(textOf(headline)).toContain("Enough signal to review strategy");

    // Collapsed <details> sections only render when they have rows, and each
    // carries its expected summary label plus at least one generated row.
    const detailsNodes = visit(panel, (n) => n.type === "details");
    expect(detailsNodes.length).toBe(4);
    const detailsText = detailsNodes.map(textOf);
    expect(detailsText.some((t) => t.includes("Sources, lanes & fit bands"))).toBe(true);
    expect(detailsText.some((t) => t.includes("LinkedIn") && t.includes("Top sources"))).toBe(true);
    expect(detailsText.some((t) => t.includes("Applications going quiet"))).toBe(true);
    expect(detailsText.some((t) => t.includes("Acme Freight"))).toBe(true);
    expect(detailsText.some((t) => t.includes("Follow-up nudges"))).toBe(true);
    expect(detailsText.some((t) => t.includes("Riverside Health"))).toBe(true);
    expect(detailsText.some((t) => t.includes("Learning (Last 30d)"))).toBe(true);
    expect(detailsText.some((t) => t.includes("remote-first"))).toBe(true);
  });

  it("dispatches the typed strategy.review intent through requestAskAction when the review-trigger CTA is clicked", () => {
    const tree = renderDashboard();
    const panel = byClass(tree, "dashboard__panel--strategy");
    const headline = byClass(panel, "dashboard__strategy-headline");

    // Two StrategyCta instances render (recommendation's "Open Jobs" Link, and
    // the review-trigger's ready:true Ask-dispatching Button) — find the one
    // that actually built a Button (props.onClick), not the plain Link.
    const buttons = visit(headline, (n) => n.type?.name === "Button");
    expect(buttons).toHaveLength(1);
    expect(textOf(buttons[0])).toBe("Run strategy review");

    expect(askEvents.requestAskAction).not.toHaveBeenCalled();
    buttons[0].props.onClick();

    expect(askEvents.requestAskAction).toHaveBeenCalledTimes(1);
    expect(askEvents.requestAskAction).toHaveBeenCalledWith({
      label: "Run strategy review",
      intent: {
        type: "strategy.review",
        entity: { type: "workspace", id: "workspace-main" },
        input: {},
      },
    });
  });

  it("renders nothing for a null strategy (no tracker data yet)", () => {
    const tree = renderDashboard({ ...DASHBOARD_DATA, strategy: null });
    expect(byClass(tree, "dashboard__panel--strategy")).toBeUndefined();
  });

  it("collapses to just the recommendation callout and metric chips when there is no breakdown, attention, cadence, or learning content", () => {
    const tree = renderDashboard({
      ...DASHBOARD_DATA,
      strategy: {
        metrics: {
          topSource: { label: "No source yet", rate: "0%", value: "No source yet" },
          bestLane: { label: "No lane yet", rate: "0%", value: "No lane yet" },
          staleCount: { label: "Quiet", value: 0, rate: "Clear" },
        },
        sources: [],
        roles: [],
        fitBands: [],
        stale: [],
        stageAges: [],
        cadence: [],
        learning: {
          windowLabel: "Last 30d",
          trends: [],
          history: [],
          signals: [],
          reviewTrigger: null,
          reevaluation: null,
        },
        recommendation: {
          title: "Build a measurable loop",
          summary: "No applied outcomes are available yet.",
          ctaLabel: "Open Jobs",
          ctaAction: "jobs",
        },
      },
    });

    const panel = byClass(tree, "dashboard__panel--strategy");
    expect(textOf(panel)).toContain("Build a measurable loop");
    expect(visit(panel, (n) => n.type === "details")).toHaveLength(0);
  });

  it("(sanity) byComponentName resolves the StrategyPanel node before it is invoked", () => {
    hooks.reset();
    dashboardContext.useDashboardSnapshot.mockReturnValue({
      data: DASHBOARD_DATA,
      setup: null,
      loading: false,
      error: null,
      noDatabase: false,
    });
    const raw = DashboardPage();
    expect(byComponentName(raw, "StrategyPanel")).toBeTruthy();
  });
});
