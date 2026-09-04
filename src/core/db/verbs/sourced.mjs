// verbs/sourced.mjs — sourced[] domain actions.

import {
  addPostingIdentity,
  identityAliasAdditions,
  identityKeysWithAliases,
  postingIdentityIsSeen,
  postingIdentityKeys,
  rowAliasKeys,
} from "../../scoring/sourced-identity.mjs";
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

function applicationNote(value) {
  return Array.from(String(value || "").trim())
    .slice(0, 60)
    .join("");
}

// Index every applications[]/sourced[] identity key back to the row it came
// from (table + id + the row itself), not just a flat membership Set, so a
// duplicate hit during canonical dedupe can locate and patch the canonical
// row's aliasKeys[], not merely detect the collision.
function storedPostingIndex(db) {
  const index = new Map();
  for (const table of ["applications", "sourced"]) {
    for (const entry of db.prepare(`SELECT id, data FROM ${table}`).all()) {
      const row = JSON.parse(entry.data);
      const entryRef = { table, id: entry.id, row };
      for (const key of identityKeysWithAliases(row)) index.set(key, entryRef);
    }
  }
  return index;
}

// When `duplicate` collides with a row already in `index`, persist the union
// of `duplicate`'s identity keys onto that row's aliasKeys[] (CR-29 round 3)
// so a later capture that only carries one of the discarded row's OTHER
// representations (e.g. an aggregator relisting with no outbound board URL)
// still resolves back to the same canonical row. addPostingIdentity folds
// aliasKeys into every seen-set builder, so persisting them here is what
// makes reconciliation and sourcedUpsertBatch "consume" them. Returns the
// newly-added keys (empty when the duplicate adds nothing new, the common
// case), so the caller can fold them into its own in-flight seen set.
function mergeDuplicateIdentityAlias(db, index, duplicate) {
  const matchKey = postingIdentityKeys(duplicate).find((key) => index.has(key));
  if (!matchKey) return [];
  const { table, id, row } = index.get(matchKey);
  const additions = identityAliasAdditions(row, duplicate);
  if (!additions.length) return [];
  const updatedRow = { ...row, aliasKeys: [...rowAliasKeys(row), ...additions] };
  putRow(db, table, id, updatedRow);
  const entryRef = { table, id, row: updatedRow };
  for (const key of additions) index.set(key, entryRef);
  return additions;
}

const ACTIVE_SOURCED_STATUSES = new Set(["sourced", "prospect", "saved", "gated"]);

function isActiveSourcedStatus(value) {
  return ACTIVE_SOURCED_STATUSES.has(String(value || "sourced").toLowerCase());
}

// sourcedUpsertBatch({rows}) — one sweep's worth of sourced rows, upserted in
// ONE transaction with ONE activity event summarizing the batch (matching
// search-jobs' own "one sweep, one write" shape rather than one event per
// row). AGENTS.md lists "search-jobs ... when they add rows" among the
// analytics-refreshing writes — refreshed here too, even though
// buildReevaluationAnalytics only consumes applications[] today (a no-op
// recompute), so the contract holds if that ever changes.
export function sourcedUpsertBatch({
  repoRoot,
  env,
  rows,
  guard,
  dedupeCanonical = false,
  prepareAcceptedRow,
  commitAcceptedArtifact,
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("sourcedUpsertBatch: rows must be a non-empty array");
  }
  const preparedRows = rows.map((row) => {
    if (!row?.id) throw new Error("sourcedUpsertBatch: every row needs an id");
    const acceptedRow = typeof prepareAcceptedRow === "function" ? prepareAcceptedRow(row) : row;
    if (!acceptedRow?.id || String(acceptedRow.id) !== String(row.id)) {
      throw new Error("sourcedUpsertBatch: prepared rows must preserve their id");
    }
    return { row, acceptedRow };
  });
  return runVerb({ repoRoot, env }, (db) => {
    if (typeof guard === "function") guard(db);
    let created = 0;
    let updated = 0;
    let duplicates = 0;
    let failed = 0;
    let aliasesMerged = false;
    const acceptedIds = [];
    const failedIds = [];
    const postingIndex = dedupeCanonical ? storedPostingIndex(db) : null;
    const seenPostingKeys = postingIndex ? new Set(postingIndex.keys()) : null;
    for (const { row, acceptedRow } of preparedRows) {
      if (seenPostingKeys && postingIdentityIsSeen(row, seenPostingKeys)) {
        duplicates++;
        const additions = mergeDuplicateIdentityAlias(db, postingIndex, row);
        if (additions.length) {
          aliasesMerged = true;
          for (const key of additions) seenPostingKeys.add(key);
        }
        continue;
      }
      // The JD artifact (or any other caller-supplied side effect this row's
      // acceptance depends on) is committed HERE — after the duplicate check
      // decided this row wins its slot, but BEFORE putRow makes it durable
      // (CR-29 round 4). A failure here means this offer is simply never
      // accepted: its identity is never added to seenPostingKeys and no row
      // is written, so a later retry (once whatever failed is fixed) sees a
      // clean slate instead of a row that already claims a JD it never got.
      if (typeof commitAcceptedArtifact === "function") {
        try {
          commitAcceptedArtifact(acceptedRow, row);
        } catch {
          failed++;
          failedIds.push(String(row.id));
          continue;
        }
      }
      if (seenPostingKeys) addPostingIdentity(seenPostingKeys, row);
      const existed = Boolean(getRow(db, "sourced", acceptedRow.id));
      putRow(db, "sourced", acceptedRow.id, acceptedRow);
      if (existed) updated++;
      else created++;
      acceptedIds.push(String(acceptedRow.id));
    }
    if (!acceptedIds.length) {
      if (aliasesMerged) bumpMeta(db);
      return {
        created,
        updated,
        duplicates,
        failed,
        acceptedIds,
        failedIds,
        meta: null,
        event: null,
        analytics: null,
      };
    }
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "sourced",
      title: `Sourced sweep: ${created} new, ${updated} updated`,
      tags: [`count:${acceptedIds.length}`],
    });
    const analytics = refreshAnalytics(db);
    return { created, updated, duplicates, failed, acceptedIds, failedIds, meta, event, analytics };
  });
}

