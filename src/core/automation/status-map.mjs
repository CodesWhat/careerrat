// status-map.mjs — normalize a raw ATS-portal status string into the tracker's
// canonical status vocabulary, and classify a status change as a transition.
//
// Phase 1 (status polling) scrapes free-form status labels off candidate ATS
// dashboards ("Application under review", "We've decided to move forward with other
// candidates", "Offer extended"). Those have to land on the SAME canonical statuses
// the rest of the system understands before track-outcomes can act on them. This
// module is that mapping — the browser-side analog of the dashboard's classifyStage
// keyword ladder, but emitting a value in VALID_APP_STATUSES.
//
// It drives no browser and writes nothing: pure string → status. The sync-status
// skill scrapes the labels (agent-driven) and hands HIGH-confidence transitions to
// track-outcomes (still the only writer of tracker.json). LOW-confidence (defaulted)
// results are surfaced for human confirmation, never auto-applied.

import { classifyStage } from "../tracker/dashboard.mjs";
import { VALID_APP_STATUSES } from "../tracker/tracker-data.mjs";

// Mirrors dashboard.mjs TERMINAL_STAGES (not exported there). A move INTO one of
// these is an outcome, not a forward step on the active ladder — reported as
// "terminal" rather than "advance" so the wording stays honest.
const TERMINAL_STAGE_IDS = new Set(["rejected", "withdrawn"]);

// Ordered keyword rules: first match wins. Raw ATS phrasing → a canonical tracker
// status (every right-hand value must be in VALID_APP_STATUSES — asserted below).
//
// Ordering is load-bearing: terminal/negative phrasings are checked BEFORE the
// positive stages so "no longer under consideration" → rejected (not "consideration"
// → awaiting) and "we are unable to offer you the role" → rejected (not "offer").
export const ATS_STATUS_RULES = [
  ["withdrawn", ["you withdrew", "withdrawn", "application withdrawn", "you have withdrawn"]],
  [
    "rejected",
    [
      "not selected",
      "not moving forward",
      "not be moving forward",
      "no longer under consideration",
      "no longer being considered",
      "decided to move forward with other",
      "move forward with other candidates",
      "pursuing other candidates",
      "unable to offer",
      "not to proceed",
      "will not be proceeding",
      "position has been filled",
      "position filled",
      "role has been filled",
      "req closed",
      "application closed",
      "unfortunately",
      "we regret",
      "regret to inform",
      "declined",
      "rejected",
    ],
  ],
  [
    "offer",
    [
      "offer extended",
      "extended an offer",
      "offer letter",
      "you have an offer",
      "congratulations",
      "hired",
      "you have accepted",
      "offer accepted",
    ],
  ],
  [
    "interview",
    [
      "onsite",
      "on-site",
      "on site",
      "final round",
      "panel",
      "interview",
      "hiring manager interview",
      "team interview",
      "loop",
    ],
  ],
  [
    "assessment",
    [
      "assessment",
      "take-home",
      "take home",
      "coding challenge",
      "online assessment",
      "skills test",
      "work sample",
      "hackerrank",
      "codesignal",
    ],
  ],
  [
    "screen",
    ["phone screen", "recruiter screen", "initial screen", "recruiter call", "screening", "screen"],
  ],
  [
    "reviewing",
    [
      "under review",
      "in review",
      "being reviewed",
      "currently reviewing",
      "reviewing your application",
      "application under review",
      "reviewing",
    ],
  ],
  [
    "awaiting",
    [
      "under consideration",
      "in process",
      "in progress",
      "application received",
      "we received",
      "received your application",
      "thank you for applying",
      "successfully submitted",
      "application submitted",
      "submitted",
      "applied",
      "awaiting",
      "pending",
      "active",
    ],
  ],
];

// Canonical round vocabulary (SSOT: AGENTS.md "Round Vocabulary"). The coarse
// `canonical` status above stays at "interview" for every interview-band rung
// (VALID_APP_STATUSES is intentionally coarse), but the dashboard names the rung
// from the conversation `kind`. So we ALSO derive a fine-grained `round` from the
// same raw label — sync-status / track-outcomes write THIS as the `conversations[]`
// kind so the portal label "Welcome to your virtual onsite" lands as `onsite`, not a
// generic interview. Ordered deepest-first; first match wins. null = not a round.
export const ATS_ROUND_RULES = [
  [
    "offer",
    ["offer extended", "extended an offer", "offer letter", "you have an offer", "offer accepted"],
  ],
  [
    "final",
    [
      "final round",
      "final interview",
      "final panel",
      "decision round",
      "exec interview",
      "executive interview",
      "bar raiser",
      "bar-raiser",
    ],
  ],
  [
    "onsite",
    ["virtual onsite", "onsite", "on-site", "on site", "panel", "loop", "super day", "superday"],
  ],
  [
    "hiring manager",
    [
      "hiring manager",
      "hm interview",
      "leadership interview",
      "manager interview",
      "director interview",
      "skip level",
      "skip-level",
    ],
  ],
  [
    "technical",
    [
      "technical interview",
      "technical screen",
      "system design",
      "live coding",
      "coding interview",
      "pair programming",
    ],
  ],
  [
    "assessment",
    [
      "assessment",
      "take-home",
      "take home",
      "coding challenge",
      "online assessment",
      "skills test",
      "work sample",
      "hackerrank",
      "codesignal",
    ],
  ],
  [
    "recruiter screen",
    ["phone screen", "recruiter screen", "initial screen", "recruiter call", "screening", "screen"],
  ],
];

