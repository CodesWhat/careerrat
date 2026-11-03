// Honest outcome rates for the CLI and TUI. Career Ops calibrate.mjs (MIT) idea:
// only resolved outcomes count, in-flight applications stay out of the denominator,
// and nothing prints as a percentage until the sample is big enough to mean something.
import {
  classifyStage,
  deepestRoundStage,
  isActive,
  isAdvanced,
  isApplied,
} from "./dashboard-data.js";

const OUTCOME_SAMPLE_FLOOR = 5;

const BANDS = [
  { id: "high", label: "High fit (80+)" },
  { id: "medium", label: "Medium fit (65-79)" },
  { id: "stretch", label: "Stretch (under 65)" },
  { id: "unscored", label: "Not scored" },
];

function bandFor(app) {
  const raw = app?.fitScore;
  if (raw === null || raw === undefined || raw === "") return "unscored";
  const fit = Number(raw);
  if (!Number.isFinite(fit)) return "unscored";
  if (fit >= 80) return "high";
  if (fit >= 65) return "medium";
  return "stretch";
}

// One of: advanced (the employer engaged: screen or deeper, live or not), rejected
// (turned down before any engagement), in-flight (applied, no answer yet), or
// excluded (never applied, or the candidate pulled out before the employer engaged).
export function classifyOutcome(app) {
  const stage = classifyStage(app?.status);
  if (isAdvanced(app || {})) return "advanced";
  if (stage === "rejected") return deepestRoundStage(app) ? "advanced" : "rejected";
  if (stage === "withdrawn") return deepestRoundStage(app) ? "advanced" : "excluded";
  if (isActive(app || {}) && isApplied(app || {})) return "in-flight";
  return "excluded";
}

function summarize(counts, floor) {
  const resolved = counts.advanced + counts.rejected;
  const pct = resolved >= floor ? Math.round((counts.advanced / resolved) * 100) : null;
  return {
    ...counts,
    resolved,
    pct,
    display: pct === null ? `n/a (${resolved} of ${floor} outcomes needed)` : `${pct}%`,
  };
}

const empty = () => ({ advanced: 0, rejected: 0, inFlight: 0, excluded: 0 });

export function buildOutcomeRates(applications = [], { floor = OUTCOME_SAMPLE_FLOOR } = {}) {
  const overall = empty();
  const byBand = new Map(BANDS.map((band) => [band.id, empty()]));
  for (const app of Array.isArray(applications) ? applications : []) {
    const outcome = classifyOutcome(app);
    const key = outcome === "in-flight" ? "inFlight" : outcome;
    overall[key] += 1;
    if (outcome !== "excluded") byBand.get(bandFor(app))[key] += 1;
  }
  return {
    floor,
    overall: summarize(overall, floor),
    bands: BANDS.map((band) => ({
      id: band.id,
      label: band.label,
      ...summarize(byBand.get(band.id), floor),
    })).filter((band) => band.advanced + band.rejected + band.inFlight > 0),
  };
}

export function formatOutcomeRates(rates) {
  const o = rates.overall;
  const lines = [
    `Advance rate: ${o.display} (${o.advanced} advanced, ${o.rejected} rejected without a conversation)`,
    `  Still waiting: ${o.inFlight} (not counted)`,
    "By fit score band:",
  ];
  if (!rates.bands.length) lines.push("  No applications yet.");
  for (const b of rates.bands) {
    lines.push(
      `  ${b.label}: ${b.display}, ${b.advanced} advanced, ${b.rejected} rejected, ${b.inFlight} waiting`
    );
  }
  return lines.join("\n");
}
