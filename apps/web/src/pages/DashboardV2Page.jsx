import { Link } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { CompanyAvatar } from "../components/CompanyAvatar.jsx";
import {
  ArrowRightIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  ListIcon,
  SearchIcon,
} from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";

const PREVIEW_FOLLOW_UPS = [
  {
    id: "preview-icapital",
    company: "iCapital",
    role: "AI Operations Lead — VP/SVP",
    dateLabel: "applied 2026-06-05",
    domain: "icapital.com",
  },
  {
    id: "preview-langchain",
    company: "LangChain",
    role: "Deployed Engineer (NYC)",
    dateLabel: "applied 2026-06-15",
    domain: "langchain.com",
  },
  {
    id: "preview-parachute",
    company: "Parachute Health",
    role: "Staff Software Engineer, Applied AI",
    dateLabel: "applied 2026-06-15",
    domain: "parachutehealth.com",
  },
  {
    id: "preview-anthropic-1",
    company: "Anthropic",
    role: "Applied AI Architect, Enterprise Tech",
    dateLabel: "applied 2026-06-15",
    domain: "anthropic.com",
  },
  {
    id: "preview-anthropic-2",
    company: "Anthropic",
    role: "Manager of Applied AI Architecture",
    dateLabel: "applied 2026-06-15",
    domain: "anthropic.com",
  },
  {
    id: "preview-figma",
    company: "Figma",
    role: "Support AI Engineer",
    dateLabel: "applied 2026-06-15",
    domain: "figma.com",
  },
];

const PREVIEW_DECISIONS = [
  {
    id: "preview-ramp",
    company: "Ramp",
    role: "Applied AI Engineer, Fullstack",
    fit: "4.10/5",
    tone: "warn",
    domain: "ramp.com",
  },
  {
    id: "preview-finite-state",
    company: "Finite State",
    role: "AI Software Engineer",
    fit: "4.10/5",
    tone: "warn",
    domain: "finitestate.io",
  },
  {
    id: "preview-ro",
    company: "Ro",
    role: "Senior AI Engineer",
    fit: "4.55/5",
    tone: "good",
    domain: "ro.co",
  },
  {
    id: "preview-avalara",
    company: "Avalara",
    role: "Principal Automation Engineer",
    fit: "4.40/5",
    tone: "good",
    domain: "avalara.com",
  },
];

const PREVIEW_MATCHES = [
  {
    id: "preview-aledade",
    company: "Aledade",
    role: "Senior Software Engineer II",
    location: "Remote (US)",
    domain: "aledade.com",
    source: "ai-search",
  },
  {
    id: "preview-agiloft",
    company: "Agiloft",
    role: "Forward Deployed Engineer - AI",
    location: "Remote (US)",
    domain: "agiloft.com",
    source: "ai-search",
  },
  {
    id: "preview-bolt",
    company: "Bolt.new (StackBlitz)",
    role: "Senior Applied AI Engineer",
    location: "Remote",
    domain: "stackblitz.com",
    source: "ai-search",
  },
  {
    id: "preview-assetwatch",
    company: "AssetWatch",
    role: "Sr. Applied AI Engineer",
    location: "Remote (US)",
    domain: "assetwatch.com",
    source: "ai-search",
  },
  {
    id: "preview-homeward",
    company: "Homeward",
    role: "Applied AI Engineer",
    location: "Remote (US)",
    domain: "homewardhealth.com",
    source: "ai-search",
  },
  {
    id: "preview-human-agency",
    company: "Human Agency",
    role: "Applied AI Engineer",
    location: "Remote",
    domain: "humanagency.com",
    source: "ai-search",
  },
];

const PREVIEW_EVENTS = [
  {
    id: "preview-interview",
    title: "Juniper Square interview",
    dateLabel: "Today",
    time: "2:00 PM",
    label: "Interview",
  },
  {
    id: "preview-followup",
    title: "Send NICE thank-you",
    dateLabel: "Tomorrow",
    time: "9:00 AM",
    label: "Follow-up",
  },
];

