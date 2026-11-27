// track-outcome-bounded.mjs — the FIRST piece of the "app calls AI ->
// structured result -> typed DB write" pipeline for application state
// (Productization). Ports the classification core of
// .agents/skills/track-outcomes/SKILL.md (STEP 0 "classify the incoming
// outcome" + STEP 2 "execute the status transition") into a bounded,
// schema-validated AI call: paste a free-text status update (a recruiter
// email, or the candidate's own note about a call) alongside the current
// application record, and get back ONE strict JSON object — never prose.
//
// Shape copied directly from
// src/core/deep-ingest/proposals/shared.mjs's createDeepIngestProposalBuilder
// (that file's own header comment: "THE reference for a bounded,
// schema-validated AI call that writes typed data"): runBoundedAI in
// "native-preferred" structured mode (the model's native JSON-schema output,
// falling back through structured-oneshot's fenced ```json + one corrective
// retry when a route doesn't support that) — never a hand-rolled fetch. Like
// proposeFromSource, this module is AI-call-only: it validates and returns
// the decision, it does NOT persist. Persistence (the typed appSetStatus/
// appSetFields DB writes) is the caller's job, exactly the way
// deep-ingest-route.mjs's buildAndPersistProposals persists what
// proposeFromSource returns — see the retired track-outcome route.
//
// Status vocabulary: the applications[] subset of the canonical status table
// in track-outcomes SKILL.md STEP 2 ("Canonical status vocabulary") — the
// same ids dashboard.mjs's STAGE_LADDER renders. `sourced`/`reviewed-hold`/
// `cut`/`closed` are sourced[]-only (pre-application) statuses and are
// intentionally excluded: this call only ever classifies an EXISTING
// application record, so the model can never propose one of those.

export const TRACK_OUTCOME_STATUSES = Object.freeze([
  "manual-apply",
  "awaiting",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
]);
