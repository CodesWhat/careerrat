// verbs/company-health.mjs — the company-health skill's STEP 5 write path:
// persist a role-scoped companyHealth rating onto whichever tracker row (an
// applications[] row or a sourced[] row) the given id resolves to. This is the
// ONE shared write path (decision 6) — `careerrat health record` (src/cli/
// health.mjs) is the only caller today, but any future HTTP surface calls the
// exact same exported function, never re-implementing the validation or the
// SQL.
//
// Unlike appSetFields/sourcedUpsertBatch (the generic patch verbs SKILL.md's
// STEP 5 described before this verb existed), this validates the FULL
// companyHealth shape before it ever reaches a row: rating/provenance enums,
// asOf format, fitDelta sign, and the current_base privacy guard — so a
// malformed or leaking payload never lands on the tracker.
import { findCurrentBaseToken } from "../../profile/comp-guard.mjs";
import { bumpMeta, getRow, logActivityEvent, NotFoundError, putRow, runVerb } from "./shared.mjs";

export const HEALTH_RATINGS = new Set(["healthy", "watch", "risky"]);
export const HEALTH_PROVENANCE = new Set(["built-from-data", "needs-more-info", "stale"]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A "small negative nudge" per SKILL.md STEP 4d (e.g. -2 mixed, -5 poor per
// intersecting need) — floor generously so a legitimate multi-need cross-cut
// isn't rejected, while still catching an obviously wrong (e.g. -50) value.
const MIN_FIT_DELTA = -20;

// Validate + normalize a companyHealth payload against the shape SKILL.md
// STEP 5 documents. Throws a descriptive Error (with a stable `.code`) on the
// first violation rather than collecting all of them — callers (the CLI) show
// one clear reason, matching every other verb's fail-fast style.
export function validateCompanyHealth(companyHealth) {
  if (!companyHealth || typeof companyHealth !== "object" || Array.isArray(companyHealth)) {
    const err = new Error("companyHealthSet: companyHealth object is required");
    err.code = "BAD_COMPANY_HEALTH";
    throw err;
  }

  const {
    rating,
    forFunction,
    asOf,
    provenance,
    dimensions,
    crossCut,
    fitDelta,
    rationale,
    signals,
  } = companyHealth;

  if (!HEALTH_RATINGS.has(rating)) {
    const err = new Error(
      `companyHealthSet: rating must be one of ${[...HEALTH_RATINGS].join(", ")} (got ${JSON.stringify(rating)})`
    );
    err.code = "BAD_HEALTH_RATING";
    throw err;
  }
  if (!HEALTH_PROVENANCE.has(provenance)) {
    const err = new Error(
      `companyHealthSet: provenance must be one of ${[...HEALTH_PROVENANCE].join(", ")} (got ${JSON.stringify(provenance)})`
    );
    err.code = "BAD_HEALTH_PROVENANCE";
    throw err;
  }
  if (typeof forFunction !== "string" || !forFunction.trim()) {
    const err = new Error("companyHealthSet: forFunction is required");
    err.code = "BAD_HEALTH_FUNCTION";
    throw err;
  }
  if (typeof asOf !== "string" || !ISO_DATE_RE.test(asOf) || Number.isNaN(Date.parse(asOf))) {
    const err = new Error("companyHealthSet: asOf must be an ISO date, YYYY-MM-DD");
    err.code = "BAD_HEALTH_AS_OF";
    throw err;
  }
  if (typeof rationale !== "string" || !rationale.trim()) {
    const err = new Error("companyHealthSet: rationale is required");
    err.code = "BAD_HEALTH_RATIONALE";
    throw err;
  }
  if (!dimensions || typeof dimensions !== "object" || Array.isArray(dimensions)) {
    const err = new Error("companyHealthSet: dimensions object is required");
    err.code = "BAD_HEALTH_DIMENSIONS";
    throw err;
  }
  // Each dimension entry is { level, note, functionHit?, trend? } per the
  // contract (docs/DATA_CONTRACT.md, SKILL.md) — a flat string level (e.g.
  // { layoffRisk: "elevated" }) is not the shape and is rejected here, not
  // silently coerced. The feature is unreleased, so no legacy data depends
  // on the flat form; the client keeps its own defensive fallback for
  // anything that slips through some other path.
  for (const [key, entry] of Object.entries(dimensions)) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.level !== "string" ||
      !entry.level.trim()
    ) {
      const err = new Error(
        `companyHealthSet: dimensions.${key} must be an object with a non-empty string level (got ${JSON.stringify(entry)})`
      );
      err.code = "BAD_HEALTH_DIMENSION_ENTRY";
      throw err;
    }
  }
  if (crossCut !== undefined && !Array.isArray(crossCut)) {
    const err = new Error("companyHealthSet: crossCut must be an array");
    err.code = "BAD_HEALTH_CROSS_CUT";
    throw err;
  }
  if (signals !== undefined && !Array.isArray(signals)) {
    const err = new Error("companyHealthSet: signals must be an array");
    err.code = "BAD_HEALTH_SIGNALS";
    throw err;
  }

  const delta = fitDelta === undefined ? 0 : fitDelta;
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta > 0 || delta < MIN_FIT_DELTA) {
    const err = new Error(
      `companyHealthSet: fitDelta must be a number <= 0 and >= ${MIN_FIT_DELTA} (a small negative nudge, never positive; got ${JSON.stringify(fitDelta)})`
    );
    err.code = "BAD_HEALTH_FIT_DELTA";
    throw err;
  }

  // Privacy rail (AGENTS.md's Privacy Invariant): the candidate's private
  // current_base field can never end up on a persisted, dashboard-rendered
  // row, even indirectly through a pasted rationale/signal summary. Mirrors
  // research-store.mjs's computeResearchWrite leak guard.
  const leak = findCurrentBaseToken(JSON.stringify(companyHealth));
  if (leak) {
    // Name the guard that tripped, never the matched value — that value is
    // the private input itself, and this error travels over HTTP via
    // sendError to the client.
    const err = new Error(
      "companyHealthSet: refusing to persist a private compensation input (current_base leak guard)"
    );
    err.code = "HEALTH_COMP_LEAK";
    throw err;
  }

  return {
    ...companyHealth,
    fitDelta: delta,
    crossCut: Array.isArray(crossCut) ? crossCut : [],
    signals: Array.isArray(signals) ? signals : [],
  };
}

