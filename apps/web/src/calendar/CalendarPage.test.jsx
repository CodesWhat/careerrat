import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const dashboardContext = vi.hoisted(() => ({
  useDashboardSnapshot: vi.fn(),
}));

vi.mock("../app-shell/DashboardContext.jsx", () => dashboardContext);

import { CalendarPage } from "./CalendarPage.jsx";

const HOOLI_REPLY_EXPORT = {
  filename: "reply-to-hooli-recruiter-2026-07-08.ics",
  ics: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Reply to Hooli recruiter\r\nDTSTART:20260708T140000Z\r\nDTEND:20260708T143000Z\r\nEND:VEVENT\r\nEND:VCALENDAR",
  googleUrl:
    "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Reply+to+Hooli+recruiter",
  outlookUrl:
    "https://outlook.live.com/calendar/0/deeplink/compose?subject=Reply+to+Hooli+recruiter",
};

const GLOBEX_SCREEN_EXPORT = {
  filename: "globex-technical-screen-2026-07-09.ics",
  ics: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Globex technical screen\r\nDTSTART:20260709T193000Z\r\nDTEND:20260709T201500Z\r\nEND:VEVENT\r\nEND:VCALENDAR",
  googleUrl:
    "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Globex+technical+screen",
  outlookUrl:
    "https://outlook.live.com/calendar/0/deeplink/compose?subject=Globex+technical+screen",
};

const ACME_DEADLINE_EXPORT = {
  filename: "acme-offer-decision-deadline-2026-07-10.ics",
  ics: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Acme offer decision deadline\r\nDTSTART;VALUE=DATE:20260710\r\nDTEND;VALUE=DATE:20260711\r\nEND:VEVENT\r\nEND:VCALENDAR",
  googleUrl:
    "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Acme+offer+decision+deadline",
  outlookUrl:
    "https://outlook.live.com/calendar/0/deeplink/compose?subject=Acme+offer+decision+deadline",
};

const MASSIVE_DYNAMIC_ONSITE_EXPORT = {
  filename: "massive-dynamic-onsite-loop-2026-07-15.ics",
  ics: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Massive Dynamic onsite loop\r\nDTSTART:20260715T160000Z\r\nDTEND:20260715T164500Z\r\nEND:VEVENT\r\nEND:VCALENDAR",
  googleUrl:
    "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Massive+Dynamic+onsite+loop",
  outlookUrl:
    "https://outlook.live.com/calendar/0/deeplink/compose?subject=Massive+Dynamic+onsite+loop",
};

const BLACK_MESA_DEADLINE_EXPORT = {
  filename: "black-mesa-sign-by-deadline-2026-08-01.ics",
  ics: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Black Mesa sign-by deadline\r\nDTSTART;VALUE=DATE:20260801\r\nDTEND;VALUE=DATE:20260802\r\nEND:VEVENT\r\nEND:VCALENDAR",
  googleUrl:
    "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Black+Mesa+sign-by+deadline",
  outlookUrl:
    "https://outlook.live.com/calendar/0/deeplink/compose?subject=Black+Mesa+sign-by+deadline",
};

const pastFollowUp = {
  id: "event-follow-hooli",
  iso: "2026-07-06",
  time: "10:00 AM",
  title: "Follow up with Hooli recruiter",
  meta: "Principal AI Engineer",
  kind: "follow-up",
  label: "Follow-up",
  detailId: "app-hooli",
  done: false,
  export: HOOLI_REPLY_EXPORT,
};

const pastInterviewDone = {
  id: "event-globex-phone",
  iso: "2026-07-07",
  time: "9:00 AM",
  title: "Globex phone screen",
  meta: "Applied ML Platform",
  kind: "interview",
  label: "Interview",
  detailId: "app-globex-phone",
  done: true,
  export: GLOBEX_SCREEN_EXPORT,
};

const busyBlock = {
  id: "event-standup",
  iso: "2026-07-07",
  time: "9:30 AM",
  title: "Team standup",
  meta: "Calendar busy",
  kind: "busy",
  label: "Busy",
  done: false,
};

