function compactTitles(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const title = String(value || "").trim();
    const key = title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    out.push(title);
  }
  return out;
}

function titleWords(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Split a posting title into punctuation-delimited segments (commas, parens,
// slashes, dashes) and word-tokenize each one. "Platform Engineer, Staff" ->
// [[platform, engineer], [staff]]; a title with no such punctuation is a
// single segment.
function titleSegments(value) {
  return String(value || "")
    .split(/[,()/\-–—]+/)
    .map((segment) => titleWords(segment))
    .filter((tokens) => tokens.length > 0);
}

// Cap on segment count before trying every reordering. Realistic Greenhouse
// or Lever titles carry at most 2-3 punctuation-delimited segments ("Role,
// Level" or "Role (Level) - Team"); 4! = 24 orderings is cheap. Above the
// cap we skip the reorder search rather than let a pathological
// many-segment title (e.g. one string of dashes) blow up factorially -
// such a title still gets checked in its original segment order, just not
// permuted.
const MAX_PERMUTATION_SEGMENTS = 4;

function segmentPermutations(segments) {
  if (segments.length <= 1 || segments.length > MAX_PERMUTATION_SEGMENTS) return [segments];
  const results = [];
  const used = new Array(segments.length).fill(false);
  const current = [];
  const backtrack = () => {
    if (current.length === segments.length) {
      results.push(current.slice());
      return;
    }
    for (let i = 0; i < segments.length; i += 1) {
      if (used[i]) continue;
      used[i] = true;
      current.push(segments[i]);
      backtrack();
      current.pop();
      used[i] = false;
    }
  };
  backtrack();
  return results;
}

function containsContiguousSequence(haystack, needle) {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

// A configured title matches when its words appear CONTIGUOUSLY and in order
// within some reordering of the posting title's punctuation-delimited
// segments. This catches "Role, Level" and "Role (Level)" renderings (common
// on Greenhouse/Lever) that a plain contiguous-substring check misses,
// without going as loose as an unordered word-anywhere-in-the-title test:
// words from unrelated segments (e.g. "Senior Manager, Engineer Enablement")
// can never interleave to form a match, because a permutation only reorders
// whole segments, never the words inside or across them out of sequence.
function titleContains(title, configuredTitle) {
  const termWords = titleWords(configuredTitle);
  if (termWords.length === 0) return false;
  const segments = titleSegments(title);
  if (segments.length === 0) return false;
  for (const order of segmentPermutations(segments)) {
    const haystack = order.flat();
    if (containsContiguousSequence(haystack, termWords)) return true;
  }
  return false;
}

function validLevels(bucket) {
  return (Array.isArray(bucket?.seniority_ladder) ? bucket.seniority_ladder : [])
    .map((level) => ({
      rank: level?.rank,
      titles: compactTitles(level?.titles),
    }))
    .filter((level) => Number.isInteger(level.rank) && level.titles.length > 0);
}

function matchingLevel(title, levels) {
  const matches = [];
  for (const level of levels) {
    for (const configuredTitle of level.titles) {
      if (!titleContains(title, configuredTitle)) continue;
      matches.push({
        level,
        specificity: configuredTitle.replace(/[^a-z0-9]/gi, "").length,
      });
    }
  }
  matches.sort(
    (left, right) =>
      right.specificity - left.specificity || Number(right.level.rank) - Number(left.level.rank)
  );
  return matches[0]?.level || null;
}

function targetRank(bucket, levels) {
  const ranks = compactTitles(bucket?.titles)
    .map((title) => matchingLevel(title, levels)?.rank)
    .filter(Number.isInteger);
  return ranks.length > 0 ? Math.min(...ranks) : null;
}

// Optional per-bucket ceiling: ranks strictly above it are too senior for this
// candidate (the ladder lists them so they can be recognized and cut).
function seniorityCeiling(bucket) {
  const ceiling = bucket?.seniority_ceiling;
  return Number.isInteger(ceiling) ? ceiling : null;
}

// Generic level words, used only when a ladder is configured and the title is
// not on it. Ladder entries always win; this just stops "VP, X" or "New Grad X"
// from falling through as unknown rank in any field.
const EXECUTIVE_LEVEL_PHRASES = [
  "vp",
  "svp",
  "evp",
  "vice president",
  "chief",
  "head of",
  "director",
  "ceo",
  "cfo",
  "coo",
  "cto",
  "cio",
  "cmo",
  "cro",
  "cpo",
  "chro",
  "ciso",
].map((phrase) => titleWords(phrase));

const ENTRY_LEVEL_PHRASES = [
  "intern",
  "internship",
  "new grad",
  "new graduate",
  "graduate program",
  "residency",
  "apprentice",
  "apprenticeship",
  "entry level",
  "junior",
  "jr",
  "associate",
].map((phrase) => titleWords(phrase));

function phrasesIn(words, phrases) {
  return phrases.filter((phrase) => containsContiguousSequence(words, phrase));
}

// "above" | "below" | null. A word the candidate's own target titles use is
// theirs (a Director candidate who never listed a ladder rank for it still
// wants Directors), and so is any word the ladder itself lists.
function genericLevel(title, targeting, ceiling) {
  const words = titleWords(title);
  const own = [];
  for (const bucket of Array.isArray(targeting?.role_buckets) ? targeting.role_buckets : []) {
    for (const target of compactTitles(bucket?.titles)) own.push(titleWords(target));
    for (const level of validLevels(bucket)) {
      for (const listed of level.titles) own.push(titleWords(listed));
    }
  }
  const unowned = (phrases) =>
    phrasesIn(words, phrases).filter(
      (phrase) => !own.some((target) => containsContiguousSequence(target, phrase))
    );
  if (ceiling != null && unowned(EXECUTIVE_LEVEL_PHRASES).length > 0) return "above";
  if (unowned(ENTRY_LEVEL_PHRASES).length > 0) return "below";
  return null;
}

export function relativeSeniority(title, targeting = {}) {
  const decisions = [];
  for (const bucket of Array.isArray(targeting?.role_buckets) ? targeting.role_buckets : []) {
    const levels = validLevels(bucket);
    const minimumRank = targetRank(bucket, levels);
    if (minimumRank == null) continue;
    const actualLevel = matchingLevel(title, levels);
    const ceiling = seniorityCeiling(bucket);
    if (!actualLevel) {
      const generic = genericLevel(title, targeting, ceiling);
      if (generic) {
        decisions.push({
          bucket: String(bucket?.name || ""),
          rank: null,
          targetRank: minimumRank,
          fallback: true,
          classification: generic === "above" ? "above-target" : "below-target",
        });
      }
      continue;
    }
    decisions.push({
      bucket: String(bucket?.name || ""),
      rank: actualLevel.rank,
      targetRank: minimumRank,
      classification:
        actualLevel.rank < minimumRank
          ? "below-target"
          : ceiling != null && actualLevel.rank > ceiling
            ? "above-target"
            : "at-or-above-target",
    });
  }

  return (
    decisions.find((decision) => decision.classification === "at-or-above-target") ||
    decisions.find((decision) => decision.classification === "above-target") ||
    decisions[0] || { classification: "unclassified" }
  );
}

export function titlesBelowTarget(targeting = {}) {
  const titles = [];
  const seen = new Set();
  let configured = false;
  for (const bucket of Array.isArray(targeting?.role_buckets) ? targeting.role_buckets : []) {
    const levels = validLevels(bucket);
    const minimumRank = targetRank(bucket, levels);
    if (minimumRank == null) continue;
    configured = true;
    for (const level of levels) {
      if (level.rank >= minimumRank) continue;
      for (const title of level.titles) {
        const key = title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        titles.push(title);
      }
    }
  }
  return { configured, titles };
}
