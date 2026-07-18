import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const dashboardContext = vi.hoisted(() => ({
  useDashboardSnapshot: vi.fn(),
}));
const capturedButtons = vi.hoisted(() => []);

vi.mock("../app-shell/DashboardContext.jsx", () => dashboardContext);

vi.mock("../components/Button.jsx", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    Button: (props) => {
      capturedButtons.push(props);
      return actual.Button(props);
    },
  };
});

vi.mock("../lib/api.js", () => ({
  getApplication: vi.fn(async () => ({ data: null })),
  getCommunications: vi.fn(async () => ({ data: [] })),
  getDashboard: vi.fn(async () => ({ setup: null })),
  getApplications: vi.fn(async () => ({ data: [] })),
  getPacket: vi.fn(async () => ({ artifacts: {} })),
  getRuntimeConfig: vi.fn(async () => ({ aiWebSearch: { available: true } })),
  getSearchSources: vi.fn(async () => ({ ready: true })),
  logoImageUrl: ({ domain, name }) => `/logo/${domain || name}`,
  appendCommMessage: vi.fn(async () => ({})),
  markCommSent: vi.fn(async () => ({})),
  mergeNestedField: vi.fn((base, field, patch) => ({ ...(base?.[field] || {}), ...patch })),
  promoteSourced: vi.fn(async () => ({})),
  runPacketGate: vi.fn(async () => ({ data: {} })),
  scheduleInterview: vi.fn(async () => ({})),
  setAppFields: vi.fn(async () => ({})),
  setAppStatus: vi.fn(async () => ({})),
  setSourcedStatus: vi.fn(async () => ({})),
  exportPacketDocuments: vi.fn(async () => ({ data: {} })),
  generatePacketDocuments: vi.fn(async () => ({ data: {} })),
  startSearchRun: vi.fn(async () => ({ run: { status: "running" } })),
  runAiWebSearchStream: vi.fn(async () => {}),
}));

import { setSourcedStatus } from "../lib/api.js";
import { describeManualRunSummary, JobsPage } from "./JobsPage.jsx";

describe("describeManualRunSummary", () => {
  it("passes preview string summaries through unchanged", () => {
    expect(
      describeManualRunSummary({ status: "completed", summary: "Last sweep found 3 roles." })
    ).toBe("Last sweep found 3 roles.");
  });

  it("formats structured free-board sweep counts", () => {
    expect(
      describeManualRunSummary({
        status: "completed",
        summary: { scanned: 318, new: 312, attemptedSources: 6, errorCount: 0 },
      })
    ).toBe("Free-board sweep: 318 scanned, 312 new roles from 6 sources.");
  });

  it("appends structured source error counts", () => {
    expect(
      describeManualRunSummary({
        status: "completed",
        summary: { scanned: 318, new: 312, attemptedSources: 6, errorCount: 2 },
      })
    ).toBe("Free-board sweep: 318 scanned, 312 new roles from 6 sources. 2 source errors.");
  });

  it("describes a zero-results sweep", () => {
    expect(describeManualRunSummary({ status: "completed", summary: { zeroResults: true } })).toBe(
      "Free-board sweep finished — no new roles this pass."
    );
  });

  it("omits failed runs and runs without summaries", () => {
    expect(describeManualRunSummary({ status: "failed", summary: "should be hidden" })).toBeNull();
    expect(describeManualRunSummary({ status: "completed" })).toBeNull();
    expect(describeManualRunSummary(null)).toBeNull();
  });
});

// No jsdom in this suite (vitest's default "node" environment has neither
// `window` nor `localStorage`), but JobsPage persists explorer state via
// `globalThis.localStorage`. Stub a minimal in-memory implementation so the
// persistence round-trip is exercised the same way it runs in a real browser.
function createMemoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

globalThis.localStorage = createMemoryStorage();