const todayReply = {
  id: "event-reply",
  iso: "2026-07-08",
  time: "10:00 AM",
  title: "Reply to Hooli recruiter",
  meta: "Principal AI Engineer",
  kind: "reply",
  label: "Reply",
  detailId: "app-hooli",
  done: false,
  export: HOOLI_REPLY_EXPORT,
};

const tomorrowInterview = {
  id: "event-screen",
  iso: "2026-07-09",
  time: "1:30 PM",
  title: "Globex technical screen",
  meta: "Applied ML Platform",
  kind: "interview",
  label: "Interview",
  detailId: "app-globex",
  done: false,
  prepped: false,
  export: GLOBEX_SCREEN_EXPORT,
};

const fridayDeadline = {
  id: "event-acme-deadline",
  iso: "2026-07-10",
  title: "Acme offer decision deadline",
  meta: "Staff Applied AI Engineer",
  kind: "deadline",
  label: "Deadline",
  detailId: "app-acme",
  done: false,
  export: ACME_DEADLINE_EXPORT,
};

const nextWeekInterview = {
  id: "event-massivedynamic-onsite",
  iso: "2026-07-15",
  time: "9:00 AM",
  title: "Massive Dynamic onsite loop",
  meta: "AI Product Engineer",
  kind: "interview",
  label: "Interview",
  detailId: "app-massivedynamic",
  done: false,
  export: MASSIVE_DYNAMIC_ONSITE_EXPORT,
};

const laterDeadline = {
  id: "event-blackmesa-deadline",
  iso: "2026-08-01",
  title: "Black Mesa sign-by deadline",
  meta: "Deployed Engineer",
  kind: "deadline",
  label: "Deadline",
  detailId: "app-blackmesa",
  done: false,
  export: BLACK_MESA_DEADLINE_EXPORT,
};

const CALENDAR_DATA = {
  todayIso: "2026-07-08",
  currentWeekIndex: 0,
  metrics: {
    thisWeek: 5,
    interviews: 2,
    dueToday: 1,
  },
  weeks: [
    {
      label: "Jul 6-10",
      days: [
        { dow: "Mon", date: "6", iso: "2026-07-06", state: "past", events: [pastFollowUp] },
        {
          dow: "Tue",
          date: "7",
          iso: "2026-07-07",
          state: "past",
          events: [pastInterviewDone, busyBlock],
        },
        { dow: "Wed", date: "8", iso: "2026-07-08", state: "today", events: [todayReply] },
        { dow: "Thu", date: "9", iso: "2026-07-09", state: "", events: [tomorrowInterview] },
        { dow: "Fri", date: "10", iso: "2026-07-10", state: "", events: [fridayDeadline] },
      ],
      events: [pastFollowUp, pastInterviewDone, todayReply, tomorrowInterview, fridayDeadline],
      loops: [todayReply],
      nextUp: todayReply,
    },
  ],
  today: {
    label: "Today",
    events: [todayReply],
  },
  upcoming: {
    events: [nextWeekInterview, laterDeadline],
  },
};

function renderCalendarPage(snapshot = {}) {
  dashboardContext.useDashboardSnapshot.mockReturnValue({
    data: { calendar: CALENDAR_DATA },
    loading: false,
    error: null,
    noDatabase: false,
    ...snapshot,
  });

  return renderToStaticMarkup(
    <MemoryRouter>
      <CalendarPage />
    </MemoryRouter>
  );
}

