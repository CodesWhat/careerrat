import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const dashboardMock = vi.hoisted(() => ({
  snapshot: {
    data: null,
    loading: false,
    error: null,
    noDatabase: false,
  },
}));

vi.mock("../app-shell/DashboardContext.jsx", () => ({
  useDashboardSnapshot: () => dashboardMock.snapshot,
}));

import { FunnelSankey } from "./FunnelSankey.jsx";
import { JobsPage } from "./JobsPage.jsx";

const sankey = {
  total: 8,
  nodes: [
    {
      id: "src-cold",
      label: "Direct apply",
      color: "#8E8B84",
      count: 5,
      col: 0,
      order: 1,
      filter: "all",
    },
    {
      id: "src-recruiter",
      label: "Recruiter sourced",
      color: "#4EA4A8",
      count: 3,
      col: 0,
      order: 2,
      filter: "all",
    },
    {
      id: "awaiting",
      label: "Awaiting response",
      color: "#B8B2AA",
      count: 3,
      col: 1,
      order: 1,
      filter: "awaiting",
    },
    {
      id: "heardback",
      label: "Heard back",
      color: "#2B2724",
      count: 5,
      col: 1,
      order: 2,
      filter: "heardback",
    },
    {
      id: "stale",
      label: "Going stale",
      color: "#A7A098",
      count: 1,
      col: 1.5,
      order: 1.5,
      filter: "stale",
    },
    {
      id: "round-1",
      label: "1st round",
      color: "#7FCBA6",
      count: 3,
      col: 2,
      order: 1,
      filter: "round-1",
    },
    {
      id: "round-2",
      label: "2nd round",
      color: "#5BC4A0",
      count: 1,
      col: 3,
      order: 2,
      filter: "round-2",
    },
    {
      id: "rejected",
      label: "Rejected",
      color: "#CB5340",
      count: 2,
      col: 2.5,
      order: 99,
      filter: "terminal",
    },
    {
      id: "accepted",
      label: "Accepted 🎉",
      color: "#2F9E55",
      count: 1,
      col: 3.7,
      order: 98,
      filter: "accepted",
    },
  ],
  links: [
    {
      from: "src-cold",
      to: "awaiting",
      count: 2,
      color: "#8E8B84",
      filter: "awaiting",
      examples: ["Alpha Labs · Applied"],
    },
    {
      from: "src-cold",
      to: "heardback",
      count: 3,
      color: "#8E8B84",
      filter: "heardback",
      examples: ["Beta Systems · Screen"],
    },
    {
      from: "src-recruiter",
      to: "heardback",
      count: 3,
      color: "#4EA4A8",
      filter: "heardback",
      examples: ["Gamma AI · Technical"],
    },
    {
      from: "heardback",
      to: "round-1",
      count: 3,
      color: "#7FCBA6",
      filter: "round-1",
    },
    {
      from: "round-1",
      to: "round-2",
      count: 1,
      color: "#5BC4A0",
      filter: "round-2",
    },
    {
      from: "round-1",
      to: "rejected",
      count: 2,
      color: "#CB5340",
      filter: "terminal",
      examples: ["Delta Cloud · 1st round"],
    },
    {
      from: "round-2",
      to: "accepted",
      count: 1,
      color: "#2F9E55",
      filter: "accepted",
      examples: ["Echo Works · Offer"],
    },
    {
      from: "awaiting",
      to: "stale",
      count: 1,
      color: "#A7A098",
      filter: "stale",
      examples: ["Foxtrot Data · Applied"],
    },
  ],
};

function renderJobsPage(data) {
  dashboardMock.snapshot = {
    data,
    loading: false,
    error: null,
    noDatabase: false,
  };
  return renderToStaticMarkup(
    <MemoryRouter>
      <JobsPage />
    </MemoryRouter>
  );
}

describe("FunnelSankey", () => {
  it("renders the legacy Sankey nodes, links, counts, and numbered round depth", () => {
    const html = renderToStaticMarkup(<FunnelSankey sankey={sankey} />);

    expect(html).toContain("Jobs funnel");
    expect(html).toContain("Direct apply");
    expect(html).toContain("Recruiter sourced");
    expect(html).toContain("Awaiting response");
    expect(html).toContain("Heard back");
    expect(html).toContain("Going stale");
    expect(html).toContain("1st round");
    expect(html).toContain("2nd round");
    expect(html).toContain("Rejected");
    expect(html).toContain("Accepted");
    expect(html).toContain('data-sankey-link="heardback-round-1"');
    expect(html).toContain('data-sankey-link="round-1-rejected"');
    expect(html).toContain("Beta Systems · Screen");
    expect(html).toContain("(3)");
    expect(html).toContain("(1)");
  });

  it("renders a quiet empty state when no Sankey data exists", () => {
    const html = renderToStaticMarkup(<FunnelSankey sankey={{ nodes: [], links: [], total: 0 }} />);

    expect(html).toContain("No application funnel data yet");
    expect(html).not.toContain("<svg");
  });

  it("mounts on the jobs page below the existing funnel and list", () => {
    const html = renderJobsPage({
      jobs: {
        funnel: [{ id: "all", label: "All Active", count: 1, color: "#2B2724" }],
        sankey,
        rows: [
          {
            id: "job-1",
            source: "application",
            company: "Alpha Labs",
            role: "Staff Engineer",
            stageLabel: "Applied",
            fit: 86,
            modeLabel: "Remote",
            sourceLabel: "Direct apply",
            appliedLabel: "Jul 1",
            action: null,
          },
        ],
      },
    });

    expect(html.indexOf("All Active")).toBeLessThan(html.indexOf("Alpha Labs"));
    expect(html.indexOf("Alpha Labs")).toBeLessThan(html.indexOf("Jobs funnel"));
    expect(html).toContain("1st round");
  });
});
