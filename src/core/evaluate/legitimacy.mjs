// evaluate/legitimacy.mjs — Block G: posting-legitimacy heuristics for the gate.
//
// A body-read gate decides fit; this decides whether the posting is worth reading
// at all. Ghost jobs, evergreen "talent community" reqs, stale listings, and
// staffing-agency reposts waste applications. assessLegitimacy() reads a saved
// posting and returns a conservative verdict the gate folds in.
//
// Design rules:
//   - **Never auto-CUT.** A single posting's heuristics are noisy; a false ghost
//     verdict makes the user miss a real job. The strongest result is `suspect`,
//     which the gate treats as REVIEW/manual — the human + body-read decide.
//   - **Domain-neutral.** Thresholds and phrase lists live in config
//     (`targeting.yml#legitimacy`) with universal, field-agnostic defaults here. No
//     company names, no tech assumptions. A nurse, a driver, and an engineer all
//     get the same ghost-job tells ("talent community", "on behalf of our client").
//   - **Pure.** `now` and any `scanHistory` are passed in (no Date.now(), no fs),
//     so it is fully testable.
//
// Signals carry a severity: a "strong" textual tell (evergreen / staffing) alone
// makes it suspect; "mild" supporting signals (stale, thin) need two to add up.

// Universal ghost / evergreen / always-hiring tells. Kept tight to avoid flagging
// legitimately growing teams. User config EXTENDS these (it does not replace them).
export const EVERGREEN_PHRASES = [
  "talent community",
  "talent network",
  "talent pool",
  "general application",
  "general interest",
  "evergreen",
  "keep your resume on file",
  "keep your details on file",
  "future opportunities",
  "future openings",
  "pipeline for future",
  "always accepting applications",
  "we're always hiring",
  "we are always hiring",
  "no specific opening",
  "expression of interest",
  "join our talent",
];

// Staffing-agency / recruiter-farm tells: the employer is a middleman, not the
// hiring company. Conservative — only unambiguous agency phrasing.
export const RECRUITER_FARM_PHRASES = [
  "on behalf of our client",
  "our client is seeking",
  "our client is looking",
  "our client, a",
  "staffing agency",
  "recruitment agency",
  "recruiting agency",
  "recruiting firm",
  "recruiting on behalf",
  "we are partnering with our client",
];

export const LEGITIMACY_DEFAULTS = {
  enabled: true,
  max_posting_age_days: 60, // older than this → "stale" (a mild signal)
  min_body_chars: 500, // thinner than this → "thin JD" (a mild signal)
  evergreen_seen_count: 4, // scanHistory: appeared in ≥ this many scans → evergreen
  evergreen_span_days: 60, // scanHistory: across ≥ this many days → evergreen
  evergreen_phrases: EVERGREEN_PHRASES,
  recruiter_farm_phrases: RECRUITER_FARM_PHRASES,
};