export function DashboardV2Page() {
  const { data, loading, error, noDatabase } = useDashboardSnapshot();

  if (noDatabase) {
    return (
      <div className="dashboard-v2">
        <InlineAlert message="No database workspace detected — run `rolester data import` (or `rolester data init`) first, then reload." />
      </div>
    );
  }

  const followUps = normalizeFollowUps(data);
  const decisions = normalizeDecisions(data);
  const matches = normalizeMatches(data);
  const scheduled = normalizeScheduled(data);
  const usingPreview =
    !followUps.realCount && !decisions.realCount && !matches.realCount && !scheduled.realCount;

  return (
    <div className="dashboard-v2">
      <header className="dashboard-v2__masthead">
        <p className="dashboard-v2__date-line">Today · {formatTodayLabel()}</p>
        <h1 className="dashboard-v2__hero-title">What needs you today.</h1>
        <p className="dashboard-v2__hero-copy">
          Follow-ups, decisions, interviews, and fresh roles in one Rolester queue.
        </p>
        <div className="dashboard-v2__hero-actions">
          <Link className="dashboard-v2__primary-link" to="/jobs">
            Find roles <ArrowRightIcon />
          </Link>
          <Link className="dashboard-v2__secondary-link" to="/jobs">
            Open jobs
          </Link>
        </div>
        {usingPreview ? <span className="dashboard-v2__preview-pill">Mock data</span> : null}
      </header>

      {error ? <InlineAlert message={error} /> : null}
      {loading ? <p className="dashboard-home__loading">Loading…</p> : null}

      <section className="dashboard-v2__section dashboard-v2__section--queue">
        <SectionHeading icon={<ListIcon />} title="Start here" detail="Highest-priority action" />
        <div className="dashboard-v2__queue-card">
          <QueueHero item={followUps.items[0]} />
          <div className="dashboard-v2__queue-list">
            {followUps.items.slice(1, 5).map((item) => (
              <FollowUpRow key={item.id} item={item} compact />
            ))}
          </div>
        </div>
      </section>

      <section className="dashboard-v2__section">
        <SectionHeading icon={<ClockIcon />} title="Keep warm" detail="People waiting on a nudge" />
        <div className="dashboard-v2__followup-list">
          {followUps.items.map((item) => (
            <FollowUpRow key={item.id} item={item} />
          ))}
        </div>
      </section>

      <section className="dashboard-v2__section">
        <SectionHeading icon={<CheckIcon />} title="Decide" detail="Apply, skip, or park" />
        <div className="dashboard-v2__decision-grid">
          {decisions.items.map((item) => (
            <DecisionCard key={item.id} item={item} />
          ))}
        </div>
      </section>

      <section className="dashboard-v2__section">
        <SectionHeading icon={<SearchIcon />} title="Fresh finds" detail="Saved by your scans" />
        <div className="dashboard-v2__match-grid">
          {matches.items.map((item) => (
            <MatchCard key={item.id} item={item} />
          ))}
        </div>
      </section>

      <section className="dashboard-v2__section dashboard-v2__section--scheduled">
        <SectionHeading icon={<CalendarIcon />} title="On deck" detail="Interviews and deadlines" />
        <div className="dashboard-v2__scheduled-list">
          {scheduled.items.map((item) => (
            <ScheduledRow key={item.id} item={item} />
          ))}
        </div>
      </section>
    </div>
  );
}

function SectionHeading({ icon, title, detail }) {
  return (
    <header className="dashboard-v2__section-heading">
      <span className="dashboard-v2__section-icon">{icon}</span>
      <h2>{title}</h2>
      {detail ? <p>{detail}</p> : null}
    </header>
  );
}

function QueueHero({ item }) {
  if (!item) return null;
  return (
    <article className="dashboard-v2__queue-hero">
      <CompanyAvatar name={item.company} domain={item.domain} size={44} />
      <div>
        <span className="dashboard-v2__eyebrow">First up</span>
        <h3>{item.title || `${item.company} · ${item.role}`}</h3>
        <p>{item.supportingText || item.dateLabel || `${item.company} · ${item.role}`}</p>
      </div>
      <button className="dashboard-v2__row-button" type="button">
        Mark done
      </button>
    </article>
  );
}

function FollowUpRow({ item, compact = false }) {
  return (
    <article
      className={`dashboard-v2__followup-row${compact ? " dashboard-v2__followup-row--compact" : ""}`}
    >
      <CompanyAvatar name={item.company} domain={item.domain} size={34} />
      <div className="dashboard-v2__row-copy">
        <h3>
          {item.company} · <span>{item.role}</span>
        </h3>
        <p>{item.dateLabel || item.supportingText || "Follow-up due"}</p>
      </div>
      <div className="dashboard-v2__row-actions">
        <button className="dashboard-v2__row-button" type="button">
          <CheckIcon /> Done
        </button>
        <button className="dashboard-v2__text-button" type="button">
          Later
        </button>
      </div>
    </article>
  );
}

