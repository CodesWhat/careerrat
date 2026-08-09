import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { effectiveTargetingForRole } from "../deep-ingest/role-signal-overlay.mjs";
import { userPath } from "../paths/workspace.mjs";
import { scannerLikelyKeepThreshold } from "../profile/modes.mjs";
import { fetchRemoteOk } from "../providers/remoteok.mjs";
import { fetchRemotive } from "../providers/remotive.mjs";
import { feedItemsToOffers, parseFeed } from "../providers/rss.mjs";
import { fetchWorkingNomads } from "../providers/workingnomads.mjs";
import { classifyRoleFamily } from "../tracker/outcome-analysis.mjs";
import { normalizeCompanyRoleKey } from "../tracker/tracker-data.mjs";

export { normalizeCompanyRoleKey };

// --- Board-wide aggregator feed registry ------------------------------------
// Board sources (config/search-sources.yml entries with source_type:"board") are
// broad, unauthenticated job-board feeds — unlike tracked_companies (one company's
// ATS) or rss sources (one saved search's feed), a board entry returns the whole
// board and relies on the entry's title_filter/location_filter to narrow it. Kept
// as a small registry (rather than inline in scanBoards) so countDeterministicSources
// in first-search-run.mjs can check provider support without duplicating the list.
const BOARD_PROVIDERS = {
  remoteok: fetchRemoteOk,
  remotive: fetchRemotive,
  workingnomads: fetchWorkingNomads,
};

export function isBoardProviderSupported(provider) {
  return Boolean(BOARD_PROVIDERS[String(provider || "").toLowerCase()]);
}

// --- Cold-family down-weight (outcome-aware scoring) ---------------------------
// The coarse scanner scores on title/keep-signal matching and is otherwise blind
// to how the candidate's applications actually convert. Every role it sources is
// a cold-board lead, so when the candidate's own recorded outcomes show a role
// family that never converts via cold apply (enough applications, zero advances,
// repeated rejections), a keep-signal title match should NOT keep surfacing that
// dead lane at "high". `computeFamilyOutcomes` derives the per-family signal; the
// scorer applies the penalty. Domain-neutral: families come from the candidate's
// targeting, nothing role-specific is hardcoded. The reevaluation lesson lives in
// outcomes — this is where it reaches the score.
const COLD_FAMILY_MIN_APPS = 8; // don't penalize thin samples
const COLD_FAMILY_MIN_REJECTS = 3; // mirrors reevaluation rejectionPerFamily
const COLD_FAMILY_PENALTY = 22; // knocks a keep-signal high (~86) down out of "high"

// A status that means the application got past the resume filter to a human —
// anything short of this (still in the awaiting void) is not yet a positive signal.
const ADVANCED_STATUSES = new Set([
  "interview",
  "offer",
  "recruiter screen",
  "screen",
  "onsite",
  "technical",
  "hiring manager",
  "final",
]);

/**
 * Per-family conversion stats from recorded application outcomes.
 * @param {Array<{role?:string,status?:string}>} apps - tracker applications (loadTrackerData shape)
 * @param {object} [targeting] - targeting.yml contents (role_families / role_buckets)
 * @returns {Record<string,{total:number,advanced:number,rejected:number,cold:boolean}>}
 */
export function computeFamilyOutcomes(apps = [], targeting) {
  const stats = {};
  for (const a of apps) {
    const fam = classifyRoleFamily(a.role || "", targeting);
    if (!stats[fam]) stats[fam] = { total: 0, advanced: 0, rejected: 0, cold: false };
    const s = stats[fam];
    s.total += 1;
    if (a.status === "rejected" || a.status === "passed") s.rejected += 1;
    else if (ADVANCED_STATUSES.has(a.status)) s.advanced += 1;
  }
  for (const fam of Object.keys(stats)) {
    const s = stats[fam];
    s.cold =
      s.total >= COLD_FAMILY_MIN_APPS && s.advanced === 0 && s.rejected >= COLD_FAMILY_MIN_REJECTS;
  }
  return stats;
}

const DEFAULT_TIMEOUT_MS = 15000;

export function normalizeKeywordList(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((item) => typeof item === "string")
    .map((item) => item.toLowerCase().trim())
    .filter(Boolean);
}

export function buildTitleFilter(titleFilter = {}) {
  const positive = normalizeKeywordList(titleFilter.positive);
  const negative = normalizeKeywordList(titleFilter.negative);
  return (title = "") => {
    const lower = title.toLowerCase();
    const hasPositive =
      positive.length === 0 ||
      positive.some(
        (term) => keywordMatches(lower, term) || boundedRoleTitleEquivalent(lower, term)
      );
    const hasNegative = negative.some((term) => keywordMatches(lower, term));
    return hasPositive && !hasNegative;
  };
}

// Full target titles are often narrower labels than employers use for the
// same engineering lane ("Staff Platform Engineer" vs "Staff Software
// Engineer, Infrastructure Foundations"). Exact substring matching rejects
// those while doing nothing useful to keep Product, Sales, DevRel, or
// Security out. This bounded fallback requires all three dimensions below:
// compatible engineering kind, compatible seniority, and a shared domain
// family. It only runs for full engineering/developer target titles; fragment
// filters such as "Applied AI" retain their exact-match behavior.
const TITLE_DOMAIN_FAMILIES = [
  new Set([
    "backend",
    "cloud",
    "compute",
    "distributed",
    "infrastructure",
    "observability",
    "platform",
    "reliability",
    "server",
    "storage",
    "systems",
  ]),
  new Set(["finance", "financial", "fintech", "payment", "payments"]),
];
const TITLE_SPECIALIZATIONS = [
  "advocate",
  "marketing",
  "product",
  "sales",
  "security",
  "solutions",
  "success",
  "support",
];
const TITLE_ENGINEERING_KINDS = new Set(["developer", "engineer", "engineering"]);
const TITLE_SENIORITY_GROUPS = [
  new Set(["staff", "principal", "lead"]),
  new Set(["senior", "sr"]),
];

function titleTokens(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  );
}

function hasAny(tokens, values) {
  return [...values].some((value) => tokens.has(value));
}

