import { useMemo, useState } from "react";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { getV3Data, V3_MOCK_DATA } from "../v3/v3MockData.js";

const VIEW_OPTIONS = ["Week", "Month", "Day", "Agenda"];
const TYPE_FILTERS = ["Interview", "Follow-up", "Deadline"];
const AGENDA_GROUPS = ["Overdue", "Today", "Tomorrow", "This week", "Later"];

export function CalendarV3Page() {
  const { data, loading, error, noDatabase } = useDashboardSnapshot();
  const calendar = calendarForV3(data);
  const model = useMemo(() => buildCalendarV3Model(calendar), [calendar]);
  const [view, setView] = useState(model.selectedView);

  return (
    <main className="v3-page calendar-v3">
      <header className="v3-hero">
        <div className="v3-title-block">
          <span className="v3-eyebrow">
            Calendar V3{model.preview ? " - Preview Data" : ""}
          </span>
          <h1 className="v3-title">Calendar V3</h1>
        </div>

        <div className="v3-actions" aria-label="Calendar range controls">
          <button className="v3-button" type="button">
            Today
          </button>
          <button aria-label="Previous range" className="v3-button" type="button">
            Prev
          </button>
          <span className="v3-chip">{model.rangeLabel}</span>
          <button aria-label="Next range" className="v3-button" type="button">
            Next
          </button>
        </div>
      </header>

      {error ? (
        <div className="v3-empty" role="alert">
          {error}
        </div>
      ) : null}
      {noDatabase ? (
        <div className="v3-empty" role="status">
          No database workspace detected. Showing preview calendar data.
        </div>
      ) : null}
      {loading ? <div className="v3-empty">Loading calendar...</div> : null}

      <section className="v3-toolbar" aria-label="Calendar controls">
        <div className="v3-tabs" aria-label="Calendar view" role="tablist">
          {VIEW_OPTIONS.map((option) => (
            <button
              aria-selected={view === option}
              className="v3-tab"
              key={option}
              onClick={() => setView(option)}
              role="tab"
              type="button"
            >
              <small>View</small>
              {option}
            </button>
          ))}
        </div>

        <div className="v3-filter-row" aria-label="Calendar type filters">
          {TYPE_FILTERS.map((type) => (
            <button
              aria-pressed={true}
              className="v3-chip"
              data-tone={toneForType(type)}
              key={type}
              type="button"
            >
              {type}
            </button>
          ))}
        </div>
      </section>

      <section className="v3-grid">
        <WeekGrid rangeLabel={model.rangeLabel} view={view} weekDays={model.weekDays} />
        <AgendaPanel groups={model.agendaGroups} />
      </section>
    </main>
  );
}