// sourcedMergeIdentityAlias({offer}): the standalone entry point for the
// same alias-merge sourcedUpsertBatch does inline on a duplicate hit, for a
// caller merging a SINGLE offer that discarded a duplicate BEFORE it ever
// reaches sourcedUpsertBatch. No-op, no write, when `offer` doesn't match a
// stored row or adds nothing new to it. Intentionally skips the
// activity-event log (an alias merge is internal bookkeeping, not a
// user-visible change) but still bumps meta when it writes, per the Data
// Write Contract. sourced-persistence.mjs's pre-capture reconciliation calls
// the batched sourcedMergeIdentityAliasBatch below instead (CR-29 round 4):
// calling this once per suppressed duplicate in a sweep rebuilt the whole
// stored posting index and opened its own transaction/export every time.
export function sourcedMergeIdentityAlias({ repoRoot, env, offer } = {}) {
  return runVerb({ repoRoot, env }, (db) => {
    const index = storedPostingIndex(db);
    const additions = mergeDuplicateIdentityAlias(db, index, offer);
    if (additions.length) bumpMeta(db);
    return { merged: additions.length > 0 };
  });
}

// sourcedMergeIdentityAliasBatch({offers}) — the same alias merge as
// sourcedMergeIdentityAlias, but for a WHOLE sweep's worth of pre-capture
// duplicates in ONE call (CR-29 round 4): builds the stored posting index
// ONCE instead of once per offer, applies every merge against it inside ONE
// transaction, and bumps meta at most once (only when something actually
// changed) instead of once per offer — matching sourcedUpsertBatch's own
// "one sweep, one write" shape. Same no-activity-event contract as the
// singular verb. A no-op, no db open at all, when `offers` is empty.
export function sourcedMergeIdentityAliasBatch({ repoRoot, env, offers } = {}) {
  if (!Array.isArray(offers) || offers.length === 0) {
    return { merged: 0 };
  }
  return runVerb({ repoRoot, env }, (db) => {
    const index = storedPostingIndex(db);
    let merged = 0;
    for (const offer of offers) {
      const additions = mergeDuplicateIdentityAlias(db, index, offer);
      if (additions.length) merged++;
    }
    if (merged) bumpMeta(db);
    return { merged };
  });
}

