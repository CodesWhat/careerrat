// Honest outcome for a configured-source scan. A run can finish with most of
// its sources failing and still be "completed" (partial results are kept), so
// this reports how much of the scan actually worked.

// Share of readable sources that failed. At or above DEGRADED the run is
// "degraded"; at or above FAILED (or when nothing could be read) it is "failed".
export const SEARCH_HEALTH_DEGRADED_SHARE = 0.1;
export const SEARCH_HEALTH_FAILED_SHARE = 0.5;

// Sources a terminal run can't read because they need a browser. These are
// skipped on purpose, so they are counted apart from real errors.
export const SEARCH_SKIP_BROWSER_REASON =
  "Skipped: this source needs a browser, and terminal searches don't use one.";

const MAX_REASON_LENGTH = 120;
const MAX_REASON_GROUPS = 10;

function reasonText(error) {
  const raw = typeof error === "string" ? error : error?.error || error?.message || "";
  const text = String(raw)
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return (text || "unknown error").slice(0, MAX_REASON_LENGTH);
}

function groupReasons(reasons) {
  const counts = new Map();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_REASON_GROUPS)
    .map(([reason, count]) => ({ reason, count }));
}

export function summarizeSearchHealth(summary = {}) {
  const errors = Array.isArray(summary?.errors) ? summary.errors : [];
  const skippedErrors = errors.filter((entry) => entry?.skipped === true);
  const failedErrors = errors.filter((entry) => entry?.skipped !== true);
  const attempted = Math.max(0, Number(summary?.attemptedSources ?? summary?.attempted) || 0);
  const skipped = skippedErrors.length;
  const failed = failedErrors.length;
  const readable = Math.max(attempted - skipped, failed);
  const failedShare = readable > 0 ? Math.min(1, failed / readable) : 0;
  const nothingRead = readable === 0 ? skipped > 0 : failed >= readable;

  let status = "ok";
  if (nothingRead || failedShare >= SEARCH_HEALTH_FAILED_SHARE) status = "failed";
  else if (failedShare >= SEARCH_HEALTH_DEGRADED_SHARE) status = "degraded";

  const skippedNote = skipped ? `, ${skipped} skipped (need a browser)` : "";
  let message;
  if (readable === 0 && skipped === 0) message = "No sources were scanned";
  else if (readable === 0) message = `No source could be read${skippedNote}`;
  else if (failed === 0) message = `All ${readable} sources read${skippedNote}`;
  else message = `${failed} of ${readable} sources failed${skippedNote}`;

  return {
    status,
    message,
    attempted,
    readable,
    failed,
    skipped,
    failedShare: Math.round(failedShare * 1000) / 1000,
    errorReasons: groupReasons(failedErrors.map(reasonText)),
    skippedReasons: groupReasons(skippedErrors.map(reasonText)),
  };
}

// A saved run may predate the health field, so fall back to computing it.
export function searchRunHealth(run) {
  if (!run?.summary || typeof run.summary !== "object") return null;
  return run.summary.health || summarizeSearchHealth(run.summary);
}
