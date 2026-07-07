import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const dashboardContext = vi.hoisted(() => ({
  useDashboardSnapshot: vi.fn(),
}));

vi.mock("../app-shell/DashboardContext.jsx", () => dashboardContext);

vi.mock("../lib/api.js", () => ({
  logoImageUrl: ({ domain, name }) => `/logo/${domain || name}`,
}));

import { DashboardV2Page } from "./DashboardV2Page.jsx";

function renderDashboardV2(snapshot = {}) {
  dashboardContext.useDashboardSnapshot.mockReturnValue({
    data: {
      allNextSteps: [],
      nextSteps: [],
      reviewHoldRoles: [],
      latestRoles: [],
      sourcedRoles: [],
      calendar: { upcoming: { events: [] } },
    },
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
  it("renders a queue-first dashboard without replacing the current dashboard", () => {
    const html = renderDashboardV2();

    expect(html).toContain('class="dashboard-v2"');
    expect(html).toContain("What needs you today.");
    expect(html).toContain("one Rolester queue");
    expect(html).toContain("Start here");
    expect(html).toContain("Keep warm");
    expect(html).toContain("Decide");
    expect(html).toContain("Fresh finds");
    expect(html).toContain("On deck");
    expect(html).toContain("Mock data");
    expect(html).toContain("Find roles");
    expect(html).toContain("Open jobs");

    expect(html).not.toContain("Focus");
    expect(html).not.toContain("new matches this week");
    expect(html).not.toContain("Awaiting your decision");
    expect(html).not.toContain("Today’s queue, without the spreadsheet.");
    expect(html).not.toContain("Next agent task");
    expect(html).not.toContain("Ask your agent");
  });

  it("prefers real dashboard queue data when present", () => {
    const html = renderDashboardV2({
      data: {
        allNextSteps: [
          {
            detailId: "app-pwc",
            company: "PwC",
            detail: "Teams interview",
            dueText: "today",
            title: "Confirm the Teams interview",
          },
        ],
        reviewHoldRoles: [
          {
            detailId: "role-ramp",
            company: "Ramp",
            role: "Applied AI Engineer",
            fit: 82,
            domain: "ramp.com",
          },
        ],
        latestRoles: [
          {
            detailId: "role-hightouch",
            company: "Hightouch",
            role: "Staff Engineer, AI Productivity",
            fit: 96,
            domain: "hightouch.com",
          },
        ],
        sourcedRoles: [],
        calendar: {
          upcoming: {
            events: [
              {
                id: "event-1",
                iso: "2026-07-07",
                time: "2:00 PM",
                title: "Juniper Square interview",
                kind: "interview",
              },
            ],
          },
        },
      },
    });

    expect(html).toContain("PwC");
    expect(html).toContain("Confirm the Teams interview");
    expect(html).toContain("Ramp");
    expect(html).toContain("Hightouch");
    expect(html).toContain("Juniper Square interview");
    expect(html).not.toContain("Mock data");
  });
});
