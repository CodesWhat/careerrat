// Field-neutral job-title normalization and lane matching. There is no
// built-in job-family vocabulary here: a "lane" is derived from the candidate's
// own targeting (role_families patterns when present, else the words of their
// primary role_buckets titles), and the adjacent titles and abbreviations that
// widen it come from the candidate's secondary buckets.

const FILLER_WORDS = new Set(["a", "an", "and", "at", "for", "in", "of", "the", "to"]);

// Cross-field rank markers. Whether a rank is wanted is the candidate's
// seniority_ladder to decide; here they only stop a level from being read as
// part of the job function.
const LEVEL_WORDS = new Set([
  "senior",
  "junior",
  "staff",
  "principal",
  "lead",
  "associate",
  "assistant",
  "intern",
  "internship",
  "entry",
  "level",
  "director",
  "vp",
  "vice",
  "president",
  "head",
  "chief",
  "i",
  "ii",
  "iii",
  "iv",
  "v",
]);
const LEVEL_NUMBER_RE = /^(?:l\d+|\d+)$/;

// Generic tier nouns. They are dropped from a lane only when at least two
// other words remain ("Customer Success Manager" -> customer success), so a
// bare "Program Manager" or "Account Manager" keeps its noun and does not
// swallow every other kind of "Account ...".
const TIER_WORDS = new Set(["manager", "specialist"]);

const ABBREVIATIONS = new Map([
  ["sr", "senior"],
  ["jr", "junior"],
  ["mgr", "manager"],
]);

// Employment-form, work-mode and region decorations. A segment made only of
// these words is dropped; the same phrases are also removed wherever they sit.
const DECORATION_PHRASES = [
  /\bfull[ -]?time\b/g,
  /\bpart[ -]?time\b/g,
  /\bper[ -]?diem\b/g,
  /\bon[ -]?site\b/g,
  /\bin[ -]office\b/g,
  /\bremote\b/g,
  /\bhybrid\b/g,
  /\bcontract(?:or)?(?:[ -]to[ -]hire)?\b/g,
  /\bc2h\b/g,
  /\btemp(?:orary)?\b/g,
  /\bpermanent\b/g,
  /\bseasonal\b/g,
  /\bfreelance\b/g,
  /\b\d+[ -]?(?:weeks?|wks?|months?|mos?)\b/g,
];
const REGION_WORDS = new Set([
  "us",
  "usa",
  "u",
  "s",
  "a",
  "uk",
  "eu",
  "emea",
  "apac",
  "latam",
  "canada",
  "north",
  "america",
  "united",
  "states",
  "based",
  "only",
  "nationwide",
]);

function words(text) {
  return text.split(/[^a-z0-9]+/).filter(Boolean);
}

function isDecorationSegment(segment) {
  const list = words(segment);
  return list.length > 0 && list.every((word) => REGION_WORDS.has(word));
}

function clean(title) {
  let text = String(title || "")
    .toLowerCase()
    .replace(/&/g, " and ");
  for (const pattern of DECORATION_PHRASES) text = text.replace(pattern, " ");
  return text;
}

function isLevel(word) {
  return LEVEL_WORDS.has(word) || LEVEL_NUMBER_RE.test(word);
}

/**
 * Field-agnostic title normalization.
 *   function:   words of the head segment minus rank markers and filler
 *   qualifiers: words of the segments after a comma, dash, slash or
 *               parenthesis (team, specialty, location), minus rank markers
 *   level:      rank markers found anywhere ("senior", "ii", "l5", "2")
 *   words:      function + qualifiers, the set lane matching reads
 * Seniority and employment decorations never count as the function.
 */
export function normalizeTitle(title) {
  const segments = clean(title)
    .split(/\s[-–—]\s|[,()/–—]+/)
    .map((segment) => segment.replace(/-/g, " "))
    .map((segment) =>
      words(segment)
        .map((word) => ABBREVIATIONS.get(word) || word)
        .join(" ")
    )
    .filter((segment) => segment && !isDecorationSegment(segment));

  const level = [];
  const split = segments.map((segment) => {
    const kept = [];
    for (const word of segment.split(" ")) {
      if (isLevel(word)) level.push(word);
      else if (!FILLER_WORDS.has(word)) kept.push(word);
    }
    return kept;
  });

  // A title that is nothing but rank words ("Chief of Staff") keeps them.
  if (split.every((segment) => segment.length === 0)) {
    const fallback = segments
      .flatMap((segment) => segment.split(" "))
      .filter((word) => !["senior", "junior"].includes(word) && !FILLER_WORDS.has(word));
    return { function: fallback, qualifiers: [], level: [], words: fallback };
  }

  const headIndex = split.findIndex((segment) => segment.length > 0);
  const head = split[headIndex];
  const qualifiers = split.filter((_segment, index) => index !== headIndex).flat();
  return { function: head, qualifiers, level, words: [...head, ...qualifiers] };
}

