// apps/web/src/calendar/calendarPreviewData.js — dev-only fallback data for
// CalendarPage.jsx, shown when the live dashboard snapshot carries no
// calendar content (see hasCalendarContent() + calendarForNext() there).
// Shaped like buildCalendar()'s real output (src/core/tracker/dashboard-data.js)
// so every agenda bucket the page renders has an example — except Tomorrow,
// which is left empty on purpose so the empty-bucket state is visible in dev.

function pad2(value) {
  return String(value).padStart(2, "0");
}

function isoParts(iso) {
  const [year, month, day] = String(iso).split("-").map(Number);
  return { year, month, day };
}

function parseClockTime(time) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(time || "").trim());
  if (!match) return null;
  let hours = Number(match[1]) % 12;
  if (/pm/i.test(match[3])) hours += 12;
  return { hours, minutes: Number(match[2]) };
}

function stampUtc(date) {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}00Z`;
}

function dateToken(iso) {
  return String(iso).replace(/-/g, "");
}

function addIsoDay(iso) {
  const { year, month, day } = isoParts(iso);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

// Mirrors the SHAPE (not the exact bytes) of calendarEventExport() in
// dashboard-data.js — filename + a short valid VCALENDAR string + Google/
// Outlook deep links — so the page's export controls have something real to
// point at in dev.
function buildExport({ id, title, meta, iso, time, durationMinutes }) {
  const { year, month, day } = isoParts(iso);
  const clock = parseClockTime(time);
  let icsStart;
  let icsEnd;
  let googleDates;
  let outlookStart;
  let outlookEnd;
  let allDay = false;

  if (clock) {
    const start = new Date(Date.UTC(year, month - 1, day, clock.hours, clock.minutes));
    const end = new Date(start.getTime() + durationMinutes * 60000);
    icsStart = `DTSTART:${stampUtc(start)}`;
    icsEnd = `DTEND:${stampUtc(end)}`;
    googleDates = `${stampUtc(start)}/${stampUtc(end)}`;
    outlookStart = start.toISOString();
    outlookEnd = end.toISOString();
  } else {
    allDay = true;
    const endIso = addIsoDay(iso);
    icsStart = `DTSTART;VALUE=DATE:${dateToken(iso)}`;
    icsEnd = `DTEND;VALUE=DATE:${dateToken(endIso)}`;
    googleDates = `${dateToken(iso)}/${dateToken(endIso)}`;
    outlookStart = iso;
    outlookEnd = endIso;
  }

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Rolester//Calendar Export//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${id}@rolester.local`,
    `DTSTAMP:${stampUtc(new Date(Date.UTC(year, month - 1, day)))}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${meta || ""}`,
    icsStart,
    icsEnd,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const googleParams = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: googleDates,
    details: meta || "",
  });
  const outlookParams = new URLSearchParams({
    subject: title,
    body: meta || "",
    startdt: outlookStart,
    enddt: outlookEnd,
  });
  if (allDay) outlookParams.set("allday", "true");

  return {
    filename: `${id}-${iso}.ics`,
    ics,
    googleUrl: `https://calendar.google.com/calendar/render?${googleParams.toString()}`,
    outlookUrl: `https://outlook.live.com/calendar/0/deeplink/compose?${outlookParams.toString()}`,
  };
}

function eventDurationMinutes(kind) {
  if (kind === "interview") return 45;
  if (kind === "assessment" || kind === "prep") return 60;
  return 30;
}

// Busy blocks never carry an export — same rule real calendar events follow
// (buildCalendarBusy() never routes through calendarEventExport()).
function withExport(event) {
  if (event.kind === "busy") return event;
  return {
    ...event,
    export: buildExport({
      id: event.id,
      title: event.title,
      meta: event.meta,
      iso: event.iso,
      time: event.time,
      durationMinutes: eventDurationMinutes(event.kind),
    }),
  };
}

const notionInterview = withExport({
  id: "preview-interview-notion",
  iso: "2026-07-02",
  time: "10:00 AM",
  title: "Notion phone screen",
  meta: "Applied AI Engineer",
  kind: "interview",
  label: "Interview",
  detailId: "preview-notion",
  done: true,
});

const greenhouseFollowUp = withExport({
  id: "preview-follow-greenhouse",
  iso: "2026-07-06",
  time: "10:00 AM",
  title: "Follow up with Greenhouse recruiter",
  meta: "Senior AI Platform Engineer",
  kind: "follow-up",
  label: "Follow-up",
  detailId: "preview-greenhouse",
  done: false,
});