function DecisionCard({ item }) {
  return (
    <article className="dashboard-v2__decision-card">
      <div className="dashboard-v2__decision-head">
        <CompanyAvatar name={item.company} domain={item.domain} size={34} />
        <span className={`dashboard-v2__score dashboard-v2__score--${item.tone || "warn"}`}>
          {item.fit}
        </span>
      </div>
      <h3>{item.company}</h3>
      <p>{item.role}</p>
      <div className="dashboard-v2__decision-actions">
        <button className="dashboard-v2__mark-button" type="button">
          <CheckIcon /> Applied
        </button>
        <button className="dashboard-v2__skip-button" type="button">
          Skip
        </button>
      </div>
    </article>
  );
}

function MatchCard({ item }) {
  return (
    <article className="dashboard-v2__match-card">
      <div className="dashboard-v2__match-head">
        <CompanyAvatar name={item.company} domain={item.domain} size={34} />
        <Link className="dashboard-v2__external" to="/jobs" aria-label={`Open ${item.company}`}>
          <ArrowRightIcon />
        </Link>
      </div>
      <h3>{item.role}</h3>
      <p>
        {item.company} · {item.location || "Remote"}
      </p>
      <div className="dashboard-v2__match-meta">
        <span>{item.source || "ai-search"}</span>
        <span>{item.age || "1d ago"}</span>
      </div>
      <div className="dashboard-v2__match-actions">
        <button className="dashboard-v2__pipeline-button" type="button">
          <CheckIcon /> Save
        </button>
        <button className="dashboard-v2__evaluate-button" type="button">
          Evaluate
        </button>
      </div>
    </article>
  );
}

function ScheduledRow({ item }) {
  return (
    <article className="dashboard-v2__scheduled-row">
      <span className="dashboard-v2__scheduled-date">
        <strong>{item.dateLabel}</strong>
        {item.time ? <small>{item.time}</small> : null}
      </span>
      <div>
        <h3>{item.title}</h3>
        <p>{item.label || "Scheduled"}</p>
      </div>
    </article>
  );
}

function normalizeFollowUps(data) {
  const steps = Array.isArray(data?.allNextSteps)
    ? data.allNextSteps
    : Array.isArray(data?.nextSteps)
      ? data.nextSteps
      : [];
  const items = steps.slice(0, 8).map((step, index) => ({
    id: step.detailId || `step-${index}`,
    company: step.company || "Rolester",
    title: step.title || "",
    role: step.detail || step.title || "Next action",
    dateLabel: step.dueText || step.supportingText || "Due",
    supportingText: step.supportingText,
  }));
  return { items: items.length ? items : PREVIEW_FOLLOW_UPS, realCount: items.length };
}

function normalizeDecisions(data) {
  const rows = Array.isArray(data?.reviewHoldRoles) ? data.reviewHoldRoles : [];
  const items = rows.slice(0, 4).map((role, index) => ({
    id: role.detailId || role.id || `decision-${index}`,
    company: role.company || "Unknown company",
    role: role.role || "Open role",
    fit: formatFit(role.fit),
    tone: Number(role.fit) >= 4.3 || Number(role.fit) >= 86 ? "good" : "warn",
    domain: role.domain,
  }));
  return { items: items.length ? items : PREVIEW_DECISIONS, realCount: items.length };
}

function normalizeMatches(data) {
  const latest = Array.isArray(data?.latestRoles) ? data.latestRoles : [];
  const sourced = Array.isArray(data?.sourcedRoles) ? data.sourcedRoles : [];
  const source = latest.length ? latest : sourced;
  const items = source.slice(0, 6).map((role, index) => ({
    id: role.detailId || role.id || `match-${index}`,
    company: role.company || "Unknown company",
    role: role.role || "Open role",
    fit: role.fit,
    location: role.location,
    domain: role.domain,
    source: role.source || "ai-search",
    age: role.age || "new",
  }));
  return { items: items.length ? items : PREVIEW_MATCHES, realCount: items.length };
}

function normalizeScheduled(data) {
  const events = Array.isArray(data?.calendar?.upcoming?.events)
    ? data.calendar.upcoming.events
    : [];
  const items = events.slice(0, 4).map((event, index) => ({
    id: event.id || event.detailId || `scheduled-${index}`,
    title: event.title || "Scheduled item",
    dateLabel: formatDateShort(event.iso) || "Soon",
    time: event.time,
    label: event.label || calendarKindLabel(event.kind),
  }));
  return { items: items.length ? items : PREVIEW_EVENTS, realCount: items.length };
}

function formatFit(value) {
  if (!Number.isFinite(Number(value))) return "4.10/5";
  const numeric = Number(value);
  if (numeric > 5) return `${(numeric / 20).toFixed(2)}/5`;
  return `${numeric.toFixed(2)}/5`;
}

function formatTodayLabel() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function formatDateShort(iso) {
  if (!iso) return "";
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function calendarKindLabel(kind) {
  if (!kind) return "Scheduled";
  return String(kind)
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