describe("CalendarPage", () => {
  it("renders an agenda-first calendar from real dashboard data", () => {
    const html = renderCalendarPage();

    expect(html).toContain('class="calendar"');
    expect(html).toContain("Calendar</h1>");
    expect(html).not.toContain("Preview Data");
    expect(html).toContain("Today");
    expect(html).toContain("Tomorrow");
    expect(html).toContain("This week");
    expect(html).toContain("Next week");
    expect(html).toContain("Later");
    expect(html).toContain('data-calendar-stat="dueToday"');
    expect(html).toContain('data-calendar-stat="interviews"');
    expect(html).toContain('data-calendar-stat="thisWeek"');

    // Bucketed rows.
    expect(html).toContain("Reply to Hooli recruiter");
    expect(html).toContain("Globex technical screen");
    expect(html).toContain("Acme offer decision deadline");
    expect(html).toContain("Massive Dynamic onsite loop");
    expect(html).toContain("Black Mesa sign-by deadline");

    // Not-prepped signal only on the one flagged interview.
    expect(html).toContain("Not prepped");

    // Busy events render without a job link or export controls.
    expect(html).toContain("Team standup");

    // Kind pills.
    expect(html).toContain("calendar__kind-pill--interview");
    expect(html).toContain("calendar__kind-pill--reply");
    expect(html).toContain("calendar__kind-pill--deadline");
    expect(html).toContain("calendar__kind-pill--busy");

    // Export controls, visible (not hover-only), siblings of the title link.
    expect(html).toContain(">.ics<");
    expect(html).toContain(">Google<");
    expect(html).toContain(">Outlook<");
    expect(html).toContain("data:text/calendar;charset=utf-8,");
    expect(html).toContain("calendar.google.com/calendar/render");
    expect(html).toContain("outlook.live.com/calendar/0/deeplink/compose");

    // Recent section: 3 past events (one done), collapsed by default.
    expect(html).toContain("Recent · 3");
    expect(html).toContain("Follow up with Hooli recruiter");
    expect(html).toContain("Globex phone screen");
    expect(html).toContain(">Done<");
    expect(html).toContain("<details");

    // V2 features that must not reappear here.
    expect(html).not.toContain("Month Snapshot");
    expect(html).not.toContain("Week/Month");
    expect(html).not.toContain("Open block");
  });

  it("uses believable preview data for an empty dev snapshot", () => {
    const html = renderCalendarPage({
      data: {
        calendar: {
          metrics: { thisWeek: 0, interviews: 0, dueToday: 0 },
          weeks: [],
          today: { events: [] },
          upcoming: { events: [] },
        },
      },
    });

    expect(html).not.toContain("Preview Data");
    expect(html).toContain("Cyberdyne Systems technical screen");
    expect(html).toContain("Prep Tyrell Corporation enterprise AI stories");
    expect(html).toContain("Send Abstergo Industries follow-up");
    expect(html).toContain("Globex packet deadline");
    expect(html).toContain("Massive Dynamic hiring manager screen");
    expect(html).toContain("Cloudscale onsite decision deadline");

    // Tomorrow is deliberately empty in the preview fixture.
    expect(html).toContain("Nothing scheduled");

    // The one interview flagged without prep.
    expect(html).toContain("Not prepped");

    // Recent: a done interview, the still-open follow-up beside it, the
    // past-due assessment, and the past busy block (4 events with iso before
    // todayIso).
    expect(html).toContain("Recent · 4");
    expect(html).toContain("Black Mesa phone screen");
    expect(html).toContain(">Done<");
    expect(html).toContain("Follow up with Nakatomi Corporation recruiter");
  });

  it("moves a round the server marked done out of Today and into Recent", () => {
    const html = renderCalendarPage({
      data: {
        calendar: {
          todayIso: "2026-07-08",
          metrics: { dueToday: 1, interviews: 1, thisWeek: 2 },
          today: {
            events: [
              {
                id: "initech-screen",
                iso: "2026-07-08",
                time: "9:00 AM",
                title: "Initech screen",
                kind: "interview",
                label: "Interview",
                done: true,
              },
              {
                id: "initech-thanks",
                iso: "2026-07-08",
                time: "4:00 PM",
                title: "Send Initech thank-you",
                kind: "follow-up",
                label: "Follow-Up",
              },
            ],
          },
          upcoming: { events: [] },
          weeks: [],
        },
      },
    });

    // The finished round renders once, and only inside Recent (which the agenda
    // precedes in the DOM). Today keeps the follow-up that still needs doing.
    expect(html.match(/Initech screen/g)).toHaveLength(1);
    expect(html.indexOf("Initech screen")).toBeGreaterThan(html.indexOf("<details"));
    expect(html.indexOf("Send Initech thank-you")).toBeLessThan(html.indexOf("<details"));
    expect(html).toContain("Recent · 1");
  });

  it("places an event inside the rolling 14-day strip under Next week", () => {
    const html = renderCalendarPage({
      data: {
        calendar: {
          todayIso: "2026-08-09",
          metrics: { dueToday: 0, interviews: 1, thisWeek: 0 },
          today: { events: [] },
          upcoming: {
            events: [
              {
                id: "temporal-hiring-manager",
                iso: "2026-08-20",
                time: "2:00 PM",
                title: "Temporal hiring manager",
                kind: "interview",
                label: "Interview",
                detailId: "temporal-staff-platform",
                done: false,
              },
            ],
          },
          weeks: [],
        },
      },
    });

    const nextWeekHeading = html.indexOf("<h2>Next week</h2>");
    const event = html.indexOf("Temporal hiring manager");
    const laterHeading = html.indexOf("<h2>Later</h2>");

    expect(nextWeekHeading).toBeGreaterThan(-1);
    expect(event).toBeGreaterThan(nextWeekHeading);
    expect(event).toBeLessThan(laterHeading);
  });
});

