// Whether a candidate's targeting carries the config that adjacent-title and
// commute-area matching run on. Targeting written before title lanes existed
// has primary titles only, so recall drops quietly. Doctor and the scan summary
// use this to say so out loud.

export const ADJACENCY_NEXT_ACTION = "run search setup to add related titles";

function hasTitles(bucket) {
  return (
    Array.isArray(bucket?.titles) &&
    bucket.titles.some((title) => String(title || "").trim().length > 0)
  );
}

function hasPatterns(family) {
  return (
    Array.isArray(family?.patterns) &&
    family.patterns.some((pattern) => String(pattern || "").trim().length > 0)
  );
}

/**
 * @returns {{ checked: boolean, missingAdjacentTitles: boolean,
 *   missingCommuteCities: boolean, gaps: string[], nextAction: string|null }}
 * `checked` is false when there is no primary title to hang adjacency on yet
 * (setup has not happened), so there is nothing to call out.
 */
export function targetingAdjacencyGaps(targeting, profile) {
  const buckets = Array.isArray(targeting?.role_buckets) ? targeting.role_buckets : [];
  const checked = buckets.some((bucket) => hasTitles(bucket));
  const none = {
    checked,
    missingAdjacentTitles: false,
    missingCommuteCities: false,
    gaps: [],
    nextAction: null,
  };
  if (!checked) return none;

  const hasAdjacentBucket = buckets.some(
    (bucket) => bucket?.priority && bucket.priority !== "primary" && hasTitles(bucket)
  );
  const hasFamilies = (Array.isArray(targeting?.role_families) ? targeting.role_families : []).some(
    hasPatterns
  );
  const missingAdjacentTitles = !hasAdjacentBucket && !hasFamilies;

  const location = profile?.location || {};
  const local = location.onsite === true || location.hybrid === true;
  const cities = Array.isArray(location.commute_cities)
    ? location.commute_cities.filter((city) => String(city || "").trim())
    : [];
  const missingCommuteCities = local && cities.length === 0;

  const gaps = [];
  if (missingAdjacentTitles) {
    gaps.push("no related titles (no secondary role bucket and no role_families)");
  }
  if (missingCommuteCities) {
    gaps.push("no commute cities for an on-site or hybrid candidate");
  }
  return {
    checked,
    missingAdjacentTitles,
    missingCommuteCities,
    gaps,
    nextAction: gaps.length > 0 ? ADJACENCY_NEXT_ACTION : null,
  };
}

// One line for the scan summary, or null when the config is fine.
export function adjacencyNote(targeting, profile) {
  const { gaps } = targetingAdjacencyGaps(targeting, profile);
  if (gaps.length === 0) return null;
  return `Ran without adjacency config: ${gaps.join("; ")}. Related roles and nearby towns may be missed; ${ADJACENCY_NEXT_ACTION}.`;
}
