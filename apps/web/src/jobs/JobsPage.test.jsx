import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Api from "../lib/api.js";

const dashboardMock = vi.hoisted(() => ({
  snapshot: {
    data: null,
    loading: false,
    error: null,
    noDatabase: false,
    refetch: async () => {},
  },
}));

vi.mock("../app-shell/DashboardContext.jsx", () => ({
  useDashboardSnapshot: () => dashboardMock.snapshot,
}));

import * as JobsPageModule from "./JobsPage.jsx";

const { JobsPage } = JobsPageModule;

const DASHBOARD_DATA = {
  jobs: {
    rows: [
      {
        id: "sourced-1",
        source: "sourced",
        company: "Acme AI",
        role: "Forward Deployed Engineer",
      },
    ],
    funnel: {
      metrics: [],
      rail: [],
      bars: [],
    },
    sankey: {
      nodes: [],
      links: [],
      total: 0,
    },
  },
};

function renderJobsPage({
  searchSources = null,
  searchRun = null,
  manualSearchError = null,
  loading = false,
} = {}) {
  dashboardMock.snapshot = {
    data: {
      ...DASHBOARD_DATA,
      searchSources,
      sourceSetup: searchSources,
      searchRun,
      manualSearchRun: searchRun,
      sourcing: { manualSearchRun: searchRun, manualSearchError },
    },
    loading,
    error: null,
    noDatabase: false,
    refetch: async () => {},
  };

  return renderToStaticMarkup(
    <MemoryRouter>
      <JobsPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("JobsPage manual search action", () => {
  it("renders PageScaffold header actions when DB source setup exists", () => {
    const html = renderJobsPage({
      searchSources: {
        ready: true,
        searches: { enabled: 1, total: 1 },
        trackedCompanies: 1,
      },
    });

    expect(html).toContain("page-scaffold__actions");
    expect(html).toContain("Search jobs");
    expect(html).not.toContain("Finish Search setup before running a job search.");
  });

  it("shows a source-setup hint instead of an enabled search action when DB sources are absent", () => {
    const html = renderJobsPage({
      searchSources: {
        ready: false,
        searches: { enabled: 0, total: 0 },
        trackedCompanies: 0,
      },
    });

    expect(html).toContain("Finish Search setup before running a job search.");
    expect(html).not.toContain("page-scaffold__actions");
    expect(html).not.toContain(">Search jobs<");
  });

  it("changes the header action to Searching... while a run is active", () => {
    const html = renderJobsPage({
      searchSources: {
        ready: true,
        searches: { enabled: 1, total: 1 },
        trackedCompanies: 0,
      },
      searchRun: {
        purpose: "manual-search",
        status: "running",
      },
    });

    expect(html).toContain("Searching...");
  });

  it("surfaces manual search errors through an inline alert", () => {
    const html = renderJobsPage({
      searchSources: {
        ready: true,
        searches: { enabled: 1, total: 1 },
        trackedCompanies: 0,
      },
      manualSearchError: "Source setup could not be read.",
    });

    expect(html).toContain("inline-alert--error");
    expect(html).toContain("Source setup could not be read.");
  });

  it("getSearchSources targets GET /api/search/sources", async () => {
    expect(Api.getSearchSources).toBeTypeOf("function");
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, ready: true }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const body = await Api.getSearchSources();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/search/sources",
      expect.objectContaining({ method: "GET" })
    );
    expect(body.ready).toBe(true);
  });

  it("startSearchRun targets POST /api/sourcing/search/start and does not use chat or discovery wrappers", async () => {
    expect(Api.startSearchRun).toBeTypeOf("function");
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, run: { id: "run-1", status: "running" } }), {
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const body = await Api.startSearchRun();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sourcing/search/start",
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/chat|discovery|skill/i);
    expect(body.run.status).toBe("running");
  });

  it("exposes a click helper that calls startSearchRun for the header action", async () => {
    expect(JobsPageModule.runJobsPageSearch).toBeTypeOf("function");
    const calls = [];

    const result = await JobsPageModule.runJobsPageSearch({
      startSearchRun: async () => {
        calls.push("startSearchRun");
        return { ok: true, run: { id: "manual-1", status: "running" } };
      },
      refetch: async () => {
        calls.push("refetch");
      },
    });

    expect(calls).toEqual(["startSearchRun", "refetch"]);
    expect(result.run.status).toBe("running");
  });
});
