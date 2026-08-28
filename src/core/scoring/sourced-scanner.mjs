import { existsSync, readFileSync } from "node:fs";

import { effectiveTargetingForRole } from "../deep-ingest/role-signal-overlay.mjs";
import { guardedFetch } from "../net/public-http-fetch.mjs";
import { userPath } from "../paths/workspace.mjs";
import { assessCompensationFloors } from "../profile/compensation.mjs";
import { scannerLikelyKeepThreshold } from "../profile/modes.mjs";
import {
  fetchCareerOpsProvider,
  inferCareerOpsProvider,
  isCareerOpsProviderSupported,
} from "../providers/career-ops-registry.mjs";
import {
  fetchHcareers,
  fetchHospitalityOnline,
  fetchIHireHospitality,
  fetchOysterLink,
} from "../providers/hospitality-public.mjs";
import { fetchRemoteOk } from "../providers/remoteok.mjs";
import { fetchRemotive } from "../providers/remotive.mjs";
import { feedItemsToOffers, parseFeed } from "../providers/rss.mjs";
import { fetchWorkingNomads } from "../providers/workingnomads.mjs";
import { classifyRoleFamily } from "../tracker/outcome-analysis.mjs";
import { normalizeCompanyRoleKey } from "../tracker/tracker-data.mjs";
import { extractReqId, postingIdentityKeys } from "./sourced-identity.mjs";

export { extractReqId } from "./sourced-identity.mjs";
export { normalizeCompanyRoleKey };

// Matches career-ops-registry.mjs's own DEFAULT_TIMEOUT_MS. fetchRss is the
// same threat model (a user-configured source URL, fetched over the guarded
// transport) so it gets the same deadline.
const RSS_TIMEOUT_MS = 15_000;

// --- Board-wide aggregator feed registry ------------------------------------
// Board sources (config/search-sources.yml entries with source_type:"board") are
// broad, unauthenticated job-board feeds — unlike tracked_companies (one company's
// ATS) or rss sources (one saved search's feed), a board entry returns the whole
// board and relies on the entry's title_filter/location_filter to narrow it. Kept
// as a small registry (rather than inline in scanBoards) so countDeterministicSources
// in first-search-run.mjs can check provider support without duplicating the list.
const BOARD_PROVIDERS = {
  remoteok: (entry, { fetchImpl }) => fetchRemoteOk(entry, fetchImpl),
  remotive: (entry, { fetchImpl }) => fetchRemotive(entry, fetchImpl),
  workingnomads: (entry, { fetchImpl }) => fetchWorkingNomads(entry, fetchImpl),
  oysterlink: fetchOysterLink,
  hcareers: fetchHcareers,
  hospitalityonline: fetchHospitalityOnline,
  ihirehospitality: fetchIHireHospitality,
};

export function isBoardProviderSupported(provider) {
  const providerId = String(provider || "").toLowerCase();
  return Boolean(BOARD_PROVIDERS[providerId]) || isCareerOpsProviderSupported(providerId);
}

