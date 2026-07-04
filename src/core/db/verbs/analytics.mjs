// verbs/analytics.mjs — the standalone analytics-refresh verb (mirrors
// `rolester analytics --write`, but against the db instead of tracker.json).
// Derived data only: never bumps meta.version/lastUpdatedAt (decision 4).
import { loadCandidateDoc } from "../../profile/config-store.mjs";
import { buildReevaluationAnalytics } from "../../tracker/outcome-analysis.mjs";
import { refreshAnalyticsInDb, runVerb } from "./shared.mjs";

function loadTargeting(pathCtx) {
  try {
    return loadCandidateDoc("targeting", pathCtx) || undefined;
  } catch {
    return undefined;
  }
}

function resolveThresholds(targeting) {
  const reeval = targeting?.reevaluation || {};
  return {
    rejectionTotal: reeval.rejection_total ?? 7,
    rejectionPerFamily: reeval.rejection_per_family ?? 3,
  };
}

export function analyticsRefresh({ repoRoot, env, at } = {}) {
  return runVerb({ repoRoot, env }, (db, pathCtx) => {
    const targeting = loadTargeting(pathCtx);
    const thresholds = resolveThresholds(targeting);
    const now = at ? new Date(at) : new Date();
    const analytics = refreshAnalyticsInDb(db, {
      buildReevaluationAnalytics,
      targeting,
      thresholds,
      now,
    });
    return { analytics };
  });
}
