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

import { DashboardPage } from "./DashboardPage.jsx";

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
    title: "Prepare for the Weyland-Yutani Teams interview",
    company: "Weyland-Yutani",
    role: "Director Solution Architect",
    note: "Weyland-Yutani confirmed the application and requested availability.",
    dueText: "19d overdue",
    tone: "error",
    detailId: "app-weyland",
    cta: "Handle next action",
  },
  allNextSteps: [
    {
      title: "Prepare for the Weyland-Yutani Teams interview",
      company: "Weyland-Yutani",
      supportingText: "Weyland-Yutani",
      actionLabel: "Interview",
      dueText: "19d overdue",
      tone: "error",
      detailId: "app-weyland",
    },
    {
      title: "Send Abstergo Industries follow-up",
      company: "Abstergo Industries",
      supportingText: "Abstergo Industries",
      actionLabel: "Follow Up",
      dueText: "today",
      detailId: "app-abstergo",
    },
  ],
  reviewHoldRoles: [
    {
      company: "Abstergo Industries",
      role: "Applied AI Engineer",
      fit: 82,
      domain: "abstergo.com",
      detailId: "role-abstergo",
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
          title: "Cyberdyne Systems interview",
          detailId: "app-cyberdyne",
        },
      ],
    },
  },
  latestRoles: [
    {
      company: "Rekall",
      role: "Staff Engineer, AI Productivity",
      status: "high",
      fit: 96,
      detailId: "role-veridian",
    },
    {
      company: "Umbrella Corporation",
      role: "Applied AI Engineers",
      status: "high",
      fit: 95,
      detailId: "role-umbrella",
    },
  ],
  sourcedRoles: [
    {
      company: "Tyrell Corporation",
      role: "Product Engineer",
      fit: 88,
      detailId: "role-tyrell",
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

function renderDashboardPage(snapshot = {}) {
  dashboardContext.useDashboardSnapshot.mockReturnValue({
    data: DASHBOARD_DATA,
    loading: false,
    error: null,
    noDatabase: false,
    ...snapshot,
  });

  return renderToStaticMarkup(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>
  );
}

describe("DashboardPage", () => {
  it("renders an action-first dashboard from the live dashboard snapshot", () => {
    const html = renderDashboardPage();

    expect(html).toContain('class="dashboard"');
    expect(html).toContain(">Clear these 2 and call it done.</h1>");
    expect(html).not.toContain("Preview Data");
    expect(html).not.toContain("Dashboard V2 ·");
    expect(html).toContain('data-dashboard-stat="needsYou"');
    expect(html).toContain("Needs You");
    expect(html).toContain('data-dashboard-stat="highFit"');
    expect(html).toContain("High Fit");
    expect(html).toContain('data-dashboard-stat="activeJobs"');
    expect(html).toContain("Active");

    expect(html).toContain("Priority");
    expect(html).toContain("Prepare for the Weyland-Yutani Teams interview");
    expect(html).toContain("Handle next action");

    // The Priority panel is the focus card and nothing else. The rest of
    // allNextSteps stays behind the Needs You count, not stacked under the hero.
    expect(html).not.toContain("Send Abstergo Industries follow-up");
    expect(html.match(/Prepare for the Weyland-Yutani Teams interview/g)).toHaveLength(1);

    expect(html).toContain("Momentum");
    expect(html).toContain("To decide");
    expect(html).toContain("Interviewing");
    expect(html).toContain("New roles");
    expect(html).not.toContain("Resolve before sourcing more");

    expect(html).toContain("Decide");
    expect(html).not.toContain("You have 3 high-fit roles");
    expect(html).not.toContain("promote, skip, or park");
    expect(html).toContain("Abstergo Industries");
    expect(html).toContain("82");
    expect(html).toContain("Fresh Finds");
    expect(html).toContain("Rekall");
    expect(html).toContain("96");
    expect(html).toContain("Cyberdyne Systems interview");
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
    const html = renderDashboardPage({
      data: {
        jobs: { rail: {}, visibleCount: 0 },
        calendar: { upcoming: { events: [] } },
        latestRoles: [],
        sourcedRoles: [],
        reviewHoldRoles: [],
        allNextSteps: [],
      },
    });

    expect(html).toContain(">Clear these 3 and call it done.</h1>");
    expect(html).toContain("Prep Cyberdyne Systems technical screen");
    expect(html).not.toContain("Send Abstergo Industries follow-up");
    expect(html).toContain("Due by today");
    expect(html).toContain("Rekall");
    expect(html).toContain("Tyrell Corporation");
    expect(html).toContain("Cyberdyne Systems technical screen");
    expect(html).not.toContain("Globex packet deadline");
    expect(html).not.toContain("No interviews or calls today");
  });

  it("counts a sourced-only queue as review work, not active applications", () => {
    const role = {
      company: "Fresh Co",
      role: "Staff Engineer",
      fit: 82,
      detailId: "fresh-role",
    };
    const html = renderDashboardPage({
      data: {
        stats: { inPlay: 0, sourced: 7, applied: 0 },
        focus: {
          kind: "review",
          type: "Review",
          title: "Best new role",
          company: role.company,
          role: role.role,
          cta: "Review roles",
        },
        allNextSteps: [],
        latestRoles: [role],
        sourcedRoles: [role],
        reviewHoldRoles: [],
        calendar: { upcoming: { events: [] } },
        jobs: {
          visibleCount: 7,
          rail: { fresh: 7, highFit: 5, manualReview: 7, screenPlus: 0 },
        },
      },
    });

    expect(html).toContain(">Clear this one and call it done.</h1>");
    expect(html).toContain("0 active applications");
    expect(html).not.toContain("7 active applications");
    expect(html).toContain('data-dashboard-stat="activeJobs">0</strong>');
  });

  it("uses singular application copy for one active application", () => {
    const html = renderDashboardPage({
      data: {
        stats: { inPlay: 1, sourced: 0, applied: 1 },
        focus: { kind: "clear" },
        allNextSteps: [],
        latestRoles: [],
        sourcedRoles: [],
        reviewHoldRoles: [],
        calendar: { upcoming: { events: [] } },
        jobs: { visibleCount: 1, rail: {} },
      },
    });

    expect(html).toContain("1 active application");
    expect(html).not.toContain("1 active applications");
  });

  it("opens a prepared interview dossier in its dedicated full-page route", () => {
    const html = renderDashboardPage({
      data: {
        ...DASHBOARD_DATA,
        focus: {
          kind: "interview",
          title: "Interview dossier",
          company: "Cyberdyne Systems",
          role: "Staff Platform Engineer",
          detailId: "app-cyberdyne",
          hasDossier: true,
          cta: "Open dossier",
        },
      },
    });

    expect(html).toContain('class="dashboard__primary-link" href="/jobs?dossier=app-cyberdyne"');
  });
});
