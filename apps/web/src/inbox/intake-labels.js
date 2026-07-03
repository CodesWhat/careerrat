// apps/web/src/inbox/intake-labels.js — human labels for the M9 kind/status
// enums (config/intake-classify.schema.json / migration 002's CHECK
// constraint). Split out of the now-deleted inbox/dispatch-summary.js (M10):
// that file's OWN dispatch-sentence formatter was a hand-maintained mirror of
// the server's summarizeDispatch() and is gone now that every intake API
// response carries a real `dispatchSummary` string (src/core/intake/
// dispatch-summary.mjs, consumed straight off `item.dispatchSummary`) — but
// these two label lookups aren't dispatch-summary formatting at all, just
// enum→label maps, so they move here rather than disappearing.
export const KIND_LABELS = {
  "jd-text": "Job posting (pasted text)",
  "job-url": "Job posting (URL)",
  "recruiter-email": "Recruiter email",
  "interview-transcript": "Interview notes",
  "status-update": "Status update",
  other: "Uncategorized",
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || "Unclassified";
}

export const STATUS_LABELS = {
  captured: "Captured",
  classifying: "Classifying…",
  proposed: "Ready to confirm",
  needs_you: "Needs you",
  confirmed: "Confirmed",
  running: "Running…",
  done: "Done",
  error: "Error",
  dismissed: "Dismissed",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}
