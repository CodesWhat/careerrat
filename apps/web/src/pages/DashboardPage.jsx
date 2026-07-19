import { Link } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { CompanyAvatar } from "../components/CompanyAvatar.jsx";
import {
  ArrowRightIcon,
  CalendarIcon,
  CheckIcon,
  ListIcon,
  SearchIcon,
  StarIcon,
} from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { DASHBOARD_PREVIEW } from "./dashboardPreviewData.js";
import { SetupReadinessCard } from "./SetupReadinessCard.jsx";

// The lower-grid panels show three rows and scroll the rest inside the card, so
// they carry a real queue rather than a truncated top-N with nothing behind it.
const PANEL_ROW_LIMIT = 12;

const FOCUS_TONE_CLASS = {
  error: "dashboard__pill--danger",
  warning: "dashboard__pill--warning",
  success: "dashboard__pill--success",
  secondary: "dashboard__pill--muted",
};

export function DashboardPage() {
  const { data, setup, loading, error, noDatabase } = useDashboardSnapshot();
  const dashboard = data ? dashboardForPage(data) : null;
  const model = buildDashboardModel(dashboard);

  if (noDatabase) {
    return (
      <div className="dashboard">
        <InlineAlert message="This workspace hasn't finished setup yet — finish setup, then reload." />
      </div>
    );
  }

  return (
    <div className="dashboard">
      <header className="dashboard__hero">
        <div className="dashboard__title-block">
          <h1 className="dashboard__title">Dashboard</h1>
        </div>
        <DashboardScoreboard metrics={model.metrics} />
      </header>

      {error ? <InlineAlert message={error} /> : null}
      {loading ? <p className="dashboard-home__loading">Loading…</p> : null}

      <SetupReadinessCard setup={setup} />

      {dashboard ? (
        <>
          <section className="dashboard__workbench">
            <PriorityPanel focus={dashboard.focus} />
            <PipelinePanel model={model} />
          </section>

          <section className="dashboard__lower-grid" aria-label="Dashboard work queues">
            <DecisionPanel hasWork={model.decisionHasWork} roles={model.reviewRoles} />
            <FreshFindsPanel roles={model.freshRoles} />
            <TodayPanel events={model.todayEvents} />
          </section>
        </>
      ) : null}
    </div>
  );
}

function DashboardScoreboard({ metrics }) {
  return (
    <section className="dashboard__scoreboard" aria-label="Dashboard status">
      {metrics.map((metric) => (
        <div className={`dashboard__score dashboard__score--${metric.tone}`} key={metric.key}>
          <strong data-dashboard-stat={metric.key}>{formatNumber(metric.value)}</strong>
          <span>{metric.label}</span>
        </div>
      ))}
    </section>
  );
}

// One card, one decision. `focus` is recomputed server-side on every poll, so
// the hero advances to whatever is most important now — no queue beneath it.
function PriorityPanel({ focus }) {
  return (
    <article className="dashboard__panel dashboard__panel--priority">
      <PanelHeader icon={<StarIcon />} title="Priority" to="/jobs" actionLabel="Open Jobs" />
      <PriorityFocus focus={focus} />
    </article>
  );
}

