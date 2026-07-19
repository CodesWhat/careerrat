import { Link } from "react-router-dom";
import { Card } from "../components/Card.jsx";
import { CheckCircleIcon, ClockIcon } from "../components/icons.jsx";

const READINESS_ROWS = [
  { key: "search_ready", label: "Search", to: "/onboarding" },
  { key: "gate_ready", label: "Gate", to: "/onboarding" },
  { key: "apply_ready", label: "Apply", to: "/onboarding" },
  { key: "deep_ingest_complete", label: "Deep ingest", to: "/deep-ingest" },
];

const FIRST_SEARCH = {
  not_started: {
    label: "Not started",
    color: "var(--mustard)",
    detail: "No search run yet",
  },
  running: {
    label: "Running",
    color: "var(--mustard)",
    detail: "Searching deterministic public sources...",
  },
  completed: {
    label: "Completed",
    color: "var(--teal)",
    detail: "Search completed.",
  },
  failed: {
    label: "Failed",
    color: "var(--m-error)",
    detail: "First search failed. Retry from onboarding.",
  },
};

const iconStyle = {
  flex: "0 0 auto",
  fontSize: 16,
  marginTop: 1,
};

function compactMissing(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function missingHint(values) {
  const missing = compactMissing(values);
  if (!missing.length) return "Needs setup details.";
  const shown = missing.slice(0, 2).join(", ");
  const suffix = missing.length > 2 ? `, +${missing.length - 2} more` : "";
  return `Needs ${shown}${suffix}.`;
}

function isComplete(setup) {
  const readiness = setup?.readiness || {};
  return READINESS_ROWS.every((row) => readiness[row.key] === true);
}

function unwrapRun(value) {
  if (!value || typeof value !== "object") return null;
  if (value.run && typeof value.run === "object") return value.run;
  return value;
}

function firstSearchContext(setup, firstSearchRun) {
  const run =
    unwrapRun(firstSearchRun) ||
    unwrapRun(setup?.firstSearchRun) ||
    unwrapRun(setup?.sourcing?.firstSearchRun);
  if (!run) return null;
  const status = FIRST_SEARCH[run.status] ? run.status : "not_started";
  const summary = run.summary || {};
  const sourcesAttempted = Number(summary.sourcesAttempted ?? summary.attemptedSources ?? 0);
  const rolesFound = Number(summary.rolesFound ?? summary.new ?? summary.offerCount ?? 0);
  const counts =
    status === "completed" && Number.isFinite(sourcesAttempted) && Number.isFinite(rolesFound)
      ? ` ${sourcesAttempted} sources attempted, ${rolesFound} roles found.`
      : "";
  return {
    ...FIRST_SEARCH[status],
    counts,
  };
}

export function SetupReadinessCard({ setup, firstSearchRun }) {
  if (!setup || isComplete(setup)) return null;

  const readiness = setup.readiness || {};
  const missing = setup.missing || {};
  const searchReady = readiness.search_ready === true;
  const firstSearch = firstSearchContext(setup, firstSearchRun);

  return (
    <Card
      title="Setup readiness"
      actions={
        <Link className="btn btn--secondary" to="/onboarding">
          Finish setup
        </Link>
      }
    >
      <p className="field__hint" style={{ margin: 0 }}>
        {searchReady
          ? "Searching now — finish setup to unlock gating and applying."
          : "Finish Search to start searching; Gate and Apply unlock as setup fills in."}
      </p>
      <div className="chip-row">
        {READINESS_ROWS.map((row) => {
          const ready = readiness[row.key] === true;
          const Icon = ready ? CheckCircleIcon : ClockIcon;
          const color = ready ? "var(--teal)" : "var(--mustard)";
          return (
            <Link
              className="chip chip--readiness"
              key={row.key}
              to={row.to}
              style={{ color, textDecoration: "none" }}
            >
              <Icon style={iconStyle} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block" }}>{row.label}</span>
                <span className="field__hint" style={{ color, display: "block", marginTop: 3 }}>
                  {ready ? "Ready" : missingHint(missing[row.key])}
                </span>
              </span>
            </Link>
          );
        })}
        {firstSearch ? (
          <div className="chip chip--readiness" style={{ color: firstSearch.color }}>
            <ClockIcon style={iconStyle} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block" }}>First search</span>
              <span
                className="field__hint"
                style={{ color: firstSearch.color, display: "block", marginTop: 3 }}
              >
                {firstSearch.label}
              </span>
              <span
                className="field__hint"
                style={{ color: firstSearch.color, display: "block", marginTop: 3 }}
              >
                {firstSearch.detail}
                {firstSearch.counts}
              </span>
            </span>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
