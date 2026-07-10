import { useState } from "react";
import { Link } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import {
  CalendarIcon,
  ClockIcon,
} from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";

const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const PREVIEW_CALENDAR = {
  todayIso: "2026-07-08",
  currentWeekIndex: 0,
  metrics: {
    thisWeek: 9,
    interviews: 2,
    dueToday: 3,
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
          events: [
            {
              id: "preview-follow-greenhouse",
              iso: "2026-07-06",
              time: "10:00 AM",
              title: "Follow up with Greenhouse recruiter",
              meta: "Senior AI Platform Engineer",
              kind: "follow-up",
              label: "Follow-Up",
              detailId: "preview-greenhouse",
            },
          ],
        },
        {
          dow: "Tue",
          date: "7",
          iso: "2026-07-07",
          state: "past",
          events: [
            {
              id: "preview-assessment-hightouch",
              iso: "2026-07-07",
              title: "Hightouch take-home due",
              meta: "Staff Engineer, AI Productivity",
              kind: "assessment",
              label: "Assessment",
              detailId: "preview-hightouch",
            },
            {
              id: "preview-busy-focus",
              iso: "2026-07-07",
              time: "1:00 PM",
              title: "Focus block",
              meta: "Calendar busy",
              kind: "busy",
              label: "Busy",
            },
          ],
        },
        {
          dow: "Wed",
          date: "8",
          iso: "2026-07-08",
          state: "today",
          events: [
            {
              id: "preview-prep-anthropic",
              iso: "2026-07-08",
              time: "9:30 AM",
              title: "Prep Anthropic enterprise AI stories",
              meta: "Applied AI Architect",
              kind: "prep",
              label: "Prep",
              detailId: "preview-anthropic",
            },
            {
              id: "preview-interview-juniper",
              iso: "2026-07-08",
              time: "2:00 PM",
              title: "Juniper Square technical screen",
              meta: "Senior Applied AI Engineer",
              kind: "interview",
              label: "Interview",
              detailId: "preview-juniper",
            },
            {
              id: "preview-follow-ramp",
              iso: "2026-07-08",
              time: "4:30 PM",
              title: "Send Ramp follow-up",
              meta: "Applied AI Engineer",
              kind: "follow-up",
              label: "Follow-Up",
              detailId: "preview-ramp",
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
              id: "preview-interview-stripe",
              iso: "2026-07-09",
              time: "11:00 AM",
              title: "Stripe hiring manager screen",
              meta: "AI Product Engineer",
              kind: "interview",
              label: "Interview",
              detailId: "preview-stripe",
            },
          ],
        },
        {
          dow: "Fri",
          date: "10",
          iso: "2026-07-10",
          state: "",
          events: [
            {
              id: "preview-deadline-glean",
              iso: "2026-07-10",
              title: "Glean packet deadline",
              meta: "AI Search Engineer",
              kind: "deadline",
              label: "Deadline",
              detailId: "preview-glean",
            },
            {
              id: "preview-reply-langchain",
              iso: "2026-07-10",
              time: "3:00 PM",
              title: "Reply to LangChain recruiter",
              meta: "Deployed Engineer",
              kind: "reply",
              label: "Reply",
              detailId: "preview-langchain",
            },
          ],
        },
      ],
      events: [],
      loops: [
        {
          id: "preview-follow-ramp",
          iso: "2026-07-08",
          time: "4:30 PM",
          title: "Send Ramp follow-up",
          meta: "Applied AI Engineer",
          kind: "follow-up",
          label: "Follow-Up",
          detailId: "preview-ramp",
        },
        {
          id: "preview-deadline-glean",
          iso: "2026-07-10",
          title: "Glean packet deadline",
          meta: "AI Search Engineer",
          kind: "deadline",
          label: "Deadline",
          detailId: "preview-glean",
        },
      ],
      nextUp: {
        id: "preview-prep-anthropic",
        iso: "2026-07-08",
        time: "9:30 AM",
        title: "Prep Anthropic enterprise AI stories",
        meta: "Applied AI Architect · 9:30 AM",
        kind: "prep",
        label: "Prep",
        detailId: "preview-anthropic",
        cta: "Open Prep",
        note: "Block the story pass before the Juniper Square screen and keep Ramp follow-up from slipping.",
      },
      stats: {
        interviews: 2,
        replies: 1,
        deadlines: 2,
      },
    },
  ],
  month: { title: "July 2026", count: 9, countLabel: "9 tracked", days: [] },
  today: {
    label: "Today",
    events: [
      {
        id: "preview-prep-anthropic",
        iso: "2026-07-08",
        time: "9:30 AM",
        title: "Prep Anthropic enterprise AI stories",
        meta: "Applied AI Architect",
        kind: "prep",
        label: "Prep",
        detailId: "preview-anthropic",
      },
      {
        id: "preview-interview-juniper",
        iso: "2026-07-08",
        time: "2:00 PM",
        title: "Juniper Square technical screen",
        meta: "Senior Applied AI Engineer",
        kind: "interview",
        label: "Interview",
        detailId: "preview-juniper",
      },
      {
        id: "preview-follow-ramp",
        iso: "2026-07-08",
        time: "4:30 PM",
        title: "Send Ramp follow-up",
        meta: "Applied AI Engineer",
        kind: "follow-up",
        label: "Follow-Up",
        detailId: "preview-ramp",
      },
    ],
  },
  upcoming: { events: [] },
  protectedPrep: {
    title: "Juniper Square technical screen",
    label: "Interview",
    kind: "interview",
    note: "Prep system design, AI routing examples, and compensation guardrails before the call.",
    detailId: "preview-juniper",
    cta: "Open Prep",
  },
  sync: {
    posture: "Calendar writes are confirm-first; preview keeps provider history hidden until needed.",
    providers: [
      { key: "google_calendar", label: "Google Calendar", status: "ready" },
      { key: "apple_calendar", label: "Apple Calendar", status: "off" },
      { key: "outlook_calendar", label: "Outlook Calendar", status: "off" },
    ],
    history: [],
  },
};

