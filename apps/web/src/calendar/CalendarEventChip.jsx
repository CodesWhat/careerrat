import { KeyIcon } from "../components/icons.jsx";

// CalendarEventChip — one event, shared by WeekView and MonthView. `kind`
// ("follow-up"/"interview"/…) picks the icon; clicking opens the Jobs drawer
// for `detailId` when the calendar event is backed by a tracked application
// (every event kind here carries one except a handful of pure reminders).
const KIND_ICON = {
  "follow-up": "mail",
  interview: "calendar",
  assessment: "check",
  reply: "chat",
  deadline: "alert",
  busy: "clock",
  prep: "list",
};

export function CalendarEventChip({ event, onOpen }) {
  const clickable = Boolean(event.detailId && onOpen);
  const Tag = clickable ? "button" : "div";
  return (
    <Tag
      type={clickable ? "button" : undefined}
      className={`calendar-event calendar-event--${event.kind || "other"}${event.done ? " calendar-event--done" : ""}`}
      onClick={clickable ? () => onOpen(event.detailId) : undefined}
      title={event.meta || event.title}
    >
      <span className="calendar-event__icon">
        <KeyIcon iconKey={KIND_ICON[event.kind] || "list"} />
      </span>
      <span className="calendar-event__body">
        {event.time ? <span className="calendar-event__time">{event.time}</span> : null}
        <span className="calendar-event__title">{event.title}</span>
      </span>
    </Tag>
  );
}