export function isCompanyProviderSupported(provider) {
  return isCareerOpsProviderSupported(provider);
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

function normalizeKeywordList(value) {
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
  const classify = (title = "") => {
    const lower = title.toLowerCase();
    const blocked = negative.some((term) => keywordMatches(lower, term));
    const matched =
      positive.length === 0 ||
      positive.some(
        (term) => keywordMatches(lower, term) || boundedRoleTitleEquivalent(lower, term)
      );
    return {
      matched: matched && !blocked,
      blocked,
      adjacent:
        !matched && !blocked && positive.some((term) => adjacentRoleTitleEquivalent(lower, term)),
    };
  };
  const filter = (title = "") => classify(title).matched;
  filter.classify = classify;
  return filter;
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
const TITLE_ADJACENT_FAMILIES = [
  new Set(["design", "front", "frontend", "ui"]),
  ...TITLE_DOMAIN_FAMILIES,
];
const TITLE_SPECIALIZATION_FAMILIES = [
  new Set(["advocate"]),
  new Set(["gtm"]),
  new Set(["marketing"]),
  new Set(["product"]),
  new Set(["revenue"]),
  new Set(["sales"]),
  new Set(["cybersecurity", "security"]),
  new Set(["solution", "solutions"]),
  new Set(["success"]),
  new Set(["support"]),
];
const TITLE_ENGINEERING_KINDS = new Set(["developer", "engineer", "engineering"]);
const TITLE_SENIORITY_GROUPS = [new Set(["staff", "principal", "lead"]), new Set(["senior", "sr"])];
const TITLE_ADJACENCY_STOPWORDS = new Set([
  "assistant",
  "associate",
  "chief",
  "director",
  "head",
  "intern",
  "junior",
  "lead",
  "manager",
  "principal",
  "senior",
  "specialist",
  "staff",
  "the",
  "vice",
]);

function titleSpecializationsCompatible(actual, target) {
  return TITLE_SPECIALIZATION_FAMILIES.every(
    (family) => hasAny(actual, family) === hasAny(target, family)
  );
}

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
  if (MANAGEMENT_TITLE_RE.test(actualTitle) !== MANAGEMENT_TITLE_RE.test(targetTitle)) return false;
  const actual = titleTokens(actualTitle);
  const target = titleTokens(targetTitle);
  if (!hasAny(target, TITLE_ENGINEERING_KINDS) || !hasAny(actual, TITLE_ENGINEERING_KINDS)) {
    return false;
  }

  // Adjacent functions with an engineering-adjacent noun are still distinct
  // lanes unless the target explicitly names that specialization.
  if (!titleSpecializationsCompatible(actual, target)) {
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

function titleSeniorityCompatible(actual, target) {
  const targetSeniority = TITLE_SENIORITY_GROUPS.find((group) => hasAny(target, group));
  if (!targetSeniority) return true;
  return (
    hasAny(actual, targetSeniority) ||
    (targetSeniority.has("senior") && hasAny(actual, TITLE_SENIORITY_GROUPS[0]))
  );
}

function adjacentRoleTitleEquivalent(actualTitle, targetTitle) {
  if (MANAGEMENT_TITLE_RE.test(actualTitle) !== MANAGEMENT_TITLE_RE.test(targetTitle)) return false;
  const actual = titleTokens(actualTitle);
  const target = titleTokens(targetTitle);
  if (!titleSeniorityCompatible(actual, target)) return false;

  if (hasAny(target, TITLE_ENGINEERING_KINDS)) {
    if (!hasAny(actual, TITLE_ENGINEERING_KINDS)) return false;
    if (!titleSpecializationsCompatible(actual, target)) {
      return false;
    }
    return true;
  }

  return [...target].some(
    (value) =>
      value.length >= 4 &&
      !TITLE_ADJACENCY_STOPWORDS.has(value) &&
      !TITLE_ENGINEERING_KINDS.has(value) &&
      actual.has(value)
  );
}

function adjacentTitleFamiliesCompatible(actualTitle, targetTitle) {
  const familyFor = (title) => {
    const words = titleTokens(title);
    return TITLE_ADJACENT_FAMILIES.findIndex((family) => hasAny(words, family));
  };
  const targetFamily = familyFor(targetTitle);
  if (targetFamily < 0) return true;
  const actualFamily = familyFor(actualTitle);
  return actualFamily < 0 || actualFamily === targetFamily;
}

function targetRoleTitleMatches(actualTitle, targetTitles) {
  if (targetTitles.length === 0) return true;
  const actual = String(actualTitle || "").toLowerCase();
  return targetTitles.some((targetTitle) => {
    const target = String(targetTitle || "").toLowerCase();
    const targetHasDomain = TITLE_DOMAIN_FAMILIES.some((family) =>
      hasAny(titleTokens(target), family)
    );
    return (
      keywordMatches(actual, target) ||
      boundedRoleTitleEquivalent(actual, target) ||
      (!targetHasDomain &&
        adjacentRoleTitleEquivalent(actual, target) &&
        adjacentTitleFamiliesCompatible(actual, target))
    );
  });
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
    if (placeMatchesAllowed(location, alwaysAllow)) return true;
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
const ONSITE_RE = /\b(on[ -]?site|in[ -]?office|office[ -]?based|in[ -]?person)\b/i;
const GLOBAL_REMOTE_RE = /\b(worldwide|anywhere|global)\b/i;
const US_REMOTE_RE = /\b(united states|u\.?s\.?a?\.?|us[- ](?:only|based)|north america)\b/i;
const US_BASED_CANDIDATE_RE =
  /\b(?:all\s+)?candidates?\s+(?:must|required to)\s+be\s+(?:(?:based|located)\s+in\s+(?:the\s+)?(?:u\.?s\.?a?\.?|united states)|(?:u\.?s\.?a?\.?|united states)[ -]?based)\b/i;
const FOREIGN_REMOTE_RE =
  /\b(de|ireland|united kingdom|uk|europe|emea|canada|india|asia|apac|australia|new zealand|singapore|germany|france|spain|portugal|poland|netherlands|sweden|norway|denmark|switzerland|israel|brazil|mexico)\b/i;
const NO_SPONSORSHIP_RE =
  /\b(?:no|not|cannot|can't|unable to|do not|does not|won't|will not)\b[^.\n]{0,50}\b(?:visa )?sponsor(?:ship)?\b|\b(?:visa )?sponsorship\b[^.\n]{0,50}\b(?:not available|is unavailable)\b/i;
const US_STATE_RE =
  /(?:^|[,\s])(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:$|[,\s])/i;
const US_STATE_NAMES = Object.freeze([
  ["AL", "Alabama"],
  ["AK", "Alaska"],
  ["AZ", "Arizona"],
  ["AR", "Arkansas"],
  ["CA", "California"],
  ["CO", "Colorado"],
  ["CT", "Connecticut"],
  ["DE", "Delaware"],
  ["FL", "Florida"],
  ["GA", "Georgia"],
  ["HI", "Hawaii"],
  ["ID", "Idaho"],
  ["IL", "Illinois"],
  ["IN", "Indiana"],
  ["IA", "Iowa"],
  ["KS", "Kansas"],
  ["KY", "Kentucky"],
  ["LA", "Louisiana"],
  ["ME", "Maine"],
  ["MD", "Maryland"],
  ["MA", "Massachusetts"],
  ["MI", "Michigan"],
  ["MN", "Minnesota"],
  ["MS", "Mississippi"],
  ["MO", "Missouri"],
  ["MT", "Montana"],
  ["NE", "Nebraska"],
  ["NV", "Nevada"],
  ["NH", "New Hampshire"],
  ["NJ", "New Jersey"],
  ["NM", "New Mexico"],
  ["NY", "New York"],
  ["NC", "North Carolina"],
  ["ND", "North Dakota"],
  ["OH", "Ohio"],
  ["OK", "Oklahoma"],
  ["OR", "Oregon"],
  ["PA", "Pennsylvania"],
  ["RI", "Rhode Island"],
  ["SC", "South Carolina"],
  ["SD", "South Dakota"],
  ["TN", "Tennessee"],
  ["TX", "Texas"],
  ["UT", "Utah"],
  ["VT", "Vermont"],
  ["VA", "Virginia"],
  ["WA", "Washington"],
  ["WV", "West Virginia"],
  ["WI", "Wisconsin"],
  ["WY", "Wyoming"],
  ["DC", "District of Columbia"],
]);
const REMOTE_REGION_EXCLUSION_RE =
  /\b(?:except|excluding|excluded|unavailable|not\s+available|cannot\s+hire|can't\s+hire|do\s+not\s+hire|does\s+not\s+hire|won't\s+hire|not\s+eligible|ineligible)\b/i;
const EXPLICIT_ONSITE_BODY_RE =
  /\b(?:fully|entirely|100%|strictly)\s+(?:on[ -]?site|in[ -]?office|office[ -]?based|in[ -]?person)\b|\b(?:on[ -]?site|in[ -]?office)\s+only\b|\b(?:location|workplace)\s*:\s*[^.\n]{0,80}\b(?:on[ -]?site|in[ -]?office|office[ -]?based|in[ -]?person)\b|\b(?:role|position|work)\s+(?:is|will be)\s+(?:fully\s+)?(?:on[ -]?site|in[ -]?office|office[ -]?based|in[ -]?person)\b|\bin[ -]?person\s+(?:role|position|work)\b/i;
const OFFICE_CONTEXT_RE = /\b(?:office|on[ -]?site|in[ -]?office|in[ -]?person)\b/i;
const REQUIRED_OFFICE_DAYS_RE = /\b(?:must|require(?:d|s)?|expect(?:ed|s)?|mandatory)\b/i;
const DECLARATIVE_OFFICE_POSTURE_RE =
  /\b(?:we|employees?|team(?: members)?)\s+(?:all\s+)?(?:work|commute|come|are)\b[^.\n]{0,80}\b(?:office|on[ -]?site|in[ -]?office|in[ -]?person)\b/i;
const OFFICE_DAYS_RE =
  /\b(one|two|three|four|five|six|seven|[1-7])\s*days?\s*(?:\/\s*week|(?:per|a|each)\s+week)\b/gi;
const OFFICE_DAY_WORDS = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
});

function requiredOfficeDaysPerWeek(value) {
  let maximum = null;
  for (const sentence of String(value || "").split(/[.!?;\n]+/)) {
    if (
      !OFFICE_CONTEXT_RE.test(sentence) ||
      (!REQUIRED_OFFICE_DAYS_RE.test(sentence) && !DECLARATIVE_OFFICE_POSTURE_RE.test(sentence))
    ) {
      continue;
    }
    for (const match of sentence.matchAll(OFFICE_DAYS_RE)) {
      const raw = match[1].toLowerCase();
      const days = OFFICE_DAY_WORDS[raw] || Number(raw);
      if (Number.isInteger(days)) maximum = Math.max(maximum || 0, days);
    }
  }
  return maximum;
}

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

const NEW_YORK_CITY_ALIASES = new Set([
  "nyc",
  "new york city",
  "new york city ny",
  "new york metropolitan area",
  "new york metro area",
  "ny metro",
  "new york ny",
  "new york new york",
  "manhattan ny",
  "brooklyn ny",
  "queens ny",
  "bronx ny",
  "staten island ny",
]);
const SAN_FRANCISCO_BAY_AREA_ALIASES = new Set([
  "bay area",
  "sf bay area",
  "san francisco bay area",
  "san francisco",
  "san francisco ca",
  "oakland",
  "oakland ca",
  "berkeley",
  "berkeley ca",
]);

function normalizePlace(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/\b(remote|hybrid|on[ -]?site|in[ -]?office)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (placeContainsAlias(normalized, NEW_YORK_CITY_ALIASES)) return "new york city";
  if (placeContainsAlias(normalized, SAN_FRANCISCO_BAY_AREA_ALIASES)) {
    return "san francisco bay area";
  }
  return normalized;
}

function placeContainsAlias(normalized, aliases) {
  if (!normalized) return false;
  return [...aliases].some((alias) =>
    new RegExp(`(?:^| )${escapeRegExp(alias)}(?: |$)`).test(normalized)
  );
}

function listedPlaces(value) {
  const source = String(value || "").trim();
  if (!source) return [];
  return source
    .split(/\s*(?:;|\||•|\n|\s\/\s)\s*/)
    .map((place) => place.trim())
    .filter(Boolean);
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
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
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
  return (
    homeRegionAliases(home).length > 0 ||
    /\bunited states|\busa\b/i.test(String(home || "")) ||
    NEW_YORK_CITY_ALIASES.has(normalizePlace(home))
  );
}

function homeRegionAliases(home) {
  const source = String(home || "");
  const normalized = normalizePlace(source);
  const aliases = new Set();
  for (const [code, name] of US_STATE_NAMES) {
    const codeMatch = new RegExp(`(?:^|[^a-z])${code.toLowerCase()}(?:$|[^a-z])`, "i").test(source);
    const normalizedName = name.toLowerCase();
    if (codeMatch || normalized.includes(normalizedName)) {
      aliases.add(code.toLowerCase());
      aliases.add(normalizedName);
    }
  }
  if (NEW_YORK_CITY_ALIASES.has(normalized)) {
    aliases.add("ny");
    aliases.add("new york");
  }
  return [...aliases];
}

function remoteExcludesHomeRegion(value, home) {
  const aliases = homeRegionAliases(home);
  if (!aliases.length) return false;
  return String(value || "")
    .split(/[.!?;\n]+/)
    .some(
      (clause) =>
        REMOTE_REGION_EXCLUSION_RE.test(clause) &&
        aliases.some((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(clause))
    );
}

function placeMatchesAllowed(location, places) {
  return listedPlaces(location).some((listedPlace) => {
    const normalized = normalizePlace(listedPlace);
    if (!normalized) return false;
    return places.some((place) => {
      const candidate = normalizePlace(place);
      return candidate && (normalized.includes(candidate) || candidate.includes(normalized));
    });
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
  const distances = homeCoordinates
    ? listedPlaces(location)
        .map((place) => coordinatesForPlace(place))
        .filter(Boolean)
        .map((jobCoordinates) => haversineMiles(homeCoordinates, jobCoordinates))
    : [];
  if (Number.isFinite(radius) && radius > 0 && homeCoordinates && distances.length > 0) {
    const distanceMiles = Math.min(...distances);
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
  const body = String(offer?.bodyText || offer?.description || offer?.body || "");
  const profileLocation = config?.profile?.location || {};
  const hasLocationPolicy =
    Boolean(String(profileLocation?.home || "").trim()) ||
    (Array.isArray(profileLocation?.relocation) && profileLocation.relocation.length > 0) ||
    ["remote", "hybrid", "onsite"].some((mode) => typeof profileLocation?.[mode] === "boolean");
  if (!hasLocationPolicy) return { eligible: true };

  const officeDays = requiredOfficeDaysPerWeek(body);
  const conditional = conditionalLocationPosture(body);
  const bodyOnsite = EXPLICIT_ONSITE_BODY_RE.test(body) || (officeDays != null && officeDays >= 4);
  const bodyHybrid = !bodyOnsite && officeDays != null && officeDays > 0;
  if (!location && !conditional && !bodyOnsite && !bodyHybrid) {
    return { eligible: true, unknown: "location" };
  }
  if (conditional) {
    const home = String(profileLocation?.home || "").trim();
    const hybridCommute = commuteEligibility(conditional.hybridNear, profileLocation);
    const displayLocation = `Remote outside ${conditional.remoteOutside} · Hybrid near ${conditional.hybridNear}`;
    if (conditional.usOnly && !homeLooksUs(home)) {
      return { eligible: false, reason: "remote-region-mismatch" };
    }
    if (hybridCommute.eligible) {
      if (profileLocation.hybrid !== true) {
        return { eligible: false, reason: "hybrid-not-allowed" };
      }
      if (officeDaysExceedPreference(officeDays, profileLocation)) {
        return { eligible: false, reason: "office-days-exceed-preference" };
      }
      return { ...hybridCommute, displayLocation };
    }
    if (profileLocation.remote !== true) {
      return { eligible: false, reason: "remote-not-allowed" };
    }
    if (profileLocation.remote_scope !== "worldwide" && !homeLooksUs(home)) {
      return { eligible: false, reason: "remote-region-unverified" };
    }
    return { eligible: true, displayLocation };
  }

  const remote = REMOTE_RE.test(`${title}\n${location}`) && !bodyHybrid && !bodyOnsite;
  const hybrid = HYBRID_RE.test(`${title}\n${location}`) || bodyHybrid;
  const onsite = ONSITE_RE.test(`${title}\n${location}`) || bodyOnsite;
  const hasExplicitModes = ["remote", "hybrid", "onsite"].some(
    (mode) => typeof profileLocation?.[mode] === "boolean"
  );

  if (officeDaysExceedPreference(officeDays, profileLocation)) {
    return { eligible: false, reason: "office-days-exceed-preference" };
  }

  // Worldwide scope applies only to fully remote work. Explicit hybrid or
  // on-site labels stay subject to the saved home/relocation commute policy,
  // even when the listing also says "remote-friendly".
  if (remote && !hybrid && !onsite) {
    if (hasExplicitModes && profileLocation.remote !== true) {
      return { eligible: false, reason: "remote-not-allowed" };
    }
    if (remoteExcludesHomeRegion(`${location}\n${body}`, profileLocation.home)) {
      return { eligible: false, reason: "remote-home-region-excluded" };
    }
    if (profileLocation.remote_scope === "worldwide") return { eligible: true };
    if (homeLooksUs(profileLocation.home)) {
      const local = commuteEligibility(location, profileLocation);
      if (local.eligible) return { eligible: true };
      const usRemoteLocation = US_REMOTE_RE.test(location) || US_STATE_RE.test(location);
      if (FOREIGN_REMOTE_RE.test(location) && !usRemoteLocation) {
        return { eligible: false, reason: "remote-region-mismatch" };
      }
      if (!usRemoteLocation) {
        return { eligible: false, reason: "remote-region-unverified" };
      }
      return { eligible: true };
    }
    if (GLOBAL_REMOTE_RE.test(location)) return { eligible: true };
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

function officeDaysExceedPreference(officeDays, profileLocation) {
  const savedMaxOfficeDays = profileLocation?.max_commute_days_per_week;
  const maxOfficeDays =
    savedMaxOfficeDays === null ||
    savedMaxOfficeDays === undefined ||
    String(savedMaxOfficeDays).trim() === ""
      ? null
      : Number(savedMaxOfficeDays);
  return (
    officeDays != null &&
    Number.isInteger(maxOfficeDays) &&
    maxOfficeDays >= 0 &&
    officeDays > maxOfficeDays
  );
}

function conditionalLocationPosture(body) {
  const match = String(body || "").match(
    /\bremote\s+(?:position|role)\s+for\s+candidates\s+outside\s+(?:of\s+)?(.+?)\s+and\s+(?:a\s+)?hybrid\s+(?:position|role)\s+for\s+candidates\s+within\s+commuting\s+distance\s+to\s+(.+?)(?:[.;]|$)/i
  );
  if (!match) return null;
  const remoteOutside = match[1].trim().replace(/^(?:the\s+)/i, "the ");
  const hybridNear = match[2].trim();
  if (!remoteOutside || !hybridNear) return null;
  return { remoteOutside, hybridNear, usOnly: US_BASED_CANDIDATE_RE.test(body) };
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
  const compensation = config?.profile?.compensation || {};
  const bands = extractCompensationBands(compensationEvidenceText(offer));
  const standing = assessCompensationFloors({
    baseBand: bands.base,
    annualEarningsBand: bands.annualEarnings,
    minimumBase: compensation.minimum_base,
    minimumAnnualEarnings: compensation.minimum_annual_earnings,
  });
  if (standing.base === "below") {
    return { eligible: false, reason: "comp-below-floor", band: bands.base };
  }
  if (standing.annualEarnings === "below") {
    return {
      eligible: false,
      reason: "annual-earnings-below-floor",
      annualEarningsBand: bands.annualEarnings,
    };
  }
  const unknown =
    standing.base === "unknown" || standing.annualEarnings === "unknown" ? "compensation" : null;
  return { eligible: true, unknown };
}

function contentEligibility(offer, config) {
  const body = String(offer?.bodyText || offer?.description || "");
  if (
    config?.profile?.authorization?.requires_sponsorship === true &&
    NO_SPONSORSHIP_RE.test(body)
  ) {
    return { eligible: false, reason: "sponsorship-unavailable" };
  }
  return { eligible: true };
}

const QUALIFICATION_BUCKETS = Object.freeze({
  seniority: "filteredSeniority",
  location: "filteredLocation",
  age: "filteredAge",
  salary: "filteredSalary",
  eligibility: "filteredEligibility",
});

function qualifyCandidateOffer(
  offer,
  {
    config = {},
    now = Date.now(),
    locationFilter = () => true,
    deferBodyDependentPolicy = false,
  } = {}
) {
  const seniority = seniorityEligibility(offer, config);
  if (!seniority.eligible) {
    return { eligible: false, bucket: "seniority", reason: seniority.reason };
  }
  if (deferBodyDependentPolicy) {
    const age = postingAgeEligibility(offer, config, Number(now));
    if (!age.eligible) return { eligible: false, bucket: "age", reason: age.reason };
    return {
      eligible: true,
      qualificationUnknowns: ["location", "compensation", age.unknown].filter(Boolean),
    };
  }
  if (!locationFilter(offer.location || "", offer.url, offer.title, offer)) {
    return { eligible: false, bucket: "location", reason: "location-policy-mismatch" };
  }
  const qualifiedLocation = locationEligibility(offer, config);
  if (!qualifiedLocation.eligible) {
    return {
      eligible: false,
      bucket: "location",
      reason: qualifiedLocation.reason,
      ...(qualifiedLocation.distanceMiles == null
        ? {}
        : { distanceMiles: qualifiedLocation.distanceMiles }),
    };
  }
  const age = postingAgeEligibility(offer, config, Number(now));
  if (!age.eligible) return { eligible: false, bucket: "age", reason: age.reason };
  const salary = salaryEligibility(offer, config);
  if (!salary.eligible) {
    return {
      eligible: false,
      bucket: "salary",
      reason: salary.reason,
      compBand: salary.band,
      annualEarningsBand: salary.annualEarningsBand,
    };
  }
  const content = contentEligibility(offer, config);
  if (!content.eligible) {
    return { eligible: false, bucket: "eligibility", reason: content.reason };
  }
  return {
    eligible: true,
    qualificationUnknowns: [qualifiedLocation.unknown, age.unknown, salary.unknown].filter(Boolean),
    ...(qualifiedLocation.displayLocation
      ? { displayLocation: qualifiedLocation.displayLocation }
      : {}),
  };
}

export function requalifyCanonicalOffers(
  offers,
  { config = {}, now = Date.now(), locationFilter = () => true } = {}
) {
  const result = {
    kept: [],
    filteredSeniority: [],
    filteredLocation: [],
    filteredAge: [],
    filteredSalary: [],
    filteredEligibility: [],
  };
  for (const offer of Array.isArray(offers) ? offers : []) {
    const qualification = qualifyCandidateOffer(offer, { config, now, locationFilter });
    if (!qualification.eligible) {
      const bucket = QUALIFICATION_BUCKETS[qualification.bucket];
      result[bucket].push({
        ...offer,
        qualificationReason: qualification.reason,
        ...(qualification.distanceMiles == null
          ? {}
          : { distanceMiles: qualification.distanceMiles }),
        ...(qualification.compBand ? { compBand: qualification.compBand } : {}),
        ...(qualification.annualEarningsBand
          ? { annualEarningsBand: qualification.annualEarningsBand }
          : {}),
      });
      continue;
    }
    const qualifiedOffer = qualification.displayLocation
      ? { ...offer, location: qualification.displayLocation }
      : offer;
    const rating = scoreSourcedOffer(qualifiedOffer, config);
    if (rating.ruleFlags?.includes("title-target-mismatch")) {
      result.filteredSeniority.push({
        ...qualifiedOffer,
        qualificationReason: "title-target-mismatch",
      });
      continue;
    }
    result.kept.push({
      ...qualifiedOffer,
      qualificationUnknowns: qualification.qualificationUnknowns,
      ...rating,
    });
  }
  return result;
}

function scoreSourcedOfferFromConfig(
  offer = {},
  { targeting, profile, modes, familyOutcomes, roleSignals }
) {
  const title = String(offer.title || "").toLowerCase();
  const company = String(offer.company || "").toLowerCase();
  const location = String(offer.location || "").toLowerCase();
  const compText = compensationEvidenceText(offer, { includeBody: false });
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
  for (const term of keepSignals) {
    if (keywordMatches(title, term) || keywordMatches(text, term)) {
      setBase(82, `matches keep signal: ${term}`);
    }
  }
  for (const term of bucketTitles.filter(Boolean)) {
    if (targetRoleTitleMatches(title, [term])) {
      setBase(82, `matches target title: ${term}`);
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

  // --- Compensation floors ---
  const minimumBase =
    profile && profile.compensation && profile.compensation.minimum_base != null
      ? Number(profile.compensation.minimum_base)
      : null;
  const minimumAnnualEarnings =
    profile?.compensation?.minimum_annual_earnings != null
      ? Number(profile.compensation.minimum_annual_earnings)
      : null;
  const hasMinimumBase = Number.isFinite(minimumBase) && minimumBase > 0;
  const hasMinimumAnnualEarnings =
    Number.isFinite(minimumAnnualEarnings) && minimumAnnualEarnings > 0;
  const compBands = extractCompensationBands(`${compText}\n${body}`);
  const compStanding = assessCompensationFloors({
    baseBand: compBands.base,
    annualEarningsBand: compBands.annualEarnings,
    minimumBase: hasMinimumBase ? minimumBase : null,
    minimumAnnualEarnings: hasMinimumAnnualEarnings ? minimumAnnualEarnings : null,
  });
  if (hasMinimumBase) {
    if (compBands.base) {
      if (compStanding.base === "below") {
        add(-24, "base below floor");
        flag("comp-below-floor");
      } else if (compStanding.base === "overlap") {
        add(-6, "must land top of band");
        flag("top-of-band-only");
      } else {
        add(4, "comp clears floor");
      }
    } else {
      flag("comp-unposted");
    }
  } else {
    if (!compBands.base && !compBands.annualEarnings) flag("comp-unposted");
  }
  if (hasMinimumAnnualEarnings) {
    if (compStanding.annualEarnings === "below") {
      add(-24, "annual earnings below floor");
      flag("annual-earnings-below-floor");
    } else if (compStanding.annualEarnings === "overlap") {
      add(-6, "annual earnings range overlaps floor");
      flag("annual-earnings-overlap");
    } else if (compStanding.annualEarnings === "clear") {
      add(4, "annual earnings clear floor");
    } else {
      flag("annual-earnings-unverified");
    }
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
  } else if (US_REMOTE_RE.test(location)) {
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

  // Evidence in the body can make an adjacent role worth a body read, but it
  // cannot turn a different job family into a strong target-title match. This
  // also protects a narrowed candidate profile from broader source filters
  // generated earlier in onboarding.
  if (!targetRoleTitleMatches(title, bucketTitles.filter(Boolean))) {
    score = Math.min(score, 64);
    reasons.unshift("outside target role titles");
    flag("title-target-mismatch");
  }

  const clamped = Math.max(35, Math.min(95, Math.round(score)));
  return {
    fit: fitFromScore(clamped, targeting?.fit_bands),
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

export function fitFromScore(score, fitBands) {
  const savedHigh =
    fitBands?.high_min == null || String(fitBands.high_min).trim() === ""
      ? Number.NaN
      : Number(fitBands.high_min);
  const savedMed =
    fitBands?.med_min == null || String(fitBands.med_min).trim() === ""
      ? Number.NaN
      : Number(fitBands.med_min);
  const highMin = Number.isFinite(savedHigh) ? savedHigh : 85;
  const medMin = Number.isFinite(savedMed) ? savedMed : 65;
  if (score >= Math.max(highMin, medMin)) return "high";
  if (score >= Math.min(highMin, medMin)) return "med";
  return "stretch";
}

export function applyPresentationCaps(
  offers,
  { companyPresentationCounts = new Map(), perCompanyCap = Infinity, limit = Infinity } = {}
) {
  const candidates = (Array.isArray(offers) ? offers : []).map((offer, inputIndex) => ({
    offer,
    inputIndex,
  }));
  const normalizedCompanyCap = Number(perCompanyCap);
  const companyCap =
    Number.isFinite(normalizedCompanyCap) && normalizedCompanyCap > 0
      ? normalizedCompanyCap
      : Infinity;
  if (Number.isFinite(companyCap)) {
    candidates.sort((left, right) => {
      const scoreDelta = Number(right.offer.score || 0) - Number(left.offer.score || 0);
      if (scoreDelta) return scoreDelta;
      const rightPosted = Date.parse(String(right.offer.postedAt || ""));
      const leftPosted = Date.parse(String(left.offer.postedAt || ""));
      if (
        Number.isFinite(rightPosted) &&
        Number.isFinite(leftPosted) &&
        rightPosted !== leftPosted
      ) {
        return rightPosted - leftPosted;
      }
      return left.inputIndex - right.inputIndex;
    });
  }

  const presented = [];
  const overflow = [];
  for (const { offer } of candidates) {
    const companyKey = String(offer.company || "")
      .trim()
      .toLowerCase();
    const companyCount = Number(companyPresentationCounts.get(companyKey) || 0);
    const { _qualificationInputIndex, ...cleanOffer } = offer;
    if (companyCount >= companyCap) {
      overflow.push({ ...cleanOffer, qualificationReason: "per-company-cap" });
      continue;
    }
    companyPresentationCounts.set(companyKey, companyCount + 1);
    presented.push(cleanOffer);
  }

  const normalizedLimit = Number(limit);
  const runLimit =
    Number.isFinite(normalizedLimit) && normalizedLimit > 0 ? normalizedLimit : Infinity;
  const kept = presented.slice(0, runLimit);
  overflow.push(
    ...presented.slice(runLimit).map((offer) => ({
      ...offer,
      qualificationReason: "run-presentation-limit",
    }))
  );
  return { kept, overflow };
}

function gateFromScoreAndFlags(score, flags, modes = {}) {
  if (
    flags.some(
      (flag) =>
        flag.startsWith("cut-risk") ||
        flag === "excluded-company" ||
        flag === "comp-below-floor" ||
        flag === "annual-earnings-below-floor"
    )
  )
    return "likely-cut";
  if (
    flags.some(
      (flag) =>
        flag === "comp-unposted" ||
        flag === "top-of-band-only" ||
        flag === "annual-earnings-overlap" ||
        flag === "annual-earnings-unverified" ||
        flag === "ca-comp-unverified" ||
        flag === "family-cold"
    )
  )
    return "review";
  if (score >= scannerLikelyKeepThreshold(modes)) return "likely-keep";
  return "review";
}

const ANNUAL_WORK_HOURS = 2_080;
const BASE_COMP_LABEL_RE = /\b(?:base\s+(?:salary|pay)|salary(?:\s+(?:range|band))?)\b/i;
const VARIABLE_COMP_LABEL_RE =
  /\b(?:on-target\s+earnings|ote|bonus|equity|commission|total\s+comp(?:ensation)?|variable\s+(?:pay|compensation)|incentive\s+(?:pay|compensation))\b/i;
const ANNUAL_EARNINGS_LABEL_RE =
  /\b(?:annual\s+(?:cash\s+)?earnings|estimated\s+annual\s+earnings|on-target\s+earnings|ote|total\s+cash\s+comp(?:ensation)?|including\s+(?:tips|commissions?))\b/i;
const EQUITY_COMP_LABEL_RE = /\b(?:equity|stock|options?)\b/i;
const HOURLY_COMP_RE = /\b(?:hourly|per\s+(?:hour|hr))\b|\/\s*(?:hour|hr)\b/i;
const WEEKLY_HOURS_RE = /\b(\d{1,2}(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:\/|per|a|each)\s*week\b/i;
const ANNUAL_PAY_UNIT_RE =
  /\b(?:annually|annualized|per\s+(?:year|annum)|a\s+year)\b|\/\s*(?:year|yr)\b/i;

function annualWorkHours(line) {
  const explicit = String(line || "").match(WEEKLY_HOURS_RE);
  if (!explicit) return ANNUAL_WORK_HOURS;
  const hours = Number(explicit[1]);
  return Number.isFinite(hours) && hours > 0 && hours <= 80
    ? Math.round(hours * 52)
    : ANNUAL_WORK_HOURS;
}

function isCalendarYear(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 1900 && numeric <= 2100;
}

function plausibleCompensationMatch(line, match, values, suffixes, { hourly = false } = {}) {
  const matchedText = String(match?.[0] || "");
  const monetaryMarker = /[$£€]|\b(?:USD|CAD|MXN|EUR|GBP)\b/i.test(matchedText);
  const abbreviated = suffixes.some(
    (suffix) =>
      String(suffix || "")
        .trim()
        .toLowerCase() === "k"
  );
  if (values.some(isCalendarYear) && !monetaryMarker && !abbreviated) return false;
  if (
    values.some((value) => Number(value) < 1000) &&
    !monetaryMarker &&
    !abbreviated &&
    !hourly &&
    !ANNUAL_PAY_UNIT_RE.test(line)
  ) {
    return false;
  }
  return true;
}

function lastLabelIndex(value, pattern) {
  let index = -1;
  for (const match of value.matchAll(new RegExp(pattern.source, "gi"))) index = match.index;
  return index;
}

export function extractCompBand(text = "", { baseOnly = false } = {}) {
  const source = String(text || "");
  const explicitBaseCandidates = [];
  const nonVariableCandidates = [];
  const candidates = [];
  const lines = source
    .split(/\n|\. /)
    .filter((line) => /\$|\b(compensation|salary|base|pay range|annual|usd)\b/i.test(line));

  for (const line of lines) {
    const normalized = line.replace(/,/g, "");
    const explicitBase = BASE_COMP_LABEL_RE.test(line);
    const variableComp = VARIABLE_COMP_LABEL_RE.test(line);
    const annualEarnings = ANNUAL_EARNINGS_LABEL_RE.test(line);
    const hourly = HOURLY_COMP_RE.test(line);
    const workHours = annualWorkHours(line);
    if (baseOnly && annualEarnings && !explicitBase) continue;
    const re =
      /(?:usd\s*)?\$?\s*(\d{2,6}(?:\.\d+)?)(\s*k)?\s*(?:-|–|—|to)\s*(?:usd\s*)?\$?\s*(\d{2,6}(?:\.\d+)?)(\s*k)?/gi;
    let foundRange = false;
    for (const match of normalized.matchAll(re)) {
      const prefix = normalized.slice(0, match.index);
      const baseLabelIndex = lastLabelIndex(prefix, BASE_COMP_LABEL_RE);
      const variableLabelIndex = lastLabelIndex(prefix, VARIABLE_COMP_LABEL_RE);
      const rangeIsBase = baseLabelIndex >= 0 && baseLabelIndex > variableLabelIndex;
      const rangeIsVariable = variableLabelIndex >= 0 && variableLabelIndex > baseLabelIndex;
      const rangeIsHourly = rangeIsBase && hourly;
      if (
        !plausibleCompensationMatch(line, match, [match[1], match[3]], [match[2], match[4]], {
          hourly: rangeIsHourly,
        })
      ) {
        continue;
      }
      const min = rangeIsHourly ? Number(match[1]) * workHours : normalizeMoney(match[1], match[2]);
      const max = rangeIsHourly ? Number(match[3]) * workHours : normalizeMoney(match[3], match[4]);
      const minimum = rangeIsBase ? 1_000 : 50_000;
      if (min >= minimum && max >= min && max <= 1200000) {
        const candidate = { min, max };
        candidates.push(candidate);
        if (rangeIsBase) explicitBaseCandidates.push(candidate);
        else if (!rangeIsVariable && !variableComp) nonVariableCandidates.push(candidate);
        foundRange = true;
      }
    }
    if (foundRange) continue;
    if (!/\b(?:salary|base\s+(?:salary|pay)|annual\s+(?:salary|pay|compensation))\b/i.test(line)) {
      continue;
    }
    if (variableComp && !explicitBase) {
      continue;
    }
    const single = normalized.match(/(?:USD\s*)?\$?\s*(\d{2,7}(?:\.\d+)?)(\s*k)?\b/i);
    if (!single) continue;
    if (
      !plausibleCompensationMatch(line, single, [single[1]], [single[2]], {
        hourly: explicitBase && hourly,
      })
    ) {
      continue;
    }
    const amount =
      explicitBase && hourly ? Number(single[1]) * workHours : normalizeMoney(single[1], single[2]);
    const minimum = explicitBase ? 1_000 : 50_000;
    if (amount >= minimum && amount <= 1200000) {
      const candidate = { min: amount, max: amount };
      candidates.push(candidate);
      if (explicitBase) explicitBaseCandidates.push(candidate);
      else if (!variableComp) nonVariableCandidates.push(candidate);
    }
  }

  return explicitBaseCandidates[0] || (baseOnly ? nonVariableCandidates[0] : candidates[0]) || null;
}

function extractAnnualEarningsBand(text = "") {
  const lines = String(text || "")
    .split(/\n|\. /)
    .filter((line) => ANNUAL_EARNINGS_LABEL_RE.test(line) && !EQUITY_COMP_LABEL_RE.test(line));

  for (const line of lines) {
    const normalized = line.replace(/,/g, "");
    const hourly = HOURLY_COMP_RE.test(line);
    // An hourly base rate with "including tips" does not quantify the tips.
    // Keep annual cash unknown until the posting supplies an annual amount.
    if (hourly) continue;
    const range = normalized.match(
      /(?:usd\s*)?\$?\s*(\d{2,6}(?:\.\d+)?)(\s*k)?\s*(?:-|–|—|to)\s*(?:usd\s*)?\$?\s*(\d{2,6}(?:\.\d+)?)(\s*k)?/i
    );
    if (range) {
      if (!plausibleCompensationMatch(line, range, [range[1], range[3]], [range[2], range[4]])) {
        continue;
      }
      const min = normalizeMoney(range[1], range[2]);
      const max = normalizeMoney(range[3], range[4]);
      if (min >= 1_000 && max >= min && max <= 1_200_000) return { min, max };
    }
    const single = normalized.match(/(?:USD\s*)?\$?\s*(\d{2,7}(?:\.\d+)?)(\s*k)?\b/i);
    if (!single) continue;
    if (!plausibleCompensationMatch(line, single, [single[1]], [single[2]])) continue;
    const amount = normalizeMoney(single[1], single[2]);
    if (amount >= 1_000 && amount <= 1_200_000) return { min: amount, max: amount };
  }
  return null;
}

export function extractCompensationBands(text = "") {
  return {
    base: extractCompBand(text, { baseOnly: true }),
    annualEarnings: extractAnnualEarningsBand(text),
  };
}

function classifyCompensationText(text = "") {
  const value = String(text || "").trim();
  if (!value) return "unknown";
  const bands = extractCompensationBands(value);
  if (bands.base && !bands.annualEarnings) return "base";
  if (bands.annualEarnings && !bands.base) return "annual-earnings";
  return bands.base && bands.annualEarnings ? "mixed" : "unknown";
}

export function resolveCompensationEvidence(offer = {}) {
  const generic = String(offer.comp || "").trim();
  const genericBasis = classifyCompensationText(generic);
  const baseComp = String(offer.baseComp || "").trim() || (genericBasis === "base" ? generic : "");
  const annualEarningsComp =
    String(offer.annualEarningsComp || "").trim() ||
    (genericBasis === "annual-earnings" ? generic : "");
  return {
    baseComp,
    annualEarningsComp,
    unclassifiedComp:
      generic && generic !== baseComp && generic !== annualEarningsComp ? generic : "",
  };
}

function compensationEvidenceText(offer = {}, { includeBody = true } = {}) {
  const evidence = resolveCompensationEvidence(offer);
  return [
    evidence.baseComp ? `Base pay: ${evidence.baseComp}` : "",
    evidence.annualEarningsComp ? `Annual earnings: ${evidence.annualEarningsComp}` : "",
    evidence.unclassifiedComp ? `Compensation: ${evidence.unclassifiedComp}` : "",
    includeBody ? offer?.bodyText : "",
    includeBody ? offer?.description : "",
  ]
    .filter(Boolean)
    .join("\n");
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
  if (entry.provider) {
    const explicit = String(entry.provider).trim();
    if (explicit.toLowerCase() === "local-parser") return null;
    return isCareerOpsProviderSupported(explicit) ? explicit.toLowerCase() : explicit;
  }
  const url = entry.careers_url || "";
  if (/jobs\.ashbyhq\.com\//.test(url)) return "ashby";
  if (/job-boards(?:\.eu)?\.greenhouse\.io\/|boards\.greenhouse\.io\//.test(url))
    return "greenhouse";
  if (/jobs\.lever\.co\//.test(url)) return "lever";
  if (/apply\.workable\.com\//.test(url)) return "workable";
  if (/(careers|jobs)\.smartrecruiters\.com\//.test(url)) return "smartrecruiters";
  if (/\/\/[a-z0-9][a-z0-9-]*\.recruitee\.com/i.test(url)) return "recruitee";
  if (/[\w-]+\.wd[\w-]*\.myworkdayjobs\.com\//.test(url)) return "workday";
  return inferCareerOpsProvider(entry);
}

function sameRunOfferKeys(offer) {
  return postingIdentityKeys(offer);
}

function offerCompleteness(offer) {
  const bodyLength = String(offer?.bodyText || offer?.description || "").trim().length;
  return (
    Math.min(bodyLength, 20_000) +
    (offer?.bodyPartial === false ? 40_000 : 0) +
    (String(offer?.comp || "").trim() ? 4_000 : 0) +
    (String(offer?.location || "").trim() ? 1_000 : 0) +
    (offer?.postedAt ? 500 : 0)
  );
}

function sameRunDuplicateReason(left, right) {
  const rightKeys = new Set(postingIdentityKeys(right));
  const sharedKey = postingIdentityKeys(left).find((key) => rightKeys.has(key));
  if (sharedKey?.startsWith("url:")) return "url_batch";
  if (sharedKey?.startsWith("req:")) return "req_id_batch";
  return "company_role_batch";
}

function dedupeBeforeQualification(offers, { seenUrls, seenReqIds, seenRunCompanyRoles }) {
  const canonical = [];
  const duplicates = [];
  const entriesByKey = new Map();

  for (const [inputIndex, offer] of offers.entries()) {
    const req = extractReqId(offer?.url);
    if (seenUrls.has(offer?.url) || (req.id && seenReqIds.has(req.id))) {
      duplicates.push({
        ...offer,
        duplicateReason: seenUrls.has(offer?.url) ? "url" : "req_id",
        reqId: req.id,
      });
      continue;
    }

    const keys = sameRunOfferKeys(offer);
    const seenRunKey = keys.find((key) => seenRunCompanyRoles.has(key));
    if (seenRunKey) {
      duplicates.push({ ...offer, duplicateReason: "company_role_batch", reqId: req.id });
      continue;
    }
    const matches = [...new Set(keys.map((key) => entriesByKey.get(key)).filter(Boolean))].filter(
      (entry) => entry.active
    );
    if (matches.length === 0) {
      const entry = { offer, inputIndex, keys: new Set(keys), active: true };
      canonical.push(entry);
      for (const key of keys) entriesByKey.set(key, entry);
      continue;
    }

    const primary = matches[0];
    const candidates = [
      ...matches.map((entry) => ({ entry, offer: entry.offer, inputIndex: entry.inputIndex })),
      { entry: null, offer, inputIndex },
    ];
    const winner = candidates.reduce((best, candidate) =>
      offerCompleteness(candidate.offer) > offerCompleteness(best.offer) ? candidate : best
    );
    const mergedKeys = new Set(keys);
    for (const match of matches) {
      for (const key of match.keys) mergedKeys.add(key);
      if (match !== primary) match.active = false;
      if (match !== winner.entry) {
        duplicates.push({
          ...match.offer,
          duplicateReason: sameRunDuplicateReason(match.offer, winner.offer),
          reqId: extractReqId(match.offer?.url).id,
        });
      }
    }
    if (winner.entry !== null) {
      duplicates.push({
        ...offer,
        duplicateReason: sameRunDuplicateReason(winner.offer, offer),
        reqId: req.id,
      });
    }
    primary.offer = winner.offer;
    primary.inputIndex = winner.inputIndex;
    primary.keys = mergedKeys;
    for (const key of mergedKeys) entriesByKey.set(key, primary);
  }

  const activeCanonical = canonical.filter((entry) => entry.active);
  for (const entry of activeCanonical) {
    for (const key of entry.keys) seenRunCompanyRoles.add(key);
  }
  return { canonical: activeCanonical, duplicates };
}

export function filterAndDedupeOffers(
  offers,
  {
    seenUrls = new Set(),
    seenReqIds = new Set(),
    seenCompanyRoles = new Set(),
    titleFilter = () => true,
    locationFilter = () => true,
    config = {},
    now = Date.now(),
    companyPresentationCounts = new Map(),
    seenRunCompanyRoles = new Set(),
    perCompanyCap = Infinity,
    deferPartialCandidatePolicy = false,
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
  const prequalified = dedupeBeforeQualification(offers, {
    seenUrls,
    seenReqIds,
    seenRunCompanyRoles,
  });
  duplicates.push(...prequalified.duplicates);

  for (const { offer, inputIndex } of prequalified.canonical) {
    if (!offer.url || !offer.title || !offer.company) {
      invalid.push({ ...offer, reason: "missing url, title, or company" });
      continue;
    }
    const titleDecision =
      typeof titleFilter.classify === "function"
        ? titleFilter.classify(offer.title)
        : { matched: titleFilter(offer.title), blocked: false, adjacent: false };
    let rating = null;
    let titleRelevance = null;
    if (!titleDecision.matched) {
      if (titleDecision.blocked) {
        filteredTitle.push({
          ...offer,
          qualificationKind: "blocker",
          qualificationReason: "title-negative-blocker",
        });
        continue;
      }
      rating = scoreSourcedOffer(offer, config);
      if (
        !titleDecision.adjacent ||
        rating.score < scannerLikelyKeepThreshold(config?.modes) ||
        rating.gate === "likely-cut"
      ) {
        filteredTitle.push({
          ...offer,
          qualificationKind: "relevance",
          qualificationReason: "title-relevance-low",
        });
        continue;
      }
      titleRelevance = "adjacent-signal";
    } else if (typeof titleFilter.classify === "function") {
      rating = scoreSourcedOffer(offer, config);
      if (rating.ruleFlags?.includes("title-target-mismatch")) {
        filteredTitle.push({
          ...offer,
          qualificationKind: "relevance",
          qualificationReason: "title-relevance-low",
        });
        continue;
      }
    }
    const qualification = qualifyCandidateOffer(offer, {
      config,
      now,
      locationFilter,
      deferBodyDependentPolicy: deferPartialCandidatePolicy && offer.bodyPartial === true,
    });
    if (!qualification.eligible) {
      const bucket = QUALIFICATION_BUCKETS[qualification.bucket];
      const buckets = {
        filteredSeniority,
        filteredLocation,
        filteredAge,
        filteredSalary,
        filteredEligibility,
      };
      buckets[bucket].push({
        ...offer,
        qualificationReason: qualification.reason,
        ...(qualification.distanceMiles == null
          ? {}
          : { distanceMiles: qualification.distanceMiles }),
        ...(qualification.compBand ? { compBand: qualification.compBand } : {}),
        ...(qualification.annualEarningsBand
          ? { annualEarningsBand: qualification.annualEarningsBand }
          : {}),
      });
      continue;
    }
    const key = normalizeCompanyRoleKey(offer.company, offer.title);
    const req = extractReqId(offer.url);
    seenUrls.add(offer.url);
    if (req.id) seenReqIds.add(req.id);
    const possibleDuplicate = seenCompanyRoles.has(key);
    if (possibleDuplicate) possibleDuplicates.push(offer);
    seenCompanyRoles.add(key);
    const qualifiedOffer = qualification.displayLocation
      ? { ...offer, location: qualification.displayLocation }
      : offer;
    qualified.push({
      ...qualifiedOffer,
      key,
      reqId: req.id,
      possibleDuplicate,
      qualificationUnknowns: qualification.qualificationUnknowns,
      ...(titleRelevance ? { titleRelevance } : {}),
      _qualificationInputIndex: inputIndex,
      ...(rating || scoreSourcedOffer(qualifiedOffer, config)),
    });
  }

  const presentation = applyPresentationCaps(qualified, {
    companyPresentationCounts,
    perCompanyCap,
  });
  kept.push(...presentation.kept);
  overflow.push(...presentation.overflow);

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

export async function scanCompanies(
  config,
  { fetchImpl = fetch, resolveHost, dispatcherFactory, companyFilter = null, signal } = {}
) {
  const companies = (config.tracked_companies || [])
    .filter((entry) => entry && entry.enabled !== false)
    .filter(
      (entry) => !companyFilter || entry.name.toLowerCase().includes(companyFilter.toLowerCase())
    );

  const results = [];
  const errors = [];

  for (const company of companies) {
    signal?.throwIfAborted?.();
    const provider = inferProvider(company);
    if (!provider || !isCompanyProviderSupported(provider)) {
      errors.push({ company: company.name, error: "no supported provider inferred" });
      continue;
    }
    try {
      const jobs = await fetchProvider(provider, company, {
        fetchImpl,
        resolveHost,
        dispatcherFactory,
        signal,
      });
      results.push(...jobs.map((job) => ({ ...job, source: `${provider}-api` })));
    } catch (error) {
      errors.push({ company: company.name, error: error.message });
    }
  }

  return { offers: results, errors };
}

// Every provider this dispatches to — the seven ATS providers formerly fetched
// by this module's own unguarded fetchers (ashby, greenhouse, lever, workable,
// smartrecruiters, recruitee, workday) plus every other Career Ops adapter —
// is now routed through fetchCareerOpsProvider, which sends every request
// through the shared SSRF guard in public-http-fetch.mjs (see
// career-ops-registry.mjs's request()). Before this, those seven had their own
// legacy fetchers here that called fetchImpl directly against entry.api/
// careers_url with native redirect-following and no host revalidation — a
// malicious or poisoned source entry could aim the request at a loopback,
// link-local, or cloud-metadata target, and the vendored providers' own
// upgrades (lever's allLocations dedupe, smartrecruiters/greenhouse/recruitee
// description hydration, ashby's retry policy) never ran because the legacy
// branches short-circuited before the isCareerOpsProviderSupported check
// below ever ran. All seven are adopted Career Ops providers (see
// provider-parity.mjs), so isCareerOpsProviderSupported already covers them —
// there is nothing left for a dedicated branch to do.
//
// `fetchImplOrOptions` accepts either a bare fetchImpl function (the shape
// every caller in this file already used) or an options object carrying
// { fetchImpl, resolveHost, dispatcherFactory } for tests that need to inject
// the guard's DNS/dispatcher seams the same way career-ops-registry.test.mjs
// does.
export async function fetchProvider(provider, entry, fetchImplOrOptions = fetch) {
  const providerId = String(provider || "").toLowerCase();
  const options =
    typeof fetchImplOrOptions === "function"
      ? { fetchImpl: fetchImplOrOptions }
      : { ...fetchImplOrOptions };
  if (!options.fetchImpl) options.fetchImpl = fetch;
  if (providerId === "rss") return fetchRss(entry, options);
  if (isCareerOpsProviderSupported(providerId)) {
    return fetchCareerOpsProvider(providerId, entry, options);
  }
  throw new Error(`unsupported provider: ${providerId || provider}`);
}

// Fetch + parse a single RSS source (a config/search-sources.yml entry with an
// rssUrl, or any { rssUrl | url }) into scanner offers. This is the runtime
// consumer for the rss.mjs provider. The URL is user-config-controlled the
// same way a tracked-company entry's api/careers_url is, so it goes through
// the same guardedFetch used by every Career Ops provider request rather than
// a raw fetchImpl call.
async function fetchRss(
  source = {},
  { fetchImpl = fetch, resolveHost, dispatcherFactory, signal } = {}
) {
  const url = source.rssUrl || source.url;
  if (!url) return [];
  // guardedFetch has no timeoutMs of its own (see its own comment). The
  // caller supplies the deadline via init.signal, same as career-ops-registry's
  // request(). One try/finally (mirroring that request()'s own timer scoping)
  // keeps the abort timer live across BOTH the guarded fetch AND the body
  // read below, clearing it only once response.text() has settled. A two-
  // finally split that cleared it right after guardedFetch resolved would
  // stop covering a host that returns headers and then stalls the body,
  // hanging that read forever instead of failing the source on deadline.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RSS_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  let close = null;
  try {
    const guarded = await guardedFetch(
      url,
      { signal: requestSignal },
      { fetchImpl, resolveHost, dispatcherFactory }
    );
    if (!guarded.ok) {
      const blockedUrl = guarded.finalUrl && guarded.finalUrl !== url ? guarded.finalUrl : url;
      throw new Error(`RSS request blocked for ${blockedUrl}: ${guarded.reason}`);
    }
    close = guarded.close;
    if (!guarded.response.ok) {
      throw new Error(`${url} returned HTTP ${guarded.response.status}`);
    }
    const xml = await guarded.response.text();
    const { items } = parseFeed(xml);
    return feedItemsToOffers(items, { source });
  } finally {
    clearTimeout(timeout);
    if (close) await close();
  }
}

// Scan the enabled RSS-bearing sources from a parsed config/search-sources.yml.
// This is what wires setup-searches output into the sourced sweep: any enabled
// source with source_type "rss" or an rssUrl is fetched and folded into the scan.
// Non-fetchable source types (browser/auth aggregators like HiringCafe, Wellfound,
// authenticated LinkedIn/Indeed) are driven by the agent's session browser per the
// Browser Automation Contract and are intentionally skipped here.
export async function scanSearchSources(
  searchSources,
  { fetchImpl = fetch, resolveHost, dispatcherFactory } = {}
) {
  const sources = (searchSources?.sources || searchSources?.searches || [])
    .filter((s) => s && s.enabled !== false)
    .filter((s) => s.source_type === "rss" || s.rssUrl);

  const results = [];
  const errors = [];
  for (const source of sources) {
    try {
      const offers = await fetchRss(source, { fetchImpl, resolveHost, dispatcherFactory });
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
export async function scanBoards(
  searchSources,
  { fetchImpl = fetch, resolveHost, dispatcherFactory } = {}
) {
  const sources = (searchSources?.sources || searchSources?.searches || [])
    .filter((s) => s && s.enabled !== false)
    .filter(
      (s) => ["ats", "board"].includes(s.source_type) && isBoardProviderSupported(s.provider)
    );

  const results = [];
  const errors = [];
  for (const source of sources) {
    const providerId = String(source.provider || "").toLowerCase();
    const provider = BOARD_PROVIDERS[providerId];
    try {
      const offers = provider
        ? await provider(source, {
            fetchImpl,
            resolveHost,
            dispatcherFactory,
          })
        : await fetchProvider(providerId, source, { fetchImpl, resolveHost, dispatcherFactory });
      const sourceKind = source.source_type === "ats" ? "api" : "board";
      results.push(...offers.map((offer) => ({ ...offer, source: `${providerId}-${sourceKind}` })));
    } catch (error) {
      errors.push({ company: source.label || providerId, error: error.message });
    }
  }
  return { offers: results, errors };
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
