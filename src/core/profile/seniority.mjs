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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleContains(title, configuredTitle) {
  const text = String(title || "").toLowerCase();
  const term = String(configuredTitle || "")
    .trim()
    .toLowerCase();
  if (!term) return false;
  const left = /^[a-z0-9]/.test(term) ? "(^|[^a-z0-9])" : "";
  const right = /[a-z0-9]$/.test(term) ? "($|[^a-z0-9])" : "";
  return new RegExp(`${left}${escapeRegExp(term)}${right}`).test(text);
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

export function relativeSeniority(title, targeting = {}) {
  const decisions = [];
  for (const bucket of Array.isArray(targeting?.role_buckets) ? targeting.role_buckets : []) {
    const levels = validLevels(bucket);
    const minimumRank = targetRank(bucket, levels);
    if (minimumRank == null) continue;
    const actualLevel = matchingLevel(title, levels);
    if (!actualLevel) continue;
    decisions.push({
      bucket: String(bucket?.name || ""),
      rank: actualLevel.rank,
      targetRank: minimumRank,
      classification: actualLevel.rank < minimumRank ? "below-target" : "at-or-above-target",
    });
  }

  return (
    decisions.find((decision) => decision.classification === "at-or-above-target") ||
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