// sourcedSetStatus({id, to, note?}) — a single-field status patch for a
// sourced[] row (e.g. the Jobs Search tab's Skip action). sourcedUpsertBatch
// REPLACES the whole row (putRow does a full JSON-blob overwrite, not a
// merge — see shared.mjs's putRow), so evaluate-job STEP 9 patches status by
// reading the full current row and rewriting it whole; that's fine for a
// skill that already has the full row in hand, but the Jobs UI only ever
// sees the derived dashboard row shape (dashboard-data.js), never the raw
// sourced[] blob — sending that shape through upsert-batch would silently
// drop every field upsert-batch didn't know to carry over. This verb avoids
// that by patching just `status` (+ optional `note`) on the CURRENT row.
// Modeled on appSetStatus (app.mjs): same meta bump + activity event +
// analytics refresh — outcome-changing, same as every other sourced[]/
// applications[] status transition.
export function sourcedSetStatus({ repoRoot, env, id, to, note } = {}) {
  if (!to) throw new Error("sourcedSetStatus: to is required");
  return runVerb({ repoRoot, env }, (db) => {
    const role = requireRow(db, "sourced", id, "sourced role");
    const from = role.status || "sourced";
    const updated = { ...role, status: to };
    if (note) updated.note = note;

    putRow(db, "sourced", id, updated);
    const meta = bumpMeta(db);
    const skipped = ["cut", "withdrawn", "skipped"].includes(String(to).toLowerCase());
    const event = logActivityEvent(db, {
      type: "status_change",
      title: skipped
        ? `${role.company || id}: Role skipped`
        : `${role.company || id}: Sourced role status updated`,
      summary: skipped
        ? note || "Removed this role from active review."
        : `Moved the sourced role to ${String(to).replace(/[-_]/g, " ")}.`,
      refs: { company: role.company, role: role.role },
      tags: [`status:${to}`, "operation:sourced:status-update"],
    });
    const analytics = refreshAnalytics(db);
    return { id, from, to, meta, event, analytics };
  });
}

// sourcedReconcilePolicyBatch({decisions}) — atomically hide every still-active
// sourced row that a fresh search found incompatible with the candidate's
// CURRENT hard search policy. Decisions carry the row version observed while
// its safely-confined JD artifact was read. A concurrent review/status change
// therefore wins instead of being overwritten by this background maintenance.
export function sourcedReconcilePolicyBatch({ repoRoot, env, decisions, guard } = {}) {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new Error("sourcedReconcilePolicyBatch: decisions must be a non-empty array");
  }
  return runVerb({ repoRoot, env }, (db) => {
    if (typeof guard === "function") guard(db);
    const hiddenIds = [];
    const hiddenAt = new Date().toISOString();

    for (const decision of decisions) {
      if (!decision?.id || !decision?.reason || !decision?.bucket) {
        throw new Error("sourcedReconcilePolicyBatch: every decision needs id, bucket, and reason");
      }
      const current = getRow(db, "sourced", decision.id);
      if (!current || !isActiveSourcedStatus(current.status)) continue;
      if (
        String(current.status || "sourced") !== String(decision.expectedStatus || "sourced") ||
        String(current.updatedAt || "") !== String(decision.expectedUpdatedAt || "") ||
        JSON.stringify(current.artifacts?.jd || "") !==
          JSON.stringify(decision.expectedJobArtifact || "")
      ) {
        continue;
      }

      putRow(db, "sourced", decision.id, {
        ...current,
        status: "cut",
        gate: "likely-cut",
        updatedAt: hiddenAt,
        policyRevalidation: {
          status: "hidden",
          bucket: decision.bucket,
          reason: decision.reason,
          at: hiddenAt,
        },
      });
      hiddenIds.push(String(decision.id));
    }

    if (!hiddenIds.length) {
      return { hidden: 0, hiddenIds, meta: null, event: null, analytics: null };
    }
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "status_change",
      title: `Search policy hid ${hiddenIds.length} stale role${hiddenIds.length === 1 ? "" : "s"}`,
      summary: "Rechecked saved job descriptions against the current search settings.",
      tags: [
        `count:${hiddenIds.length}`,
        "skill:search-jobs",
        "operation:sourced:policy-revalidate",
      ],
    });
    const analytics = refreshAnalytics(db);
    return { hidden: hiddenIds.length, hiddenIds, meta, event, analytics };
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
    if (newApp.note) newApp.note = applicationNote(newApp.note);

    putRow(db, "applications", newApp.id, newApp);
    deleteRow(db, "sourced", id);

    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "applied",
      title: `${newApp.company || newApp.id}: promoted from sourced`,
      refs: { applicationId: newApp.id, company: newApp.company, role: newApp.role },
    });
    const analytics = refreshAnalytics(db);
    return { id: newApp.id, promotedFrom: id, meta, event, analytics };
  });
}
