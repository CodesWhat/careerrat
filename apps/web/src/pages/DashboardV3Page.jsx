import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { formatV3Count, getV3Data } from "../v3/v3MockData.js";

export function DashboardV3Page() {
  const { data, loading, error, noDatabase } = useDashboardSnapshot();
  const hasDashboardV3 = Boolean(data?.v3?.dashboard);
  const v3 = getV3Data(hasDashboardV3 ? data : null);
  const dashboard = v3.dashboard || {};
  const preview = !hasDashboardV3;

  return (
    <main className="v3-page">
      <header className="v3-hero">
        <div className="v3-title-block">
          <span className="v3-eyebrow">Dashboard V3{preview ? " · Preview Data" : ""}</span>
          <h1 className="v3-title">Dashboard V3</h1>
        </div>
        <DashboardMetrics metrics={dashboard.metrics} />
      </header>

      {noDatabase ? (
        <div className="v3-empty">
          No database workspace detected. Preview data is shown until a Rolester workspace is ready.
        </div>
      ) : null}
      {error ? <div className="v3-empty">{error}</div> : null}
      {loading ? <div className="v3-empty">Loading dashboard...</div> : null}

      <section className="v3-grid" aria-label="Dashboard V3 command center">
        <NeedsYouPanel needs={dashboard.needs} />
        <TodayPanel items={dashboard.today} />
      </section>

      <section className="v3-grid" aria-label="Dashboard V3 lower panels">
        <RecentActivityPanel activity={dashboard.activity} />
        <PipelineSnapshotPanel pipeline={dashboard.pipeline} />
      </section>
    </main>
  );
}

function DashboardMetrics({ metrics }) {
  const rows = asArray(metrics);

  return (
    <section className="v3-metrics" aria-label="Dashboard V3 metrics">
      {rows.length ? (
        rows.map((metric) => (
          <div className="v3-metric" data-tone={metric.tone} key={metricKey(metric)}>
            <strong data-dashboard-v3-stat={slugify(metric.label)}>
              {formatV3Count(metric.value)}
            </strong>
            <span>{metric.label}</span>
          </div>
        ))
      ) : (
        <div className="v3-empty">No metrics yet.</div>
      )}
    </section>
  );
}

function NeedsYouPanel({ needs }) {
  const rows = asArray(needs);

  return (
    <article className="v3-panel">
      <PanelHeader meta={formatV3Count(rows.length)} title="Needs You" />
      <div className="v3-row-list">
        {rows.length ? (
          rows.map((need) => (
            <div className="v3-row" key={need.id || need.title}>
              <div className="v3-row-main">
                <span className="v3-row-kicker">{need.type}</span>
                <strong>{need.title}</strong>
                {need.meta ? <small>{need.meta}</small> : null}
              </div>
              <div className="v3-row-actions">
                {need.due ? (
                  <span className="v3-chip" data-tone={normalizeTone(need.tone)}>
                    {need.due}
                  </span>
                ) : null}
                {need.action ? (
                  <button className="v3-button v3-button--primary" type="button">
                    {need.action}
                  </button>
                ) : null}
              </div>
            </div>
          ))
        ) : (
          <div className="v3-empty">No priority actions waiting.</div>
        )}
      </div>
    </article>
  );
}

function TodayPanel({ items }) {
  const rows = asArray(items);

  return (
    <article className="v3-panel">
      <PanelHeader meta={formatV3Count(rows.length)} title="Today" />
      <div className="v3-row-list">
        {rows.length ? (
          rows.map((item) => (
            <div className="v3-row" key={`${item.time || "today"}-${item.title}`}>
              <div className="v3-row-main">
                <span className="v3-row-kicker">{item.type}</span>
                <strong>{item.title}</strong>
              </div>
              <div className="v3-row-actions">
                {item.time ? <span className="v3-row-meta">{item.time}</span> : null}
                {item.action ? (
                  <button className="v3-button" type="button">
                    {item.action}
                  </button>
                ) : null}
              </div>
            </div>
          ))
        ) : (
          <div className="v3-empty">No tracked items due today.</div>
        )}
      </div>
    </article>
  );
}

function RecentActivityPanel({ activity }) {
  const rows = asArray(activity);

  return (
    <article className="v3-panel">
      <PanelHeader meta={formatV3Count(rows.length)} title="Recent Activity" />
      <div className="v3-row-list">
        {rows.length ? (
          rows.map((item) => (
            <div className="v3-row" key={`${item.time || "activity"}-${item.event}`}>
              <div className="v3-row-main">
                <span className="v3-row-kicker">{item.source}</span>
                <strong>{item.event}</strong>
              </div>
              {item.time ? <span className="v3-row-meta">{item.time}</span> : null}
            </div>
          ))
        ) : (
          <div className="v3-empty">No recent activity yet.</div>
        )}
      </div>
    </article>
  );
}

function PipelineSnapshotPanel({ pipeline }) {
  const rows = asArray(pipeline);

  return (
    <article className="v3-panel">
      <PanelHeader
        meta={formatV3Count(rows.reduce((sum, row) => sum + safeNumber(row.value), 0))}
        title="Pipeline Snapshot"
      />
      <div className="v3-panel-body">
        {rows.length ? (
          <div className="v3-meter-list">
            {rows.map((stage) => {
              const value = safeNumber(stage.value);
              const max = Math.max(safeNumber(stage.max), value, 1);
              const width = `${Math.round((value / max) * 100)}%`;

              return (
                <div className="v3-meter-row" key={stage.label}>
                  <span>{stage.label}</span>
                  <div
                    aria-label={`${stage.label}: ${formatV3Count(value)}`}
                    aria-valuemax={max}
                    aria-valuemin={0}
                    aria-valuenow={value}
                    className="v3-meter"
                    role="progressbar"
                  >
                    <i style={{ width }} />
                  </div>
                  <span>{formatV3Count(value)}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="v3-empty">No pipeline data yet.</div>
        )}
      </div>
    </article>
  );
}

function PanelHeader({ meta, title }) {
  return (
    <header className="v3-panel-header">
      <h2>{title}</h2>
      {meta ? <span className="v3-panel-meta">{meta}</span> : null}
    </header>
  );
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
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

function normalizeTone(tone) {
  if (tone === "warning") return "gold";
  return tone;
}
