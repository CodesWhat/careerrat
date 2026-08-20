// apps/web/src/lib/intake-labels.js — human labels for the M9 kind/status
// enums (config/intake-classify.schema.json / migration 002's CHECK
// constraint). Originally split out of the now-deleted inbox/dispatch-
// summary.js (M10), then moved here from inbox/ (Lane B) when /inbox and its
// page/card components were retired in favor of universal AskBar intake —
// these two label lookups are just enum→label maps, not page-shaped, so they
// live in lib/ alongside the rest of the shared client helpers rather than
// disappearing with the page that used to own them.
const KIND_LABELS = {
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