function PriorityFocus({ focus }) {
  if (!focus) {
    return (
      <div className="dashboard__focus">
        <span className="dashboard__pill dashboard__pill--success">Clear</span>
        <h2>Nothing blocking</h2>
        <p>No tracked action needs attention right now.</p>
      </div>
    );
  }

  const ctaTo = focus.detailId ? `/jobs?open=${encodeURIComponent(focus.detailId)}` : "/jobs";
  const toneClass = FOCUS_TONE_CLASS[focus.tone] || FOCUS_TONE_CLASS.secondary;
  const facts = Array.isArray(focus.facts) ? focus.facts : [];
  // Only surface a distinct secondary dossier action — when the primary CTA is
  // ALREADY "Open dossier" (the interview branch collapses to that once
  // hasDossier is true), a second identical button would be pure noise.
  const showDossierLink =
    focus.hasDossier &&
    (focus.kind === "interview" || focus.kind === "interview-followup") &&
    focus.cta !== "Open dossier";

  return (
    <div className="dashboard__focus">
      {focus.type || focus.dueText ? (
        <div className="dashboard__focus-tags">
          {focus.type ? <span className="dashboard__pill">{focus.type}</span> : null}
          {focus.dueText ? (
            <span className={`dashboard__pill ${toneClass}`}>{duePillLabel(focus.dueText)}</span>
          ) : null}
        </div>
      ) : null}
      <h2>{focus.title}</h2>
      <p>
        {focus.company}
        {focus.role ? ` · ${focus.role}` : ""}
      </p>
      {focus.meta ? <p className="dashboard__focus-meta">{focus.meta}</p> : null}
      {facts.length ? (
        <div className="dashboard__focus-facts">
          {facts.map((fact) => (
            <span className="dashboard__focus-fact" key={fact.label}>
              {fact.label} · <strong>{fact.value}</strong>
            </span>
          ))}
        </div>
      ) : null}
      <div className="dashboard__focus-actions">
        {showDossierLink ? (
          <Link className="dashboard__secondary-link" to={ctaTo}>
            <span>Open dossier</span>
          </Link>
        ) : null}
        <Link className="dashboard__primary-link" to={ctaTo}>
          <span>{focus.cta || "Review"}</span>
          <ArrowRightIcon />
        </Link>
      </div>
    </div>
  );
}

