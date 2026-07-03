import { CalendarEventChip } from "./CalendarEventChip.jsx";

// WeekView — the default calendar surface (buildCalendarWeek,
// dashboard-data.js:2075-2136). `weeks` is a short (3-entry) window: prior /
// current / next — `index` picks which one is showing, controlled by
// CalendarPage's prev/next buttons.
export function WeekView({ week, onOpenEvent }) {
  if (!week) return <p className="field__hint">No week data.</p>;
  return (
    <div className="calendar-week">
      {week.days.map((day) => (
        <div
          key={day.iso}
          className={`calendar-day${day.state === "today" ? " calendar-day--today" : ""}`}
        >
          <div className="calendar-day__header">
            <span className="calendar-day__dow">{day.dow}</span>
            <span className="calendar-day__date">{day.date}</span>
          </div>
          <div className="calendar-day__events">
            {day.events.length === 0 ? (
              <span className="calendar-day__empty">—</span>
            ) : (
              day.events.map((event) => (
                <CalendarEventChip key={event.id} event={event} onOpen={onOpenEvent} />
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
