import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { Card } from "../components/Card.jsx";
import { PageScaffold } from "../components/PageScaffold.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { JobDrawer } from "../jobs/JobDrawer.jsx";
import { MonthView } from "./MonthView.jsx";
import { WeekView } from "./WeekView.jsx";

// /calendar — week view by default (buildCalendarWeek), a month toggle
// (buildCalendarMonth), the protected-prep card, and the confirm-first
// external-sync write history collapsed behind a <details> (that log is
// the calendar-sync SKILL's surface, not this page's primary job — M10
// design doc §1).
export function CalendarPage() {
  const { data, loading, error, noDatabase } = useDashboardSnapshot();
  const [view, setView] = useState("week");
  const [weekIndex, setWeekIndex] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const calendar = data?.calendar;
  const rows = data?.jobs?.rows || [];
  const activeWeekIndex = weekIndex ?? calendar?.currentWeekIndex ?? 0;
  const week = calendar?.weeks?.[activeWeekIndex];

  const openId = searchParams.get("open");
  const openRow = openId ? rows.find((r) => r.id === openId) : null;

  function openDrawer(id) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("open", id);
      return next;
    });
  }
  function closeDrawer() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("open");
      return next;
    });
  }

  if (noDatabase) {
    return (
      <PageScaffold title="Calendar">
        <InlineAlert message="No database workspace detected — run `rolester data import` (or `rolester data init`) first, then reload." />
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      title="Calendar"
      subtitle="Interviews, assessments, follow-ups, and deadlines pulled from the tracker."
      wide
    >
      {error ? <InlineAlert message={error} /> : null}
      {loading ? <p>Loading…</p> : null}

      {calendar ? (
        <>
          <div className="calendar-metrics">
            <span className="badge badge--muted">{calendar.metrics.thisWeek} this week</span>
            <span className="badge badge--muted">{calendar.metrics.interviews} interviews</span>
            <span className="badge badge--muted">{calendar.metrics.dueToday} due today</span>
          </div>

          <div className="calendar-toolbar">
            <div className="inbox-filters">
              <button
                type="button"
                className={`inbox-filter${view === "week" ? " inbox-filter--active" : ""}`}
                onClick={() => setView("week")}
              >
                Week
              </button>
              <button
                type="button"
                className={`inbox-filter${view === "month" ? " inbox-filter--active" : ""}`}
                onClick={() => setView("month")}
              >
                Month
              </button>
            </div>
            {view === "week" ? (
              <div className="calendar-toolbar__nav">
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={activeWeekIndex <= 0}
                  onClick={() => setWeekIndex(Math.max(0, activeWeekIndex - 1))}
                >
                  ← Prev
                </button>
                <span className="field__hint">{week?.label}</span>
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={activeWeekIndex >= calendar.weeks.length - 1}
                  onClick={() =>
                    setWeekIndex(Math.min(calendar.weeks.length - 1, activeWeekIndex + 1))
                  }
                >
                  Next →
                </button>
              </div>
            ) : (
              <span className="field__hint">
                {calendar.month.title} · {calendar.month.countLabel}
              </span>
            )}
          </div>

          {view === "week" ? (
            <WeekView week={week} onOpenEvent={openDrawer} />
          ) : (
            <MonthView month={calendar.month} onOpenEvent={openDrawer} />
          )}

          <Card title="Protected prep">
            <p className="job-drawer__timeline-title">{calendar.protectedPrep.title}</p>
            <p className="field__hint">{calendar.protectedPrep.note}</p>
          </Card>

          <details className="calendar-sync">
            <summary>Synced to calendar ({calendar.sync.history.length})</summary>
            <p className="field__hint">
              {calendar.sync.posture} — confirm-first writes to an external calendar go through the
              calendar-sync skill, not this page.
            </p>
            <div className="chip-row">
              {calendar.sync.providers.map((p) => (
                <span className="chip" key={p.key}>
                  {p.label}: {p.status}
                </span>
              ))}
            </div>
            {calendar.sync.history.length ? (
              <ul className="job-drawer__list">
                {calendar.sync.history.map((h, i) => (
                  // sync history is an append-only log with no stable id surfaced.
                  // biome-ignore lint/suspicious/noArrayIndexKey: no stable id available
                  <li key={i}>{h.summary || JSON.stringify(h)}</li>
                ))}
              </ul>
            ) : null}
          </details>
        </>
      ) : null}

      {openRow ? <JobDrawer row={openRow} onClose={closeDrawer} /> : null}
    </PageScaffold>
  );
}
