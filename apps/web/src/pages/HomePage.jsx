import { Link } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import {
  ArrowRightIcon,
  CalendarIcon,
  ListIcon,
  SearchIcon,
  StarIcon,
} from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";

const FOCUS_TONE_CLASS = {
  error: "dashboard-home__due--error",
  warning: "dashboard-home__due--warning",
  success: "dashboard-home__due--success",
  secondary: "dashboard-home__due--muted",
};

const METRICS = [
  { key: "inPlay", label: "In Play", tone: "in-play", format: formatNumber },
  { key: "responseRate", label: "Response Rate", tone: "response", format: formatPercent },
  { key: "interviews", label: "Interviews", tone: "interviews", format: formatNumber },
];

// / (Home) renders the same product-dashboard frame as the generated tracker:
// Dashboard hero + summary metrics, Focus/Next Steps split, Upcoming, and
// Latest Roles. The row decisions still come straight from
// GET /api/data/dashboard; this page only ports the frame into the React app.
export function HomePage() {
  const { data, loading, error, noDatabase } = useDashboardSnapshot();

  if (noDatabase) {
    return (
      <div className="dashboard-home">
        <InlineAlert message="No database workspace detected — run `rolester data import` (or `rolester data init`) first, then reload." />
      </div>
    );
  }

  return (
    <div className="dashboard-home">
      <header className="dashboard-home__hero">
        <div className="dashboard-home__title-block">
          <h1 className="dashboard-home__title">Dashboard</h1>
          <p className="dashboard-home__subtitle">
            Queue, calendar, latest roles, and pipeline movement.
          </p>
        </div>
        <DashboardMetrics stats={data?.stats} />
      </header>

      {error ? <InlineAlert message={error} /> : null}
      {loading ? <p className="dashboard-home__loading">Loading…</p> : null}

      {data ? (
        <>
          <section className="dashboard-home__focus-row">
            <FocusCard focus={data.focus} />
            <NextStepsCard nextSteps={data.nextSteps} />
          </section>

          <section className="dashboard-home__secondary-row">
            <UpcomingCard upcoming={data.calendar?.upcoming} />
            <LatestRolesCard roles={data.latestRoles} />
          </section>
        </>
      ) : null}
    </div>
  );
}

function DashboardMetrics({ stats }) {
  return (
    <div className="dashboard-home__metrics">
      {METRICS.map((metric) => (
        <div
          className={`dashboard-home__metric dashboard-home__metric--${metric.tone}`}
          key={metric.key}
        >
          <strong data-dashboard-stat={metric.key}>{metric.format(stats?.[metric.key])}</strong>
          <span>{metric.label}</span>
        </div>
      ))}
    </div>
  );
}