export function CalendarV2Page() {
  const { data, loading, error, noDatabase } = useDashboardSnapshot();
  const [view, setView] = useState("week");
  const calendar = data ? calendarForV2(data.calendar) : null;
  const model = buildCalendarV2Model(calendar);

  if (noDatabase) {
    return (
      <div className="calendar-v2">
        <InlineAlert message="No database workspace detected — run `rolester data import` (or `rolester data init`) first, then reload." />
      </div>
    );
  }

  return (
    <div className="calendar-v2">
      <header className="calendar-v2__hero">
        <div className="calendar-v2__title-block">
          <span className="calendar-v2__eyebrow">
            Calendar V2{model.preview ? " · Preview Data" : ""}
          </span>
          <h1 className="calendar-v2__title">This Week</h1>
          <p>{model.weekLabel}</p>
        </div>
        <CalendarV2Metrics metrics={model.metrics} />
      </header>

      {error ? <InlineAlert message={error} /> : null}
      {loading ? <p className="dashboard-home__loading">Loading…</p> : null}

      {calendar ? (
        <>
          <section className="calendar-v2__workbench">
            <TodayPanel today={model.today} />
            <MonthSnapshotPanel month={model.month} />
          </section>

          <CalendarBoard
            month={model.month}
            onViewChange={setView}
            view={view}
            weekDays={model.weekDays}
            weekLabel={model.weekLabel}
          />
        </>
      ) : null}
    </div>
  );
}

function CalendarV2Metrics({ metrics }) {
  return (
    <div className="calendar-v2__metrics" aria-label="Calendar status">
      {metrics.map((metric) => (
        <div className={`calendar-v2__metric calendar-v2__metric--${metric.tone}`} key={metric.key}>
          <strong data-calendar-v2-stat={metric.key}>{formatNumber(metric.value)}</strong>
          <span>{metric.label}</span>
        </div>
      ))}
    </div>
  );
}

