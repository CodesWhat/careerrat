import { KeyIcon } from "../components/icons.jsx";

// JobFunnel — the bucket funnel bar chart (buildJobsFunnel,
// dashboard-data.js:4260-4281). The round-depth Sankey is rendered separately
// from the same server-derived jobs payload.
export function JobFunnel({ funnel }) {
  if (!funnel?.length) return null;
  const max = Math.max(...funnel.map((f) => f.count || 0), 1);
  return (
    <div className="job-funnel">
      {funnel.map((f) => (
        <div className="job-funnel__row" key={f.id}>
          <span className="job-funnel__label">
            {f.icon ? <KeyIcon iconKey={f.icon} /> : null}
            {f.label}
          </span>
          <span className="job-funnel__bar-track">
            <span
              className="job-funnel__bar"
              style={{ width: `${Math.max(4, (f.count / max) * 100)}%`, background: f.color }}
            />
          </span>
          <span className="job-funnel__count">{f.count}</span>
        </div>
      ))}
    </div>
  );
}