function FocusCard({ focus }) {
  if (!focus) {
    return (
      <article className="dashboard-home__card dashboard-home__focus-card">
        <CardHeader icon={<StarIcon />} title="Focus" meta="Adaptive" />
        <div className="dashboard-home__focus-body">
          <h2 className="dashboard-home__focus-title">All clear</h2>
          <p className="dashboard-home__muted">
            When tracker activity needs attention, it will show up here first.
          </p>
        </div>
      </article>
    );
  }

  const ctaTo = focus.detailId ? `/jobs?open=${encodeURIComponent(focus.detailId)}` : "/jobs";
  const dueClass = FOCUS_TONE_CLASS[focus.tone] || FOCUS_TONE_CLASS.secondary;

  return (
    <article className="dashboard-home__card dashboard-home__focus-card">
      <CardHeader icon={<StarIcon />} title="Focus" meta="Adaptive" />
      <div className="dashboard-home__focus-body">
        <div className="dashboard-home__focus-copy">
          <h2 className="dashboard-home__focus-title">{focus.title}</h2>
          <p className="dashboard-home__focus-meta">
            {focus.company}
            {focus.role ? ` · ${focus.role}` : ""}
          </p>
          {focus.note ? <p className="dashboard-home__focus-note">{focus.note}</p> : null}
          {focus.facts?.length ? (
            <dl className="dashboard-home__facts">
              {focus.facts.map((fact) => (
                <div key={`${fact.label}-${fact.value}`}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
        <div className="dashboard-home__focus-actions">
          {focus.dueText ? (
            <span className={`dashboard-home__due ${dueClass}`}>{focus.dueText}</span>
          ) : null}
          <Link className="dashboard-home__primary-cta" to={ctaTo}>
            {focus.cta || "Review"}
          </Link>
        </div>
      </div>
    </article>
  );
}

function NextStepsCard({ nextSteps }) {
  const steps = Array.isArray(nextSteps) ? nextSteps : [];
  return (
    <article className="dashboard-home__card dashboard-home__queue-card">
      <CardHeader icon={<ListIcon />} title="Next Steps" meta="Queue" to="/jobs" />
      <div className="dashboard-home__queue">
        {steps.length ? (
          steps.map((step) => (
            <Link
              className="dashboard-home__queue-row"
              key={nextStepKey(step)}
              to={step.detailId ? `/jobs?open=${encodeURIComponent(step.detailId)}` : "/jobs"}
            >
              <span className="dashboard-home__queue-copy">
                <strong>{step.title}</strong>
                <small>{step.supportingText || step.company || step.dueText || "Review"}</small>
              </span>
              <span className="dashboard-home__row-label">{step.actionLabel || "Review"}</span>
            </Link>
          ))
        ) : (
          <div className="dashboard-home__empty-row">Nothing waiting on you right now.</div>
        )}
      </div>
    </article>
  );
}

function UpcomingCard({ upcoming }) {
  const events = Array.isArray(upcoming?.events) ? upcoming.events : [];
  return (
    <article className="dashboard-home__card">
      <CardHeader icon={<CalendarIcon />} title="Upcoming" meta="Calendar" to="/calendar" />
      <div className="dashboard-home__zebra-list">
        {events.length ? (
          events.map((event) => (
            <Link
              className="dashboard-home__upcoming-row"
              key={calendarEventKey(event)}
              to={event.detailId ? `/jobs?open=${encodeURIComponent(event.detailId)}` : "/calendar"}
            >
              <span className="dashboard-home__date-cell">
                <strong>{formatDateShort(event.iso)}</strong>
                {event.time ? <small>{event.time}</small> : null}
              </span>
              <strong>{event.title}</strong>
              <span className="dashboard-home__kind-pill">
                {event.label || calendarKindLabel(event.kind)}
              </span>
            </Link>
          ))
        ) : (
          <div className="dashboard-home__empty-row">Nothing upcoming.</div>
        )}
      </div>
    </article>
  );
}

function LatestRolesCard({ roles }) {
  const rows = Array.isArray(roles) ? roles : [];
  return (
    <article className="dashboard-home__card">
      <CardHeader icon={<SearchIcon />} title="Latest Roles" meta="All new" to="/jobs" />
      <div className="dashboard-home__zebra-list">
        {rows.length ? (
          rows.map((role) => (
            <Link
              className="dashboard-home__role-row"
              key={latestRoleKey(role)}
              to={role.detailId ? `/jobs?open=${encodeURIComponent(role.detailId)}` : "/jobs"}
            >
              <span className="dashboard-home__role-copy">
                <strong>{role.company}</strong>
                <small>
                  {role.role}
                  {role.status ? ` · ${role.status}` : ""}
                </small>
              </span>
              {Number.isFinite(role.fit) ? (
                <span className="dashboard-home__fit-score">{role.fit}</span>
              ) : null}
            </Link>
          ))
        ) : (
          <div className="dashboard-home__empty-row">No new roles yet.</div>
        )}
      </div>
    </article>
  );
}

function CardHeader({ icon, title, meta, to }) {
  const metaContent = (
    <>
      <span>{meta}</span>
      {to ? <ArrowRightIcon /> : null}
    </>
  );

  return (
    <header className="dashboard-home__card-header">
      <h2>
        <span className="dashboard-home__card-icon">{icon}</span>
        <span>{title}</span>
      </h2>
      {to ? (
        <Link className="dashboard-home__card-link" to={to}>
          {metaContent}
        </Link>
      ) : (
        <span className="dashboard-home__card-meta">{metaContent}</span>
      )}
    </header>
  );
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return "0";
  return Intl.NumberFormat("en-US").format(Number(value));
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) return "0%";
  return `${Number(value)}%`;
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

function nextStepKey(step) {
  return [step.detailId, step.title, step.company, step.dueText, step.actionLabel]
    .filter(Boolean)
    .join("::");
}

function calendarEventKey(event) {
  return [event.id, event.detailId, event.iso, event.time, event.title, event.kind]
    .filter(Boolean)
    .join("::");
}

function latestRoleKey(role) {
  return [role.detailId, role.company, role.role, role.fit, role.status].filter(Boolean).join("::");
}
