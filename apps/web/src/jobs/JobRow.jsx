import { CompanyAvatar } from "../components/CompanyAvatar.jsx";

// JobRow — one glanceable row per application/sourced role (the repo's
// standing "no giant tables" rule: a jobs LIST + a drawer for drill-in, never
// a dense spreadsheet-style table). Every field here reads directly off the
// server-derived row (dashboard-data.js's buildJobs() output) — no
// client-side re-derivation of stage/fit/action.
function stageTone(row) {
  if (row.terminal) return "badge--muted";
  if (row.stage === "offer" || row.stage === "accepted") return "badge--ok";
  if (row.source === "sourced") return "badge--muted";
  return "badge--warn";
}

export function JobRow({ row, onOpen }) {
  return (
    <button type="button" className="job-row" onClick={() => onOpen(row.id)}>
      <CompanyAvatar name={row.company} domain={row.domain} />
      <span className="job-row__main">
        <span className="job-row__title">
          <span className="job-row__company">{row.company}</span>
          <span className="job-row__role">{row.role}</span>
        </span>
        <span className="job-row__meta">
          {row.location ? <span>{row.location}</span> : null}
          {row.comp ? <span>{row.comp}</span> : null}
        </span>
      </span>
      <span className={`badge ${stageTone(row)} job-row__stage`}>{row.stageLabel}</span>
      <span className="job-row__fit">{Number.isFinite(row.fit) ? `Fit ${row.fit}` : ""}</span>
      <span className="job-row__date">{row.action?.dueText || row.appliedLabel || ""}</span>
      <span className="job-row__action">{row.action?.cta || "Open details"}</span>
    </button>
  );
}