const hightouchAssessment = withExport({
  id: "preview-assessment-hightouch",
  iso: "2026-07-07",
  title: "Hightouch take-home due",
  meta: "Staff Engineer, AI Productivity",
  kind: "assessment",
  label: "Assessment",
  detailId: "preview-hightouch",
  done: false,
});

const focusBlock = withExport({
  id: "preview-busy-focus",
  iso: "2026-07-07",
  time: "1:00 PM",
  title: "Focus block",
  meta: "Calendar busy",
  kind: "busy",
  label: "Busy",
});

const prepAnthropic = withExport({
  id: "preview-prep-anthropic",
  iso: "2026-07-08",
  time: "9:30 AM",
  title: "Prep Anthropic enterprise AI stories",
  meta: "Applied AI Architect",
  kind: "prep",
  label: "Prep",
  detailId: "preview-anthropic",
  done: false,
});

// The one interview in this preview set without a prep packet yet — the only
// event that should ever set prepped:false. Every other event leaves the
// field off entirely, since real data doesn't emit it yet either.
const juniperInterview = withExport({
  id: "preview-interview-juniper",
  iso: "2026-07-08",
  time: "2:00 PM",
  title: "Juniper Square technical screen",
  meta: "Senior Applied AI Engineer",
  kind: "interview",
  label: "Interview",
  detailId: "preview-juniper",
  done: false,
  prepped: false,
});

const rampFollowUp = withExport({
  id: "preview-follow-ramp",
  iso: "2026-07-08",
  time: "4:30 PM",
  title: "Send Ramp follow-up",
  meta: "Applied AI Engineer",
  kind: "follow-up",
  label: "Follow-up",
  detailId: "preview-ramp",
  done: false,
});

const gleanDeadline = withExport({
  id: "preview-deadline-glean",
  iso: "2026-07-10",
  title: "Glean packet deadline",
  meta: "AI Search Engineer",
  kind: "deadline",
  label: "Deadline",
  detailId: "preview-glean",
  done: false,
});

const langchainReply = withExport({
  id: "preview-reply-langchain",
  iso: "2026-07-10",
  time: "3:00 PM",
  title: "Reply to LangChain recruiter",
  meta: "Deployed Engineer",
  kind: "reply",
  label: "Reply",
  detailId: "preview-langchain",
  done: false,
});

const stripeInterview = withExport({
  id: "preview-interview-stripe",
  iso: "2026-07-14",
  time: "11:00 AM",
  title: "Stripe hiring manager screen",
  meta: "AI Product Engineer",
  kind: "interview",
  label: "Interview",
  detailId: "preview-stripe",
  done: false,
});

const cloudscaleDeadline = withExport({
  id: "preview-deadline-cloudscale",
  iso: "2026-07-29",
  title: "Cloudscale onsite decision deadline",
  meta: "Staff Applied AI Engineer",
  kind: "deadline",
  label: "Deadline",
  detailId: "preview-cloudscale",
  done: false,
});

export const PREVIEW_CALENDAR = {
  todayIso: "2026-07-08",
  currentWeekIndex: 0,
  metrics: {
    thisWeek: 7,
    interviews: 1,
    dueToday: 3,
  },
  weeks: [
    {
      label: "Jul 6-10",
      days: [
        { dow: "Mon", date: "6", iso: "2026-07-06", state: "past", events: [greenhouseFollowUp] },
        {
          dow: "Tue",
          date: "7",
          iso: "2026-07-07",
          state: "past",
          events: [hightouchAssessment, focusBlock],
        },
        {
          dow: "Wed",
          date: "8",
          iso: "2026-07-08",
          state: "today",
          events: [prepAnthropic, juniperInterview, rampFollowUp],
        },
        // Tomorrow is deliberately empty so the empty-bucket state is visible.
        { dow: "Thu", date: "9", iso: "2026-07-09", state: "", events: [] },
        {
          dow: "Fri",
          date: "10",
          iso: "2026-07-10",
          state: "",
          events: [gleanDeadline, langchainReply],
        },
      ],
      events: [
        greenhouseFollowUp,
        hightouchAssessment,
        prepAnthropic,
        juniperInterview,
        rampFollowUp,
        gleanDeadline,
        langchainReply,
      ],
      loops: [notionInterview],
      nextUp: prepAnthropic,
      stats: { interviews: 1, replies: 1, deadlines: 2 },
    },
  ],
  today: {
    label: "Today",
    events: [prepAnthropic, juniperInterview, rampFollowUp],
  },
  upcoming: {
    events: [stripeInterview, cloudscaleDeadline],
  },
};
