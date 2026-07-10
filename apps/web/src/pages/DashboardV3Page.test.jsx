import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const dashboardContext = vi.hoisted(() => ({
  useDashboardSnapshot: vi.fn(),
}));

vi.mock("../app-shell/DashboardContext.jsx", () => dashboardContext);

import { DashboardV3Page } from "./DashboardV3Page.jsx";

const DASHBOARD_V3_DATA = {
  dashboard: {
    metrics: [
      { label: "Needs action", value: 1200, tone: "danger" },
      { label: "Interviewing", value: 3, tone: "teal" },
      { label: "Waiting", value: 9, tone: "sky" },
      { label: "High-fit new", value: 4, tone: "gold" },
    ],
    needs: [
      {
        id: "need-northstar",
        type: "Decision",
        title: "Review Northstar priority queue",
        meta: "2 high-fit roles need promote or skip",
        due: "Due now",
        action: "Review roles",
        tone: "danger",
      },
      {
        id: "need-omni",
        type: "Follow-up",
        title: "Draft Omniware follow-up",
        meta: "AI Platform Lead recruiter thread",
        due: "3:00 PM",
        action: "Open thread",
        tone: "warning",
      },
    ],
    today: [
      {
        time: "11:30 AM",
        type: "Interview",
        title: "Globex technical screen",
        action: "Open dossier",
      },
      {
        time: "EOD",
        type: "Decision",
        title: "Acme packet review",
        action: "Open packet",
      },
    ],
    activity: [
      { time: "8 min ago", event: "Promoted Acme AI to applied", source: "apply-job" },
      { time: "Yesterday", event: "Sent Omniware follow-up draft", source: "email-comms" },
    ],
    pipeline: [
      { label: "Applied", value: 5, max: 10 },
      { label: "Screen", value: 2, max: 10 },
      { label: "Technical", value: 1, max: 10 },
      { label: "Offer", value: 0, max: 10 },
    ],
  },
};

function renderDashboardV3(snapshot = {}) {
  dashboardContext.useDashboardSnapshot.mockReturnValue({
    data: { v3: DASHBOARD_V3_DATA },
    loading: false,
    error: null,
    noDatabase: false,
    ...snapshot,
  });

  return renderToStaticMarkup(<DashboardV3Page />);
}

describe("DashboardV3Page", () => {
  it("renders a compact command center from the live V3 dashboard snapshot", () => {
    const html = renderDashboardV3();

    expect(html).toContain('class="v3-page"');
    expect(html).toContain("Dashboard V3");
    expect(html).not.toContain("Preview Data");
    expect(html).toContain('aria-label="Dashboard V3 metrics"');
    expect(html).toContain('data-dashboard-v3-stat="needs-action"');
    expect(html).toContain("1,200");
    expect(html).toContain("Needs You");
    expect(html).toContain("Review Northstar priority queue");
    expect(html).toContain("Due now");
    expect(html).toContain("Review roles");
    expect(html).toContain("Today");
    expect(html).toContain("Globex technical screen");
    expect(html).toContain("11:30 AM");
    expect(html).toContain("Recent Activity");
    expect(html).toContain("Promoted Acme AI to applied");
    expect(html).toContain("apply-job");
    expect(html).toContain("Pipeline Snapshot");
    expect(html).toContain("Applied");
    expect(html).toContain("Screen");
    expect(html).not.toContain("Welcome");
    expect(html).not.toContain("Closed");
    expect(html).not.toContain("Archived");
  });

  it("uses the shared V3 mock data when the snapshot has no V3 payload", () => {
    const html = renderDashboardV3({
      data: {
        jobs: { visibleCount: 0 },
        calendar: { today: { events: [] } },
      },
    });

    expect(html).toContain("Dashboard V3 · Preview Data");
    expect(html).toContain("Decide what to do with 3 high-fit roles");
    expect(html).toContain("Juniper Square technical screen");
    expect(html).toContain("Sourced 7 roles from company boards");
    expect(html).toContain("Technical");
    expect(html).not.toContain("Northstar");
  });
});
