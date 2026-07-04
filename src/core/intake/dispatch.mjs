// dispatch.mjs — the three-lane dispatch table (M9 orchestrator decisions
// memo, "Lanes"). Pure data-in/data-out: given a classification, decide
// {lane, action, params} — no verb calls, no skill runs, no chat/session
// I/O. The route layer (src/cli/intake-route.mjs) performs the actual
// dispatch based on this decision, after (and only after) POST
// /api/intake/confirm — this module never runs before confirm.
//
// Lane A — pure deterministic verb call, no AI at execution time.
// Lane B — the existing embedded one-shot runtime (POST /api/skill/run).
// Lane C — the existing chat runtime (findBySkill reuse / new session).
//
// "status-update" is the one kind that can ALSO resolve to needs_you: per
// the decisions memo, an intake item never guesses which application a
// status change refers to — trackerMatch must be an unambiguous hit
// (exact_req_id / exact_url / company_role / company_unique) against a real
// applications[] row, or this returns needs_you instead of a lane, full
// stop. company_unique (match.mjs) is still not a guess: it only fires when
// exactly one row at that company exists — two-or-more stays unmatched.
const NEEDS_YOU = (reason) => ({ lane: null, action: "needs_you", params: { reason } });

export function resolveIntakeDispatch({ kind, entities = {}, trackerMatch = null } = {}) {
  switch (kind) {
    case "jd-text":
    case "job-url":
      return { lane: "B", action: "run_skill", params: { skill: "evaluate-job" } };

    case "recruiter-email":
      return { lane: "C", action: "chat_skill", params: { skill: "email-comms" } };

    case "interview-transcript":
      return { lane: "C", action: "chat_skill", params: { skill: "interview-prep" } };

    case "status-update": {
      const isUnambiguousApplicationMatch =
        trackerMatch?.matched === true &&
        trackerMatch.recordType === "application" &&
        Boolean(trackerMatch.id) &&
        ["exact_req_id", "exact_url", "company_role", "company_unique"].includes(
          trackerMatch.confidence
        );
      if (!isUnambiguousApplicationMatch) {
        return NEEDS_YOU(
          "no unambiguous tracked application matched this status update — never guess which application it refers to"
        );
      }
      return {
        lane: "A",
        action: "app_set_status",
        params: {
          applicationId: trackerMatch.id,
          to: entities.statusTo || null,
          note: entities.statusNote || null,
          // Carried through so the confirm-time preview can show the human
          // what they're about to change, e.g. "E Corp — Staff Software
          // Engineer" — the sanity-check backstop for the rare wrong-unique
          // case, since confirm-first is what makes company_unique safe.
          matchedCompany: trackerMatch.company || null,
          matchedRole: trackerMatch.role || null,
          matchedSummary: trackerMatch.summary || null,
        },
      };
    }

    case "other":
      return NEEDS_YOU("no specific route matched this paste — a human needs to route it manually");

    default:
      return NEEDS_YOU(`unrecognized intake kind "${kind}"`);
  }
}
