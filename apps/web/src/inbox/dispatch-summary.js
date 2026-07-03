// apps/web/src/inbox/dispatch-summary.js — mirrors src/cli/intake-route.mjs's
// own summarizeDispatch(): that function only ever runs SERVER-SIDE, once, at
// confirm time (its output feeds the activity-log title, not the API
// response body — see intakeDecide()'s call site). The Inbox needs the exact
// proposed action shown BEFORE confirm too (the M9 decisions memo's "preview
// always shows... the exact proposed action"), so this is the same
// {lane, action, params} shape (src/core/intake/dispatch.mjs) rendered as a
// sentence on the client. Keep in lockstep with dispatch.mjs's params shape —
// this repo does not (yet) share this formatter between server and client.
export function formatDispatchSummary(dispatch) {
  if (!dispatch) return null;
  if (dispatch.action === "app_set_status") {
    const { matchedCompany, matchedRole, applicationId, to } = dispatch.params;
    const target =
      matchedCompany && matchedRole ? `${matchedCompany} — ${matchedRole}` : applicationId;
    return `Update ${target} status to "${to}"`;
  }
  if (dispatch.action === "run_skill") return `Run ${dispatch.params.skill}`;
  if (dispatch.action === "chat_skill") return `Hand off to ${dispatch.params.skill}`;
  return null; // "needs_you" (lane null) has no dispatch preview — nothing to confirm into yet
}

// Human labels for the M9 kind enum (config/intake-classify.schema.json).
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

// Human labels for intake_items.status (migration 002's CHECK constraint).
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