function TodayPanel({ today }) {
  const rows = Array.isArray(today?.events) ? today.events : [];
  return (
    <article className="calendar-v2__panel">
      <PanelHeader icon={<ClockIcon />} title={today?.label || "Today"} />
      <div className="calendar-v2__agenda-list">
        {rows.length ? (
          rows.map((event) => <AgendaEvent event={event} key={eventKey(event)} />)
        ) : (
          <div className="calendar-v2__empty">No tracked item due today.</div>
        )}
      </div>
    </article>
  );
}

function MonthSnapshotPanel({ month }) {
  return (
    <article className="calendar-v2__panel">
      <PanelHeader
        actionLabel={month?.countLabel || "0 tracked"}
        icon={<CalendarIcon />}
        title="Month Snapshot"
      />
      <MonthGrid compact month={month} />
    </article>
  );
}

function CalendarBoard({ month, onViewChange, view, weekDays, weekLabel }) {
  return (
    <section className="calendar-v2__week-panel calendar-v2__calendar-board" aria-label="Calendar">
      <header className="calendar-v2__panel-header">
        <h2>
          <span className="calendar-v2__panel-icon">
            <CalendarIcon />
          </span>
          <span>Calendar</span>
        </h2>
        <div className="calendar-v2__view-controls" aria-label="Calendar view">
          <span className="calendar-v2__panel-meta">
            {view === "week" ? weekLabel : month?.title || "Month"}
          </span>
          <div className="calendar-v2__segments">
            {["week", "month"].map((key) => (
              <button
                aria-pressed={view === key}
                className={`calendar-v2__segment${
                  view === key ? " calendar-v2__segment--active" : ""
                }`}
                key={key}
                onClick={() => onViewChange(key)}
                type="button"
              >
                {key === "week" ? "Week" : "Month"}
              </button>
            ))}
          </div>
        </div>
      </header>
      {view === "week" ? (
        <div className="calendar-v2__week-grid">
          {weekDays.length ? (
            weekDays.map((day) => <WeekDayCard day={day} key={day.iso} />)
          ) : (
            <div className="calendar-v2__empty">No week data.</div>
          )}
        </div>
      ) : (
        <MonthGrid month={month} />
      )}
    </section>
  );
}

function WeekDayCard({ day }) {
  const events = Array.isArray(day?.events) ? day.events : [];
  return (
    <article
      className={`calendar-v2__day${day.state === "today" ? " calendar-v2__day--today" : ""}${day.state === "past" ? " calendar-v2__day--past" : ""}`}
    >
      <header className="calendar-v2__day-head">
        <span>{day.dow}</span>
        <strong>{day.date}</strong>
      </header>
      <div className="calendar-v2__day-events">
        {events.length ? (
          events.slice(0, 3).map((event) => <CompactEvent event={event} key={eventKey(event)} />)
        ) : (
          <span className="calendar-v2__day-empty">Open</span>
        )}
        {events.length > 3 ? (
          <span className="calendar-v2__more">+{events.length - 3} more</span>
        ) : null}
      </div>
    </article>
  );
}

function AgendaEvent({ event, compact = false }) {
  const content = (
    <>
      <span className="calendar-v2__event-time">{event.time || formatDateShort(event.iso)}</span>
      <span className="calendar-v2__event-copy">
        <strong>{event.title}</strong>
        {event.meta ? <small>{event.meta}</small> : null}
      </span>
      <EventKindPill event={event} />
    </>
  );

  if (event.detailId) {
    return (
      <Link
        className={`calendar-v2__event-row${compact ? " calendar-v2__event-row--compact" : ""}`}
        to={`/jobs?open=${encodeURIComponent(event.detailId)}`}
      >
        {content}
      </Link>
    );
  }

  return <div className="calendar-v2__event-row">{content}</div>;
}