function stripTierWords(set) {
  const stripped = [...set].filter((word) => !TIER_WORDS.has(word));
  return new Set(stripped.length >= 2 ? stripped : set);
}

function isSubset(small, large) {
  return small.every((word) => large.has(word));
}

/**
 * Minimal word-set lanes for a list of target titles. The generic tier noun is
 * dropped from a title's words first (see stripTierWords). A title whose words
 * contain another title's words adds nothing, so the broader lane absorbs it
 * and keeps its title as a source (used for rank compatibility).
 * @returns {Array<{words: Set<string>, sources: string[]}>}
 */
export function deriveLanes(titles) {
  const entries = [];
  for (const title of titles) {
    const set = stripTierWords(new Set(normalizeTitle(title).words));
    if (set.size > 0) entries.push({ words: set, title: String(title) });
  }
  const lanes = [];
  for (const entry of entries) {
    const covers = entries.some(
      (other) =>
        other !== entry &&
        isSubset([...other.words], entry.words) &&
        (other.words.size < entry.words.size || entries.indexOf(other) < entries.indexOf(entry))
    );
    if (!covers) lanes.push({ words: entry.words, sources: [entry.title] });
  }
  for (const entry of entries) {
    for (const lane of lanes) {
      if (isSubset([...lane.words], entry.words) && !lane.sources.includes(entry.title)) {
        lane.sources.push(entry.title);
      }
    }
  }
  return lanes;
}

function partitionBuckets(targeting) {
  const primary = [];
  const adjacent = [];
  for (const bucket of Array.isArray(targeting?.role_buckets) ? targeting.role_buckets : []) {
    const titles = (Array.isArray(bucket?.titles) ? bucket.titles : [])
      .map((title) => String(title || "").trim())
      .filter(Boolean);
    // A bucket with no priority is a plain target, as it always was.
    (bucket?.priority && bucket.priority !== "primary" ? adjacent : primary).push(...titles);
  }
  return { primary, adjacent };
}

const specCache = new WeakMap();

function targetingSignature(targeting) {
  return JSON.stringify([
    (targeting.role_buckets || []).map((bucket) => [bucket?.priority, bucket?.titles]),
    (targeting.role_families || []).map((family) => family?.patterns),
  ]);
}

/**
 * Lane spec for a candidate: `{ primary, adjacent, lanes, patterns,
 * adjacentLanes }`. Primary titles are the exact targets. Lanes come from
 * `role_families` patterns when present (`patterns`), else from the words of
 * the primary titles. Titles in secondary buckets are adjacent.
 * `fallbackTitles` stands in for the primary titles when the targeting has no
 * role_buckets (a bare title filter).
 */
export function buildLaneSpec(targeting, fallbackTitles = []) {
  const hasBuckets =
    targeting && typeof targeting === "object" && Array.isArray(targeting.role_buckets);
  const signature = hasBuckets ? targetingSignature(targeting) : null;
  const cached = hasBuckets ? specCache.get(targeting) : null;
  if (cached && cached.signature === signature) return cached.spec;
  const { primary, adjacent } = partitionBuckets(targeting);
  const primaryTitles = primary.length > 0 || adjacent.length > 0 ? primary : fallbackTitles;
  const families = Array.isArray(targeting?.role_families) ? targeting.role_families : [];
  const patterns = families
    .flatMap((family) => (Array.isArray(family?.patterns) ? family.patterns : []))
    .map((pattern) =>
      String(pattern || "")
        .toLowerCase()
        .trim()
    )
    .filter(Boolean);
  const spec = {
    primary: primaryTitles,
    adjacent,
    patterns,
    lanes: patterns.length > 0 ? [] : deriveLanes(primaryTitles),
    adjacentLanes: deriveLanes(adjacent),
  };
  if (hasBuckets && (primary.length > 0 || adjacent.length > 0)) {
    specCache.set(targeting, { signature, spec });
  }
  return spec;
}

/**
 * Whether a posting title sits in the candidate's lane: it carries all the
 * words of a primary-title lane (or any `role_families` pattern), or of a
 * secondary-bucket title. `compatible(source)` filters lanes by the rank of the
 * title they came from.
 * @returns {"lane"|"adjacent"|null}
 */
export function laneMatch(actualTitle, spec, compatible = () => true) {
  const actual = new Set(normalizeTitle(actualTitle).words);
  const lower = String(actualTitle || "").toLowerCase();
  const inLane = (lane) =>
    isSubset([...lane.words], actual) && lane.sources.some((source) => compatible(source));
  if (spec.patterns.length > 0) {
    if (
      spec.patterns.some((pattern) => lower.includes(pattern)) &&
      (spec.primary.length === 0 || spec.primary.some((source) => compatible(source)))
    ) {
      return "lane";
    }
  } else if (spec.lanes.some(inLane)) {
    return "lane";
  }
  return spec.adjacentLanes.some(inLane) ? "adjacent" : null;
}
