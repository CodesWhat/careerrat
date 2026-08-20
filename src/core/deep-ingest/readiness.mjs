export const DEFAULT_DEEP_INGEST_REQUIRED_LANES = Object.freeze([
  "source_coverage",
  "evidence_claims",
  "story_bank",
  "honesty_boundaries",
  "writing_voice",
  "role_signals",
  "open_gaps",
]);

export const DEEP_INGEST_TERMINAL_STATUSES = Object.freeze([
  "completed",
  "deferred",
  "not_available",
]);

const DEEP_INGEST_NONTERMINAL_STATUSES = Object.freeze([
  "not_started",
  "needs_source",
  "scanning",
  "review_needed",
  "gap",
  "failed",
]);

const KNOWN_STATUSES = new Set([
  ...DEEP_INGEST_TERMINAL_STATUSES,
  ...DEEP_INGEST_NONTERMINAL_STATUSES,
]);

const REASON_REQUIRED_TERMINAL_STATUSES = new Set(["deferred", "not_available"]);

const LANE_LABELS = {
  source_coverage: "Source coverage",
  evidence_claims: "Evidence claims",
  story_bank: "Story bank",
  honesty_boundaries: "Honesty boundaries",
  writing_voice: "Writing voice",
  role_signals: "Role signals",
  open_gaps: "Open gaps",
};

export function evaluateDeepIngestReadiness({
  laneStates = [],
  requiredLanes = DEFAULT_DEEP_INGEST_REQUIRED_LANES,
} = {}) {
  const required = normalizeRequiredLanes(requiredLanes);
  const stateByLane = normalizeLaneStateMap(laneStates);
  const lanes = required.map((lane) => normalizeLane(lane, stateByLane.get(lane)));
  const terminalCount = lanes.filter((lane) => lane.terminal).length;
  const requiredCount = lanes.length;
  const ready = requiredCount > 0 && terminalCount === requiredCount;

  return {
    ready,
    missing: ready ? [] : lanes.filter((lane) => !lane.terminal),
    todos: lanes.filter((lane) => lane.status === "deferred" && lane.terminal),
    gaps: lanes.filter((lane) => lane.status === "not_available" && lane.terminal),
    terminalCount,
    requiredCount,
    progressText: `${terminalCount} of ${requiredCount} lanes terminal`,
    lanes,
  };
}

function normalizeRequiredLanes(requiredLanes) {
  const seen = new Set();
  const lanes = [];
  for (const raw of Array.isArray(requiredLanes) ? requiredLanes : []) {
    const lane = String(raw?.lane || raw?.key || raw || "").trim();
    if (!lane || seen.has(lane)) continue;
    seen.add(lane);
    lanes.push(lane);
  }
  return lanes.length ? lanes : [...DEFAULT_DEEP_INGEST_REQUIRED_LANES];
}

function normalizeLaneStateMap(laneStates) {
  const rows = Array.isArray(laneStates)
    ? laneStates
    : laneStates && typeof laneStates === "object"
      ? Object.values(laneStates)
      : [];
  const map = new Map();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const lane = String(raw.lane || raw.key || raw.id || "").trim();
    if (!lane) continue;
    map.set(lane, raw);
  }
  return map;
}

function normalizeLane(lane, raw = {}) {
  const status = normalizeStatus(raw?.status);
  const reason = String(raw?.reason || "").trim();
  const reasonRequired = REASON_REQUIRED_TERMINAL_STATUSES.has(status) && !reason;
  const terminal =
    status === "completed" || (DEEP_INGEST_TERMINAL_STATUSES.includes(status) && !reasonRequired);

  return {
    ...raw,
    key: lane,
    lane,
    label: LANE_LABELS[lane] || humanize(lane),
    status,
    reason: reason || null,
    terminal,
    reasonRequired,
  };
}

function normalizeStatus(value) {
  const status = String(value || "not_started").trim();
  return KNOWN_STATUSES.has(status) ? status : "not_started";
}

function humanize(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}
