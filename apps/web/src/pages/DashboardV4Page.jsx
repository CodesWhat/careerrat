import { useState } from "react";
import { Link } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { formatV4Count, getV4Data } from "../v4/v4MockData.js";

const DATABASE_ALERT =
  "No database workspace detected — run `rolester data import` (or `rolester data init`) first, then reload.";

const VALID_TONES = new Set(["danger", "warning", "teal", "muted", "sky", "gold"]);
const SKELETON_KEYS = ["one", "two", "three", "four"];

export function DashboardV4Page() {
  const { data, loading, error, noDatabase } = useDashboardSnapshot();

  if (noDatabase) {
    return (
      <main className="v4-page">
        <InlineAlert message={DATABASE_ALERT} />
      </main>
    );
  }

  if (loading && !data) {
    return (
      <main className="v4-page">
        <DashboardV4Skeleton />
      </main>
    );
  }

  const v4 = getV4Data(data);

  return (
    <main className="v4-page">
      <header className="v4-header">
        <div className="v4-title-block">
          <h1 className="v4-title">Today</h1>
          <p className="v4-subline">
            <TextWithMonoNumbers text={v4.header?.dateLabel || "Today"} />
            <span aria-hidden="true"> · </span>
            <TextWithMonoNumbers text={`${formatV4Count(v4.header?.overdueCount || 0)} overdue`} />
          </p>
        </div>
        <DashboardMetrics metrics={v4.metrics} />
      </header>

      {error ? <InlineAlert message={error} /> : null}

      <section className="v4-focus-grid" aria-label="Dashboard V4 priority work">
        <FocusPanel focus={v4.focus} />
        <NeedsPanel focusId={v4.focus?.id} needs={v4.needs} overflow={v4.needsOverflow} />
      </section>

      <AgentTaskStrip task={v4.agentTask} />

      <section className="v4-schedule-grid" aria-label="Dashboard V4 schedule and activity">
        <SchedulePanel schedule={v4.schedule} />
        <ActivityPanel activity={v4.activity} />
      </section>

      <PipelinePanel pipeline={v4.pipeline} />
    </main>
  );
}

function DashboardMetrics({ metrics }) {
  const rows = asArray(metrics).slice(0, 4);

  return (
    <section className="v4-metrics" aria-label="Dashboard V4 metrics">
      {rows.length ? (
        rows.map((metric) => (
          <Link
            className="v4-metric"
            data-tone={normalizeTone(metric.tone)}
            key={metric.key || metricKey(metric)}
            to={realRoute(metric.to, "/jobs")}
          >
            <strong data-dashboard-v4-stat={metric.key || slugify(metric.label)}>
              {formatV4Count(metric.value)}
            </strong>
            <span>{metric.label}</span>
          </Link>
        ))
      ) : (
        <EmptyState
          body="Metric tiles count urgent queues, active interviews, waiting applications, and new high-fit roles."
          cta={{ label: "Open jobs", to: "/jobs" }}
          title="No metrics yet"
        />
      )}
    </section>
  );
}