function matchRound(s) {
  for (const [round, subs] of ATS_ROUND_RULES) {
    if (subs.some((sub) => s.includes(sub))) return round;
  }
  return null;
}

// Dev guard: every rule must emit a status the tracker accepts. Cheap, runs once on
// import, and turns a typo in the table into an immediate, obvious failure.
for (const [canonical] of ATS_STATUS_RULES) {
  if (!VALID_APP_STATUSES.has(canonical)) {
    throw new Error(`status-map: "${canonical}" is not in VALID_APP_STATUSES`);
  }
}

/**
 * Normalize a raw ATS status string to a canonical tracker status.
 *
 * @param {string} raw free-form status text scraped from a portal
 * @returns {{ canonical: string|null, stage: string|null, round: string|null, confidence: "high"|"low"|"none", raw: string }}
 *   canonical ∈ VALID_APP_STATUSES (or null for empty input). round = canonical
 *   conversation kind (AGENTS.md Round Vocabulary) or null when the label isn't a
 *   round. confidence "high" = matched a keyword rule; "low" = unknown non-empty text
 *   defaulted to awaiting (DO NOT auto-transition on low); "none" = empty/blank input.
 */
export function normalizeAtsStatus(raw) {
  const s = String(raw == null ? "" : raw)
    .toLowerCase()
    .trim();
  if (!s)
    return {
      canonical: null,
      stage: null,
      round: null,
      confidence: "none",
      raw: String(raw ?? ""),
    };
  const round = matchRound(s);
  for (const [canonical, subs] of ATS_STATUS_RULES) {
    if (subs.some((sub) => s.includes(sub))) {
      return { canonical, stage: classifyStage(canonical).id, round, confidence: "high", raw };
    }
  }
  // Unknown but non-empty: keep it in-pipeline but flag it low so the skill asks a
  // human instead of silently moving the row.
  return {
    canonical: "awaiting",
    stage: classifyStage("awaiting").id,
    round,
    confidence: "low",
    raw,
  };
}

/**
 * Classify a scraped status against the tracker's current status as a transition.
 * Stage order (from classifyStage) tells us advance vs. regress; a regress or a
 * low-confidence read is exactly what a human should eyeball before any write.
 *
 * @param {string} currentStatus the application's current tracker status
 * @param {string} scrapedRaw the raw status read from the portal
 * @returns {{
 *   changed: boolean, from: string, to: string, fromOrder: number, toOrder: number,
 *   direction: "advance"|"regress"|"same", canonical: string|null,
 *   confidence: string, autoApplicable: boolean, norm: object
 * }}
 *   autoApplicable is true only for a high-confidence, non-regressing change — the
 *   sync-status skill hands those to track-outcomes and surfaces everything else.
 */
export function statusTransition(currentStatus, scrapedRaw) {
  const norm = normalizeAtsStatus(scrapedRaw);
  const from = classifyStage(currentStatus);
  if (!norm.canonical) {
    return {
      changed: false,
      from: from.id,
      to: from.id,
      fromOrder: from.order,
      toOrder: from.order,
      direction: "same",
      canonical: null,
      confidence: norm.confidence,
      autoApplicable: false,
      norm,
    };
  }
  const to = classifyStage(norm.canonical);
  const changed = to.id !== from.id;
  // manual-apply sits above applied on the display ladder (order 1.5 vs 1),
  // but a portal read that the application is now submitted means the manual
  // submission landed — that is forward progress, not a step backward.
  const manualApplyLanded = from.id === "manual-apply" && to.id === "applied";
  const direction = !changed
    ? "same"
    : TERMINAL_STAGE_IDS.has(to.id)
      ? "terminal"
      : to.order > from.order || manualApplyLanded
        ? "advance"
        : "regress";
  return {
    changed,
    from: from.id,
    to: to.id,
    fromOrder: from.order,
    toOrder: to.order,
    direction,
    canonical: norm.canonical,
    confidence: norm.confidence,
    // Auto-apply only a confident forward step or a confident definitive outcome.
    // A regress (e.g. interview → applied) is almost always a scrape artifact — surface it.
    autoApplicable:
      changed &&
      norm.confidence === "high" &&
      (direction === "advance" || direction === "terminal"),
    norm,
  };
}

/**
 * Map the wider canonical status vocabulary (VALID_APP_STATUSES) onto the
 * narrower Ask-native track-outcome allowlist (TRACK_OUTCOME_STATUSES).
 * app.status stays coarse per the track-outcomes SSOT; screen/assessment
 * granularity lives in the round vocabulary, not the status — so both
 * collapse into "interview" here, and "reviewing" collapses into "awaiting".
 *
 * @param {string|null} canonical a VALID_APP_STATUSES value, or null
 * @returns {string|null} a TRACK_OUTCOME_STATUSES value, or null for
 *   null/unknown input
 */
export function toTrackOutcomeStatus(canonical) {
  switch (canonical) {
    case "reviewing":
      return "awaiting";
    case "screen":
    case "assessment":
      return "interview";
    case "withdrawn":
    case "rejected":
    case "offer":
    case "interview":
    case "awaiting":
      return canonical;
    default:
      return null;
  }
}

// Dev guard: every canonical the rules table can emit must map to a
// track-outcome status. The auto-apply path in the Ask workspace writes
// toTrackOutcomeStatus(canonical) directly, so a rule added to
// ATS_STATUS_RULES without a mapping here would surface as a runtime write
// failure instead of this immediate import-time error.
for (const [canonical] of ATS_STATUS_RULES) {
  if (toTrackOutcomeStatus(canonical) === null) {
    throw new Error(`status-map: toTrackOutcomeStatus has no mapping for "${canonical}"`);
  }
}
