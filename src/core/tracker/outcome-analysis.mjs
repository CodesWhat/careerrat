/**
 * Resolve the ordered family list from an optional targeting config.
 *
 * Priority:
 *  1. targeting.role_families  — explicit [{name, patterns[]}] array
 *  2. targeting.role_buckets   — derive each bucket name → its titles as patterns
 *  3. null                     — no config present; caller falls back to neutral slug
 */
function resolveFamilies(targeting) {
  if (targeting && Array.isArray(targeting.role_families) && targeting.role_families.length > 0) {
    return targeting.role_families;
  }
  if (targeting && Array.isArray(targeting.role_buckets) && targeting.role_buckets.length > 0) {
    return targeting.role_buckets.map((bucket) => ({
      name: (bucket.name || "other").toLowerCase().replace(/\s+/g, "-"),
      patterns: Array.isArray(bucket.titles) ? bucket.titles.map((t) => t.toLowerCase()) : [],
    }));
  }
  return null;
}

/**
 * Classify a role title into a family name.
 *
 * Priority:
 *  1. targeting.role_families  — explicit [{name, patterns[]}] array
 *  2. targeting.role_buckets   — each bucket name matched against its titles
 *  3. neutral slug from the role title (no taxonomy) — lowercase, runs of
 *     non-alphanumeric chars collapsed to "-", leading/trailing "-" trimmed;
 *     returns "uncategorized" when role is empty/blank.
 *
 * @param {string} role        - The role title string.
 * @param {object} [targeting] - Optional targeting config (targeting.yml contents).
 *                               Provides role_families or role_buckets for classification.
 *                               When omitted, returns a neutral slug from the role title.
 * @returns {string} Family name or neutral slug.
 */
export function classifyRoleFamily(role = "", targeting) {
  // `role = ""` above only covers an omitted/undefined arg — a row that
  // stores role explicitly as null (or any other non-string) reaches here as
  // that exact value, and every outcome-changing verb classifies every row
  // in one shared transaction (buildReevaluationAnalytics), so one bad row
  // would otherwise throw and wedge all future outcome writes. Coerce here,
  // at the entry point, rather than trusting every caller to pre-sanitize.
  const safeRole = String(role ?? "");
  const lower = safeRole.toLowerCase();
  const families = resolveFamilies(targeting);

  if (families !== null) {
    for (const family of families) {
      const patterns = Array.isArray(family.patterns) ? family.patterns : [];
      if (patterns.some((p) => lower.includes(p.toLowerCase()))) {
        return family.name;
      }
    }
    return "other";
  }

  // Tier 3: neutral slug — domain-agnostic, groups identical role titles.
  const trimmed = safeRole.trim();
  if (!trimmed) return "uncategorized";
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildOutcomeSummary({ apps = [], sourced = [], prospects, targeting } = {}) {
  // Back-compat: accept legacy "prospects" param; canonical is "sourced".
  const sourcedRows = sourced.length ? sourced : prospects || [];
  const classify = (r) => classifyRoleFamily(r, targeting);

  const byStatus = countBy(apps, (row) => row.status || "unknown");
  const byChannel = countBy(apps, (row) => row.channel || "unknown");
  const byMode = countBy(apps, (row) => row.mode || "unknown");
  const byRoleFamily = countBy(apps, (row) => classify(row.role));
  const sourcedFamilies = countBy(sourcedRows, (row) => classify(row.role));

  return {
    counts: {
      apps: apps.length,
      sourced: sourcedRows.length,
    },
    byStatus,
    byChannel,
    byMode,
    byRoleFamily,
    sourcedFamilies,
    topSourced: [...sourcedRows]
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 10)
      .map((row) => ({
        co: row.co,
        role: row.role,
        score: row.score,
        channel: row.channel,
        mode: row.mode,
        family: classify(row.role),
      })),
  };
}

function countBy(rows, getKey) {
  return rows.reduce((acc, row) => {
    const key = getKey(row);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

const DEFAULT_THRESHOLDS = { rejectionTotal: 7, rejectionPerFamily: 3 };

export function buildReevaluationAnalytics({
  apps = [],
  targeting,
  strategyReview = null,
  thresholds,
  now = null,
} = {}) {
  const classify = (role) => classifyRoleFamily(role, targeting);

  const resolvedThresholds = {
    rejectionTotal: thresholds?.rejectionTotal ?? DEFAULT_THRESHOLDS.rejectionTotal,
    rejectionPerFamily: thresholds?.rejectionPerFamily ?? DEFAULT_THRESHOLDS.rejectionPerFamily,
  };

  const byStatus = countBy(apps, (row) => row.status || "unknown");

  const rejectedApps = apps.filter((row) => row.status === "rejected");
  const advancedApps = apps.filter((row) => row.status === "interview" || row.status === "offer");

  const rejectedByFamily = countBy(rejectedApps, (row) => classify(row.role));
  const advancedByFamily = countBy(advancedApps, (row) => classify(row.role));

  const snap = strategyReview?.snapshot || {};
  const baseRejectionTotal = snap.rejected ?? 0;
  const baseByFamily = snap.rejectedByFamily || {};

  const sinceRejectionTotal = Math.max(0, rejectedApps.length - baseRejectionTotal);

  const sinceRejectionByFamily = {};
  for (const family of Object.keys(rejectedByFamily)) {
    const current = rejectedByFamily[family] || 0;
    const base = baseByFamily[family] ?? 0;
    sinceRejectionByFamily[family] = Math.max(0, current - base);
  }

  const dueReasons = [];
  if (sinceRejectionTotal >= resolvedThresholds.rejectionTotal) {
    dueReasons.push(`total ${sinceRejectionTotal}>=${resolvedThresholds.rejectionTotal}`);
  }
  for (const [family, count] of Object.entries(sinceRejectionByFamily)) {
    if (count >= resolvedThresholds.rejectionPerFamily) {
      dueReasons.push(`family:${family} ${count}>=${resolvedThresholds.rejectionPerFamily}`);
    }
  }

  return {
    updatedAt: now ? now.toISOString() : null,
    byStatus,
    rejected: { total: rejectedApps.length, byFamily: rejectedByFamily },
    advanced: { total: advancedApps.length, byFamily: advancedByFamily },
    reevaluation: {
      thresholds: resolvedThresholds,
      sinceLastReview: {
        rejectionTotal: sinceRejectionTotal,
        rejectionByFamily: sinceRejectionByFamily,
      },
      due: dueReasons.length > 0,
      dueReasons,
    },
  };
}