// ---------------------------------------------------------------------------
// Calendar apps sync panel (buildCalendarSync — dashboard-data.js), a plain
// status readout: which calendar providers are connected and the last few
// confirmed writes. Nothing here is scheduling data.
// ---------------------------------------------------------------------------

const CALENDAR_SYNC_DATA = {
  ...CALENDAR_DATA,
  sync: {
    capability: "calendar_sync",
    posture: "Confirm-first",
    providers: [
      { key: "apple_calendar", label: "Apple Calendar", status: "Ready" },
      { key: "google_calendar", label: "Google Calendar", status: "Needs setup" },
      { key: "outlook_calendar", label: "Outlook Calendar", status: "Off" },
      { key: "automation_tools", label: "Automation tools", status: "Consent gated" },
    ],
    history: [
      {
        id: "cal-write-automated",
        provider: "apple_calendar",
        providerLabel: "Apple Calendar",
        title: "Temporal onsite",
        eventIso: "2026-07-15",
        atLabel: "Jul 15",
        provenance: "automated",
      },
      {
        id: "cal-write-manual",
        provider: "google_calendar",
        providerLabel: "Google Calendar",
        title: "Globex screen",
        eventIso: "2026-07-09",
        atLabel: "Jul 9",
        provenance: "manual",
      },
    ],
  },
};

describe("CalendarPage — calendar apps sync panel", () => {
  it("reserves the ok badge for a Ready provider and shows every other status as muted", () => {
    const html = renderCalendarPage({ data: { calendar: CALENDAR_SYNC_DATA } });

    expect(html).toContain("Calendar apps");
    expect(html).toContain("CareerRat only writes to a calendar after you approve it.");

    expect(html).toMatch(/<span class="badge badge--ok">Ready<\/span>/);
    expect(html).toMatch(/<span class="badge badge--muted">Needs setup<\/span>/);
    expect(html).toMatch(/<span class="badge badge--muted">Off<\/span>/);
    expect(html).toMatch(/<span class="badge badge--muted">Consent gated<\/span>/);
  });

  it("labels an automated write as synced and a manual self-report as recorded", () => {
    const html = renderCalendarPage({ data: { calendar: CALENDAR_SYNC_DATA } });

    expect(html).toContain("Temporal onsite");
    expect(html).toContain("Globex screen");
    expect(html).toMatch(/<small>Apple Calendar · [^<]*synced<\/small>/);
    expect(html).toMatch(/<small>Google Calendar · [^<]*recorded<\/small>/);
  });

  it("shows the empty-history line when there are no confirmed calendar writes yet", () => {
    const html = renderCalendarPage({
      data: {
        calendar: {
          ...CALENDAR_DATA,
          sync: { ...CALENDAR_SYNC_DATA.sync, history: [] },
        },
      },
    });

    expect(html).toContain("No confirmed calendar writes yet.");
  });

  it("shows the export microcopy note beside the .ics/Google/Outlook links", () => {
    const html = renderCalendarPage();

    expect(html).toContain(
      "These links create an event in your calendar app. Nothing stays in sync."
    );
  });
});