// Merge user config over defaults. Phrase lists EXTEND (defaults ∪ user, deduped);
// scalars override. `enabled: false` turns the whole check off.
export function resolveLegitimacyConfig(targeting) {
  const user = targeting?.legitimacy || {};
  const mergePhrases = (base, extra) =>
    Array.from(
      new Set(
        [...(base || []), ...(Array.isArray(extra) ? extra : [])].map((s) =>
          String(s).toLowerCase()
        )
      )
    );
  return {
    enabled: user.enabled !== false,
    maxAgeDays: numOr(user.max_posting_age_days, LEGITIMACY_DEFAULTS.max_posting_age_days),
    minBodyChars: numOr(user.min_body_chars, LEGITIMACY_DEFAULTS.min_body_chars),
    evergreenSeenCount: numOr(user.evergreen_seen_count, LEGITIMACY_DEFAULTS.evergreen_seen_count),
    evergreenSpanDays: numOr(user.evergreen_span_days, LEGITIMACY_DEFAULTS.evergreen_span_days),
    evergreenPhrases: mergePhrases(EVERGREEN_PHRASES, user.evergreen_phrases),
    recruiterFarmPhrases: mergePhrases(RECRUITER_FARM_PHRASES, user.recruiter_farm_phrases),
  };
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function firstPhrase(haystack, phrases) {
  const hay = String(haystack || "").toLowerCase();
  for (const p of phrases) {
    if (p && hay.includes(p)) return p;
  }
  return null;
}

// Parse an ISO-ish date string to a Date, or null. Accepts "2026-05-01" etc.
function parseDate(s) {
  if (!s) return null;
  const d = new Date(String(s));
  return Number.isNaN(d.getTime()) ? null : d;
}

const DAY_MS = 86400000;

/**
 * Assess whether a saved posting looks legitimate.
 *
 * @param {object} args
 * @param {{frontmatter:object, body:string}} args.job  parsed saved job
 * @param {object} [args.targeting]                       candidate/targeting.yml (for config)
 * @param {Date}   [args.now]                             reference "now" (default: new Date())
 * @param {{seenCount:number, firstSeen:string, lastSeen:string}} [args.scanHistory]
 *        optional cross-scan history for evergreen/repost detection (when a durable
 *        scan-history store exists; omitted today → those signals just don't fire)
 * @returns {{verdict:"clear"|"suspect", signals:Array, reason:string, checked:string[], gaps:string[]}}
 */
export function assessLegitimacy({ job, targeting, now = new Date(), scanHistory } = {}) {
  const cfg = resolveLegitimacyConfig(targeting);
  const frontmatter = job?.frontmatter || {};
  const body = String(job?.body || "");

  if (!cfg.enabled) {
    return {
      verdict: "clear",
      signals: [],
      reason: "legitimacy check disabled",
      checked: [],
      gaps: [],
    };
  }

  const signals = [];
  const checked = [];
  const gaps = [];

  // --- evergreen / talent-community language (strong textual tell) ---
  checked.push("evergreen-language");
  const evergreenHit = firstPhrase(body, cfg.evergreenPhrases);
  if (evergreenHit) {
    signals.push({
      id: "evergreen-language",
      severity: "strong",
      detail: `evergreen/talent-pipeline phrasing: "${evergreenHit}"`,
    });
  }

  // --- staffing-agency / recruiter-farm language (strong textual tell) ---
  checked.push("recruiter-farm");
  const farmHit = firstPhrase(body, cfg.recruiterFarmPhrases);
  if (farmHit) {
    signals.push({
      id: "recruiter-farm",
      severity: "strong",
      detail: `staffing/agency phrasing: "${farmHit}"`,
    });
  }

  // --- staleness (mild) ---
  checked.push("staleness");
  const posted = parseDate(frontmatter.postedAt) || parseDate(frontmatter.dateOpened);
  if (posted) {
    const ageDays = Math.floor((now.getTime() - posted.getTime()) / DAY_MS);
    if (ageDays > cfg.maxAgeDays) {
      signals.push({
        id: "stale",
        severity: "mild",
        detail: `posting is ${ageDays} days old (> ${cfg.maxAgeDays}d)`,
      });
    }
  } else {
    gaps.push("no posting date (postedAt/dateOpened): staleness not assessed");
  }

  // --- thin JD (mild) ---
  checked.push("thin-jd");
  if (body.length > 0 && body.length < cfg.minBodyChars) {
    signals.push({
      id: "thin-jd",
      severity: "mild",
      detail: `JD body is ${body.length} chars (< ${cfg.minBodyChars})`,
    });
  } else if (body.length === 0) {
    gaps.push("no JD body captured: thin-JD not assessed");
  }

  // --- evergreen via cross-scan history (strong), when available ---
  if (scanHistory && Number.isFinite(Number(scanHistory.seenCount))) {
    checked.push("scan-history");
    const seen = Number(scanHistory.seenCount);
    const first = parseDate(scanHistory.firstSeen);
    const last = parseDate(scanHistory.lastSeen) || now;
    const spanDays = first ? Math.floor((last.getTime() - first.getTime()) / DAY_MS) : 0;
    if (seen >= cfg.evergreenSeenCount && spanDays >= cfg.evergreenSpanDays) {
      signals.push({
        id: "evergreen-recurring",
        severity: "strong",
        detail: `seen in ${seen} scans across ${spanDays} days: recurring/evergreen`,
      });
    }
  }

  // --- verdict ---
  const strong = signals.filter((s) => s.severity === "strong");
  const mild = signals.filter((s) => s.severity === "mild");
  const suspect = strong.length >= 1 || mild.length >= 2;

  const reason = suspect
    ? signals.map((s) => s.detail).join("; ")
    : signals.length === 1
      ? `${signals[0].detail} (single soft signal, not conclusive)`
      : "no legitimacy concerns detected";

  return { verdict: suspect ? "suspect" : "clear", signals, reason, checked, gaps };
}
