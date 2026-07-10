// apps/web/src/calendar/CalendarNextPage.jsx — the agenda-first calendar from
// docs/CALENDAR_UX_RESEARCH.md ("The target shape"). Renders fields the way
// DashboardContext.jsx's data contract requires: `data.calendar` is the
// unmodified output of buildCalendar() (src/core/tracker/dashboard-data.js) —
// every event's `done`, `cta`, `label`, and `kind` is rendered as-is, never
// re-derived. Bucket placement and the 14-day strip window are the only
// client-side date math, and they derive nothing the server owns.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { ArrowLeftIcon, ArrowRightIcon } from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { PREVIEW_CALENDAR } from "./calendarPreviewData.js";

const BUCKET_ORDER = ["today", "tomorrow", "thisWeek", "nextWeek", "later"];
const BUCKET_LABELS = {
  today: "Today",
  tomorrow: "Tomorrow",
  thisWeek: "This week",
  nextWeek: "Next week",
  later: "Later",
};
const STRIP_WINDOW_DAYS = 14;

export function CalendarNextPage() {
  const { data, loading, error, noDatabase } = useDashboardSnapshot();
  const calendar = data ? calendarForNext(data.calendar) : null;
  const model = buildCalendarNextModel(calendar);

  if (noDatabase) {
    return (
      <div className="calendar-next">
        <InlineAlert message="No database workspace detected — run `rolester data import` (or `rolester data init`) first, then reload." />
      </div>
    );
  }

  return (
    <div className="calendar-next">
      <CalendarNextHero metrics={model.metrics} />

      {error ? <InlineAlert message={error} /> : null}
      {loading ? <p className="dashboard-home__loading">Loading…</p> : null}

      {calendar ? <CalendarNextBody model={model} /> : null}
    </div>
  );
}

function CalendarNextHero({ metrics }) {
  return (
    <header className="calendar-next__hero">
      <div className="calendar-next__title-block">
        <h1 className="calendar-next__title">Calendar</h1>
      </div>
      <section aria-label="Calendar status" className="calendar-next__scoreboard">
        {metrics.map((metric) => (
          <div
            className={`calendar-next__score calendar-next__score--${metric.tone}`}
            key={metric.key}
          >
            <strong data-calendar-next-stat={metric.key}>{formatNumber(metric.value)}</strong>
            <span>{metric.label}</span>
          </div>
        ))}
      </section>
    </header>
  );
}

function CalendarNextBody({ model }) {
  const [windowStartIso, setWindowStartIso] = useState(model.todayIso);

  const handleToday = () => setWindowStartIso(model.todayIso);
  const handlePrev = () =>
    setWindowStartIso((iso) => isoFromDate(addUtcDays(utcDateFromIso(iso), -STRIP_WINDOW_DAYS)));
  const handleNext = () =>
    setWindowStartIso((iso) => isoFromDate(addUtcDays(utcDateFromIso(iso), STRIP_WINDOW_DAYS)));
  const handleSelectDay = (iso) => {
    if (typeof document === "undefined") return;
    document.getElementById(anchorIdForIso(iso))?.scrollIntoView({ block: "nearest" });
  };

  return (
    <>
      <DateStrip
        eventsByIso={model.eventsByIso}
        onNext={handleNext}
        onPrev={handlePrev}
        onSelectDay={handleSelectDay}
        onToday={handleToday}
        todayIso={model.todayIso}
        windowStartIso={windowStartIso}
      />

      <section aria-label="Agenda" className="calendar-next__agenda">
        {BUCKET_ORDER.map((key) => (
          <AgendaBucket bucketKey={key} events={model.buckets[key]} key={key} />
        ))}
      </section>

      <RecentSection events={model.recent} />
    </>
  );
}