// applications[] takes precedence over sourced[] on an id collision, mirroring
// intake/match.mjs's matchTrackerRecord() "Applications take precedence over
// sourced rows" convention.
function findHostRow(db, id) {
  const app = getRow(db, "applications", id);
  if (app) return { table: "applications", row: app };
  const sourced = getRow(db, "sourced", id);
  if (sourced) return { table: "sourced", row: sourced };
  return null;
}

// companyHealthSet({id, companyHealth}) — validate, then replace the row's
// `companyHealth` field WHOLE (it is always written in full per SKILL.md STEP
// 5, never merged field-by-field) on whichever table `id` resolves to. Not
// outcome-changing (mirrors appSetFields/appRegisterArtifact/sourcedSetStatus's
// non-status writes): no analytics refresh, since a health rating alone never
// changes an application's funnel stage.
export function companyHealthSet({ repoRoot, env, id, companyHealth } = {}) {
  if (!id) throw new Error("companyHealthSet: id is required");
  const validated = validateCompanyHealth(companyHealth);

  return runVerb({ repoRoot, env }, (db) => {
    const found = findHostRow(db, id);
    if (!found) throw new NotFoundError(`no application or sourced role with id "${id}"`);
    const { table, row } = found;

    const updated = { ...row, companyHealth: validated };
    putRow(db, table, id, updated);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "research",
      title: `Company health: ${row.company || id} — ${validated.rating}`,
      summary: `${validated.forFunction}-scoped as of ${validated.asOf} (${validated.provenance}).`,
      refs: {
        company: row.company,
        role: row.role,
        ...(table === "applications" ? { applicationId: id } : { sourcedId: id }),
      },
      tags: [`health:${validated.rating}`, "operation:company-health:rate"],
    });
    return { id, table, companyHealth: validated, meta, event };
  });
}
