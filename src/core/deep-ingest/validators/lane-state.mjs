const REQUIRED_LANES = new Set([
  "source_coverage",
  "evidence_claims",
  "story_bank",
  "honesty_boundaries",
  "writing_voice",
  "role_signals",
  "open_gaps",
]);

const LANE_STATUSES = new Set([
  "not_started",
  "needs_source",
  "scanning",
  "review_needed",
  "gap",
  "completed",
  "deferred",
  "not_available",
  "failed",
]);

const REASON_REQUIRED = new Set(["gap", "deferred", "not_available", "failed"]);
const TERMINAL = new Set(["completed", "deferred", "not_available"]);

export function validateDeepIngestLaneTransition({ lane, status, reason } = {}) {
  const normalizedLane = String(lane || "").trim();
  const normalizedStatus = String(status || "").trim();
  const normalizedReason = String(reason || "").trim();

  if (!REQUIRED_LANES.has(normalizedLane)) {
    return { ok: false, error: `unsupported Deep ingest lane "${normalizedLane || "(missing)"}"` };
  }
  if (!LANE_STATUSES.has(normalizedStatus)) {
    return {
      ok: false,
      error: `unsupported Deep ingest lane status "${normalizedStatus || "(missing)"}"`,
    };
  }
  if (REASON_REQUIRED.has(normalizedStatus) && !normalizedReason) {
    return { ok: false, error: `Deep ingest lane status "${normalizedStatus}" requires reason` };
  }

  return {
    ok: true,
    lane: normalizedLane,
    status: normalizedStatus,
    reason: normalizedReason || null,
    terminal: TERMINAL.has(normalizedStatus),
  };
}
