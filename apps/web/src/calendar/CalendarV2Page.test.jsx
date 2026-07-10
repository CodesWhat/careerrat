import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const dashboardContext = vi.hoisted(() => ({
  useDashboardSnapshot: vi.fn(),
}));

vi.mock("../app-shell/DashboardContext.jsx", () => dashboardContext);

import { CalendarV2Page } from "./CalendarV2Page.jsx";

const CALENDAR_DATA = {
  todayIso: "2026-07-08",
  currentWeekIndex: 0,
  metrics: {
    thisWeek: 5,
    interviews: 1,
    dueToday: 2,
  },
  weeks: [
    {
      label: "Jul 6-10",
      days: [
        {
          dow: "Mon",
          date: "6",
          iso: "2026-07-06",
          state: "past",
          events: [],
        },
        {
          dow: "Tue",
          date: "7",
          iso: "2026-07-07",
          state: "past",
          events: [],
        },
        {
          dow: "Wed",
          date: "8",
          iso: "2026-07-08",
          state: "today",
          events: [
            {
              id: "event-reply",
              iso: "2026-07-08",
              time: "10:00 AM",
              title: "Reply to Hooli recruiter",
              meta: "Principal AI Engineer",
              kind: "reply",
              label: "Reply",
              detailId: "app-hooli",
            },
          ],
        },
        {
          dow: "Thu",
          date: "9",
          iso: "2026-07-09",
          state: "",
          events: [
            {
              id: "event-screen",
              iso: "2026-07-09",
              time: "1:30 PM",
              title: "Globex technical screen",
              meta: "Applied ML Platform",
              kind: "interview",
              label: "Interview",
              detailId: "app-globex",
            },
          ],
        },
        {
          dow: "Fri",
          date: "10",
          iso: "2026-07-10",
          state: "",
          events: [],
        },
      ],
      loops: [
        {
          id: "loop-hooli",
          iso: "2026-07-08",
          time: "10:00 AM",
          title: "Reply to Hooli recruiter",
          meta: "Principal AI Engineer",
          kind: "reply",
          label: "Reply",
          detailId: "app-hooli",
        },
      ],
      nextUp: {
        id: "event-reply",
        iso: "2026-07-08",
        time: "10:00 AM",
        title: "Reply to Hooli recruiter",
        meta: "Principal AI Engineer · 10:00 AM",
        kind: "reply",
        label: "Reply",
        detailId: "app-hooli",
        cta: "Open Thread",
        note: "Send the answer before adding any more sourcing work.",
      },
    },
  ],
  today: {
    label: "Today",
    events: [
      {
        id: "event-reply",
        iso: "2026-07-08",
        time: "10:00 AM",
        title: "Reply to Hooli recruiter",
        meta: "Principal AI Engineer",
        kind: "reply",
        label: "Reply",
        detailId: "app-hooli",
      },
    ],
  },
  protectedPrep: {
    title: "Globex technical screen",
    kind: "interview",
    label: "Interview",
    note: "Review AI routing examples and deployment tradeoffs.",
    detailId: "app-globex",
    cta: "Open Prep",
  },
  sync: {
    posture: "Calendar writes are confirm-first.",
    providers: [{ key: "google_calendar", label: "Google Calendar", status: "ready" }],
    history: [{ summary: "Synced private provider history" }],
  },
};

function renderCalendarV2(snapshot = {}) {
  dashboardContext.useDashboardSnapshot.mockReturnValue({
    data: { calendar: CALENDAR_DATA },
    loading: false,
    error: null,
    noDatabase: false,
    ...snapshot,
  });

  return renderToStaticMarkup(
    <MemoryRouter>
      <CalendarV2Page />
    </MemoryRouter>
  );
}

describe("CalendarV2Page", () => {
  it("renders an agenda-first calendar from real dashboard data", () => {
    const html = renderCalendarV2();

    expect(html).toContain('class="calendar-v2"');
    expect(html).toContain("Calendar V2");
    expect(html).not.toContain("Preview Data");
    expect(html).toContain("This Week");
    expect(html).toContain("Jul 6-10");
    expect(html).toContain('data-calendar-v2-stat="dueToday"');
    expect(html).toContain("Today");
    expect(html).toContain("Month Snapshot");
    expect(html).toContain("Calendar");
    expect(html).toContain("Week");
    expect(html).toContain("Month");
    expect(html).toContain("Reply to Hooli recruiter");
    expect(html).toContain("Globex technical screen");
    expect(html).not.toContain("Next Up");
    expect(html).not.toContain("Open Prep");
    expect(html).not.toContain("Open Loops");
    expect(html).not.toContain("Calendar Sync");
    expect(html).not.toContain("1 Provider Ready");
    expect(html).not.toContain("Synced private provider history");
  });

  it("uses believable preview data for an empty dev snapshot", () => {
    const html = renderCalendarV2({
      data: {
        calendar: {
          metrics: { thisWeek: 0, interviews: 0, dueToday: 0 },
          weeks: [],
          today: { events: [] },
          upcoming: { events: [] },
        },
      },
    });

    expect(html).toContain("Calendar V2 · Preview Data");
    expect(html).toContain("Month Snapshot");
    expect(html).toContain("Prep Anthropic enterprise AI stories");
    expect(html).toContain("Juniper Square technical screen");
    expect(html).toContain("Send Ramp follow-up");
    expect(html).toContain("Glean packet deadline");
    expect(html).not.toContain("Open Prep");
    expect(html).not.toContain("Calendar writes are confirm-first");
  });
});
