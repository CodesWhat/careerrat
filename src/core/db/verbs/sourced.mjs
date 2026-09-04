// verbs/sourced.mjs — sourced[] domain actions.

import {
  addPostingIdentity,
  identityAliasAdditions,
  identityKeysWithAliases,
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
//
// Looks up `duplicate`'s match by identityKeysWithAliases (own keys PLUS any
// aliasKeys already merged onto it), not just its own url/reqId (CR-29 round
// 5): a duplicate whose OWN identity is new but whose aliasKeys already claim
// a persisted row's identity (e.g. one absorbed by an in-batch offer before
// reconciliation recognized the persisted row's ownership) must still resolve
// to that persisted row, not silently fail to match.
//
// Mutates the matched entry's `.row` IN PLACE rather than replacing it with a
// new object (CR-29 round 5): `index` maps every one of a stored posting's
// identity keys to the SAME entry object, so every key set at storedPostingIndex
// build time — not just the keys THIS merge happened to add — sees the
// updated aliasKeys on its next lookup. Building a fresh `{table, id, row}`
// per merge (the old behavior) only repointed the newly-added keys; the
// posting's ORIGINAL keys still resolved to the stale pre-merge row, so a
// later duplicate matching one of those original keys rebuilt `updatedRow`
// from that stale row and overwrote (rather than accumulated with) the
// earlier merge's aliasKeys.
function mergeDuplicateIdentityAlias(db, index, duplicate) {
  const matchKey = identityKeysWithAliases(duplicate).find((key) => index.has(key));
  if (!matchKey) return [];
  const entry = index.get(matchKey);
  const additions = identityAliasAdditions(entry.row, duplicate);
  if (!additions.length) return [];
  entry.row = { ...entry.row, aliasKeys: [...rowAliasKeys(entry.row), ...additions] };
  putRow(db, entry.table, entry.id, entry.row);
  for (const key of additions) index.set(key, entry);
  return additions;
}

const ACTIVE_SOURCED_STATUSES = new Set(["sourced", "prospect", "saved", "gated"]);

function isActiveSourcedStatus(value) {
  return ACTIVE_SOURCED_STATUSES.has(String(value || "sourced").toLowerCase());
}

// sourcedUpsertBatch({rows, duplicateOffers}) — one sweep's worth of sourced
// rows, upserted in ONE transaction with ONE activity event summarizing the
// batch (matching search-jobs' own "one sweep, one write" shape rather than
// one event per row). AGENTS.md lists "search-jobs ... when they add rows"
// among the analytics-refreshing writes — refreshed here too, even though
// buildReevaluationAnalytics only consumes applications[] today (a no-op
// recompute), so the contract holds if that ever changes.
//
// `duplicateOffers` (CR-29 round 5) is a caller-precomputed list of offers
// reconciliation already recognized as duplicates of an ALREADY-PERSISTED
// row (see sourced-persistence.mjs's reconcileOffersBeforeCapture) — merged
// here, INSIDE this verb's own guard(db)-protected transaction, instead of
// through a separate unguarded call before this transaction even opens.
// Reconciliation itself stays read-only: a superseded search's alias writes
// must roll back with everything else when the guard rejects the batch, and
// a batch that's ALL duplicates (no new/updated row to accept) must still
// run the guard rather than skip straight past it. `rows` may be empty when
// `duplicateOffers` carries the whole batch.
//
// This verb no longer takes a prepareAcceptedRow/commitAcceptedArtifact
// hook (CR-29 round 5 removed both): a hook is, by construction, arbitrary
// caller code running INSIDE this transaction, which is exactly the
// "JD writes hold the SQLite writer lock" failure mode under fix here.
// sourced-persistence.mjs now stages every JD artifact BEFORE calling this
// verb and finalizes/discards it AFTER the verb returns (or throws), so this
// transaction does DB work only — see captureAndPersistOffersIfDb.
export function sourcedUpsertBatch({
  repoRoot,
  env,
  rows,
  duplicateOffers,
  guard,
  dedupeCanonical = false,
} = {}) {
  const hasRows = Array.isArray(rows) && rows.length > 0;
  const hasDuplicateOffers = Array.isArray(duplicateOffers) && duplicateOffers.length > 0;
  if (!hasRows && !hasDuplicateOffers) {
    throw new Error("sourcedUpsertBatch: rows or duplicateOffers must be a non-empty array");
  }
  const preparedRows = (rows || []).map((row) => {
    if (!row?.id) throw new Error("sourcedUpsertBatch: every row needs an id");
    return { row, acceptedRow: row };
  });
  return runVerb({ repoRoot, env }, (db) => {
    if (typeof guard === "function") guard(db);
    let created = 0;
    let updated = 0;
    let duplicates = 0;
    const failed = 0;
    let aliasesMerged = false;
    const acceptedIds = [];
    const failedIds = [];
    const postingIndex = dedupeCanonical || hasDuplicateOffers ? storedPostingIndex(db) : null;
    const seenPostingKeys = postingIndex ? new Set(postingIndex.keys()) : null;
    if (hasDuplicateOffers) {
      for (const offer of duplicateOffers) {
        duplicates++;
        const additions = mergeDuplicateIdentityAlias(db, postingIndex, offer);
        if (additions.length) {
          aliasesMerged = true;
          for (const key of additions) seenPostingKeys.add(key);
        }
      }
    }
    for (const { row, acceptedRow } of preparedRows) {
      // Checks identityKeysWithAliases (row's own url/reqId PLUS any
      // aliasKeys reconciliation already merged onto it), not just its own
      // url/reqId (CR-29 round 5): a row whose OWN identity is new but whose
      // aliasKeys already claim a persisted row's identity must be caught
      // here and merged, not inserted as a second row for that identity.
      if (seenPostingKeys && identityKeysWithAliases(row).some((key) => seenPostingKeys.has(key))) {
        duplicates++;
        const additions = mergeDuplicateIdentityAlias(db, postingIndex, row);
        if (additions.length) {
          aliasesMerged = true;
          for (const key of additions) seenPostingKeys.add(key);
        }
        continue;
      }
      // `failed`/`failedIds` stay at their initial value on this path (CR-29
      // round 5): a row's side effects — its JD artifact, specifically — are
      // now staged by the caller BEFORE this verb is even invoked (see
      // captureAndPersistOffersIfDb), so a failure there means the row never
      // reaches `rows` here at all. This verb still reports `failed`/
      // `failedIds` in its return shape so a caller can fold its own
      // pre-transaction failures into the same counters without a shape
      // mismatch.
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
// Write Contract. sourced-persistence.mjs's pre-capture reconciliation used
// to call the batched sourcedMergeIdentityAliasBatch below for its whole
// sweep's worth of persisted-duplicate offers; as of CR-29 round 5 it instead
// hands them to sourcedUpsertBatch's own `duplicateOffers` param, so the
// merge runs inside that verb's guard(db)-protected transaction rather than a
// separate, unguarded one that could commit even when the guard would go on
// to reject the batch's own new/updated rows. These standalone verbs remain
// for any OTHER caller merging a duplicate (or a whole batch of them) outside
// a sourcedUpsertBatch call.
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