function CompactEvent({ event }) {
  const content = (
    <>
      {event.time ? <span>{event.time}</span> : null}
      <strong>{event.title}</strong>
    </>
  );

  if (event.detailId) {
    return (
      <Link className={`calendar-v2__compact-event calendar-v2__compact-event--${event.kind || "other"}`} to={`/jobs?open=${encodeURIComponent(event.detailId)}`}>
        {content}
      </Link>
    );
  }

  return (
    <div className={`calendar-v2__compact-event calendar-v2__compact-event--${event.kind || "other"}`}>
      {content}
    </div>
  );
}

function EventKindPill({ event }) {
  const label = event?.label || calendarKindLabel(event?.kind);
  return (
    <span className={`calendar-v2__kind-pill calendar-v2__kind-pill--${event?.kind || "other"}`}>
      {label}
    </span>
  );
}

function MonthGrid({ compact = false, month }) {
  const days = Array.isArray(month?.days) ? month.days : [];
  if (!days.length) {
    return <div className="calendar-v2__empty">No month data.</div>;
  }

  return (
    <div className={`calendar-v2__month${compact ? " calendar-v2__month--compact" : ""}`}>
      <div className="calendar-v2__month-weekdays">
        {WEEKDAY_HEADERS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="calendar-v2__month-grid">
        {days.map((day) => {
          const events = Array.isArray(day.events) ? day.events : [];
          return (
            <div
              className={`calendar-v2__month-cell${
                day.muted ? " calendar-v2__month-cell--muted" : ""
              }${day.isToday ? " calendar-v2__month-cell--today" : ""}`}
              key={day.iso}
            >
              <span className="calendar-v2__month-date">
                {day.monthLabel ? `${day.monthLabel} ` : ""}
                {day.date}
              </span>
              {compact ? (
                <span className="calendar-v2__month-dots" aria-label={`${events.length} events`}>
                  {events.slice(0, 3).map((event) => (
                    <i data-kind={event.kind || "other"} key={eventKey(event)} />
                  ))}
                </span>
              ) : (
                <div className="calendar-v2__month-events">
                  {events.slice(0, 2).map((event) => (
                    <CompactEvent event={event} key={eventKey(event)} />
                  ))}
                  {events.length > 2 ? (
                    <span className="calendar-v2__more">+{events.length - 2} more</span>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PanelHeader({ icon, title, actionLabel }) {
  return (
    <header className="calendar-v2__panel-header">
      <h2>
        <span className="calendar-v2__panel-icon">{icon}</span>
        <span>{title}</span>
      </h2>
      {actionLabel ? <span className="calendar-v2__panel-meta">{actionLabel}</span> : null}
    </header>
  );
}

function calendarForV2(calendar) {
  if (hasCalendarContent(calendar)) return calendar;
  return import.meta.env.DEV ? PREVIEW_CALENDAR : calendar;
}

function hasCalendarContent(calendar) {
  if (!calendar) return false;
  if (Number(calendar?.metrics?.thisWeek || 0) > 0) return true;
  if (Number(calendar?.metrics?.dueToday || 0) > 0) return true;
  if ((calendar?.today?.events || []).length > 0) return true;
  if ((calendar?.upcoming?.events || []).length > 0) return true;
  return (calendar?.weeks || []).some((week) =>
    (week?.days || []).some((day) => (day?.events || []).length > 0)
  );
}

function buildCalendarV2Model(calendar) {
  const week = calendar?.weeks?.[calendar.currentWeekIndex || 0] || calendar?.weeks?.[0] || {};
  const today = calendar?.today || { label: "Today", events: [] };
  const weekDays = Array.isArray(week.days) ? week.days : [];
  const month = calendarMonthForV2(calendar, weekDays);

  return {
    weekLabel: week.label || calendar?.month?.title || "This week",
    today,
    weekDays,
    month,
    preview: calendar === PREVIEW_CALENDAR,
    metrics: [
      {
        key: "dueToday",
        label: "Due Today",
        tone: Number(calendar?.metrics?.dueToday || 0) ? "danger" : "neutral",
        value: calendar?.metrics?.dueToday,
      },
      {
        key: "interviews",
        label: "Interviews",
        tone: "teal",
        value: calendar?.metrics?.interviews,
      },
      {
        key: "thisWeek",
        label: "This Week",
        tone: "sky",
        value: calendar?.metrics?.thisWeek,
      },
    ],
  };
}

function calendarMonthForV2(calendar, weekDays = []) {
  if (Array.isArray(calendar?.month?.days) && calendar.month.days.length) return calendar.month;

  const todayIso =
    calendar?.todayIso ||
    weekDays.find((day) => day?.state === "today")?.iso ||
    weekDays.find((day) => day?.iso)?.iso ||
    new Date().toISOString().slice(0, 10);
  const today = utcDateFromIso(todayIso);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const gridStart = mondayForDate(monthStart);
  const eventMap = new Map();

  collectCalendarEvents(calendar).forEach((event) => {
    if (!event?.iso) return;
    const key = event.iso;
    const existing = eventMap.get(key) || [];
    existing.push(event);
    eventMap.set(key, existing);
  });

  const days = Array.from({ length: 42 }, (_, index) => {
    const date = addUtcDays(gridStart, index);
    const iso = isoFromDate(date);
    return {
      iso,
      date: String(date.getUTCDate()),
      monthLabel: date.getUTCDate() === 1 ? monthShortFromIso(iso) : "",
      muted: date.getUTCMonth() !== today.getUTCMonth(),
      isToday: iso === todayIso,
      state: compareIsoDate(iso, todayIso) < 0 ? "past" : iso === todayIso ? "today" : "",
      events: dedupeEvents(eventMap.get(iso) || []),
    };
  });

  const monthEvents = dedupeEvents(
    [...eventMap.values()]
      .flat()
      .filter((event) => {
        const eventDate = utcDateFromIso(event.iso);
        return (
          eventDate.getUTCMonth() === today.getUTCMonth() &&
          eventDate.getUTCFullYear() === today.getUTCFullYear()
        );
      })
  );

  return {
    title: calendar?.month?.title || monthTitleFromIso(todayIso),
    count: monthEvents.length,
    countLabel: `${monthEvents.length} tracked`,
    days,
  };
}

function collectCalendarEvents(calendar) {
  const events = [];
  if (Array.isArray(calendar?.today?.events)) events.push(...calendar.today.events);
  if (Array.isArray(calendar?.upcoming?.events)) events.push(...calendar.upcoming.events);
  if (Array.isArray(calendar?.weeks)) {
    calendar.weeks.forEach((week) => {
      if (Array.isArray(week?.events)) events.push(...week.events);
      if (Array.isArray(week?.loops)) events.push(...week.loops);
      if (week?.nextUp) events.push(week.nextUp);
      (week?.days || []).forEach((day) => {
        if (Array.isArray(day?.events)) events.push(...day.events);
      });
    });
  }
  return dedupeEvents(events);
}

function dedupeEvents(events) {
  const seen = new Set();
  return (Array.isArray(events) ? events : []).filter((event) => {
    const key = eventKey(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function utcDateFromIso(iso) {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const fallback = new Date();
  return new Date(Date.UTC(fallback.getUTCFullYear(), fallback.getUTCMonth(), fallback.getUTCDate()));
}

function isoFromDate(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function mondayForDate(date) {
  const monday = new Date(date);
  const day = monday.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  monday.setUTCDate(monday.getUTCDate() + offset);
  return monday;
}

function compareIsoDate(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function monthTitleFromIso(iso) {
  return utcDateFromIso(iso).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function monthShortFromIso(iso) {
  return utcDateFromIso(iso).toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return "0";
  return Intl.NumberFormat("en-US").format(Number(value));
}

function formatDateShort(iso) {
  if (!iso) return "";
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function calendarKindLabel(kind) {
  if (!kind) return "Due";
  return String(kind)
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function eventKey(event) {
  return [event.id, event.detailId, event.iso, event.time, event.title, event.kind]
    .filter(Boolean)
    .join("::");
}
