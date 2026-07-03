// verbs/sourced.mjs — sourced[] domain actions.
import { buildReevaluationAnalytics } from "../../tracker/outcome-analysis.mjs";
import {
  bumpMeta,
  deleteRow,
  getRow,
  logActivityEvent,
  putRow,
  refreshAnalyticsInDb,
  requireRow,
  runVerb,
} from "./shared.mjs";

function refreshAnalytics(db, now = new Date()) {
  return refreshAnalyticsInDb(db, { buildReevaluationAnalytics, now });
}

// sourcedUpsertBatch({rows}) — one sweep's worth of sourced rows, upserted in
// ONE transaction with ONE activity event summarizing the batch (matching
// search-jobs' own "one sweep, one write" shape rather than one event per
// row). AGENTS.md lists "search-jobs ... when they add rows" among the
// analytics-refreshing writes — refreshed here too, even though
// buildReevaluationAnalytics only consumes applications[] today (a no-op
// recompute), so the contract holds if that ever changes.
export function sourcedUpsertBatch({ repoRoot, env, rows } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("sourcedUpsertBatch: rows must be a non-empty array");
  }
  return runVerb({ repoRoot, env }, (db) => {
    let created = 0;
    let updated = 0;
    for (const row of rows) {
      if (!row?.id) throw new Error("sourcedUpsertBatch: every row needs an id");
      const existed = Boolean(getRow(db, "sourced", row.id));
      putRow(db, "sourced", row.id, row);
      if (existed) updated++;
      else created++;
    }
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "sourced",
      title: `Sourced sweep — ${created} new, ${updated} updated`,
      tags: [`count:${rows.length}`],
    });
    const analytics = refreshAnalytics(db);
    return { created, updated, meta, event, analytics };
  });
}

// sourcedPromote({id, appRow?}) — a sourced role passing the gate becomes an
// application: moved into applications[] and removed from sourced[] in ONE
// transaction (AGENTS.md: "Sourced roles stay in sourced[] until the gate ...
// promote them"). `appRow` may override/extend fields (e.g. status,
// artifacts) on top of the sourced row's own data; defaults to
// status: "reviewed-hold" (the gate-pass status per track-outcomes SKILL.md).
// Outcome-changing: this IS "new applications" per the Tracker Write Contract.
export function sourcedPromote({ repoRoot, env, id, appRow } = {}) {
  return runVerb({ repoRoot, env }, (db) => {
    const sourced = requireRow(db, "sourced", id, "sourced role");
    const newApp = {
      ...sourced,
      status: "reviewed-hold",
      ...(appRow || {}),
    };
    newApp.id = appRow?.id || sourced.id;

    putRow(db, "applications", newApp.id, newApp);
    deleteRow(db, "sourced", id);

    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "applied",
      title: `${newApp.company || newApp.id} — promoted from sourced`,
      refs: { applicationId: newApp.id, company: newApp.company, role: newApp.role },
    });
    const analytics = refreshAnalytics(db);
    return { id: newApp.id, promotedFrom: id, meta, event, analytics };
  });
}
