import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const dashboardContext = vi.hoisted(() => ({
  useDashboardSnapshot: vi.fn(),
}));

vi.mock("../app-shell/DashboardContext.jsx", () => dashboardContext);

import { CalendarV3Page } from "./CalendarV3Page.jsx";

const CALENDAR_DATA = {
  rangeLabel: "Aug 3-9, 2026",
  selectedView: "Week",
  agenda: [
    {
      group: "Overdue",
      items: [
        {
          id: "cal-overdue-nova",
          type: "Follow-up",
          time: "Yesterday",
          title: "Nova recruiter follow-up",
          meta: "Agentic AI Engineer",
          action: "Open thread",
        },
      ],
    },
    {
      group: "Today",
      items: [
        {
          id: "cal-today-orbit",
          type: "Interview",
          time: "11:00 AM",
          title: "Orbit technical screen",
          meta: "Applied AI Engineer",
          action: "Open dossier",
        },
      ],
    },
    {
      group: "Tomorrow",
      items: [
        {
          id: "cal-tomorrow-lumen",
          type: "Deadline",
          time: "EOD",
          title: "Lumen packet deadline",
          meta: "AI Architect",
          action: "Open artifact",
        },
      ],
    },
  ],
  weekDays: [
    { day: "Mon", date: "Aug 3", items: [] },
    {
      day: "Tue",
      date: "Aug 4",
      today: true,
      items: [
        { type: "Interview", time: "11:00", title: "Orbit technical" },
        { type: "Follow-up", time: "3:30", title: "Nova reply" },
      ],
    },
    { day: "Wed", date: "Aug 5", items: [{ type: "Deadline", time: "EOD", title: "Lumen packet" }] },
  ],
};

function renderCalendarV3(snapshot = {}) {
  dashboardContext.useDashboardSnapshot.mockReturnValue({
    data: { calendar: CALENDAR_DATA },
    loading: false,
    error: null,
    noDatabase: false,
    ...snapshot,
  });

  return renderToStaticMarkup(<CalendarV3Page />);
}

describe("CalendarV3Page", () => {
  it("renders literal calendar controls, type chips, agenda groups, and week events from snapshot data", () => {
    const html = renderCalendarV3();

    expect(html).toContain('class="v3-page calendar-v3"');
    expect(html).toContain("Calendar V3");
    expect(html).not.toContain("Preview Data");
    expect(html).toContain("Today");
    expect(html).toContain("Previous range");
    expect(html).toContain("Next range");
    expect(html).toContain("Aug 3-9, 2026");
    expect(html).toContain('aria-label="Calendar view"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Week");
    expect(html).toContain("Month");
    expect(html).toContain("Day");
    expect(html).toContain("Agenda");
    expect(html).toContain("Interview");
    expect(html).toContain("Follow-up");
    expect(html).toContain("Deadline");
    expect(html).toContain("Overdue");
    expect(html).toContain("Tomorrow");
    expect(html).toContain("Nova recruiter follow-up");
    expect(html).toContain("Orbit technical screen");
    expect(html).toContain("Lumen packet deadline");
    expect(html).toContain('class="v3-calendar-week"');
    expect(html).toContain("Aug 4");
    expect(html).toContain("Orbit technical");
    expect(html).toContain("Nova reply");
    expect(html).not.toContain("Pipeline");
    expect(html).not.toContain("Prep hero");
  });

  it("uses shared V3 mock data when the dashboard snapshot has no calendar content", () => {
    const html = renderCalendarV3({
      data: {
        calendar: {
          rangeLabel: "",
          agenda: [],
          weekDays: [],
        },
      },
    });

    expect(html).toContain("Calendar V3 - Preview Data");
    expect(html).toContain("Jul 8-14, 2026");
    expect(html).toContain("Ramp recruiter follow-up");
    expect(html).toContain("Juniper Square technical screen");
    expect(html).toContain("Glean packet deadline");
    expect(html).toContain("Stripe HM");
    expect(html).toContain("Overdue");
    expect(html).not.toContain("No dated work");
  });
});