function boundedRoleTitleEquivalent(actualTitle, targetTitle) {
  const actual = titleTokens(actualTitle);
  const target = titleTokens(targetTitle);
  if (!hasAny(target, TITLE_ENGINEERING_KINDS) || !hasAny(actual, TITLE_ENGINEERING_KINDS)) {
    return false;
  }

  // Adjacent functions with an engineering-adjacent noun are still distinct
  // lanes unless the target explicitly names that specialization.
  if (
    TITLE_SPECIALIZATIONS.some(
      (specialization) => actual.has(specialization) && !target.has(specialization)
    )
  ) {
    return false;
  }

  const targetSeniority = TITLE_SENIORITY_GROUPS.find((group) => hasAny(target, group));
  if (targetSeniority) {
    const compatible =
      hasAny(actual, targetSeniority) ||
      (targetSeniority.has("senior") && hasAny(actual, TITLE_SENIORITY_GROUPS[0]));
    if (!compatible) return false;
  }

  const targetDomains = TITLE_DOMAIN_FAMILIES.filter((family) => hasAny(target, family));
  return targetDomains.length > 0 && targetDomains.some((family) => hasAny(actual, family));
}

function keywordMatches(text, term) {
  const t = String(term || "").trim();
  if (!t) return false;
  const left = /^[a-z0-9]/.test(t) ? "(^|[^a-z0-9])" : "";
  const right = /[a-z0-9]$/.test(t) ? "($|[^a-z0-9])" : "";
  return new RegExp(`${left}${escapeRegExp(t)}${right}`).test(text);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildLocationFilter(locationFilter = null) {
  if (!locationFilter) return () => true;
  if (locationFilter.needs_location === true) return () => false;
  const alwaysAllow = normalizeKeywordList(locationFilter.always_allow);
  const allow = normalizeKeywordList(locationFilter.allow);
  const block = normalizeKeywordList(locationFilter.block);
  const hasPolicy = alwaysAllow.length > 0 || allow.length > 0 || block.length > 0;

  return (location = "") => {
    // A missing provider location is ambiguous, not evidence of a foreign role.
    // Keep it for body review when the candidate otherwise has a real policy.
    if (typeof location !== "string" || location.trim() === "") return true;
    if (!hasPolicy) return true;
    const lower = location.toLowerCase();
    if (alwaysAllow.some((term) => keywordMatches(lower, term))) return true;
    if (block.some((term) => keywordMatches(lower, term))) return false;
    return allow.some((term) => keywordMatches(lower, term));
  };
}

const MANAGEMENT_TITLE_RE =
  /\b(manager|director|head|vice president|vp|chief|people lead|engineering lead)\b/i;
const EARLY_CAREER_TITLE_RE = /\b(intern(ship)?|junior|jr\.?|entry[ -]level|graduate)\b/i;
const SENIOR_TITLE_RE = /\b(senior|sr\.?|staff|principal|distinguished|fellow)\b/i;
const REMOTE_RE = /\b(remote|work from home|wfh|distributed)\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const ONSITE_RE = /\b(on[ -]?site|in[ -]?office|office[ -]?based)\b/i;
const GLOBAL_REMOTE_RE = /\b(worldwide|anywhere|global)\b/i;
const US_REMOTE_RE =
  /\b(united states|u\.?s\.?a?\.?|us[- ](?:only|based)|north america)\b/i;
const FOREIGN_REMOTE_RE =
  /\b(ireland|united kingdom|uk|europe|emea|canada|india|asia|apac|australia|new zealand|singapore|germany|france|spain|portugal|poland|netherlands|sweden|norway|denmark|switzerland|israel|brazil|mexico)\b/i;
const NO_SPONSORSHIP_RE =
  /\b(?:no|not|cannot|can't|unable to|do not|does not|won't|will not)\b[^.\n]{0,50}\b(?:visa )?sponsor(?:ship)?\b|\b(?:visa )?sponsorship\b[^.\n]{0,50}\b(?:not available|is unavailable)\b/i;
const US_STATE_RE =
  /(?:^|[,\s])(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:$|[,\s])/i;

// Small offline centroid registry for the metro aliases most likely to differ
// between a candidate's neighborhood and an ATS display label. Exact locality
// matching works everywhere; these centroids make configured radii meaningful
// without an API key. Unknown places stay reviewable, never silently pass as local.
const LOCATION_CENTROIDS = [
  ["brooklyn ny", 40.6782, -73.9442],
  ["new york ny", 40.7128, -74.006],
  ["new york city", 40.7128, -74.006],
  ["manhattan ny", 40.7831, -73.9712],
  ["queens ny", 40.7282, -73.7949],
  ["jersey city nj", 40.7178, -74.0431],
  ["newark nj", 40.7357, -74.1724],
  ["albany ny", 42.6526, -73.7562],
];

function normalizePlace(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(remote|hybrid|on[ -]?site|in[ -]?office)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function coordinatesForPlace(value) {
  const normalized = normalizePlace(value);
  if (!normalized) return null;
  const match = LOCATION_CENTROIDS.find(([alias]) =>
    new RegExp(`(?:^| )${escapeRegExp(alias)}(?: |$)`).test(normalized)
  );
  return match ? { latitude: match[1], longitude: match[2] } : null;
}

function haversineMiles(left, right) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = radians(right.latitude - left.latitude);
  const dLon = radians(right.longitude - left.longitude);
  const lat1 = radians(left.latitude);
  const lat2 = radians(right.latitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function targetTitles(config = {}) {
  return (Array.isArray(config?.targeting?.role_buckets) ? config.targeting.role_buckets : [])
    .flatMap((bucket) => (Array.isArray(bucket?.titles) ? bucket.titles : []))
    .map((title) => String(title || "").trim())
    .filter(Boolean);
}

function seniorityEligibility(offer, config) {
  const targets = targetTitles(config);
  if (targets.length === 0) return { eligible: true };
  const title = String(offer?.title || "");
  const targetsManagement = targets.some((target) => MANAGEMENT_TITLE_RE.test(target));
  if (MANAGEMENT_TITLE_RE.test(title) && !targetsManagement) {
    return { eligible: false, reason: "management-track-mismatch" };
  }
  const targetsSenior = targets.some((target) => SENIOR_TITLE_RE.test(target));
  if (targetsSenior && EARLY_CAREER_TITLE_RE.test(title)) {
    return { eligible: false, reason: "seniority-below-target" };
  }
  return { eligible: true };
}

function homeLooksUs(home) {
  return US_STATE_RE.test(String(home || "")) || /\bunited states|\busa\b/i.test(String(home || ""));
}

function placeMatchesAllowed(location, places) {
  const normalized = normalizePlace(location);
  return places.some((place) => {
    const candidate = normalizePlace(place);
    return candidate && (normalized.includes(candidate) || candidate.includes(normalized));
  });
}

function commuteEligibility(location, profileLocation) {
  const home = String(profileLocation?.home || "").trim();
  const relocations = Array.isArray(profileLocation?.relocation)
    ? profileLocation.relocation.filter(Boolean)
    : [];
  if (placeMatchesAllowed(location, [home, ...relocations])) return { eligible: true };

  const radius = Number(profileLocation?.commute_radius_miles);
  const homeCoordinates =
    Number.isFinite(Number(profileLocation?.home_latitude)) &&
    Number.isFinite(Number(profileLocation?.home_longitude))
      ? {
          latitude: Number(profileLocation.home_latitude),
          longitude: Number(profileLocation.home_longitude),
        }
      : coordinatesForPlace(home);
  const jobCoordinates = coordinatesForPlace(location);
  if (Number.isFinite(radius) && radius > 0 && homeCoordinates && jobCoordinates) {
    const distanceMiles = haversineMiles(homeCoordinates, jobCoordinates);
    return {
      eligible: distanceMiles <= radius,
      reason: distanceMiles <= radius ? undefined : "outside-commute-radius",
      distanceMiles: Math.round(distanceMiles * 10) / 10,
    };
  }
  return { eligible: false, reason: "outside-commute-area" };
}

function locationEligibility(offer, config) {
  const location = String(offer?.location || "").trim();
  const title = String(offer?.title || "");
  const profileLocation = config?.profile?.location || {};
  const hasLocationPolicy =
    Boolean(String(profileLocation?.home || "").trim()) ||
    (Array.isArray(profileLocation?.relocation) && profileLocation.relocation.length > 0) ||
    ["remote", "hybrid", "onsite"].some(
      (mode) => typeof profileLocation?.[mode] === "boolean"
    );
  if (!hasLocationPolicy) return { eligible: true };
  if (!location) return { eligible: true, unknown: "location" };

  const remote = REMOTE_RE.test(`${title}\n${location}`);
  const hybrid = HYBRID_RE.test(`${title}\n${location}`);
  const onsite = ONSITE_RE.test(`${title}\n${location}`);
  const hasExplicitModes = ["remote", "hybrid", "onsite"].some(
    (mode) => typeof profileLocation?.[mode] === "boolean"
  );

  if (remote) {
    if (hasExplicitModes && profileLocation.remote !== true) {
      return { eligible: false, reason: "remote-not-allowed" };
    }
    if (GLOBAL_REMOTE_RE.test(location)) return { eligible: true };
    if (homeLooksUs(profileLocation.home)) {
      if (FOREIGN_REMOTE_RE.test(location) && !US_REMOTE_RE.test(location)) {
        return { eligible: false, reason: "remote-region-mismatch" };
      }
      if (!US_REMOTE_RE.test(location)) return { eligible: true, unknown: "remote-region" };
    }
    return { eligible: true };
  }

  const modeAllowed = hybrid
    ? profileLocation.hybrid === true
    : onsite
      ? profileLocation.onsite === true
      : profileLocation.hybrid === true || profileLocation.onsite === true;
  if (hasExplicitModes && !modeAllowed) {
    return { eligible: false, reason: hybrid ? "hybrid-not-allowed" : "onsite-not-allowed" };
  }
  return commuteEligibility(location, profileLocation);
}

function maxPostingAgeDays(config = {}) {
  const postingAge = config?.targeting?.search_preferences?.posting_age;
  if (postingAge?.mode !== "fixed-days") return null;
  const days = Number(postingAge.days);
  return Number.isFinite(days) && days > 0 ? days : null;
}

function postingAgeEligibility(offer, config, now) {
  if (offer?.postedAt === null || offer?.postedAt === undefined || offer?.postedAt === "") {
    return { eligible: true, unknown: "postedAt" };
  }
  const postedAt =
    typeof offer.postedAt === "number" ? offer.postedAt : Date.parse(String(offer.postedAt));
  if (!Number.isFinite(postedAt)) return { eligible: true, unknown: "postedAt" };
  const days = maxPostingAgeDays(config);
  if (!days) return { eligible: true };
  return postedAt >= now - days * 86400000
    ? { eligible: true }
    : { eligible: false, reason: "posting-too-old" };
}

function salaryEligibility(offer, config) {
  const floor = Number(config?.profile?.compensation?.minimum_base);
  const band = extractCompBand(
    [offer?.comp, offer?.bodyText, offer?.description].filter(Boolean).join("\n")
  );
  if (!band) return { eligible: true, unknown: "compensation" };
  if (Number.isFinite(floor) && floor > 0 && band.max < floor) {
    return { eligible: false, reason: "comp-below-floor", band };
  }
  return { eligible: true };
}

function contentEligibility(offer, config) {
  const body = String(offer?.bodyText || offer?.description || "");
  if (config?.profile?.authorization?.requires_sponsorship === true && NO_SPONSORSHIP_RE.test(body)) {
    return { eligible: false, reason: "sponsorship-unavailable" };
  }
  return { eligible: true };
}

function scoreSourcedOfferFromConfig(
  offer = {},
  { targeting, profile, modes, familyOutcomes, roleSignals }
) {
  const title = String(offer.title || "").toLowerCase();
  const company = String(offer.company || "").toLowerCase();
  const location = String(offer.location || "").toLowerCase();
  const compText = String(offer.comp || "");
  const body = String(offer.bodyText || offer.description || "");
  const text = `${title}\n${body}`.toLowerCase();
  const hasBody = body.trim().length > 300;

  // Role-signal overlay: ephemeral merge of confirmed keep/cut rows into
  // targeting, resolved per-offer from this offer's own title, before the
  // keep/cut arrays below are read — a matching row raises/penalizes the
  // score exactly like a base signal. No rows (or none matching) → the
  // effective targeting is identical to `targeting` and scoring is unchanged.
  const roleSignalOverlay = effectiveTargetingForRole({
    roleTitle: offer.title || "",
    targeting,
    roleSignals,
  });
  const effectiveTargeting = roleSignalOverlay.targeting;
  // Attribution only for callers that opted into role signals — legacy
  // callers must receive a byte-identical rating object.
  const roleSignalExtras =
    roleSignals === undefined
      ? {}
      : {
          roleSignalIds: [...roleSignalOverlay.applied.keep, ...roleSignalOverlay.applied.cut].map(
            (s) => s.id
          ),
        };

  let score = hasBody ? 58 : 52;
  const reasons = [];
  const flags = [];

  const setBase = (value, reason) => {
    if (value > score) {
      score = value;
      reasons.unshift(reason);
    }
  };
  const add = (value, reason) => {
    score += value;
    reasons.push(reason);
  };
  const flag = (value) => {
    if (!flags.includes(value)) flags.push(value);
  };

  // --- Exclusions from targeting.excluded_companies ---
  const excludedCompanies = normalizeKeywordList(
    targeting?.excluded_companies ? targeting.excluded_companies : []
  );
  for (const ex of excludedCompanies) {
    if (keywordMatches(company, ex)) {
      add(-45, "excluded company unless exceptional comp");
      flag("excluded-company");
      break;
    }
  }

  // --- Keep shapes from targeting.keep_signals + targeting.role_buckets titles ---
  const keepSignals = normalizeKeywordList(
    effectiveTargeting?.keep_signals ? effectiveTargeting.keep_signals : []
  );
  const bucketTitles = [];
  if (effectiveTargeting && Array.isArray(effectiveTargeting.role_buckets)) {
    for (const bucket of effectiveTargeting.role_buckets) {
      if (bucket.title) bucketTitles.push(String(bucket.title).toLowerCase().trim());
      if (Array.isArray(bucket.titles)) {
        for (const t of bucket.titles) bucketTitles.push(String(t).toLowerCase().trim());
      }
    }
  }
  const allKeepTerms = [...keepSignals, ...bucketTitles.filter(Boolean)];
  for (const term of allKeepTerms) {
    if (keywordMatches(title, term) || keywordMatches(text, term)) {
      setBase(82, `matches keep signal: ${term}`);
    }
  }

  // --- Cut signals from targeting.cut_signals ---
  const cutSignals = normalizeKeywordList(
    effectiveTargeting?.cut_signals ? effectiveTargeting.cut_signals : []
  );
  for (const term of cutSignals) {
    if (keywordMatches(title, term) || keywordMatches(text, term)) {
      const kebab = term.replace(/\s+/g, "-");
      add(-30, `cut signal: ${term}`);
      flag(`cut-risk-${kebab}`);
    }
  }

  // --- Cold-family down-weight from recorded outcomes ---
  // Every scanner-sourced role is a cold-board lead. If the candidate's own
  // outcomes show this role family never converts via cold apply, discount it so
  // a keep-signal title match doesn't keep surfacing a dead lane at "high".
  if (familyOutcomes) {
    const offerFamily = classifyRoleFamily(offer.title || "", targeting);
    const fam = familyOutcomes[offerFamily];
    if (fam?.cold) {
      add(
        -COLD_FAMILY_PENALTY,
        `cold-board lane: ${offerFamily} has 0 advances in ${fam.total} apps`
      );
      flag("family-cold");
    }
  }

  // --- Comp floor from profile.compensation.minimum_base ---
  const minimumBase =
    profile && profile.compensation && profile.compensation.minimum_base != null
      ? Number(profile.compensation.minimum_base)
      : null;
  const comp = extractCompBand(`${compText}\n${body}`);
  if (minimumBase !== null && Number.isFinite(minimumBase)) {
    if (comp) {
      if (comp.max < minimumBase) {
        add(-24, "base below floor");
        flag("comp-below-floor");
      } else if (comp.min < minimumBase) {
        add(-6, "must land top of band");
        flag("top-of-band-only");
      } else {
        add(4, "comp clears floor");
      }
    } else {
      flag("comp-unposted");
    }
  } else {
    if (!comp) flag("comp-unposted");
  }

  // --- Location bonus from profile.location ---
  const homeLoc = String(profile?.location?.home ? profile.location.home : "")
    .toLowerCase()
    .trim();
  const reloMetros = normalizeKeywordList(
    profile?.location && Array.isArray(profile.location.relocation)
      ? profile.location.relocation
      : []
  );

  if (homeLoc && location.includes(homeLoc)) {
    add(5, "home/relo region");
  } else if (reloMetros.some((metro) => location.includes(metro))) {
    add(5, "home/relo region");
  } else if (/\b(remote|united states|usa|us)\b/.test(location)) {
    add(5, "remote/US location");
  }

  if (/\b(onsite|on-site|in office|in-office|5 days?\/week|five days? a week)\b/.test(text)) {
    add(-5, "office burden");
    flag("office-burden");
  }
  if (/\b(25\s*[-–]\s*50%|50%\+?|up to 50%|heavy travel|significant travel)\b/.test(text)) {
    add(-8, "travel burden");
    flag("travel");
  }

  const clamped = Math.max(35, Math.min(95, Math.round(score)));
  return {
    fit: fitFromScore(clamped),
    score: clamped,
    gate: gateFromScoreAndFlags(clamped, flags, modes),
    ratingReason: reasons.slice(0, 5).join("; "),
    ruleFlags: flags,
    ...roleSignalExtras,
  };
}

export function scoreSourcedOffer(offer = {}, config = {}) {
  return scoreSourcedOfferFromConfig(offer, config);
}

export function fitFromScore(score) {
  if (score >= 82) return "high";
  if (score >= 65) return "med";
  return "stretch";
}

function gateFromScoreAndFlags(score, flags, modes = {}) {
  if (
    flags.some(
      (flag) =>
        flag.startsWith("cut-risk") || flag === "excluded-company" || flag === "comp-below-floor"
    )
  )
    return "likely-cut";
  if (
    flags.some(
      (flag) =>
        flag === "comp-unposted" ||
        flag === "top-of-band-only" ||
        flag === "ca-comp-unverified" ||
        flag === "family-cold"
    )
  )
    return "review";
  if (score >= scannerLikelyKeepThreshold(modes)) return "likely-keep";
  return "review";
}

export function extractCompBand(text = "") {
  const source = String(text || "");
  const candidates = [];
  const lines = source
    .split(/\n|\. /)
    .filter((line) => /\$|\b(compensation|salary|base|pay range|annual|usd)\b/i.test(line));

  for (const line of lines) {
    const normalized = line.replace(/,/g, "");
    const re =
      /(?:usd\s*)?\$?\s*(\d{2,6}(?:\.\d+)?)(\s*k)?\s*(?:-|–|—|to)\s*(?:usd\s*)?\$?\s*(\d{2,6}(?:\.\d+)?)(\s*k)?/gi;
    for (const match of normalized.matchAll(re)) {
      const min = normalizeMoney(match[1], match[2]);
      const max = normalizeMoney(match[3], match[4]);
      if (min >= 50000 && max >= min && max <= 1200000) candidates.push({ min, max });
    }
  }

  return candidates.sort((a, b) => b.max - b.min - (a.max - a.min) || b.max - a.max)[0] || null;
}

function normalizeMoney(value, suffix = "") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (suffix.trim().toLowerCase() === "k") return numeric * 1000;
  if (numeric < 1000) return numeric * 1000;
  return numeric;
}

export function htmlToText(value = "") {
  let text = decodeHtmlEntities(String(value || ""));
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|section|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(text)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value = "") {
  const ENTITY_MAP = {
    "&lt;": "<",
    "&gt;": ">",
    "&amp;": "&",
    "&quot;": '"',
    "&#39;": "'",
    "&rsquo;": "'",
    "&lsquo;": "'",
    "&rdquo;": '"',
    "&ldquo;": '"',
    "&mdash;": "—",
    "&#8212;": "—",
    "&#x2014;": "—",
    "&ndash;": "–",
    "&#8211;": "–",
    "&#x2013;": "–",
    "&nbsp;": " ",
  };
  // Single-pass replacement avoids order-dependent double-decoding.
  return String(value).replace(
    /&(?:lt|gt|amp|quot|#39|rsquo|lsquo|rdquo|ldquo|mdash|#8212|#x2014|ndash|#8211|#x2013|nbsp);/gi,
    (m) => ENTITY_MAP[m.toLowerCase()] ?? m
  );
}

export function inferProvider(entry = {}) {
  if (entry.provider) return entry.provider;
  const url = entry.careers_url || "";
  if (/jobs\.ashbyhq\.com\//.test(url)) return "ashby";
  if (/job-boards(?:\.eu)?\.greenhouse\.io\/|boards\.greenhouse\.io\//.test(url))
    return "greenhouse";
  if (/jobs\.lever\.co\//.test(url)) return "lever";
  if (/apply\.workable\.com\//.test(url)) return "workable";
  if (/(careers|jobs)\.smartrecruiters\.com\//.test(url)) return "smartrecruiters";
  if (/\/\/[a-z0-9][a-z0-9-]*\.recruitee\.com/i.test(url)) return "recruitee";
  if (/[\w-]+\.wd[\w-]*\.myworkdayjobs\.com\//.test(url)) return "workday";
  return null;
}

export function filterAndDedupeOffers(
  offers,
  {
    seenUrls,
    seenReqIds = new Set(),
    seenCompanyRoles,
    titleFilter,
    locationFilter,
    config = {},
    now = Date.now(),
    companyPresentationCounts = new Map(),
    perCompanyCap = Infinity,
  }
) {
  const kept = [];
  const filteredTitle = [];
  const filteredSeniority = [];
  const filteredLocation = [];
  const filteredAge = [];
  const filteredSalary = [];
  const filteredEligibility = [];
  const duplicates = [];
  const possibleDuplicates = [];
  const invalid = [];
  const overflow = [];
  const qualified = [];

  for (const [inputIndex, offer] of offers.entries()) {
    if (!offer.url || !offer.title || !offer.company) {
      invalid.push({ ...offer, reason: "missing url, title, or company" });
      continue;
    }
    if (!titleFilter(offer.title)) {
      filteredTitle.push({ ...offer, qualificationReason: "title-mismatch" });
      continue;
    }
    const seniority = seniorityEligibility(offer, config);
    if (!seniority.eligible) {
      filteredSeniority.push({ ...offer, qualificationReason: seniority.reason });
      continue;
    }
    if (!locationFilter(offer.location || "", offer.url, offer.title, offer)) {
      filteredLocation.push({ ...offer, qualificationReason: "location-policy-mismatch" });
      continue;
    }
    const qualifiedLocation = locationEligibility(offer, config);
    if (!qualifiedLocation.eligible) {
      filteredLocation.push({
        ...offer,
        qualificationReason: qualifiedLocation.reason,
        ...(qualifiedLocation.distanceMiles == null
          ? {}
          : { distanceMiles: qualifiedLocation.distanceMiles }),
      });
      continue;
    }
    const age = postingAgeEligibility(offer, config, Number(now));
    if (!age.eligible) {
      filteredAge.push({ ...offer, qualificationReason: age.reason });
      continue;
    }
    const salary = salaryEligibility(offer, config);
    if (!salary.eligible) {
      filteredSalary.push({ ...offer, qualificationReason: salary.reason, compBand: salary.band });
      continue;
    }
    const content = contentEligibility(offer, config);
    if (!content.eligible) {
      filteredEligibility.push({ ...offer, qualificationReason: content.reason });
      continue;
    }
    const key = normalizeCompanyRoleKey(offer.company, offer.title);
    const req = extractReqId(offer.url);
    if (seenUrls.has(offer.url) || (req.id && seenReqIds.has(req.id))) {
      duplicates.push({
        ...offer,
        duplicateReason: seenUrls.has(offer.url) ? "url" : "req_id",
        reqId: req.id,
      });
      continue;
    }
    seenUrls.add(offer.url);
    if (req.id) seenReqIds.add(req.id);
    const possibleDuplicate = seenCompanyRoles.has(key);
    if (possibleDuplicate) possibleDuplicates.push(offer);
    seenCompanyRoles.add(key);
    const qualificationUnknowns = [qualifiedLocation.unknown, age.unknown, salary.unknown].filter(
      Boolean
    );
    qualified.push({
      ...offer,
      key,
      reqId: req.id,
      possibleDuplicate,
      qualificationUnknowns,
      _qualificationInputIndex: inputIndex,
      ...scoreSourcedOffer(offer, config),
    });
  }

  // A company board is usually newest-first, but not all providers guarantee
  // it. Rank the already-qualified survivors before applying the presentation
  // cap so one employer cannot fill the default inbox with weaker roles.
  const normalizedCap = Number(perCompanyCap);
  const cap = Number.isFinite(normalizedCap) && normalizedCap > 0 ? normalizedCap : Infinity;
  if (Number.isFinite(cap)) {
    qualified.sort((left, right) => {
      const scoreDelta = Number(right.score || 0) - Number(left.score || 0);
      if (scoreDelta) return scoreDelta;
      const rightPosted = Date.parse(String(right.postedAt || ""));
      const leftPosted = Date.parse(String(left.postedAt || ""));
      if (
        Number.isFinite(rightPosted) &&
        Number.isFinite(leftPosted) &&
        rightPosted !== leftPosted
      ) {
        return rightPosted - leftPosted;
      }
      return left._qualificationInputIndex - right._qualificationInputIndex;
    });
  }
  for (const offer of qualified) {
    const companyKey = String(offer.company || "").trim().toLowerCase();
    const presented = Number(companyPresentationCounts.get(companyKey) || 0);
    const { _qualificationInputIndex, ...cleanOffer } = offer;
    if (presented >= cap) {
      overflow.push({ ...cleanOffer, qualificationReason: "per-company-cap" });
      continue;
    }
    companyPresentationCounts.set(companyKey, presented + 1);
    kept.push(cleanOffer);
  }

  return {
    kept,
    filteredTitle,
    filteredSeniority,
    filteredLocation,
    filteredAge,
    filteredSalary,
    filteredEligibility,
    duplicates,
    possibleDuplicates,
    invalid,
    overflow,
  };
}

export function extractReqId(rawUrl = "") {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname;
    const greenhouse = path.match(/\/jobs\/(\d+)/);
    if (greenhouse)
      return { provider: "greenhouse", value: greenhouse[1], id: `greenhouse:${greenhouse[1]}` };
    const ashby = path.match(/\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/|$)/i);
    if (ashby)
      return {
        provider: "ashby",
        value: ashby[1].toLowerCase(),
        id: `ashby:${ashby[1].toLowerCase()}`,
      };
    const lever = path.match(/\/([^/]+)$/);
    if (url.hostname === "jobs.lever.co" && lever)
      return { provider: "lever", value: lever[1], id: `lever:${lever[1].toLowerCase()}` };
    const apple = path.match(/\/details\/([0-9-]+)/);
    if ((url.hostname === "apple.com" || url.hostname.endsWith(".apple.com")) && apple)
      return { provider: "apple", value: apple[1], id: `apple:${apple[1]}` };
    const hiringCafe = path.match(/\/job\/([a-z0-9_-]+)/i);
    if (url.hostname === "hiring.cafe" && hiringCafe)
      return {
        provider: "hiringcafe",
        value: hiringCafe[1].toLowerCase(),
        id: `hiringcafe:${hiringCafe[1].toLowerCase()}`,
      };
    const linkedIn = path.match(/\/jobs\/view\/(\d+)/);
    if ((url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) && linkedIn)
      return { provider: "linkedin", value: linkedIn[1], id: `linkedin:${linkedIn[1]}` };
  } catch {
    return { provider: null, value: null, id: null };
  }
  return { provider: null, value: null, id: null };
}

export async function scanCompanies(config, { fetchImpl = fetch, companyFilter = null } = {}) {
  const companies = (config.tracked_companies || [])
    .filter((entry) => entry && entry.enabled !== false)
    .filter(
      (entry) => !companyFilter || entry.name.toLowerCase().includes(companyFilter.toLowerCase())
    );

  const results = [];
  const errors = [];

  for (const company of companies) {
    const provider = inferProvider(company);
    if (!provider) {
      errors.push({ company: company.name, error: "no supported provider inferred" });
      continue;
    }
    try {
      const jobs = await fetchProvider(provider, company, fetchImpl);
      results.push(...jobs.map((job) => ({ ...job, source: `${provider}-api` })));
    } catch (error) {
      errors.push({ company: company.name, error: error.message });
    }
  }

  return { offers: results, errors };
}

export async function fetchProvider(provider, entry, fetchImpl = fetch) {
  if (provider === "ashby") return fetchAshby(entry, fetchImpl);
  if (provider === "greenhouse") return fetchGreenhouse(entry, fetchImpl);
  if (provider === "lever") return fetchLever(entry, fetchImpl);
  if (provider === "workable") return fetchWorkable(entry, fetchImpl);
  if (provider === "smartrecruiters") return fetchSmartRecruiters(entry, fetchImpl);
  if (provider === "recruitee") return fetchRecruitee(entry, fetchImpl);
  if (provider === "workday") return fetchWorkday(entry, fetchImpl);
  if (provider === "rss") return fetchRss(entry, fetchImpl);
  throw new Error(`unsupported provider: ${provider}`);
}

// Fetch + parse a single RSS source (a config/search-sources.yml entry with an
// rssUrl, or any { rssUrl | url }) into scanner offers. This is the runtime
// consumer for the rss.mjs provider.
export async function fetchRss(source = {}, fetchImpl = fetch) {
  const url = source.rssUrl || source.url;
  if (!url) return [];
  const res = await fetchImpl(url);
  const xml = typeof res === "string" ? res : await res.text();
  const { items } = parseFeed(xml);
  return feedItemsToOffers(items, { source });
}

// Scan the enabled RSS-bearing sources from a parsed config/search-sources.yml.
// This is what wires setup-searches output into the sourced sweep: any enabled
// source with source_type "rss" or an rssUrl is fetched and folded into the scan.
// Non-fetchable source types (browser/auth aggregators like HiringCafe, Wellfound,
// authenticated LinkedIn/Indeed) are driven by the agent's session browser per the
// Browser Automation Contract and are intentionally skipped here.
export async function scanSearchSources(searchSources, { fetchImpl = fetch } = {}) {
  const sources = (searchSources?.sources || searchSources?.searches || [])
    .filter((s) => s && s.enabled !== false)
    .filter((s) => s.source_type === "rss" || s.rssUrl);

  const results = [];
  const errors = [];
  for (const source of sources) {
    try {
      const offers = await fetchRss(source, fetchImpl);
      results.push(
        ...offers.map((offer) => ({ ...offer, source: source.label || offer.source || "rss" }))
      );
    } catch (error) {
      errors.push({ company: source.label || source.provider || "rss", error: error.message });
    }
  }
  return { offers: results, errors };
}

// Scan the enabled board-wide aggregator sources (source_type:"board" with a
// supported `provider`) from a parsed config/search-sources.yml. Sibling of
// scanSearchSources — same run path, same enabled-filter/error-isolation shape —
// but dispatches to BOARD_PROVIDERS instead of the RSS parser. Offers are tagged
// `source: "<provider>-board"`, mirroring scanCompanies' `"<provider>-api"` tag.
export async function scanBoards(searchSources, { fetchImpl = fetch } = {}) {
  const sources = (searchSources?.sources || searchSources?.searches || [])
    .filter((s) => s && s.enabled !== false)
    .filter((s) => s.source_type === "board" && isBoardProviderSupported(s.provider));

  const results = [];
  const errors = [];
  for (const source of sources) {
    const providerId = String(source.provider || "").toLowerCase();
    const provider = BOARD_PROVIDERS[providerId];
    try {
      const offers = await provider(source, fetchImpl);
      results.push(...offers.map((offer) => ({ ...offer, source: `${providerId}-board` })));
    } catch (error) {
      errors.push({ company: source.label || providerId, error: error.message });
    }
  }
  return { offers: results, errors };
}

async function fetchJson(url, fetchImpl, options = {}) {
  const response = await fetchWithTimeout(url, fetchImpl, options);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function fetchText(url, fetchImpl, options = {}) {
  const response = await fetchWithTimeout(url, fetchImpl, options);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function fetchWithTimeout(
  url,
  fetchImpl,
  { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 0, method, body, headers } = {}
) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init = { signal: controller.signal, redirect: "follow" };
      if (method) init.method = method;
      if (body !== undefined) init.body = body;
      if (headers) init.headers = headers;
      return await fetchImpl(url, init);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await delay(500 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function fetchAshby(entry, fetchImpl) {
  const slug = new URL(entry.careers_url).pathname.split("/").filter(Boolean)[0];
  const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  const json = await fetchJson(url, fetchImpl, { timeoutMs: 30000, retries: 2 });
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
  return jobs.map((job) => ({
    title: job.title || "",
    url: job.jobUrl || "",
    company: entry.name,
    location: job.location || "",
    comp: formatAshbyComp(job.compensation),
    bodyText: job.descriptionPlain || htmlToText(job.descriptionHtml || ""),
  }));
}

async function fetchGreenhouse(entry, fetchImpl) {
  const apiUrl = entry.api || greenhouseApiFromCareersUrl(entry.careers_url);
  if (!apiUrl) throw new Error("cannot derive Greenhouse API URL");
  const json = await fetchJson(withQueryParam(apiUrl, "content", "true"), fetchImpl);
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
  return jobs.map((job) => ({
    title: job.title || "",
    url: job.absolute_url || "",
    company: entry.name,
    location: job.location?.name || "",
    comp: "",
    bodyText: htmlToText(job.content || ""),
  }));
}

function withQueryParam(rawUrl, key, value) {
  const url = new URL(rawUrl);
  url.searchParams.set(key, value);
  return url.toString();
}

function greenhouseApiFromCareersUrl(rawUrl = "") {
  const match = rawUrl.match(
    /(?:job-boards(?:\.eu)?\.greenhouse\.io|boards\.greenhouse\.io)\/([^/?#]+)/
  );
  return match ? `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs` : null;
}

async function fetchLever(entry, fetchImpl) {
  const slug = new URL(entry.careers_url).pathname.split("/").filter(Boolean)[0];
  const jobs = await fetchJson(`https://api.lever.co/v0/postings/${slug}`, fetchImpl);
  return Array.isArray(jobs)
    ? jobs.map((job) => ({
        title: job.text || "",
        url: job.hostedUrl || "",
        company: entry.name,
        location: job.categories?.location || "",
        comp: formatLeverComp(job),
        bodyText: [
          job.descriptionBodyPlain || job.descriptionPlain,
          job.additionalPlain,
          job.salaryDescriptionPlain,
          ...(Array.isArray(job.lists)
            ? job.lists.map((list) => `${list.text || ""}\n${list.content || ""}`)
            : []),
        ]
          .filter(Boolean)
          .join("\n\n"),
      }))
    : [];
}

async function fetchWorkable(entry, fetchImpl) {
  const slug = new URL(entry.careers_url).pathname.split("/").filter(Boolean)[0];
  const text = await fetchText(`https://apply.workable.com/${slug}/jobs.md`, fetchImpl);
  return parseWorkableMarkdown(text, entry.name);
}

export function parseWorkableMarkdown(text, companyName) {
  const jobs = [];
  for (const line of String(text).split("\n")) {
    if (!line.startsWith("|") || !line.includes("[View]")) continue;
    const cols = line.split("|").map((col) => col.trim());
    const title = cols[1];
    const location = cols[3] || "";
    const urlMatch = line.match(/\[View\]\(([^)]+)\)/);
    let url = urlMatch ? urlMatch[1] : "";
    if (url.endsWith(".md")) url = url.slice(0, -3);
    if (!title || title === "Title" || !url) continue;
    jobs.push({ title, url, company: companyName, location, comp: "" });
  }
  return jobs;
}

const SR_PAGE_LIMIT = 100;
const SR_MAX_PAGES = 20;

async function fetchSmartRecruiters(entry, fetchImpl) {
  const slug = new URL(entry.careers_url).pathname.split("/").filter(Boolean)[0];
  const allJobs = [];
  let offset = 0;
  let totalElements = null;

  for (let page = 0; page < SR_MAX_PAGES; page++) {
    const url = `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${SR_PAGE_LIMIT}&offset=${offset}&status=PUBLIC`;
    const json = await fetchJson(url, fetchImpl);
    const jobs = Array.isArray(json?.content) ? json.content : [];
    allJobs.push(...jobs);

    if (totalElements === null && json?.totalElements != null) {
      totalElements = Number(json.totalElements);
    }

    const fetched = allJobs.length;
    const done =
      jobs.length < SR_PAGE_LIMIT || (totalElements !== null && fetched >= totalElements);
    if (done) break;

    offset += SR_PAGE_LIMIT;
    if (page === SR_MAX_PAGES - 1) {
      console.warn(
        `[sourced-scanner] SmartRecruiters ${slug}: stopped after ${SR_MAX_PAGES} pages` +
          (totalElements !== null ? ` (${totalElements - fetched} postings may be missing)` : "")
      );
    }
  }

  return allJobs.map((job) => {
    const loc = job.location || {};
    const location =
      loc.fullLocation ||
      [loc.city, loc.region, loc.country, loc.remote ? "Remote" : ""].filter(Boolean).join(", ");
    const titleSlug = (job.name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return {
      title: job.name || "",
      url: job.ref
        ? String(job.ref).replace(
            "https://api.smartrecruiters.com/v1/companies/",
            "https://jobs.smartrecruiters.com/"
          )
        : `https://jobs.smartrecruiters.com/${slug}/${job.id}-${titleSlug}`,
      company: entry.name,
      location,
      comp: "",
      bodyText: htmlToText(
        [
          job.jobAd?.sections?.jobDescription?.text,
          job.jobAd?.sections?.qualifications?.text,
          job.jobAd?.sections?.benefits?.text,
        ]
          .filter(Boolean)
          .join("\n\n")
      ),
    };
  });
}

// Ported from santifer/career-ops (MIT License, Copyright (c) 2026 Santiago
// Fernández de Valderrama — github.com/santifer/career-ops) providers/recruitee.mjs.
// Per-tenant subdomains are the variable part — SSRF defence uses a regex match
// on `<safe-slug>.recruitee.com` rather than a static allowlist.
const RECRUITEE_HOST_RE = /^[a-z0-9][a-z0-9-]*\.recruitee\.com$/;

async function fetchRecruitee(entry, fetchImpl) {
  const parsed = new URL(entry.careers_url);
  if (parsed.protocol !== "https:" || !RECRUITEE_HOST_RE.test(parsed.hostname)) {
    throw new Error(
      `recruitee: untrusted hostname "${parsed.hostname}" — must match <slug>.recruitee.com`
    );
  }
  const apiUrl = `https://${parsed.hostname}/api/offers/`;
  const json = await fetchJson(apiUrl, fetchImpl);
  const offers = Array.isArray(json?.offers) ? json.offers : [];
  return offers.map((j) => {
    const city = j.city || "";
    const country = j.country || "";
    const remote = j.remote ? "Remote" : "";
    const location = j.location || [city, country, remote].filter(Boolean).join(", ");

    // Validate offer URL: must parse as https://<safe-slug>.recruitee.com/...
    let url = "";
    const rawUrl = j.careers_url || j.url || "";
    if (typeof rawUrl === "string" && rawUrl) {
      try {
        const offerUrl = new URL(rawUrl);
        if (offerUrl.protocol === "https:" && RECRUITEE_HOST_RE.test(offerUrl.hostname)) {
          url = offerUrl.href;
        }
      } catch {
        // malformed URL → leave url = ""
      }
    }

    return {
      title: j.title || "",
      url,
      company: entry.name,
      location,
      comp: "",
      bodyText: htmlToText(j.description || ""),
    };
  });
}

// Ported from santifer/career-ops (MIT License, Copyright (c) 2026 Santiago
// Fernández de Valderrama — github.com/santifer/career-ops) providers/workday.mjs.
// Auto-detects from careers_url pattern
// `https://<tenant>.<instance>.myworkdayjobs.com[/<locale>]/<site>`, e.g.
// https://23andme.wd5.myworkdayjobs.com/23 →
//      POST https://23andme.wd5.myworkdayjobs.com/wday/cxs/23andme/23/jobs
//
// Workday only exposes a relative "postedOn" label ("Posted Today",
// "Posted 5 Days Ago", "Posted 30+ Days Ago"); postedAt is derived from it
// and omitted (null) for the unbounded "30+ Days Ago" form.
const WD_PAGE_LIMIT = 20;
const WD_MAX_PAGES = 50; // safety cap — at most 1000 postings per site
const WORKDAY_URL_RE =
  /^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/;

function resolveWorkdayEndpoint(entry) {
  const url = entry.careers_url || "";
  const m = url.match(WORKDAY_URL_RE);
  if (!m) return null;
  const [, tenant, instance, site] = m;
  const origin = `https://${tenant}.${instance}.myworkdayjobs.com`;
  return {
    api: `${origin}/wday/cxs/${tenant}/${site}/jobs`,
    // externalPath is relative to the site, not the host root — without the
    // site segment the URL 404s.
    jobBase: `${origin}/${site}`,
  };
}

function parseWorkdayPostedOn(label) {
  if (!label) return undefined;
  if (/posted\s+today/i.test(label)) return Date.now();
  if (/posted\s+yesterday/i.test(label)) return Date.now() - 86_400_000;
  const m = label.match(/posted\s+(\d+)(\+?)\s*day/i);
  if (!m || m[2] === "+") return undefined; // "30+ Days Ago" — unbounded, no usable date
  return Date.now() - Number(m[1]) * 86_400_000;
}

async function fetchWorkday(entry, fetchImpl) {
  const ep = resolveWorkdayEndpoint(entry);
  if (!ep) throw new Error(`workday: cannot derive CXS endpoint for ${entry.name}`);

  const jobs = [];
  for (let page = 0; page < WD_MAX_PAGES; page++) {
    const body = JSON.stringify({
      limit: WD_PAGE_LIMIT,
      offset: page * WD_PAGE_LIMIT,
      searchText: "",
      appliedFacets: {},
    });
    const json = await fetchJson(ep.api, fetchImpl, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", accept: "application/json" },
    });
    const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
    for (const j of postings) {
      if (!j.externalPath) continue;
      const postedAtMs = parseWorkdayPostedOn(j.postedOn);
      jobs.push({
        title: j.title || "",
        url: ep.jobBase + j.externalPath,
        company: entry.name,
        location: j.locationsText || "",
        comp: "",
        postedAt: postedAtMs != null ? new Date(postedAtMs).toISOString() : null,
      });
    }
    if (postings.length < WD_PAGE_LIMIT) break;
  }
  return jobs;
}

function formatAshbyComp(compensation) {
  if (!compensation) return "";
  if (typeof compensation === "string") return compensation;
  if (compensation.scrapeableCompensationSalarySummary)
    return compensation.scrapeableCompensationSalarySummary;
  if (compensation.compensationTierSummary) return compensation.compensationTierSummary;
  const parts = [];
  const items = [
    ...(Array.isArray(compensation) ? compensation : [compensation]),
    ...(Array.isArray(compensation.summaryComponents) ? compensation.summaryComponents : []),
    ...(Array.isArray(compensation.compensationTiers)
      ? compensation.compensationTiers.flatMap((tier) => tier.components || [])
      : []),
  ];
  for (const item of items) {
    const min = item?.minValue ?? item?.min;
    const max = item?.maxValue ?? item?.max;
    const currency = item?.currencyCode || item?.currency || "";
    if (min || max) parts.push(`${currency} ${min || "?"}-${max || "?"}`.trim());
  }
  return parts.join("; ");
}

function formatLeverComp(job = {}) {
  const parts = [];
  if (job.salaryDescriptionPlain) parts.push(job.salaryDescriptionPlain);
  const min = job.salaryRange?.min;
  const max = job.salaryRange?.max;
  const currency = job.salaryRange?.currency || "";
  const interval = job.salaryRange?.interval || "";
  if (min || max) parts.push(`${currency} ${min || "?"}-${max || "?"} ${interval}`.trim());
  return parts.join("\n\n");
}

// Load the company-watchlist scanner config. When no config exists the scanner
// stays domain-neutral: an empty, field-neutral config (no tracked companies, no
// title/location bias) so a zero-config install scans nothing rather than inheriting
// anyone's role/geography/company defaults. Personal scan config lives in the
// gitignored config/sourced-scan.json (see config/sourced-scan.example.json).
export function loadScannerConfig(path = userPath({}, "config/sourced-scan.json")) {
  if (!existsSync(path)) {
    return { title_filter: {}, location_filter: null, tracked_companies: [] };
  }
  return JSON.parse(readFileSync(path, "utf8"));
}
