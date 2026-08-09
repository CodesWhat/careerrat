// dispatch-summary.mjs — a one-line human-readable summary of a resolved
// intake dispatch (src/core/intake/dispatch.mjs's {lane, action, params}
// shape). Extracted (M10, no behavior change) out of src/cli/intake-route.mjs,
// where it started life as a private confirm-time-only helper feeding the
// activity-log title. dispatch-summary.mjs is next to dispatch.mjs
// deliberately — it mirrors that module's own params shape 1:1, so a change
// to one is the obvious prompt to check the other.
//
// M10: this is no longer confirm-only. intake-route.mjs now computes and
// includes `dispatchSummary` on EVERY response that carries a `dispatch`
// object (POST /api/intake, GET /api/intake/list, GET /api/intake/one, POST
// /api/intake/classify) — not just the confirm-time activity-log title — so
// the client (apps/web/src/inbox/dispatch-summary.js's now-deleted
// formatDispatchSummary hand-copy) reads `item.dispatchSummary` straight off
// the API response instead of re-deriving it. One implementation, computed
// here, consumed everywhere.
export function summarizeDispatch(dispatch) {
  if (!dispatch) return null;
  if (dispatch.action === "app_set_status") {
    // matchedCompany/matchedRole are present whenever dispatch.mjs resolved
    // this off a real trackerMatch (always, for app_set_status) — named
    // explicitly here so a company_unique match (no role in the original
    // paste) still shows the human exactly which tracked application is
    // about to change, e.g. "E Corp — Staff Software Engineer", the
    // sanity-check confirm-first exists for.
    const target =
      dispatch.params.matchedCompany && dispatch.params.matchedRole
        ? `${dispatch.params.matchedCompany} — ${dispatch.params.matchedRole}`
        : dispatch.params.applicationId;
    return `update ${target} status to "${dispatch.params.to}"`;
  }
  if (dispatch.action === "run_skill") return `run ${dispatch.params.skill}`;
  if (dispatch.action === "chat_skill") return `hand off to ${dispatch.params.skill}`;
  if (
    dispatch.action === "workspace_intent" &&
    dispatch.params.intentType === "communication.capture-inbound"
  ) {
    return "capture the recruiter message in your workspace conversation";
  }
  if (
    dispatch.action === "workspace_intent" &&
    dispatch.params.intentType === "interview.capture-context"
  ) {
    return "capture this interview context in your workspace conversation";
  }
  return dispatch.action;
}