function DateStrip({
  eventsByIso,
  onNext,
  onPrev,
  onSelectDay,
  onToday,
  todayIso,
  windowStartIso,
}) {
  const days = buildStripDays(windowStartIso, eventsByIso, todayIso);
  return (
    <section aria-label="Date strip" className="calendar-next__strip-panel">
      <div className="calendar-next__strip-controls">
        <button className="calendar-next__strip-nav" onClick={onToday} type="button">
          Today
        </button>
        <div className="calendar-next__strip-steps">
          <button
            aria-label="Previous 14 days"
            className="calendar-next__strip-step"
            onClick={onPrev}
            type="button"
          >
            <ArrowLeftIcon />
          </button>
          <span className="calendar-next__strip-month">{monthTitleFromIso(windowStartIso)}</span>
          <button
            aria-label="Next 14 days"
            className="calendar-next__strip-step"
            onClick={onNext}
            type="button"
          >
            <ArrowRightIcon />
          </button>
        </div>
      </div>
      <div className="calendar-next__strip">
        {days.map((day) => (
          <button
            className={`calendar-next__strip-day${day.isToday ? " calendar-next__strip-day--today" : ""}`}
            key={day.iso}
            onClick={() => onSelectDay(day.iso)}
            type="button"
          >
            <span className="calendar-next__strip-dow">{day.dow}</span>
            <span className="calendar-next__strip-date">{day.date}</span>
            {day.dots.length ? (
              <span aria-hidden="true" className="calendar-next__strip-dots">
                {day.dots.map((dot) => (
                  <i data-kind={dot.kind} key={dot.key} />
                ))}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function AgendaBucket({ bucketKey, events }) {
  const rows = Array.isArray(events) ? events : [];
  return (
    <article className="calendar-next__bucket">
      <header className="calendar-next__bucket-header">
        <h2>{BUCKET_LABELS[bucketKey]}</h2>
        <span className="calendar-next__bucket-count">{rows.length}</span>
      </header>
      <div className="calendar-next__bucket-body">
        {rows.length ? (
          rows.map((event) => <AgendaEventRow event={event} key={eventKey(event)} />)
        ) : (
          <div className="calendar-next__empty">Nothing scheduled</div>
        )}
      </div>
    </article>
  );
}

function RecentSection({ events }) {
  const rows = Array.isArray(events) ? events : [];
  if (!rows.length) return null;
  return (
    <details className="calendar-next__recent">
      <summary>Recent · {rows.length}</summary>
      <div className="calendar-next__recent-body">
        {rows.map((event) => (
          <AgendaEventRow
            event={event}
            key={eventKey(event)}
            statusLabel={event.done ? "Done" : event.label || calendarKindLabel(event.kind)}
          />
        ))}
      </div>
    </details>
  );
}

function AgendaEventRow({ event, statusLabel }) {
  const isBusy = event.kind === "busy";
  const pillLabel = statusLabel || event.label || calendarKindLabel(event.kind);
  const copy = (
    <span className="calendar-next__event-copy">
      <strong>{event.title}</strong>
      {event.meta ? <small>{event.meta}</small> : null}
    </span>
  );

  return (
    <div
      className={`calendar-next__event-row${isBusy ? " calendar-next__event-row--busy" : ""}`}
      id={event.anchorId || undefined}
    >
      <span className="calendar-next__event-time">
        <strong>{event.time || "All day"}</strong>
        <small>{formatDateWithWeekday(event.iso)}</small>
      </span>

      {event.detailId && !isBusy ? (
        <Link
          className="calendar-next__event-link"
          to={`/jobs?open=${encodeURIComponent(event.detailId)}`}
        >
          {copy}
        </Link>
      ) : (
        <div className="calendar-next__event-link">{copy}</div>
      )}

      <div className="calendar-next__event-trailing">
        <span
          className={`calendar-next__kind-pill calendar-next__kind-pill--${event.kind || "other"}`}
        >
          {pillLabel}
        </span>
        {event.prepped === false ? (
          <span className="calendar-next__prep-flag">Not prepped</span>
        ) : null}
        {!isBusy && event.export ? <EventExportControls exportData={event.export} /> : null}
      </div>
    </div>
  );
}

function EventExportControls({ exportData }) {
  const icsHref = `data:text/calendar;charset=utf-8,${encodeURIComponent(exportData.ics)}`;
  return (
    <div className="calendar-next__export">
      <a className="calendar-next__export-link" download={exportData.filename} href={icsHref}>
        .ics
      </a>
      <a
        className="calendar-next__export-link"
        href={exportData.googleUrl}
        rel="noreferrer"
        target="_blank"
      >
        Google
      </a>
      <a
        className="calendar-next__export-link"
        href={exportData.outlookUrl}
        rel="noreferrer"
        target="_blank"
      >
        Outlook
      </a>
    </div>
  );
}

function calendarForNext(calendar) {
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

function buildCalendarNextModel(calendar) {
  const todayIso = calendar?.todayIso || new Date().toISOString().slice(0, 10);
  const events = collectCalendarEvents(calendar);
  const { buckets, recent } = classifyEvents(events, todayIso);
  const anchored = assignAnchors(buckets, recent);

  return {
    todayIso,
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
    buckets: anchored.buckets,
    recent: anchored.recent,
    eventsByIso: buildEventsByIso(events),
  };
}

// buildCalendar() scatters events across five places. Miss one (week.events and
// week.nextUp are the easy ones to miss) and rows silently vanish from the agenda.
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

function bucketForIso(iso, todayIso) {
  if (compareIsoDate(iso, todayIso) < 0) return "past";
  if (iso === todayIso) return "today";
  const tomorrowIso = isoFromDate(addUtcDays(utcDateFromIso(todayIso), 1));
  if (iso === tomorrowIso) return "tomorrow";
  const currentSundayIso = isoFromDate(addUtcDays(mondayForDate(utcDateFromIso(todayIso)), 6));
  if (compareIsoDate(iso, currentSundayIso) <= 0) return "thisWeek";
  const nextSundayIso = isoFromDate(addUtcDays(utcDateFromIso(currentSundayIso), 7));
  if (compareIsoDate(iso, nextSundayIso) <= 0) return "nextWeek";
  return "later";
}

function eventTimeMinutes(time) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(time || "").trim());
  if (!match) return -1;
  let hours = Number(match[1]) % 12;
  if (/pm/i.test(match[3])) hours += 12;
  return hours * 60 + Number(match[2]);
}

function eventSortKey(event) {
  return `${event.iso || ""}::${String(eventTimeMinutes(event.time) + 1).padStart(5, "0")}`;
}

function classifyEvents(events, todayIso) {
  const buckets = { today: [], tomorrow: [], thisWeek: [], nextWeek: [], later: [] };
  const recent = [];
  const ordered = [...events].sort((a, b) => {
    const keyA = eventSortKey(a);
    const keyB = eventSortKey(b);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  for (const event of ordered) {
    const bucket = bucketForIso(event.iso, todayIso);
    // A round the server already marked done has happened. It moves to Recent
    // rather than sitting in Today's bucket reading as something still to do.
    if (bucket === "past" || event.done === true) {
      recent.push(event);
      continue;
    }
    buckets[bucket].push(event);
  }

  recent.sort((a, b) => {
    const keyA = eventSortKey(a);
    const keyB = eventSortKey(b);
    return keyA < keyB ? 1 : keyA > keyB ? -1 : 0;
  });

  return { buckets, recent };
}

// One DOM id per iso, assigned to the first row that carries it (bucket order
// first, Recent second) — the date strip's only navigation target, and never
// duplicated across the two sections it can appear in.
function assignAnchors(buckets, recent) {
  const seen = new Set();
  const withAnchor = (list) =>
    list.map((event) => {
      if (seen.has(event.iso)) return event;
      seen.add(event.iso);
      return { ...event, anchorId: anchorIdForIso(event.iso) };
    });

  const anchoredBuckets = {};
  for (const key of BUCKET_ORDER) anchoredBuckets[key] = withAnchor(buckets[key]);
  return { buckets: anchoredBuckets, recent: withAnchor(recent) };
}

function anchorIdForIso(iso) {
  return `calendar-next-row-${iso}`;
}

function buildEventsByIso(events) {
  const map = new Map();
  for (const event of events) {
    if (!event?.iso) continue;
    const list = map.get(event.iso) || [];
    list.push(event);
    map.set(event.iso, list);
  }
  return map;
}

function buildStripDays(windowStartIso, eventsByIso, todayIso) {
  const start = utcDateFromIso(windowStartIso);
  return Array.from({ length: STRIP_WINDOW_DAYS }, (_, index) => {
    const date = addUtcDays(start, index);
    const iso = isoFromDate(date);
    const dayEvents = eventsByIso.get(iso) || [];
    return {
      iso,
      dow: date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
      date: String(date.getUTCDate()),
      isToday: iso === todayIso,
      dots: dayEvents.slice(0, 3).map((event) => ({
        key: event.id || event.detailId || `${iso}-${event.title}`,
        kind: event.kind || "other",
      })),
    };
  });
}

function utcDateFromIso(iso) {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const fallback = new Date();
  return new Date(
    Date.UTC(fallback.getUTCFullYear(), fallback.getUTCMonth(), fallback.getUTCDate())
  );
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

function formatDateWithWeekday(iso) {
  if (!iso) return "";
  return utcDateFromIso(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return "0";
  return Intl.NumberFormat("en-US").format(Number(value));
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
