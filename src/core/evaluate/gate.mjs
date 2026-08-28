// evaluate/gate.mjs — M4 evaluate-job gate logic for CareerRat.
// Zero runtime dependencies. Node v24 ESM.

import { effectiveTargetingForRole } from "../deep-ingest/role-signal-overlay.mjs";
import { assessCompensationFloors } from "../profile/compensation.mjs";
import { shouldReviewMediumBodyReadFits } from "../profile/modes.mjs";
import { parseYaml } from "../profile/yaml.mjs";
import { extractCompensationBands } from "../scoring/sourced-scanner.mjs";
import { classifyEstimateAgainstFloor, estimateCompFromComparables } from "./comp-comparables.mjs";
import { assessLegitimacy } from "./legitimacy.mjs";

// ---------------------------------------------------------------------------
// parseSavedJob
// ---------------------------------------------------------------------------

/**
 * Parse a job.md-shaped markdown file into { frontmatter, body, gateNotes }.
 *
 * Structure expected:
 *   ---
 *   <yaml frontmatter>
 *   ---
 *
 *   # Job Description
 *   <body text>
 *
 *   # Gate Notes
 *   <gate notes text>
 */
export function parseSavedJob(markdown) {
  const text = String(markdown || "");

  // --- extract YAML frontmatter ---
  let frontmatter = {};
  let rest = text;

  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fmMatch) {
    const parsed = parseYaml(fmMatch[1]);
    frontmatter =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    rest = fmMatch[2];
  }

  // --- split sections ---
  const jdMatch = rest.match(/(?:^|\n)#\s*Job Description\s*\r?\n([\s\S]*?)(?=\n#\s|$)/);
  const gnMatch = rest.match(/(?:^|\n)#\s*Gate Notes\s*\r?\n([\s\S]*?)(?=\n#\s|$)/);

  const body = jdMatch ? jdMatch[1].trim() : "";
  const gateNotes = gnMatch ? gnMatch[1].trim() : "";

  return { frontmatter, body, gateNotes };
}

// ---------------------------------------------------------------------------
// matchSignals
// ---------------------------------------------------------------------------

/**
 * Case-insensitive whole-phrase substring match of each signal in text.
 * Returns [{ signal, matched }]. Never throws on null text.
 */
export function matchSignals(text, signals) {
  const haystack = String(text || "").toLowerCase();
  return (signals || []).map((signal) => ({
    signal,
    matched: haystack.includes(String(signal || "").toLowerCase()),
  }));
}

// ---------------------------------------------------------------------------
// anyMatched
// ---------------------------------------------------------------------------

/**
 * Returns true if at least one signal is found in text.
 */
export function anyMatched(text, signals) {
  return matchSignals(text, signals).some((r) => r.matched);
}

function normalizeExcludedText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function matchesExcluded({ company, title, excludedCompanies } = {}) {
  const haystacks = [company, title].map(normalizeExcludedText).filter(Boolean);
  for (const entry of Array.isArray(excludedCompanies) ? excludedCompanies : []) {
    const normalized = normalizeExcludedText(entry);
    if (!normalized) continue;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`);
    if (haystacks.some((haystack) => pattern.test(haystack))) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// matchedTitleBucket
// ---------------------------------------------------------------------------

/**
 * Returns the first role_bucket whose `titles` array contains a
 * case-insensitive substring match with the job title (substring in either
 * direction: title contains bucket-title OR bucket-title contains title).
 * Returns null if no match.
 */
export function matchedTitleBucket(title, targeting) {
  const needle = String(title || "")
    .toLowerCase()
    .trim();
  if (!needle) return null;
  const buckets = targeting?.role_buckets ? targeting.role_buckets : [];
  for (const bucket of buckets) {
    const titles = Array.isArray(bucket.titles) ? bucket.titles : [];
    for (const t of titles) {
      const hay = String(t || "")
        .toLowerCase()
        .trim();
      if (needle.includes(hay) || hay.includes(needle)) return bucket;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// evaluateCompensation
// ---------------------------------------------------------------------------

/**
 * Resolve the applicable BASE-comp floor for a posting from the candidate's
 * arrangement-based floors (profile.compensation.comp_floors), set at ingestion.
 * Remote → comp_floors.remote. Onsite/hybrid in the home metro → the matching
 * arrangement floor. Onsite/hybrid requiring relocation → a per-metro override
 * or comp_floors.relocation, and `relo: true` (a relocation floor miss is a hard
 * cut). Falls back to minimum_base when comp_floors is absent (backward-compat).
 * Domain-neutral: every metro/location pattern lives in candidate config, never
 * in this code.
 *
 * @returns {{ floor: number|null, relo: boolean, label: string, arrangement: string }}
 */
function resolveCompFloor({ profile, frontmatter }) {
  const comp = profile?.compensation ? profile.compensation : {};
  const minimumBase =
    comp.minimum_base != null && Number.isFinite(Number(comp.minimum_base))
      ? Number(comp.minimum_base)
      : null;
  const num = (v, fallback) => (v != null && Number.isFinite(Number(v)) ? Number(v) : fallback);

  const floors = comp.comp_floors ? comp.comp_floors : null;
  const mode = String(frontmatter?.mode || "").toLowerCase();
  const locationText = String(frontmatter?.location || "").toLowerCase();

  const isRemote = /\bremote\b/.test(mode) || (!mode && /\bremote\b/.test(locationText));
  const isHybrid = mode === "hybrid" || /\bhybrid\b/.test(mode);
  // Anything not remote and not hybrid is treated as onsite below.

  // No floors config → fall back to the flat minimum_base for every arrangement.
  if (!floors) {
    return { floor: minimumBase, relo: false, label: "", arrangement: mode || "unknown" };
  }

  if (isRemote) {
    return {
      floor: num(floors.remote, minimumBase),
      relo: false,
      label: "",
      arrangement: "remote",
    };
  }

  // Onsite or hybrid. Determine whether it requires relocation.
  const includesAny = (patterns) =>
    Array.isArray(patterns) &&
    patterns.some((p) => locationText.includes(String(p || "").toLowerCase()));

  const arrangement = isHybrid ? "hybrid" : "onsite";

  // Unknown location, or home metro → no relocation, use the arrangement floor.
  if (!locationText || includesAny(floors.home_metro)) {
    const f =
      arrangement === "hybrid" ? num(floors.hybrid, minimumBase) : num(floors.onsite, minimumBase);
    return { floor: f, relo: false, label: "", arrangement };
  }

  // Relocation required. Per-metro override first.
  if (Array.isArray(floors.relocation_by_metro)) {
    for (const entry of floors.relocation_by_metro) {
      if (includesAny(entry?.match) && Number.isFinite(Number(entry?.floor))) {
        return {
          floor: Number(entry.floor),
          relo: true,
          label: String(entry.label || "relocation"),
          arrangement,
        };
      }
    }
  }

  // Default relocation floor.
  return {
    floor: num(floors.relocation, minimumBase),
    relo: true,
    label: "relocation",
    arrangement,
  };
}

/**
 * Verdict decision table:
 *   bucket.priority === "oe"                         → "OE-bucket"
 *   no comp band found in frontmatter.comp || body   → "review" (reason: "no comp in JD")
 *   band.max < applicable floor (resolveCompFloor)   → "below-floor"
 *   band.max >= applicable floor                     → "clear"
 *
 * The floor is location-adjusted: relocation-required postings must clear the
 * relocation floor, not just minimum_base. `relo: true` on the result marks a
 * relocation-floor miss, which the gate treats as a hard CUT (not a soft hold).
 *
 * NEVER reads profile.compensation.current_base.
 *
 * @returns {{ verdict: string, reason: string, band: object|null, relo?: boolean, floor?: number }}
 */
export function evaluateCompensation({ body, frontmatter, profile, bucket, tracker, targeting }) {
  // OE bucket takes priority — any comp posture is acceptable under OE.
  if (bucket && bucket.priority === "oe") {
    return {
      verdict: "OE-bucket",
      reason: "opportunistic-engagement bucket; comp not gating",
      band: null,
    };
  }

  const compSource = [
    frontmatter?.comp ? `Base pay: ${String(frontmatter.comp)}` : "",
    frontmatter?.tc ? `Annual earnings: ${String(frontmatter.tc)}` : "",
    String(body || ""),
  ].join("\n");

  const bands = extractCompensationBands(compSource);
  const { floor, relo, label } = resolveCompFloor({ profile, frontmatter });
  const hasBaseFloor = Number.isFinite(floor) && floor > 0;
  const minimumAnnualEarnings = Number(profile?.compensation?.minimum_annual_earnings);
  const hasAnnualEarningsFloor =
    Number.isFinite(minimumAnnualEarnings) && minimumAnnualEarnings > 0;
  const standing = assessCompensationFloors({
    baseBand: bands.base,
    annualEarningsBand: bands.annualEarnings,
    minimumBase: hasBaseFloor ? floor : null,
    minimumAnnualEarnings: hasAnnualEarningsFloor ? minimumAnnualEarnings : null,
  });
  const bandFields = {
    baseBand: bands.base,
    annualEarningsBand: bands.annualEarnings,
  };

  if (standing.base === "below") {
    const reloWhere = label && label !== "relocation" ? ` to ${label}` : "";
    return {
      verdict: "below-floor",
      reason: relo
        ? `relocation${reloWhere} requires $${floor.toLocaleString()} base; band tops at $${bands.base.max.toLocaleString()}`
        : `band max $${bands.base.max.toLocaleString()} < floor $${floor.toLocaleString()}`,
      band: bands.base,
      basis: "base",
      relo,
      floor,
      ...bandFields,
    };
  }

  if (hasAnnualEarningsFloor && standing.annualEarnings === "below") {
    return {
      verdict: "below-floor",
      reason: `annual earnings top out at $${bands.annualEarnings.max.toLocaleString()}, below your $${minimumAnnualEarnings.toLocaleString()} floor`,
      band: bands.annualEarnings,
      basis: "annual-earnings",
      floor: minimumAnnualEarnings,
      relo: false,
      ...bandFields,
    };
  }

  if (standing.base === "overlap") {
    return {
      verdict: "review",
      reason: `base range overlaps your $${floor.toLocaleString()} floor`,
      band: bands.base,
      basis: "base",
      floor,
      relo,
      ...bandFields,
    };
  }

  if (hasAnnualEarningsFloor && standing.annualEarnings === "overlap") {
    return {
      verdict: "review",
      reason: `annual earnings range overlaps your $${minimumAnnualEarnings.toLocaleString()} floor`,
      band: bands.annualEarnings || bands.base,
      basis: "annual-earnings",
      floor: minimumAnnualEarnings,
      ...bandFields,
    };
  }

  if (standing.base === "unknown" && bands.annualEarnings) {
    return {
      verdict: "review",
      reason: "base pay is unverified; annual earnings do not prove the guaranteed base floor",
      band: null,
      basis: "base",
      floor,
      relo,
      ...bandFields,
    };
  }

  if (hasAnnualEarningsFloor && standing.annualEarnings === "unknown") {
    return {
      verdict: "review",
      reason:
        "annual earnings are unverified; posted base pay does not include unknown tips or variable cash",
      band: bands.base,
      basis: "annual-earnings",
      floor: minimumAnnualEarnings,
      ...bandFields,
    };
  }

  // No comp posted: instead of just handing the question back, estimate the
  // likely band from comparable roles already in the tracker (same role family
  // + same area, rejected ones included). An estimate is advisory only — it
  // pushes to REVIEW and never hard-cuts, since it's a guess, not a posted band.
  if (!bands.base && !bands.annualEarnings) {
    const estimate = estimateCompFromComparables({
      role: frontmatter?.role,
      loc: frontmatter?.location,
      mode: frontmatter?.mode,
      tracker,
      targeting,
      compFloors: profile?.compensation?.comp_floors,
    });

    if (!estimate) {
      return {
        verdict: "review",
        reason: "no comp in JD",
        band: null,
      };
    }

    const standing = classifyEstimateAgainstFloor(estimate, hasBaseFloor ? floor : null);
    const range = `$${estimate.lowK}K–$${estimate.highK}K (mid $${estimate.midpointK}K)`;
    const floorText =
      floor != null && Number.isFinite(floor) ? `$${Math.round(floor / 1000)}K` : "";

    if (standing === "below" || standing === "thin") {
      return {
        verdict: "estimated-below-floor",
        reason: `no comp posted; estimated ${range} from ${estimate.basis}${floorText ? `, under your ${floorText} floor` : ""}, likely pass unless strong non-cash benefits`,
        band: null,
        estimate,
        confirmNeeded: true,
        floor: floor ?? undefined,
        basis: "base",
        ...bandFields,
      };
    }

    return {
      verdict: "estimated",
      reason: `no comp posted; estimated ${range} from ${estimate.basis}${standing === "clear" && floorText ? `, clears your ${floorText} floor` : ""} (confirm live)`,
      band: null,
      estimate,
      confirmNeeded: true,
      floor: floor ?? undefined,
      basis: "base",
      ...bandFields,
    };
  }

  // If no floor configured, treat as clear.
  if (!hasBaseFloor && !hasAnnualEarningsFloor) {
    const band = bands.base || bands.annualEarnings;
    return {
      verdict: "clear",
      reason: `band $${band.min.toLocaleString()}–$${band.max.toLocaleString()} (no floor configured)`,
      band,
      basis: bands.base ? "base" : "annual-earnings",
      relo: false,
      ...bandFields,
    };
  }

  const band = hasAnnualEarningsFloor ? bands.annualEarnings || bands.base : bands.base;
  const relevantFloor = hasAnnualEarningsFloor ? minimumAnnualEarnings : floor;
  const relevantBasis = hasAnnualEarningsFloor ? "annual-earnings" : "base";
  const reloWhere = label && label !== "relocation" ? ` to ${label}` : "";

  return {
    verdict: "clear",
    reason: relo
      ? `band $${band.min.toLocaleString()}–$${band.max.toLocaleString()} clears relocation${reloWhere} floor $${relevantFloor.toLocaleString()}`
      : `band $${band.min.toLocaleString()}–$${band.max.toLocaleString()} clears floor $${relevantFloor.toLocaleString()}`,
    band,
    basis: relevantBasis,
    relo: false,
    floor: relevantFloor,
    ...bandFields,
  };
}

/**
 * Compute the outbound comp anchor — the salary to STATE — for a KEEP/REVIEW
 * verdict. Privacy invariant (AGENTS.md): anchor on target_base, or oe_max_base for
 * OE roles. NEVER current_base or minimum_base. Returns null when no target is
 * configured (the skill then asks the user / runs research-comp).
 *
 * @returns {{ value: number, rationale: string } | null}
 */
function computeCompAnchor({ profile, bucket, comp }) {
  const c = profile?.compensation ? profile.compensation : {};
  if (bucket && bucket.priority === "oe") {
    if (c.oe_max_base != null)
      return { value: Number(c.oe_max_base), rationale: "top of your OE range (oe_max_base)" };
    return null;
  }
  if (c.target_base != null) {
    const rationale =
      comp && comp.verdict === "below-floor"
        ? "your target base: JD band is below your floor, so anchor up or pass"
        : "your target base";
    return { value: Number(c.target_base), rationale };
  }
  return null;
}

// ---------------------------------------------------------------------------
// evaluateLocation
// ---------------------------------------------------------------------------

/**
 * Simple heuristics:
 *   - If profile.location.remote is true AND (JD mentions remote/remote-friendly
 *     OR onsite location is in profile.location.relocation or home) → ok: true.
 *   - If JD is onsite-only in a non-relo/non-home city AND profile is remote-only
 *     (remote true, onsite false/undefined) → ok: false.
 *   - Otherwise → ok: true (benefit of the doubt / hybrid).
 *
 * @returns {{ ok: boolean, reason: string }}
 */
function evaluateLocation({ body, frontmatter, profile }) {
  const jdText = [
    String(frontmatter?.location ? frontmatter.location : ""),
    String(frontmatter?.mode ? frontmatter.mode : ""),
    String(body || ""),
  ]
    .join(" ")
    .toLowerCase();

  const loc = profile?.location ? profile.location : {};
  const profileRemote = !!loc.remote;
  const profileOnsite = !!loc.onsite;
  const reloCities = Array.isArray(loc.relocation)
    ? loc.relocation.map((c) => String(c || "").toLowerCase())
    : [];
  const homeCity = String(loc.home || "").toLowerCase();

  // Does the JD signal remote-ok?
  const jdRemoteFriendly = /\bremote\b/i.test(jdText);

  // Does the JD signal onsite-only?
  const jdOnsiteOnly = /\b(on[- ]?site|in[- ]office|hybrid)\b/i.test(jdText) && !jdRemoteFriendly;

  // Does the JD location overlap with relo/home cities?
  const jdLocation = String(frontmatter?.location ? frontmatter.location : "").toLowerCase();
  const locationOverlap = homeCity
    ? jdLocation.includes(homeCity) || reloCities.some((c) => jdLocation.includes(c))
    : reloCities.some((c) => jdLocation.includes(c));

  if (profileRemote && jdRemoteFriendly) {
    return { ok: true, reason: "JD offers remote; profile accepts remote" };
  }
  if (profileRemote && locationOverlap) {
    return { ok: true, reason: "JD location matches home/relo city" };
  }
  if (profileRemote && !profileOnsite && jdOnsiteOnly && !locationOverlap) {
    return {
      ok: false,
      reason: "JD appears onsite-only in a non-relo city; profile is remote-only",
    };
  }
  if (profileOnsite && jdOnsiteOnly) {
    return { ok: true, reason: "JD onsite; profile accepts onsite" };
  }

  return { ok: true, reason: "location not blocking (no hard conflict detected)" };
}

// ---------------------------------------------------------------------------
// scoreFit
// ---------------------------------------------------------------------------

/**
 * Score 0–100 based on:
 *   +5 per matched keep_signal (capped contribution)
 *   +20 if title bucket matched
 *   -10 per matched cut_signal
 *
 * Tier: high (≥high_min), med (≥med_min), stretch (<med_min).
 * Bands read from targeting.fit_bands; default { high_min: 85, med_min: 65 }.
 * Priority derived from bucket.priority or "low".
 *
 * @returns {{ tier: string, score: number, why: string, caveats: string, priority: string }}
 */
function scoreFit({ body, title, targeting, _profile, bucket }) {
  const searchText = [String(title || ""), String(body || "")].join("\n");

  const keepSignals = targeting?.keep_signals ? targeting.keep_signals : [];
  const cutSignals = targeting?.cut_signals ? targeting.cut_signals : [];

  const matchedKeep = matchSignals(searchText, keepSignals).filter((r) => r.matched);
  const matchedCut = matchSignals(searchText, cutSignals).filter((r) => r.matched);

  let score = 50; // neutral baseline

  // +5 per keep signal, max +30
  const keepBonus = Math.min(matchedKeep.length * 5, 30);
  score += keepBonus;

  // +20 for title bucket match
  if (bucket) score += 20;

  // -10 per cut signal
  score -= matchedCut.length * 10;

  // clamp 0–100
  score = Math.max(0, Math.min(100, score));

  const fitBands = targeting?.fit_bands ? targeting.fit_bands : {};
  const highMin = fitBands.high_min != null ? Number(fitBands.high_min) : 85;
  const medMin = fitBands.med_min != null ? Number(fitBands.med_min) : 65;
  const tier = score >= highMin ? "high" : score >= medMin ? "med" : "stretch";

  const why =
    matchedKeep.length > 0
      ? matchedKeep.map((r) => r.signal).join(", ")
      : bucket
        ? `title matches bucket "${bucket.name}"`
        : "no keep signals matched";

  const caveats = matchedCut.length > 0 ? matchedCut.map((r) => r.signal).join(", ") : "none";

  const priorityMap = { primary: "primary", secondary: "secondary", stretch: "stretch", oe: "oe" };
  const priority = bucket && priorityMap[bucket.priority] ? priorityMap[bucket.priority] : "low";

  return { tier, score, why, caveats, priority };
}

// ---------------------------------------------------------------------------
// evaluateGate
// ---------------------------------------------------------------------------

/**
 * Full gate evaluation.
 *
 * HARD CUT conditions (any one → gate "CUT", action "cut"):
 *   (a) a cut_signal phrase appears in body
 *   (b) frontmatter.company or title matches targeting.excluded_companies (case-insensitive)
 *   (c) requires_sponsorship + body mentions "no sponsorship" / "not able to sponsor" /
 *       "unable to sponsor"; OR work_authorized===false and role requires it
 *
 * Comp below-floor → REVIEW (not a hard cut) unless already CUT.
 * fit.tier === "stretch" OR comp.verdict in ["review","OE-bucket"] → REVIEW.
 * legitimacy.verdict === "suspect" → REVIEW/manual (never an auto-cut).
 * Otherwise → KEEP, action "apply-now".
 *
 * `roleSignals` (optional, confirmed deep-ingest role-signal rows) is resolved
 * against this posting's title via `effectiveTargetingForRole()` BEFORE any
 * targeting-derived check runs (bucket match, fit score, comp, hard-cuts) —
 * a matching `cut` row folds into `cut_signals` and gets the same hard-cut
 * semantics as a base cut signal. With no rows (or none matching), the
 * effective targeting is identical to `targeting` and behavior is unchanged.
 *
 * @param {{ job, targeting, profile, honesty, modes?, now?, scanHistory?, roleSignals? }} args
 * @returns {{ gate, fit, comp, location, legitimacy, action, reasons, appliedRoleSignalIds }}
 */
export function evaluateGate({
  job,
  targeting,
  profile,
  _honesty,
  modes,
  now,
  scanHistory,
  tracker,
  roleSignals,
}) {
  const frontmatter = job?.frontmatter ? job.frontmatter : {};
  const body = String(job?.body ? job.body : "");
  const title = String(frontmatter.role || "");
  const company = String(frontmatter.company || "");

  const reasons = [];

  // --- role-signal overlay: ephemeral merge of confirmed keep/cut rows into
  // targeting, resolved for THIS posting's title, before any targeting-derived
  // check reads keep_signals/cut_signals/etc. Never written back; targeting
  // stays the authoritative base (see role-signal-overlay.mjs contract).
  const overlay = effectiveTargetingForRole({ roleTitle: title, targeting, roleSignals });
  const effectiveTargeting = overlay.targeting;
  // Only callers that opt into role signals get the attribution field —
  // legacy callers must receive a byte-identical result object.
  const roleSignalExtras =
    roleSignals === undefined
      ? {}
      : {
          appliedRoleSignalIds: [...overlay.applied.keep, ...overlay.applied.cut].map((s) => s.id),
        };

  // --- locate bucket ---
  const bucket = matchedTitleBucket(title, effectiveTargeting);

  // --- fit score ---
  const fit = scoreFit({ body, title, targeting: effectiveTargeting, profile, bucket });

  // --- comp ---
  const comp = evaluateCompensation({
    body,
    frontmatter,
    profile,
    bucket,
    tracker,
    targeting: effectiveTargeting,
  });

  // --- location ---
  const location = evaluateLocation({ body, frontmatter, profile });

  // --- outbound comp anchor (the figure to state on KEEP/REVIEW) ---
  const anchor = computeCompAnchor({ profile, bucket, comp });

  // --- posting legitimacy (Block G) — flags only, never a hard cut ---
  const legitimacy = assessLegitimacy({ job, targeting, now, scanHistory });

  // -----------------------------------------------------------------------
  // Hard-cut checks
  // -----------------------------------------------------------------------
  const cutSignals = effectiveTargeting?.cut_signals ? effectiveTargeting.cut_signals : [];
  const excludedCompanies = effectiveTargeting?.excluded_companies
    ? effectiveTargeting.excluded_companies
    : [];

  let hardCut = false;

  // (a) cut_signal in body
  const matchedCuts = matchSignals(body, cutSignals).filter((r) => r.matched);
  if (matchedCuts.length > 0) {
    hardCut = true;
    reasons.push(`cut signal(s) found in JD: ${matchedCuts.map((r) => r.signal).join(", ")}`);
  }

  // (b) excluded company or title — match on whole words, not substrings, so a
  // short entry like "X" doesn't false-cut "UX Engineer", "Box", or "Nexus".
  const matchedExcluded = matchesExcluded({ company, title, excludedCompanies });
  if (matchedExcluded) {
    hardCut = true;
    reasons.push(`company/title matches excluded list: "${matchedExcluded}"`);
  }

  // (c) sponsorship mismatch
  const auth = profile?.authorization ? profile.authorization : {};
  const requiresSponsorship = auth.requires_sponsorship === true;
  const notAuthorized = auth.work_authorized === false;
  const noSponsorshipPhrase =
    /no sponsorship|not able to sponsor|unable to sponsor|we do not offer sponsorship|cannot provide sponsorship/i.test(
      body
    );

  if ((requiresSponsorship || notAuthorized) && noSponsorshipPhrase) {
    hardCut = true;
    reasons.push(
      "authorization mismatch: sponsorship required but JD states no sponsorship offered"
    );
  }

  // (d) relocation comp floor — a seat that requires relocation but whose band
  // cannot clear the location-adjusted base floor is a hard cut, not a soft
  // hold. Relocating for under-floor comp is a real-cost no-go.
  if (comp.verdict === "below-floor" && comp.relo) {
    hardCut = true;
    reasons.push(`relocation comp floor not met: ${comp.reason}`);
  }

  // (e) fit floor — a body-read fit score below the configured floor is an
  // auto-drop, not a question for the candidate. Domain-neutral: the threshold
  // lives in targeting.fit_bands.fit_floor; with none configured, nothing drops.
  const fitFloorRaw = effectiveTargeting?.fit_bands?.fit_floor;
  const fitFloor =
    fitFloorRaw != null && Number.isFinite(Number(fitFloorRaw)) ? Number(fitFloorRaw) : null;
  if (fitFloor != null && fit.score < fitFloor) {
    hardCut = true;
    reasons.push(`fit ${fit.score} below your fit floor ${fitFloor} (auto-drop)`);
  }

  // -----------------------------------------------------------------------
  // Gate resolution
  // -----------------------------------------------------------------------

  if (hardCut) {
    return {
      gate: "CUT",
      fit,
      comp,
      location,
      legitimacy,
      action: "cut",
      reasons,
      ...roleSignalExtras,
    };
  }

  // Soft flags that push to REVIEW
  const reviewReasons = [];

  if (legitimacy.verdict === "suspect") {
    reviewReasons.push(`legitimacy suspect: ${legitimacy.reason}`);
  }

  if (comp.verdict === "below-floor") {
    reviewReasons.push(`comp below floor: ${comp.reason}`);
  }
  if (comp.verdict === "estimated-below-floor") {
    reviewReasons.push(`comp likely below floor: ${comp.reason}`);
  }
  if (comp.verdict === "estimated") {
    reviewReasons.push(`comp estimated (no band posted): ${comp.reason}`);
  }
  if (comp.verdict === "review") {
    reviewReasons.push("comp unknown: no comp posted in JD");
  }
  if (comp.verdict === "OE-bucket") {
    reviewReasons.push("OE-bucket: verify opportunity before applying");
  }
  if (fit.tier === "stretch") {
    reviewReasons.push(`fit is stretch (score ${fit.score})`);
  }
  if (fit.tier === "med" && shouldReviewMediumBodyReadFits(modes)) {
    reviewReasons.push("application mode selective: medium fit requires manual review");
  }
  if (!location.ok) {
    reviewReasons.push(`location concern: ${location.reason}`);
  }

  // Degree check (soft — caveat only, not a hard cut per spec)
  const degreePolicy = effectiveTargeting?.degree_policy ? effectiveTargeting.degree_policy : "";
  const graduateDegreeToken = ["mas", "ter"].join("");
  const degreeRequirementPattern = new RegExp(
    `\\b(bachelor|${graduateDegreeToken}|phd|degree required)\\b`,
    "i"
  );
  const requiresDegree = degreeRequirementPattern.test(body);
  if (requiresDegree && /\bno[- ]degree|degree[- ]not required\b/i.test(degreePolicy)) {
    reviewReasons.push("JD requires a degree; check degree_policy");
  }

  if (reviewReasons.length > 0) {
    return {
      gate: "REVIEW",
      fit,
      comp,
      anchor,
      location,
      legitimacy,
      action:
        comp.verdict === "below-floor" || comp.verdict === "estimated-below-floor"
          ? "hold"
          : "manual",
      reasons: reviewReasons,
      ...roleSignalExtras,
    };
  }

  reasons.push(`fit ${fit.tier} (score ${fit.score}); comp ${comp.verdict}`);
  return {
    gate: "KEEP",
    fit,
    comp,
    anchor,
    location,
    legitimacy,
    action: "apply-now",
    reasons,
    ...roleSignalExtras,
  };
}

// ---------------------------------------------------------------------------
// renderGateBlock
// ---------------------------------------------------------------------------

/**
 * Renders the 4-line gate block matching the SKILL contract:
 *
 *   GATE: <KEEP|CUT|REVIEW> - <reason>
 *   FIT: <high|med|stretch> <score> - <why> | caveats: <...> | priority: <...>
 *   COMP: <clear|review|below-floor|OE-bucket> - <reason>
 *   COMP ANCHOR: <salary to state> - <rationale>   (only on KEEP/REVIEW with a target configured)
 *   LEGITIMACY: suspect - <reason>      (only when the posting looks suspect)
 *   ACTION: <apply-now|hold|manual|cut>
 */
export function renderGateBlock(result) {
  const { gate, fit, comp, anchor, legitimacy, action, reasons } = result;
  const gateReason = Array.isArray(reasons) && reasons.length > 0 ? reasons[0] : gate.toLowerCase();

  const lines = [
    `GATE: ${gate} - ${gateReason}`,
    `FIT: ${fit.tier} ${fit.score} - ${fit.why} | caveats: ${fit.caveats} | priority: ${fit.priority}`,
    `COMP: ${comp.verdict} - ${comp.reason}`,
  ];
  if (comp && comp.estimate) {
    const e = comp.estimate;
    lines.push(
      `COMP ESTIMATE: $${e.lowK}K–$${e.highK}K (mid $${e.midpointK}K) - ${e.basis}; confidence ${e.confidence} (confirm live before anchoring)`
    );
  }
  if (anchor && anchor.value != null) {
    const figure =
      typeof anchor.value === "number" ? `$${anchor.value.toLocaleString()}` : String(anchor.value);
    lines.push(`COMP ANCHOR: ${figure} - ${anchor.rationale}`);
  }
  if (legitimacy && legitimacy.verdict === "suspect") {
    lines.push(`LEGITIMACY: suspect - ${legitimacy.reason}`);
  }
  lines.push(`ACTION: ${action}`);

  return lines.join("\n");
}