const JOBS_DATA = {
  searchSources: {
    ready: true,
    searches: { enabled: 2, total: 3 },
    trackedCompanies: 8,
    deterministicSources: { attempted: 10, rss: 2, supportedAtsCompanies: 8, skipped: 0 },
  },
  sourcing: {
    manualSearchRun: {
      purpose: "manual-search",
      status: "idle",
      summary: "Last sweep found 3 roles.",
    },
  },
  jobs: {
    visibleCount: 5,
    rail: {
      nextDecision: {
        title: "Review high-fit roles",
        summary: "Two sourced roles need a gate decision.",
        action: "manual-review",
        hasWork: true,
      },
    },
    sankey: {
      total: 4,
      nodes: [
        {
          id: "src-cold",
          label: "Cold",
          color: "#8E8B84",
          count: 2,
          col: 0,
          order: 0,
          filter: "src-cold",
        },
        {
          id: "awaiting",
          label: "Awaiting",
          color: "#F2C94C",
          count: 1,
          col: 1,
          order: 0,
          filter: "awaiting",
        },
        {
          id: "technical",
          label: "Technical",
          color: "#2F9E8F",
          count: 1,
          col: 2,
          order: 0,
          filter: "technical",
        },
        {
          id: "ghosted",
          label: "Ghosted",
          color: "#8E8B84",
          count: 1,
          col: 1,
          order: 1,
          filter: "ghosted",
        },
      ],
      links: [
        {
          from: "src-cold",
          to: "awaiting",
          count: 1,
          color: "#F2C94C",
          examples: ["Northstar Systems"],
          filter: "awaiting",
        },
        {
          from: "awaiting",
          to: "technical",
          count: 1,
          color: "#2F9E8F",
          examples: ["Vector Loom"],
          filter: "technical",
        },
      ],
    },
    rows: [
      {
        id: "app-stale",
        source: "application",
        company: "Northstar Systems",
        role: "Applied AI Engineer",
        domain: "northstar.example",
        location: "New York hybrid",
        comp: "$230k base",
        compSummary: "$230k base",
        stage: "applied",
        stageLabel: "Applied",
        sourceBucket: "src-cold",
        channel: "board",
        mode: "hybrid",
        fit: 82,
        fitBasis: "screened",
        baseK: 230,
        compMidpointK: 240,
        terminal: false,
        roundsReached: 0,
        needsReview: false,
        needsAction: false,
        stale: true,
        ghosted: false,
        missingComp: false,
        highFit: true,
        interviewPath: false,
        decayState: "stale",
        actionState: "stale",
        workstream: "stale",
        appliedAt: "2026-07-01",
        appliedLabel: "Jul 1",
        healthBadge: { rating: "risky", label: "Risky", title: "Company risk is elevated" },
        action: { cta: "Follow up", dueText: "Today" },
        searchText: "northstar systems applied ai engineer hybrid board",
        drawer: {
          floor: 215,
          ask: 245,
          marketLo: 220,
          marketP50: 238,
          marketHi: 270,
          compState: "built",
          compStateLabel: "Built from data",
          compBasis: "NYC AI engineer comps",
          compConfidence: "high",
          compHasMarket: true,
          compSampleSize: 14,
          compAsOf: "2026-07-08",
        },
      },
      {
        id: "app-ghosted",
        source: "application",
        company: "Signal Harbor",
        role: "AI Platform Lead",
        domain: "signal.example",
        location: "Remote",
        comp: "$220k base",
        stage: "screen",
        stageLabel: "Screen",
        sourceBucket: "src-recruiter",
        channel: "recruiter",
        mode: "remote",
        fit: 79,
        fitBasis: "screened",
        baseK: 220,
        terminal: false,
        roundsReached: 1,
        needsReview: false,
        needsAction: false,
        stale: false,
        ghosted: true,
        missingComp: false,
        highFit: false,
        interviewPath: true,
        decayState: "ghosted",
        actionState: "ghosted",
        workstream: "ghosted",
        appliedAt: "2026-06-15",
        appliedLabel: "Jun 15",
        healthBadge: { rating: "watch", label: "Watch", title: "Watch hiring pace" },
        action: { cta: "Revive", dueText: "30d" },
        searchText: "signal harbor ai platform lead remote recruiter",
      },
      {
        id: "app-technical",
        source: "application",
        company: "Vector Loom",
        role: "Staff AI Engineer",
        domain: "vector.example",
        location: "NYC hybrid",
        comp: "$250k base",
        stage: "technical",
        stageLabel: "Technical",
        sourceBucket: "src-referral",
        channel: "referral",
        mode: "hybrid",
        fit: 91,
        fitBasis: "screened",
        baseK: 250,
        terminal: false,
        roundsReached: 2,
        needsReview: false,
        needsAction: true,
        stale: false,
        ghosted: false,
        missingComp: false,
        highFit: true,
        interviewPath: true,
        actionState: "needs-action",
        workstream: "interview",
        appliedAt: "2026-07-04",
        appliedLabel: "Jul 4",
        action: { cta: "Prep", dueText: "Tomorrow" },
        searchText: "vector loom staff ai engineer nyc hybrid referral",
      },
      {
        id: "sourced-triage",
        source: "sourced",
        company: "Meridian Labs",
        role: "Forward Deployed AI Engineer",
        domain: "meridian.example",
        location: "Remote US",
        comp: "$235k base",
        stage: "sourced",
        stageLabel: "Review",
        sourceBucket: "src-cold",
        channel: "board",
        mode: "remote",
        fit: 88,
        fitBasis: "triage estimate",
        baseK: 235,
        terminal: false,
        roundsReached: 0,
        needsReview: true,
        needsAction: false,
        stale: false,
        ghosted: false,
        missingComp: false,
        highFit: true,
        interviewPath: false,
        actionState: "review",
        workstream: "review",
        action: { cta: "Evaluate", dueText: "Fresh" },
        searchText: "meridian labs forward deployed ai engineer remote board",
      },
      {
        id: "app-rejected",
        source: "application",
        company: "Closed Door",
        role: "AI Systems Engineer",
        stage: "rejected",
        stageLabel: "Rejected",
        sourceBucket: "src-cold",
        channel: "portal",
        mode: "remote",
        fit: 64,
        fitBasis: "screened",
        baseK: 200,
        terminal: true,
        roundsReached: 1,
        needsReview: false,
        needsAction: false,
        stale: false,
        ghosted: false,
        missingComp: false,
        highFit: false,
        interviewPath: false,
        actionState: "archived",
        workstream: "archived",
        appliedAt: "2026-06-01",
        appliedLabel: "Jun 1",
        action: { cta: "Closed", dueText: "Done" },
        searchText: "closed door ai systems engineer",
      },
    ],
  },
};

