// evaluate/comp-comparables.mjs — estimate compensation for an unposted-comp
// posting from the candidate's OWN tracker history of comparable roles
// (same role family + same area), including rejected ones. The estimate gets
// stronger over time: more comparable rows -> a tighter match tier (family ->
// mode -> metro) and higher confidence.
//
// Domain-neutral: role-family grouping comes from targeting config and metro
// grouping comes from the candidate's comp_floors config. No company, metro, or
// salary number is hardcoded in this module.
//
// Used server-side by the evaluate-job gate and the one-time backfill. The
// browser dashboard never imports this — it renders the persisted `compEstimate`
// the agent writes onto each tracker row.

import { extractCompBand } from "../scoring/sourced-scanner.mjs";
import { classifyRoleFamily } from "../tracker/outcome-analysis.mjs";

function median(sortedNums) {
  const n = sortedNums.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedNums[mid - 1] + sortedNums[mid]) / 2 : sortedNums[mid];
}

function percentile(sortedNums, p) {
  const n = sortedNums.length;
  if (n === 0) return null;
  if (n === 1) return sortedNums[0];
  const rank = (n - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedNums[lo];
  return sortedNums[lo] + (sortedNums[hi] - sortedNums[lo]) * (rank - lo);
}

/**
 * Normalize a posting's work arrangement to one of remote|hybrid|onsite, or null
 * when unknown. Reads `mode`, falling back to a remote hint in the location text.
 */
function normalizeArrangement(mode, loc = "") {
  const m = String(mode || "").toLowerCase();
  if (/\bremote\b/.test(m)) return "remote";
  if (/\bhybrid\b/.test(m)) return "hybrid";
  if (/\b(onsite|on-site|on site|in-office|relo)\b/.test(m)) return "onsite";
  if (m) return "onsite";
  if (/\bremote\b/.test(String(loc || "").toLowerCase())) return "remote";
  return null;
}

/**
 * Map a posting's location to a metro GROUP id using the candidate's configured
 * metro groups (comp_floors.home_metro + relocation_by_metro[].match). Two
 * postings are "same metro" when they resolve to the same group. Remote roles
 * bucket together as "remote". Returns null when the location matches no
 * configured group (so metro-tier matching is skipped, never guessed).
 */
function resolveMetroGroup(loc, mode, compFloors) {
  if (normalizeArrangement(mode, loc) === "remote") return "remote";
  const text = String(loc || "").toLowerCase();
  if (!text) return null;
  const floors = compFloors || {};
  const includesAny = (patterns) =>
    Array.isArray(patterns) && patterns.some((p) => text.includes(String(p || "").toLowerCase()));

  if (includesAny(floors.home_metro)) return "home";
  if (Array.isArray(floors.relocation_by_metro)) {
    for (const entry of floors.relocation_by_metro) {
      if (includesAny(entry?.match)) {
        const key = String(entry?.label || entry?.match?.[0] || "metro").toLowerCase();
        return `metro:${key}`;
      }
    }
  }
  if (/\bremote\b/.test(text)) return "remote";
  return null;
}

// Catch-all role families produced by classifyRoleFamily when a title matches no
// configured pattern. Pooling these together mixes unrelated roles, so an
// estimate built on a catch-all family is capped to low confidence and labeled.
const CATCHALL_FAMILIES = new Set(["other", "uncategorized"]);

function midpointKFromComp(compensation) {
  const band = extractCompBand(compensation);
  if (!band) return null;
  return Math.round((band.min + band.max) / 2 / 1000);
}

function hasAnnualEarningsProvenance(row) {
  if (row?.compBasis === "annual-earnings" || row?.comp?.basis === "annual-earnings") {
    return true;
  }
  const evaluated = row?.evaluation?.compensation;
  return (
    (evaluated?.minAnnualEarnings !== null && evaluated?.minAnnualEarnings !== undefined) ||
    (evaluated?.maxAnnualEarnings !== null && evaluated?.maxAnnualEarnings !== undefined)
  );
}

/**
 * Estimate a salary midpoint + range for an unposted-comp posting from
 * comparable roles already in the tracker.
 *
 * Match logic (tightest tier with data wins):
 *   1. metro  — same role family AND same metro group (or both remote)
 *   2. mode   — same role family AND same arrangement (remote/hybrid/onsite)
 *   3. family — same role family, any location
 *
 * Only comparables with a parseable band for the requested compensation basis
 * contribute (we learn real comp from history, including rejected roles).
 * Returns null when no same-family comparable with matching comp data exists.
 *
 * @returns {{
 *   midpointK:number, lowK:number, highK:number, sampleSize:number,
 *   tier:'metro'|'mode'|'family', confidence:'low'|'medium'|'high',
 *   family:string, basis:string, compensationBasis:'base'|'annual-earnings',
 *   comparables:Array<{company:string, role:string, base?:string, annualEarnings?:string, status:string}>
 * } | null}
 */
export function estimateCompFromComparables({
  role,
  loc,
  mode,
  tracker,
  targeting,
  compFloors,
  excludeId,
  minMetroSamples = 3,
  compensationBasis = "base",
} = {}) {
  if (!new Set(["base", "annual-earnings"]).has(compensationBasis)) {
    throw new Error(`Unsupported comparable compensation basis: ${compensationBasis}`);
  }
  const family = classifyRoleFamily(role || "", targeting);
  const targetMetro = resolveMetroGroup(loc, mode, compFloors);
  const targetMode = normalizeArrangement(mode, loc);

  const apps = Array.isArray(tracker?.applications) ? tracker.applications : [];
  const sourced = Array.isArray(tracker?.sourced)
    ? tracker.sourced
    : Array.isArray(tracker?.prospects)
      ? tracker.prospects
      : [];

  const pool = [];
  for (const r of [...apps, ...sourced]) {
    if (!r) continue;
    if (excludeId && r.id === excludeId) continue;
    if (classifyRoleFamily(r.role || "", targeting) !== family) continue;
    const compensation =
      compensationBasis === "annual-earnings"
        ? hasAnnualEarningsProvenance(r)
          ? r.tc || r.comp?.tc || ""
          : ""
        : r.base || r.comp?.base || "";
    const mid = midpointKFromComp(compensation);
    if (mid == null) continue;
    pool.push({
      company: r.company || "",
      role: r.role || "",
      compensation,
      status: r.status || "",
      mid,
      metro: resolveMetroGroup(r.loc, r.mode, compFloors),
      mode: normalizeArrangement(r.mode, r.loc),
    });
  }

  if (pool.length === 0) return null;

  const sameMetro = targetMetro ? pool.filter((p) => p.metro === targetMetro) : [];
  const sameMode = targetMode ? pool.filter((p) => p.mode === targetMode) : [];

  let tier;
  let set;
  if (sameMetro.length >= minMetroSamples) {
    tier = "metro";
    set = sameMetro;
  } else if (sameMode.length >= minMetroSamples) {
    tier = "mode";
    set = sameMode;
  } else if (sameMetro.length >= 1) {
    tier = "metro";
    set = sameMetro;
  } else if (sameMode.length >= 1) {
    tier = "mode";
    set = sameMode;
  } else {
    tier = "family";
    set = pool;
  }

  const mids = set.map((p) => p.mid).sort((a, b) => a - b);
  const sampleSize = set.length;
  const midpointK = Math.round(median(mids));
  // Thin data -> show the full observed spread (honestly wide). Richer data ->
  // tighten to the inter-quartile range so one outlier can't distort the band.
  const lowK = sampleSize >= 4 ? Math.round(percentile(mids, 0.25)) : mids[0];
  const highK = sampleSize >= 4 ? Math.round(percentile(mids, 0.75)) : mids[mids.length - 1];

  // Catch-all families mix unrelated roles, so a same-family pool there is noisy;
  // cap such estimates to low confidence regardless of sample size.
  const catchAll = CATCHALL_FAMILIES.has(family);
  let confidence =
    tier === "metro" && sampleSize >= 5 ? "high" : sampleSize >= 3 ? "medium" : "low";
  if (catchAll) confidence = "low";

  const tierLabel =
    tier === "metro" ? "same-area" : tier === "mode" ? "same-arrangement" : "same-role-family";
  const familyNote = catchAll ? " (role family unclassified, rough)" : "";

  return {
    midpointK,
    lowK,
    highK,
    sampleSize,
    tier,
    confidence,
    family,
    compensationBasis,
    basis: `${sampleSize} ${tierLabel} comparable${sampleSize === 1 ? "" : "s"} in your tracker${familyNote}`,
    comparables: set
      .slice()
      .sort((a, b) => b.mid - a.mid)
      .slice(0, 6)
      .map((p) => ({
        company: p.company,
        role: p.role,
        ...(compensationBasis === "annual-earnings"
          ? { annualEarnings: p.compensation }
          : { base: p.compensation }),
        status: p.status,
      })),
  };
}

/**
 * Compare a comp estimate against the resolved arrangement floor.
 *   below  — even the estimate midpoint lands under the floor (confirm live
 *            before deciding; advisory, never a hard cut since it's a guess,
 *            not a posted band)
 *   thin   — estimate top end is under the floor too (stronger pass signal)
 *   clear  — estimate midpoint clears the floor
 * Returns null when there is no estimate or no floor to compare against.
 */
export function classifyEstimateAgainstFloor(estimate, floor) {
  if (!estimate || floor == null || !Number.isFinite(Number(floor))) return null;
  const f = Number(floor);
  const mid = estimate.midpointK * 1000;
  const high = estimate.highK * 1000;
  if (high < f) return "thin";
  if (mid < f) return "below";
  return "clear";
}
