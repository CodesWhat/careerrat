// linkedin.mjs — the deterministic LinkedIn saved-search URL builder. Sibling
// of hiringcafe.mjs (same directory, same "pure function, no I/O" shape) but
// genuinely new code: unlike hiring.cafe, LinkedIn has no existing builder —
// only a prose recipe an agent applies by hand
// (.agents/skills/search-jobs/SKILL.md's "LinkedIn URL-filter recipe" section).
// This module codifies that recipe as a pure function so the M8 onboarding
// wizard's targeting step can render a live "here's what your saved search
// will look like" preview without re-deriving the query-param shape.
//
// Real, observed examples of the shape this must produce (present today in
// this workspace's own config/search-sources.yml, `platform: linkedin`
// entries):
//
//   https://www.linkedin.com/jobs/search/?keywords=%22Forward%20Deployed%20Engineer%22
//     &location=United%20States&f_TPR=r86400&f_SB2=9&sortBy=DD
//
// Encoding note: query params are built with encodeURIComponent (not
// URLSearchParams.toString(), which encodes spaces as "+" rather than "%20")
// so the output is byte-for-byte the same encoding LinkedIn's own UI produces
// and this workspace's existing entries already use.

const LINKEDIN_SEARCH_ORIGIN = "https://www.linkedin.com/jobs/search/";

// f_SB2's band-to-dollar mapping is not publicly documented; the only
// confirmed data points (SKILL.md's own recipe comment) are band 7 ≈ $160k,
// band 8 ≈ $180k, band 9 ≈ $200k — a fixed $20k step per band, i.e.
// threshold(band) = 20000 * (band + 1). Kept local to this file (not
// hardcoded into a wizard/UI layer) so the one place that knows LinkedIn's
// banding scheme is this provider module, matching hiringcafe.mjs's own
// "provider-specific quirks live in the provider file" precedent.
const SALARY_BAND_STEP = 20000;

// Derive the f_SB2 band integer from profile.yml#compensation.minimum_base —
// "never hardcode a figure," per the SKILL.md recipe. Picks the band whose
// threshold is at or BELOW minimumBase (floor(base / step) - 1, never
// rounded up) so a real qualifying posting is never excluded by a banding
// mismatch; evaluate-job's own comp-floor check is what actually enforces
// the hard cutoff downstream. Returns null for a non-positive/non-numeric
// input rather than throwing — an unset comp floor should degrade to "no
// salary filter," not break the whole search-URL preview.
//
// This is an addition beyond the M8 frozen contract's literal
// buildLinkedInSearchUrl({keywords, location, remote, salaryBand,
// postedWithin, sortBy}) signature (which takes salaryBand pre-computed) —
// exported separately so a caller that only has minimumBase (not yet a band
// integer) doesn't have to re-derive this formula itself.
export function salaryBandForMinimumBase(minimumBase) {
  const base = Number(minimumBase);
  if (!Number.isFinite(base) || base <= 0) return null;
  return Math.max(0, Math.floor(base / SALARY_BAND_STEP) - 1);
}

function encodeParam(key, value) {
  return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

// Pure — builds the saved-search URL string. Params are appended in the same
// order LinkedIn's own UI produces them (keywords, location, f_TPR, f_SB2,
// [f_WT], sortBy) so a pasted real URL and this builder's output read the
// same way for a human comparing them.
//
//   keywords        required, non-empty string — wrapped in literal quotes
//                   for an exact-phrase match per the SKILL.md recipe
//                   (pass an already-unquoted phrase; quoting is this
//                   function's job, not the caller's).
//   location        optional string, passed through to `location=`.
//   remote          optional boolean — true adds f_WT=2 (LinkedIn's
//                   Workplace-Type filter for "Remote"). Not part of the
//                   SKILL.md recipe (which only covers keywords/f_TPR/f_SB2/
//                   sortBy/location) but a reasonable, documented extension
//                   to satisfy the frozen signature's `remote` field —
//                   flagged here since it's the one param this builder had
//                   to interpret rather than transcribe.
//   salaryBand      optional non-negative integer — the f_SB2 value
//                   verbatim (see salaryBandForMinimumBase() above for how
//                   to derive one from a dollar figure).
//   postedWithin    optional positive number of HOURS — converted to
//                   f_TPR's `r<seconds>` shape internally. Hours (not raw
//                   seconds) to match this codebase's existing recency-
//                   window convention (hiringcafe.mjs's own `windowHours`,
//                   resolveRecencyWindow's `windowHours`) even though the
//                   frozen contract names the field `postedWithin` without
//                   a unit suffix — documented assumption, see this file's
//                   test suite for the exact seconds each value produces.
//   sortBy          defaults to "DD" (date, descending) per the recipe.
export function buildLinkedInSearchUrl({
  keywords,
  location = null,
  remote = false,
  salaryBand = null,
  postedWithin = null,
  sortBy = "DD",
} = {}) {
  if (!keywords || typeof keywords !== "string" || !keywords.trim()) {
    throw new Error("buildLinkedInSearchUrl requires a non-empty keywords string");
  }

  const params = [encodeParam("keywords", `"${keywords.trim()}"`)];

  if (location) {
    params.push(encodeParam("location", String(location)));
  }

  if (postedWithin !== null && postedWithin !== undefined) {
    const hours = Number(postedWithin);
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new Error("buildLinkedInSearchUrl: postedWithin must be a positive number of hours");
    }
    const seconds = Math.round(hours * 3600);
    params.push(encodeParam("f_TPR", `r${seconds}`));
  }

  if (salaryBand !== null && salaryBand !== undefined) {
    const band = Number(salaryBand);
    if (!Number.isInteger(band) || band < 0) {
      throw new Error("buildLinkedInSearchUrl: salaryBand must be a non-negative integer");
    }
    params.push(encodeParam("f_SB2", String(band)));
  }

  if (remote) {
    params.push(encodeParam("f_WT", "2"));
  }

  params.push(encodeParam("sortBy", sortBy || "DD"));

  return `${LINKEDIN_SEARCH_ORIGIN}?${params.join("&")}`;
}