function renderJobsPage({ route = "/jobs", snapshot = {}, storageState = null } = {}) {
  globalThis.localStorage.clear();
  if (storageState) {
    globalThis.localStorage.setItem("rolester-jobs-next-explorer", JSON.stringify(storageState));
  }
  dashboardContext.useDashboardSnapshot.mockReturnValue({
    data: JOBS_DATA,
    loading: false,
    error: null,
    noDatabase: false,
    refetch: async () => {},
    ...snapshot,
  });

  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[route]}>
      <JobsPage />
    </MemoryRouter>
  );
}

afterEach(() => {
  globalThis.localStorage.clear();
  capturedButtons.length = 0;
  vi.clearAllMocks();
});

describe("JobsPage", () => {
  it("renders the pipeline explorer as a sortable table by default", () => {
    const html = renderJobsPage({ storageState: { showGhosted: true } });

    expect(html).toContain('class="jobs"');
    expect(html).toContain(">Jobs<");
    expect(html).toContain("Pipeline");
    expect(html).toContain("Search");
    expect(html).toContain("Jobs funnel");
    expect(html).toContain("Jobs Sankey funnel");
    expect(html).toContain('role="button"');
    for (const label of ["Company", "Role", "Fit", "Base", "Stage", "Applied", "Action"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Northstar Systems");
    expect(html).toContain("Going stale");
    expect(html).toContain("Signal Harbor");
    expect(html).toContain("Ghosted");
    expect(html).toContain("Risky");
    expect(html).toContain("~88");
    expect(html).toContain("Showing");
  });

  it("renders the next-decision CTA when the rail has work", () => {
    const html = renderJobsPage();

    expect(html).toContain("Review high-fit roles");
    expect(html).toContain("Two sourced roles need a gate decision.");
  });

  it("renders the drawer comp bar from row drawer comp fields", () => {
    const html = renderJobsPage({ route: "/jobs?open=app-stale" });

    expect(html).toContain("Built from data");
    expect(html).toContain("14 comps");
    expect(html).toContain("high conf");
    expect(html).toContain("Mkt P50");
    expect(html).toContain("Your ask");
    expect(html).toContain("$238K");
  });

  it("renders the wired AI web-search lane instead of the coming-soon stub", () => {
    const html = renderJobsPage({ route: "/jobs?tab=search" });

    expect(html).toContain("AI Web Search Unavailable");
    expect(html).toContain("Run AI Web Search");
    expect(html).toContain("Configure an AI key in Settings to enable this lane.");
    expect(html).not.toContain("Coming soon");
  });

  it("search results use Open and Skip actions, with no Park action", () => {
    const html = renderJobsPage({ route: "/jobs?tab=search" });

    // "Open" is deliberate: the button only opens the drawer (evaluation is
    // the drawer's PacketGateCard), so labelling it "Evaluate" was a lie.
    expect(html).toContain(">Open<");
    expect(html).toContain(">Skip<");
    expect(html).not.toContain(">Park<");
    expect(html).not.toContain(">Evaluate<");
  });

  it("Skip cuts the sourced row and refetches the dashboard", async () => {
    const refetch = vi.fn(async () => {});
    renderJobsPage({ route: "/jobs?tab=search", snapshot: { refetch } });
    const skip = capturedButtons.find((props) => props.children === "Skip");
    expect(skip).toBeTruthy();

    await skip.onClick();

    expect(setSourcedStatus).toHaveBeenCalledWith({ id: "sourced-triage", to: "cut" });
    expect(refetch).toHaveBeenCalledOnce();
  });
});
