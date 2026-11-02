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

// Sources that can't run in a terminal search (browser-only, or login-backed
// with no session). They are left out of the attempted set before the run, so
// they never count toward the failed share.
export const SEARCH_NOT_SEARCHABLE_BROWSER_REASON =
  "Needs the browser, which terminal searches don't use.";
export const SEARCH_NOT_SEARCHABLE_LOGIN_REASON =
  "Needs a logged-in session, which terminal searches don't have.";

const MAX_REASON_LENGTH = 120;
const MAX_REASON_GROUPS = 10;

function reasonText(error) {
  const raw =
    typeof error === "string" ? error : error?.error || error?.warning || error?.message || "";
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
  const notSearchable = Array.isArray(summary?.notSearchable?.sources)
    ? summary.notSearchable.sources.length
    : Math.max(0, Number(summary?.notSearchable?.count) || 0);
  const warnings = Array.isArray(summary?.warnings) ? summary.warnings : [];
  const attempted = Math.max(0, Number(summary?.attemptedSources ?? summary?.attempted) || 0);
  const skipped = skippedErrors.length;
  const failed = failedErrors.length;
  const readable = Math.max(attempted - skipped, failed);
  const failedShare = readable > 0 ? Math.min(1, failed / readable) : 0;
  const nothingRead = readable === 0 ? skipped > 0 || notSearchable > 0 : failed >= readable;

  let status = "ok";
  if (nothingRead || failedShare >= SEARCH_HEALTH_FAILED_SHARE) status = "failed";
  else if (failedShare >= SEARCH_HEALTH_DEGRADED_SHARE) status = "degraded";
  // A source that answered but came back short (truncated, partial pages,
  // ignored settings) is not a clean read.
  else if (warnings.length > 0) status = "degraded";

  const skippedNote = skipped ? `, ${skipped} skipped (need a browser)` : "";
  let message;
  if (readable === 0 && skipped === 0 && notSearchable > 0) {
    message = `None of the ${notSearchable} sources can be searched from the terminal, so nothing was searched`;
  } else if (readable === 0 && skipped === 0) message = "No sources were scanned";
  else if (readable === 0) message = `No source could be read${skippedNote}`;
  else if (failed === 0 && warnings.length === 0) {
    message = `All ${readable} sources read${skippedNote}`;
  } else if (failed === 0) {
    message = `${readable} sources read, but ${warnings.length} came back incomplete${skippedNote}`;
  } else message = `${failed} of ${readable} sources failed${skippedNote}`;

  return {
    status,
    message,
    attempted,
    readable,
    failed,
    skipped,
    notSearchable,
    warningCount: warnings.length,
    warningReasons: groupReasons(warnings.map(reasonText)),
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
