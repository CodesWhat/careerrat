import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const dashboardContext = vi.hoisted(() => ({
  useDashboardSnapshot: vi.fn(),
}));

vi.mock("../app-shell/DashboardContext.jsx", () => dashboardContext);

vi.mock("../lib/api.js", () => ({
  getDashboard: vi.fn(async () => ({ setup: null })),
}));

import { HomePage } from "./HomePage.jsx";

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
    label: "Focus",
    title: "Prepare for the PwC Teams interview; confirm the exact date/time",
    company: "PwC",
    role: "Director Solution Architect",
    note: "PwC confirmed the application and requested availability.",
    dueText: "19d overdue",
    tone: "error",
    detailId: "app-pwc",
    cta: "Handle next action",
  },
  nextSteps: [
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
      title: "Await recruiter response",
      company: "Ramp",
      supportingText: "Ramp",
      actionLabel: "Review",
      dueText: "soon",
      detailId: "app-ramp",
    },
  ],
  calendar: {
    upcoming: {
      events: [
        {
          kind: "interview",
          label: "Interview",
          iso: "2026-07-07",
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
  jobs: {
    rail: {
      screenPlus: 0,
      fresh: 0,
      highFit: 0,
      manualReview: 0,
      terminal: 0,
    },
  },
};

function renderHome(snapshot = {}) {
  dashboardContext.useDashboardSnapshot.mockReturnValue({
    data: DASHBOARD_DATA,
    loading: false,
    error: null,
    noDatabase: false,
    ...snapshot,
  });

  return renderToStaticMarkup(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>
  );
}

describe("HomePage product dashboard frame", () => {
  it("ports the generated dashboard overview frame instead of the generic app scaffold", () => {
    const html = renderHome();

    expect(html).toContain('class="dashboard-home"');
    expect(html).toContain('class="dashboard-home__hero"');
    expect(html).toContain('class="dashboard-home__title">Dashboard</h1>');
    expect(html).toContain("Queue, calendar, latest roles, and pipeline movement.");
    expect(html).toContain('data-dashboard-stat="inPlay"');
    expect(html).toContain(">110</strong>");
    expect(html).toContain("Response Rate");
    expect(html).toContain(">28%</strong>");
    expect(html).toContain("Interviews");
    expect(html).toContain(">5</strong>");

    expect(html).toContain('class="dashboard-home__focus-row"');
    expect(html).toContain("Focus");
    expect(html).toContain("Adaptive");
    expect(html).toContain("Next Steps");
    expect(html).toContain("Queue");
    expect(html).toContain("Prepare for the PwC Teams interview");
    expect(html).toContain("Handle next action");

    expect(html).toContain("Upcoming");
    expect(html).toContain("Calendar");
    expect(html).toContain("Juniper Square interview");
    expect(html).toContain("Latest Roles");
    expect(html).toContain("All new");
    expect(html).toContain("Hightouch");
    expect(html).toContain("96");

    expect(html).not.toContain("Your weekly loop");
    expect(html).not.toContain("Pipeline snapshot");
    expect(html).not.toContain('class="dashboard-home__agent-card"');
    expect(html).not.toContain("Next agent task");
    expect(html).not.toContain("Ask your agent");
    expect(html).not.toContain("Run search-jobs");
  });
});