function FocusPanel({ focus }) {
  const [showReasons, setShowReasons] = useState(false);
  const [snoozed, setSnoozed] = useState(false);

  if (!focus || snoozed) {
    return (
      <article className="v4-panel v4-focus-panel" aria-label="Dashboard V4 focus">
        <PanelHeader meta="Clear" title="Focus" />
        <EmptyState
          body="The next dated interview, overdue follow-up, or decision that needs your input lands here."
          cta={{ label: "Run search-jobs", to: "/jobs" }}
          title="Nothing needs you"
        />
      </article>
    );
  }

  return (
    <article className="v4-panel v4-focus-panel" aria-label="Dashboard V4 focus">
      <div className="v4-focus-body">
        {focus.dueLabel ? (
          <span className="v4-chip" data-tone={normalizeTone(focus.dueTone)}>
            <TextWithMonoNumbers text={focus.dueLabel} />
          </span>
        ) : null}
        <div className="v4-focus-copy">
          <h2>{focus.title}</h2>
          <p>
            {focus.company}
            {focus.role ? " · " : ""}
            {focus.role}
          </p>
        </div>
        <div className="v4-basis">
          <p>
            <TextWithMonoNumbers
              text={focus.basis?.summary || "View model selected this as the top action."}
            />
          </p>
          {asArray(focus.basis?.reasons).length ? (
            <button
              className="v4-inline-button"
              onClick={() => setShowReasons((value) => !value)}
              type="button"
            >
              {showReasons ? "Hide" : "Why?"}
            </button>
          ) : null}
        </div>
        {showReasons ? (
          <ul className="v4-basis-reasons">
            {asArray(focus.basis?.reasons).map((reason) => (
              <li key={reason}>
                <TextWithMonoNumbers text={reason} />
              </li>
            ))}
          </ul>
        ) : null}
        <section className="v4-facts" aria-label="Focus facts">
          {asArray(focus.facts)
            .slice(0, 3)
            .map((fact) => (
              <span className="v4-fact" key={`${fact.label}-${fact.value}`}>
                <small>{fact.label}</small>
                <strong>
                  <TextWithMonoNumbers text={fact.value} />
                </strong>
              </span>
            ))}
        </section>
        <div className="v4-actions">
          <Link className="v4-button v4-button--primary" to={realRoute(focus.cta?.to, "/jobs")}>
            {focus.cta?.label || "Review"}
          </Link>
          {focus.secondary?.label ? (
            <button className="v4-button" onClick={() => setSnoozed(true)} type="button">
              {focus.secondary.label}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function NeedsPanel({ focusId, needs, overflow }) {
  const rows = asArray(needs)
    .filter((need) => need?.id !== focusId)
    .slice(0, 3);
  const overflowCount = Math.max(0, safeNumber(overflow));
  const totalCount = rows.length + overflowCount;

  return (
    <article className="v4-panel" aria-label="Dashboard V4 needs you">
      <PanelHeader meta={formatV4Count(totalCount)} title="Needs you" />
      <div className="v4-row-list">
        {rows.length ? (
          rows.map((need) => <NeedRow key={need.id || need.title} need={need} />)
        ) : (
          <EmptyState
            body="Decisions, follow-ups, and interview prep show up here after the focus item is removed."
            cta={{ label: "Open jobs", to: "/jobs?filter=needs-you" }}
            title="No queued actions"
          />
        )}
        {overflowCount > 0 ? (
          <Link className="v4-overflow-link" to="/jobs?filter=needs-you">
            <span className="v4-num">{formatV4Count(overflowCount)}</span> more
          </Link>
        ) : null}
      </div>
    </article>
  );
}

function NeedRow({ need }) {
  return (
    <div className="v4-row">
      <div className="v4-row-main">
        <span className="v4-row-kicker">{need.kicker}</span>
        <strong>
          <TextWithMonoNumbers text={need.title} />
        </strong>
        {need.meta ? (
          <small>
            <TextWithMonoNumbers text={need.meta} />
          </small>
        ) : null}
      </div>
      <div className="v4-row-actions">
        {need.due ? (
          <span className="v4-chip" data-tone={normalizeTone(need.tone)}>
            <TextWithMonoNumbers text={need.due} />
          </span>
        ) : null}
        {need.action ? (
          <Link className="v4-row-action" to={realRoute(need.action.to, "/jobs")}>
            {need.action.label || "Review"}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function AgentTaskStrip({ task }) {
  const [dismissed, setDismissed] = useState(false);
  const [status, setStatus] = useState("");

  if (!task || dismissed) return null;

  const riskCopy =
    task.risk === "write" ? "Drafts only — nothing sends." : "Reads only — no writes.";

  return (
    <section className="v4-agent" aria-label="Dashboard V4 next agent task">
      <div className="v4-agent-copy">
        <span className="v4-row-kicker">Next agent task</span>
        <h2>{task.title}</h2>
        <p>
          <TextWithMonoNumbers text={task.why} />
          {task.why ? " " : ""}
          {riskCopy}
        </p>
        {status ? (
          <p aria-live="polite" className="v4-agent-status">
            {status}
          </p>
        ) : null}
      </div>
      <div className="v4-agent-actions">
        <button
          className="v4-button v4-button--primary"
          onClick={() => setStatus(`${task.skill || "agent task"} queued for review.`)}
          type="button"
        >
          {task.cta?.label ||
            (task.risk === "write" ? `Preview ${task.skill}` : `Run ${task.skill}`)}
        </button>
        <button className="v4-button" onClick={() => setDismissed(true)} type="button">
          {task.dismiss?.label || "Not now"}
        </button>
      </div>
    </section>
  );
}

function SchedulePanel({ schedule }) {
  const overdue = asArray(schedule?.overdue);
  const today = asArray(schedule?.today);
  const hasRows = overdue.length || today.length;

  return (
    <article className="v4-panel" aria-label="Dashboard V4 schedule">
      <PanelHeader meta={formatV4Count(overdue.length + today.length)} title="Today" />
      <div className="v4-row-list">
        {hasRows ? (
          <>
            {overdue.length ? <ScheduleGroup label="Overdue" rows={overdue} /> : null}
            {today.length ? <ScheduleGroup label="Today" rows={today} /> : null}
          </>
        ) : (
          <EmptyState
            body="Overdue actions and today's dated interviews, follow-ups, and deadlines appear here."
            cta={{ label: "Open calendar", to: "/calendar" }}
            title="No dated work today"
          />
        )}
      </div>
    </article>
  );
}

function ScheduleGroup({ label, rows }) {
  return (
    <div className="v4-schedule-group">
      <h3>{label}</h3>
      {rows.map((item) => (
        <Link
          className="v4-schedule-row"
          key={item.id || `${item.time}-${item.title}`}
          to={realRoute(item.to, "/calendar")}
        >
          <span className="v4-time">
            <TextWithMonoNumbers text={item.time || "EOD"} />
          </span>
          <span className="v4-schedule-copy">
            <strong>
              <TextWithMonoNumbers text={item.title} />
            </strong>
            {item.meta ? (
              <small>
                <TextWithMonoNumbers text={item.meta} />
              </small>
            ) : null}
          </span>
        </Link>
      ))}
    </div>
  );
}

function ActivityPanel({ activity }) {
  const rows = asArray(activity).slice(0, 5);

  return (
    <article className="v4-panel" aria-label="Dashboard V4 agent activity">
      <PanelHeader
        action={{ label: "View all", to: "/inbox" }}
        meta={formatV4Count(rows.length)}
        title="Agent activity"
      />
      <div className="v4-row-list">
        {rows.length ? (
          rows.map((item) => (
            <Link
              className="v4-activity-row"
              key={item.id || `${item.relTime}-${item.summary}`}
              to={realRoute(item.to, "/inbox")}
            >
              <span className="v4-time">
                <TextWithMonoNumbers text={item.relTime} />
              </span>
              <span className="v4-activity-copy">
                <span className="v4-skill">{item.skill}</span>
                <strong>
                  <TextWithMonoNumbers text={item.summary} />
                </strong>
              </span>
            </Link>
          ))
        ) : (
          <EmptyState
            body="Agent receipts show what changed, when it changed, and which skill made the change."
            cta={{ label: "Open inbox", to: "/inbox" }}
            title="No recent activity"
          />
        )}
      </div>
    </article>
  );
}

function PipelinePanel({ pipeline }) {
  const stages = asArray(pipeline?.stages);
  const stale = asArray(pipeline?.stale);

  return (
    <section className="v4-panel v4-pipeline" aria-label="Dashboard V4 pipeline">
      <PanelHeader
        meta={formatV4Count(stages.reduce((sum, stage) => sum + safeNumber(stage.count), 0))}
        title="Pipeline"
      />
      <div className="v4-pipeline-body">
        {stages.length ? (
          <div className="v4-stage-strip">
            {stages.map((stage, index) => {
              const previous = stages[index - 1];
              return (
                <div className="v4-stage" key={stage.key || stage.label}>
                  <span className="v4-stage-label">{stage.label}</span>
                  <strong className="v4-stage-count">{formatV4Count(stage.count)}</strong>
                  <span className="v4-conversion">{conversionLabel(stage, previous)}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            body="Active application stages and stage-to-stage conversion appear here once jobs move through the funnel."
            cta={{ label: "Open jobs", to: "/jobs" }}
            title="No pipeline yet"
          />
        )}
        {stale.length ? (
          <section className="v4-stale-list" aria-label="Stale applications">
            {stale.map((item) => (
              <Link
                className="v4-stale-row"
                key={item.id || `${item.company}-${item.role}`}
                to="/jobs"
              >
                <span>
                  <strong>{item.company}</strong>
                  {item.role ? ` · ${item.role}` : ""}
                </span>
                <small>
                  <TextWithMonoNumbers text={`${item.days}d in ${item.stage} (${item.reason})`} />
                </small>
              </Link>
            ))}
          </section>
        ) : null}
      </div>
    </section>
  );
}

function DashboardV4Skeleton() {
  return (
    <section className="v4-skeleton" aria-label="Dashboard V4 pending state">
      <div className="v4-skeleton-header">
        <div className="v4-skeleton-line v4-skeleton-line--title" />
        <div className="v4-skeleton-line v4-skeleton-line--short" />
      </div>
      <div className="v4-focus-grid">
        <SkeletonPanel rows={2} />
        <SkeletonPanel rows={3} />
      </div>
      <SkeletonPanel rows={1} />
    </section>
  );
}

function SkeletonPanel({ rows }) {
  return (
    <div className="v4-panel v4-skeleton-panel">
      {SKELETON_KEYS.slice(0, rows).map((key) => (
        <div className="v4-skeleton-row" key={key}>
          <span className="v4-skeleton-avatar" />
          <span className="v4-skeleton-copy">
            <span className="v4-skeleton-line" />
            <span className="v4-skeleton-line v4-skeleton-line--short" />
          </span>
          <span className="v4-skeleton-chip" />
        </div>
      ))}
    </div>
  );
}

function PanelHeader({ action, meta, title }) {
  return (
    <header className="v4-panel-header">
      <h2>{title}</h2>
      <span className="v4-panel-tools">
        {meta ? <span className="v4-panel-meta">{meta}</span> : null}
        {action ? (
          <Link className="v4-panel-link" to={realRoute(action.to, "/jobs")}>
            {action.label}
          </Link>
        ) : null}
      </span>
    </header>
  );
}

function EmptyState({ body, cta, title }) {
  return (
    <div className="v4-empty">
      <strong>{title}</strong>
      <p>{body}</p>
      <Link className="v4-row-action" to={realRoute(cta?.to, "/jobs")}>
        {cta?.label || "Open jobs"}
      </Link>
    </div>
  );
}

function TextWithMonoNumbers({ text }) {
  const value = String(text ?? "");
  const parts = splitTextWithOffsets(value);

  return parts.map((part) =>
    part.numeric ? (
      <span className="v4-num" key={part.key}>
        {part.text}
      </span>
    ) : (
      part.text
    )
  );
}

function splitTextWithOffsets(value) {
  const pattern = /\d+(?:[.,:]\d+)*(?:%|x|d)?/g;
  const parts = [];
  let cursor = 0;

  for (const match of value.matchAll(pattern)) {
    if (match.index > cursor) {
      parts.push({
        key: `text-${cursor}`,
        numeric: false,
        text: value.slice(cursor, match.index),
      });
    }
    parts.push({
      key: `num-${match.index}`,
      numeric: true,
      text: match[0],
    });
    cursor = match.index + match[0].length;
  }

  if (cursor < value.length) {
    parts.push({
      key: `text-${cursor}`,
      numeric: false,
      text: value.slice(cursor),
    });
  }

  return parts;
}

function conversionLabel(stage, previous) {
  if (stage.conversionFromPrev == null) return "Entry stage";
  return `${formatV4Count(stage.conversionFromPrev)}% from ${previous?.label || "previous"}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeTone(tone) {
  return VALID_TONES.has(tone) ? tone : "muted";
}

function realRoute(to, fallback) {
  return typeof to === "string" && to.startsWith("/") ? to : fallback;
}

function slugify(value) {
  return String(value || "metric")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function metricKey(metric) {
  return `${metric.label || "metric"}-${metric.tone || "neutral"}`;
}
