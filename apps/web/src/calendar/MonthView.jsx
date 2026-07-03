import { CalendarEventChip } from "./CalendarEventChip.jsx";

const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// MonthView — the toggled-to month grid (buildCalendarMonth,
// dashboard-data.js:2138-2177): a fixed 42-cell grid (6 weeks × 7 days),
// muted for days outside the focused month. Denser than WeekView by
// necessity (a month has ~4x the days) — still a grid, not a table, so the
// "no giant tables" rule isn't in tension here.
export function MonthView({ month, onOpenEvent }) {
  if (!month?.days?.length) return <p className="field__hint">No month data.</p>;
  return (
    <div className="calendar-month">
      <div className="calendar-month__weekdays">
        {WEEKDAY_HEADERS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="calendar-month__grid">
        {month.days.map((day) => (
          <div
            key={day.iso}
            className={`calendar-month__cell${day.muted ? " calendar-month__cell--muted" : ""}${
              day.isToday ? " calendar-month__cell--today" : ""
            }`}
          >
            <span className="calendar-month__date">
              {day.monthLabel ? `${day.monthLabel} ` : ""}
              {day.date}
            </span>
            <div className="calendar-month__events">
              {day.events.slice(0, 3).map((event) => (
                <CalendarEventChip key={event.id} event={event} onOpen={onOpenEvent} />
              ))}
              {day.events.length > 3 ? (
                <span className="calendar-month__more">+{day.events.length - 3} more</span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
