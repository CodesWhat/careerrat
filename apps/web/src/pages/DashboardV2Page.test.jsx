import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const dashboardContext = vi.hoisted(() => ({
  useDashboardSnapshot: vi.fn(),
}));

vi.mock("../app-shell/DashboardContext.jsx", () => dashboardContext);

vi.mock("../lib/api.js", () => ({
  getDashboard: vi.fn(async () => ({ setup: null })),
  logoImageUrl: ({ domain, name }) => `/logo/${domain || name}`,
}));

import { DashboardV2Page } from "./DashboardV2Page.jsx";

const DASHBOARD_DATA = {
  stats: {
    inPlay: 110,
    responseRate: 28,
    interviews: 5,
  },
  agentGuidance: {
    title: "Next agent task",
    message: "Ask your agent to run search-jobs next for a refresh.",
    reason: "Sources are configured and have prior run history.",
    ctaLabel: "Run search-jobs",
  },
  focus: {
    kind: "action",
    title: "Prepare for the PwC Teams interview",
    company: "PwC",
    role: "Director Solution Architect",
    note: "PwC confirmed the application and requested availability.",
    dueText: "19d overdue",
    tone: "error",
    detailId: "app-pwc",
    cta: "Handle next action",
  },
  allNextSteps: [
    {
      title: "Prepare for the PwC Teams interview",
      company: "PwC",
      supportingText: "PwC",
      actionLabel: "Interview",
      dueText: "19d overdue",
      tone: "error",
      detailId: "app-pwc",
    },
    {
      title: "Send Ramp follow-up",
      company: "Ramp",
      supportingText: "Ramp",
      actionLabel: "Follow Up",
      dueText: "today",
      detailId: "app-ramp",
    },
  ],
  reviewHoldRoles: [
    {
      company: "Ramp",
      role: "Applied AI Engineer",
      fit: 82,
      domain: "ramp.com",
      detailId: "role-ramp",
    },
  ],
  calendar: {
    todayIso: "2026-07-07",
    upcoming: {
      events: [
        {
          kind: "interview",
          label: "Interview",
          iso: "2026-07-07",
          time: "2:00 PM",
          title: "Juniper Square interview",
          detailId: "app-juniper",
        },
      ],
    },
  },
  latestRoles: [
    {
      company: "Hightouch",
      role: "Staff Engineer, AI Productivity",
      status: "high",
      fit: 96,
      detailId: "role-hightouch",
    },
    {
      company: "Zoom",
      role: "Applied AI Engineers",
      status: "high",
      fit: 95,
      detailId: "role-zoom",
    },
  ],
  sourcedRoles: [
    {
      company: "Anthropic",
      role: "Product Engineer",
      fit: 88,
      detailId: "role-anthropic",
    },
  ],
  jobs: {
    visibleCount: 12,
    rail: {
      screenPlus: 2,
      fresh: 6,
      highFit: 4,
      manualReview: 3,
      terminal: 9,
      nextDecision: {
        title: "Review 3 roles",
        summary: "Triage sourced, missing-comp, or medium-fit roles before promoting more work.",
        action: "manual-review",
        hasWork: true,
      },
    },
  },
};

function renderDashboardV2(snapshot = {}) {
  dashboardContext.useDashboardSnapshot.mockReturnValue({
    data: DASHBOARD_DATA,
    loading: false,
    error: null,
    noDatabase: false,
    ...snapshot,
  });

  return renderToStaticMarkup(
    <MemoryRouter>
      <DashboardV2Page />
    </MemoryRouter>
  );
}

describe("DashboardV2Page", () => {
  it("renders an action-first dashboard from the live dashboard snapshot", () => {
    const html = renderDashboardV2();

    expect(html).toContain('class="dashboard-v2"');
    expect(html).toContain(">Dashboard</h1>");
    expect(html).not.toContain("Preview Data");
    expect(html).not.toContain("Dashboard V2 ·");
    expect(html).toContain('data-dashboard-v2-stat="needsYou"');
    expect(html).toContain("Needs You");
    expect(html).toContain('data-dashboard-v2-stat="highFit"');
    expect(html).toContain("High Fit");
    expect(html).toContain('data-dashboard-v2-stat="activeJobs"');
    expect(html).toContain("Active");

    expect(html).toContain("Priority");
    expect(html).toContain("Prepare for the PwC Teams interview");
    expect(html).toContain("Handle next action");
    expect(html).toContain("Send Ramp follow-up");

    // The focus card is the hero; the queue below it must not repeat that step.
    expect(html.match(/Prepare for the PwC Teams interview/g)).toHaveLength(1);

    expect(html).toContain("Momentum");
    expect(html).toContain("To decide");
    expect(html).toContain("Interviewing");
    expect(html).toContain("New roles");
    expect(html).not.toContain("Resolve before sourcing more");

    expect(html).toContain("Decide");
    expect(html).toContain("You have 3 high-fit roles");
    expect(html).toContain("Decide what to do with them now: promote, skip, or park.");
    expect(html).toContain("Ramp");
    expect(html).toContain("82");
    expect(html).toContain("Fresh Finds");
    expect(html).toContain("Hightouch");
    expect(html).toContain("96");
    expect(html).toContain("Juniper Square interview");
    expect(html).toContain("2:00 PM");
    expect(html).not.toContain("Closed");
    expect(html).not.toContain("Archived");

    expect(html).not.toContain("Response Rate");
    expect(html).not.toContain('data-dashboard-stat="responseRate"');
    expect(html).not.toContain("Next agent task");
    expect(html).not.toContain("Run search-jobs");
    expect(html).not.toContain("Mock data");
    expect(html).not.toContain("Your weekly loop");
  });

  it("uses believable preview data for an empty dev snapshot", () => {
    const html = renderDashboardV2({
      data: {
        jobs: { rail: {}, visibleCount: 0 },
        calendar: { upcoming: { events: [] } },
        latestRoles: [],
        sourcedRoles: [],
        reviewHoldRoles: [],
        allNextSteps: [],
      },
    });

    expect(html).toContain(">Dashboard</h1>");
    expect(html).toContain("Prep Juniper Square technical screen");
    expect(html).toContain("Send Ramp follow-up");
    expect(html).toContain("Due by today");
    expect(html).toContain("You have 3 high-fit roles");
    expect(html).toContain("Hightouch");
    expect(html).toContain("Anthropic");
    expect(html).toContain("Juniper Square technical screen");
    expect(html).not.toContain("Glean packet deadline");
    expect(html).not.toContain("Queue clear");
    expect(html).not.toContain("No interviews or calls today");
  });
});
