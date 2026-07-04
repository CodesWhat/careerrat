import { Link } from "react-router-dom";
import { Card } from "../components/Card.jsx";
import { CheckCircleIcon, ClockIcon } from "../components/icons.jsx";

const READINESS_ROWS = [
  { key: "search_ready", label: "Search" },
  { key: "gate_ready", label: "Gate" },
  { key: "apply_ready", label: "Apply" },
  { key: "deep_ingest_complete", label: "Deep ingest" },
];

const chipStyle = {
  alignItems: "flex-start",
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  flex: "1 1 170px",
  padding: "9px 10px",
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

export function SetupReadinessCard({ setup }) {
  if (!setup || isComplete(setup)) return null;

  const readiness = setup.readiness || {};
  const missing = setup.missing || {};
  const searchReady = readiness.search_ready === true;

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
            <div
              className="chip"
              key={row.key}
              style={{
                ...chipStyle,
                color,
              }}
            >
              <Icon style={iconStyle} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block" }}>{row.label}</span>
                <span className="field__hint" style={{ color, display: "block", marginTop: 3 }}>
                  {ready ? "Ready" : missingHint(missing[row.key])}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