function PipelinePanel({ model }) {
  return (
    <aside className="dashboard__panel">
      <PanelHeader icon={<ListIcon />} title="Momentum" to="/jobs" actionLabel="Open Jobs" />
      <div className="dashboard__pipeline-list">
        {model.pipeline.map((item) => (
          <div className="dashboard__pipeline-row" key={item.key}>
            <span className="dashboard__pipeline-label">
              <strong>{item.label}</strong>
            </span>
            <span className="dashboard__pipeline-meter" aria-hidden="true">
              <span style={{ width: `${item.width}%` }} />
            </span>
            <span className="dashboard__pipeline-value">{formatNumber(item.value)}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

function DecisionPanel({ hasWork, roles }) {
  return (
    <article className="dashboard__panel">
      <PanelHeader icon={<CheckIcon />} title="Decide" to="/jobs" actionLabel="Open Roles" />
      <RoleList
        roles={roles}
        emptyText={
          hasWork ? "Open Jobs to review the waiting roles." : "No high-fit roles need a decision."
        }
      />
    </article>
  );
}

function FreshFindsPanel({ roles }) {
  return (
    <article className="dashboard__panel">
      <PanelHeader icon={<SearchIcon />} title="Fresh Finds" to="/jobs" actionLabel="Search" />
      <RoleList roles={roles} emptyText="No fresh roles from the last sweep." />
    </article>
  );
}

function TodayPanel({ events }) {
  const rows = Array.isArray(events) ? events : [];
  return (
    <article className="dashboard__panel">
      <PanelHeader icon={<CalendarIcon />} title="Today" to="/calendar" actionLabel="Calendar" />
      <div className="dashboard__event-list">
        {rows.length ? (
          rows.map((event) => (
            <Link
              className="dashboard__event-row"
              key={calendarEventKey(event)}
              to={event.detailId ? `/jobs?open=${encodeURIComponent(event.detailId)}` : "/calendar"}
            >
              <span className="dashboard__date-cell">
                <strong>{event.time || formatDateShort(event.iso)}</strong>
                {event.time ? <small>Today</small> : null}
              </span>
              <span className="dashboard__row-copy">
                <strong>{event.title}</strong>
                <small>{event.label || calendarKindLabel(event.kind)}</small>
              </span>
            </Link>
          ))
        ) : (
          <div className="dashboard__empty">No interviews or calls today.</div>
        )}
      </div>
    </article>
  );
}

function RoleList({ roles, emptyText }) {
  const rows = Array.isArray(roles) ? roles : [];
  return (
    <div className="dashboard__role-list">
      {rows.length ? (
        rows.map((role) => (
          <Link
            className="dashboard__role-row"
            key={latestRoleKey(role)}
            to={role.detailId ? `/jobs?open=${encodeURIComponent(role.detailId)}` : "/jobs"}
          >
            <CompanyAvatar name={role.company} domain={role.domain} size={32} />
            <span className="dashboard__row-copy">
              <strong>{role.company}</strong>
              <small>{role.role || "Open Role"}</small>
            </span>
            {fitLabel(role.fit) ? (
              <span className="dashboard__fit">{fitLabel(role.fit)}</span>
            ) : null}
          </Link>
        ))
      ) : (
        <div className="dashboard__empty">{emptyText}</div>
      )}
    </div>
  );
}

function PanelHeader({ icon, title, to, actionLabel }) {
  return (
    <header className="dashboard__panel-header">
      <h2>
        <span className="dashboard__panel-icon">{icon}</span>
        <span>{title}</span>
      </h2>
      {to ? (
        <Link className="dashboard__panel-link" to={to}>
          <span>{actionLabel}</span>
          <ArrowRightIcon />
        </Link>
      ) : null}
    </header>
  );
}

function dashboardForPage(data) {
  if (hasDashboardContent(data)) return data;
  return import.meta.env.DEV ? DASHBOARD_PREVIEW : data;
}

function hasDashboardContent(data) {
  if (!data) return false;
  if (data.focus && data.focus.kind !== "clear") return true;
  if ((data.allNextSteps || []).length > 0) return true;
  if ((data.nextSteps || []).length > 0) return true;
  if ((data.reviewHoldRoles || []).length > 0) return true;
  if ((data.latestRoles || []).length > 0) return true;
  if ((data.sourcedRoles || []).length > 0) return true;
  if ((data.calendar?.today?.events || []).length > 0) return true;
  if ((data.calendar?.upcoming?.events || []).length > 0) return true;
  if (Number(data.jobs?.visibleCount || 0) > 0) return true;
  const rail = data.jobs?.rail || {};
  return ["manualReview", "highFit", "screenPlus", "fresh", "terminal"].some(
    (key) => Number(rail[key] || 0) > 0
  );
}

function buildDashboardModel(data) {
  const allSteps = dashboardAllSteps(data);
  const todayEvents = dashboardTodayEvents(data);
  const reviewRoles = dashboardReviewRoles(data);
  const highFitRoles = dashboardHighFitRoles(data);
  const freshRoles = dashboardFreshRoles(data, reviewRoles);
  const pipeline = dashboardPipeline(data);
  const highFitCount = highFitRoleCount(data, highFitRoles);
  const decisionCount = decisionRoleCount(data, reviewRoles);
  // Counts every step that needs the user, including the one promoted to the
  // focus card. Only the hero renders, so this tile is the sole signal of how
  // much work is queued behind it.
  const needsYou = allSteps.length;
  const dueNow = allSteps.filter(
    (step) => step?.tone === "error" || /\b(overdue|today)\b/i.test(step?.dueText || "")
  ).length;
  const activeJobs = Number(data?.jobs?.visibleCount);

  return {
    todayEvents,
    reviewRoles,
    highFitRoles,
    freshRoles,
    pipeline,
    decisionHasWork: decisionCount > 0 || Boolean(data?.jobs?.rail?.nextDecision?.hasWork),
    metrics: [
      {
        key: "needsYou",
        label: "Needs You",
        tone: dueNow ? "danger" : "neutral",
        value: needsYou,
      },
      {
        key: "highFit",
        label: "High Fit",
        tone: "teal",
        value: highFitCount,
      },
      {
        key: "activeJobs",
        label: "Active",
        tone: "sky",
        value: Number.isFinite(activeJobs) ? activeJobs : Number(data?.stats?.inPlay || 0),
      },
    ],
  };
}

function dashboardAllSteps(data) {
  if (Array.isArray(data?.allNextSteps)) return data.allNextSteps;
  if (Array.isArray(data?.nextSteps)) return data.nextSteps;
  return [];
}

function dashboardReviewRoles(data) {
  return (Array.isArray(data?.reviewHoldRoles) ? data.reviewHoldRoles : []).slice(
    0,
    PANEL_ROW_LIMIT
  );
}

function dashboardHighFitRoles(data) {
  const latest = Array.isArray(data?.latestRoles) ? data.latestRoles : [];
  const sourced = Array.isArray(data?.sourcedRoles) ? data.sourcedRoles : [];
  const seen = new Set();
  return [...latest, ...sourced]
    .filter((role) => Number(role?.fit) >= 80)
    .filter((role) => {
      const key = latestRoleKey(role);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, PANEL_ROW_LIMIT);
}

function dashboardFreshRoles(data, reviewRoles = []) {
  const latest = Array.isArray(data?.latestRoles) ? data.latestRoles : [];
  const sourced = Array.isArray(data?.sourcedRoles) ? data.sourcedRoles : [];
  const reviewKeys = new Set(reviewRoles.map(roleDedupKey));
  const seen = new Set();

  return [...latest, ...sourced]
    .filter((role) => !reviewKeys.has(roleDedupKey(role)))
    .filter((role) => {
      const key = roleDedupKey(role);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, PANEL_ROW_LIMIT);
}

function dashboardTodayEvents(data) {
  const calendar = data?.calendar || {};
  const todayEvents = Array.isArray(calendar.today?.events) ? calendar.today.events : [];
  const upcomingEvents = Array.isArray(calendar.upcoming?.events) ? calendar.upcoming.events : [];
  const todayIso =
    calendar.todayIso ||
    calendar.today?.iso ||
    todayEvents.find((event) => event?.iso)?.iso ||
    new Date().toISOString().slice(0, 10);
  const rows = todayEvents.length
    ? todayEvents
    : upcomingEvents.filter((event) => event?.iso === todayIso);

  return rows.filter(isTimedCalendarReminder).slice(0, PANEL_ROW_LIMIT);
}

function dashboardPipeline(data) {
  const rail = data?.jobs?.rail || {};
  const visibleCount = Number(data?.jobs?.visibleCount || data?.stats?.inPlay || 0);
  const items = [
    { key: "manualReview", label: "To decide", value: rail.manualReview },
    { key: "screenPlus", label: "Interviewing", value: rail.screenPlus },
    { key: "fresh", label: "New roles", value: rail.fresh },
    { key: "active", label: "Active", value: visibleCount },
  ].map((item) => ({ ...item, value: Number(item.value) || 0 }));
  const max = Math.max(1, ...items.map((item) => item.value));
  return items.map((item) => ({ ...item, width: Math.max(6, (item.value / max) * 100) }));
}

function highFitRoleCount(data, roles = []) {
  const railHighFit = Number(data?.jobs?.rail?.highFit);
  if (Number.isFinite(railHighFit)) return railHighFit;
  return roles.length;
}

function decisionRoleCount(data, roles = []) {
  const railManualReview = Number(data?.jobs?.rail?.manualReview);
  if (Number.isFinite(railManualReview)) return railManualReview;
  return roles.length;
}

function duePillLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^(due|by)\b/i.test(text) || /\boverdue\b/i.test(text)) return text;
  return `Due by ${text}`;
}

function isTimedCalendarReminder(event) {
  const text = [event?.kind, event?.label, event?.title].filter(Boolean).join(" ").toLowerCase();
  const isLiveEvent =
    /\b(interview|screen|call|meeting|onsite|technical|hiring manager|recruiter)\b/.test(text);
  return Boolean(isLiveEvent);
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return "0";
  return Intl.NumberFormat("en-US").format(Number(value));
}

function fitLabel(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  if (numeric > 5) return `${Math.round(numeric)}`;
  return numeric.toFixed(2);
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

function calendarEventKey(event) {
  return [event.id, event.detailId, event.iso, event.time, event.title, event.kind]
    .filter(Boolean)
    .join("::");
}

function latestRoleKey(role) {
  return [role.detailId, role.company, role.role, role.fit, role.status].filter(Boolean).join("::");
}

function roleDedupKey(role) {
  const companyRole = [role?.company, role?.role].filter(Boolean).join("::");
  return (companyRole || role?.detailId || "").toLowerCase();
}