function WeekGrid({ rangeLabel, view, weekDays }) {
  return (
    <section className="v3-panel" aria-label={`${view} calendar`}>
      <header className="v3-panel-header">
        <div>
          <span className="v3-panel-meta">{rangeLabel}</span>
          <h2>{view === "Week" ? "Week" : `${view} preview`}</h2>
        </div>
        <span className="v3-chip">{weekDays.length} days</span>
      </header>

      <div className="v3-panel-body">
        <div className="v3-calendar-week">
          {weekDays.map((day) => (
            <article className="v3-day" data-today={day.today ? "true" : undefined} key={dayKey(day)}>
              <header className="v3-day-head">
                <span>{day.day}</span>
                <strong>{day.date}</strong>
              </header>

              {day.items.length ? (
                day.items.map((item) => <WeekEvent event={item} key={eventKey(item)} />)
              ) : (
                <div className="v3-empty">Open</div>
              )}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function WeekEvent({ event }) {
  return (
    <div className="v3-event" data-type={event.type || "Other"}>
      <span>
        {event.time ? `${event.time} - ` : ""}
        {event.type || "Item"}
      </span>
      <strong>{event.title}</strong>
    </div>
  );
}

function AgendaPanel({ groups }) {
  return (
    <section className="v3-panel" aria-label="Agenda">
      <header className="v3-panel-header">
        <div>
          <span className="v3-panel-meta">Agenda</span>
          <h2>Dated work</h2>
        </div>
      </header>

      <div className="v3-row-list">
        {groups.map((group) => (
          <article className="calendar-v3__agenda-group" key={group.group}>
            <span className="v3-row-kicker">{group.group}</span>
            <div className="v3-row-list">
              {group.items.length ? (
                group.items.map((item) => <AgendaRow item={item} key={eventKey(item)} />)
              ) : (
                <div className="v3-empty">No items in this group.</div>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function AgendaRow({ item }) {
  return (
    <div className="v3-row">
      <div className="v3-row-main">
        <span className="v3-row-kicker">
          {item.time || "Any time"} - {item.type || "Item"}
        </span>
        <strong>{item.title}</strong>
        {item.meta ? <small>{item.meta}</small> : null}
      </div>
      <div className="v3-row-actions">
        <span className="v3-chip" data-tone={toneForType(item.type)}>
          {item.type || "Item"}
        </span>
        {item.action ? (
          <button className="v3-button" type="button">
            {item.action}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function calendarForV3(data) {
  const calendar = data?.v3?.calendar || data?.calendar;
  if (hasCalendarV3Content(calendar)) return calendar;
  return getV3Data(null).calendar;
}

function hasCalendarV3Content(calendar) {
  if (!calendar) return false;
  if (Array.isArray(calendar.agenda) && calendar.agenda.some((group) => group?.items?.length)) {
    return true;
  }
  if (Array.isArray(calendar.weekDays) && calendar.weekDays.some((day) => day?.items?.length)) {
    return true;
  }
  return Boolean(calendar.rangeLabel && Array.isArray(calendar.weekDays) && calendar.weekDays.length);
}

function buildCalendarV3Model(calendar) {
  const weekDays = normalizeWeekDays(calendar?.weekDays);
  return {
    agendaGroups: normalizeAgendaGroups(calendar?.agenda),
    preview: calendar === V3_MOCK_DATA.calendar,
    rangeLabel: calendar?.rangeLabel || "This week",
    selectedView: normalizeView(calendar?.selectedView),
    weekDays,
  };
}

function normalizeAgendaGroups(agenda = []) {
  const groupsByName = new Map();

  if (Array.isArray(agenda)) {
    agenda.forEach((group) => {
      if (!group?.group) return;
      groupsByName.set(group.group, {
        group: group.group,
        items: normalizeAgendaItems(group.items),
      });
    });
  }

  const orderedGroups = AGENDA_GROUPS.map((group) => ({
    group,
    items: groupsByName.get(group)?.items || [],
  }));

  groupsByName.forEach((group, name) => {
    if (!AGENDA_GROUPS.includes(name)) orderedGroups.push(group);
  });

  return orderedGroups;
}

function normalizeAgendaItems(items = []) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    action: item?.action || "",
    id: item?.id || "",
    meta: item?.meta || "",
    time: item?.time || "",
    title: item?.title || "Untitled calendar item",
    type: normalizeType(item?.type),
  }));
}

function normalizeWeekDays(weekDays = []) {
  if (!Array.isArray(weekDays)) return [];
  return weekDays.map((day) => ({
    date: day?.date || "",
    day: day?.day || "",
    items: normalizeAgendaItems(day?.items),
    today: Boolean(day?.today),
  }));
}

function normalizeType(type) {
  if (TYPE_FILTERS.includes(type)) return type;
  return type || "Item";
}

function normalizeView(view) {
  return VIEW_OPTIONS.includes(view) ? view : "Week";
}

function toneForType(type) {
  if (type === "Interview") return "teal";
  if (type === "Follow-up") return "danger";
  if (type === "Deadline") return "gold";
  return undefined;
}

function dayKey(day) {
  return `${day.day}-${day.date}`;
}

function eventKey(event) {
  return event.id || `${event.type}-${event.time}-${event.title}`;
}
