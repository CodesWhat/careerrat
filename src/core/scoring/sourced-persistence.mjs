import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { currencyCodePatternSource } from "../currency-format.mjs";
import { dbExists, requireDb } from "../db/connection.mjs";
import { buildDbSeenSets, readDbScannerRows } from "../db/scan-context.mjs";
import { sourceConfigGet, sourceConfigMutate } from "../db/verbs/source-config.mjs";
import { sourcedReconcilePolicyBatch, sourcedUpsertBatch } from "../db/verbs/sourced.mjs";
import { readJobDescriptionArtifact } from "../jobs/job-description.mjs";
import { userPath } from "../paths/workspace.mjs";
import { atomicWriteFile } from "../profile/gate-writer.mjs";
import { stringifyYaml } from "../profile/yaml.mjs";
import { trimEdgeCharacter } from "../text/slug.mjs";
import {
  addPostingIdentity,
  identityAliasAdditions,
  identityKeysWithAliases,
  postingIdentityKeys,
} from "./sourced-identity.mjs";
import {
  extractCompBand,
  requalifyCanonicalOffers,
  resolveCompensationEvidence,
} from "./sourced-scanner.mjs";

const ACTIVE_SOURCED_STATUSES = new Set(["sourced", "prospect", "saved", "gated"]);
const POLICY_FAILURE_BUCKETS = Object.freeze([
  ["seniority", "filteredSeniority"],
  ["location", "filteredLocation"],
  ["age", "filteredAge"],
  ["salary", "filteredSalary"],
  ["eligibility", "filteredEligibility"],
]);

function activeSourcedRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    ACTIVE_SOURCED_STATUSES.has(String(row?.status || "sourced").toLowerCase())
  );
}

function persistedRowOffer(row, artifact) {
  return {
    id: row.id,
    company: row.company,
    title: row.role || row.title,
    url: row.link || row.url,
    location: row.loc || row.location || row.mode || "",
    postedAt: row.postedAt,
    bodyText: artifact.markdown,
    bodyPartial: artifact.completeness === "partial",
  };
}

export function revalidatePersistedSourcedRows({
  repoRoot,
  env,
  config,
  now = new Date(),
  locationFilter,
  policyDigest,
  guard,
} = {}) {
  const empty = {
    examined: 0,
    readable: 0,
    unreadable: 0,
    hidden: 0,
    hiddenIds: [],
    skipped: false,
  };
  if (!dbExists({ repoRoot, env })) return empty;
  if (
    policyDigest &&
    sourceConfigGet({ repoRoot, env, name: "sourced-scan" }).data.policyRevalidation?.digest ===
      policyDigest
  ) {
    return { ...empty, skipped: true };
  }

  const activeRows = activeSourcedRows(readDbScannerRows({ repoRoot, env }));
  const rowsById = new Map(activeRows.map((row) => [String(row.id), row]));
  const offers = [];
  let unreadable = 0;
  for (const row of activeRows) {
    try {
      const capture = readJobDescriptionArtifact({ repoRoot, env, source: "sourced", id: row.id });
      offers.push(persistedRowOffer(row, capture.artifact));
    } catch {
      // A missing or unsafe capture is unknown, never evidence for hiding a row.
      unreadable += 1;
    }
  }

  const qualification = requalifyCanonicalOffers(offers, {
    config,
    now: now instanceof Date ? now.getTime() : Number(now),
    locationFilter,
  });
  const decisions = [];
  for (const [bucket, resultKey] of POLICY_FAILURE_BUCKETS) {
    for (const offer of qualification[resultKey]) {
      const row = rowsById.get(String(offer.id));
      if (!row) continue;
      decisions.push({
        id: row.id,
        bucket,
        reason: offer.qualificationReason,
        expectedStatus: row.status || "sourced",
        expectedUpdatedAt: row.updatedAt || "",
        expectedJobArtifact: row.artifacts?.jd || "",
      });
    }
  }

  const reconciled = decisions.length
    ? sourcedReconcilePolicyBatch({ repoRoot, env, decisions, guard })
    : { hidden: 0, hiddenIds: [] };
  if (policyDigest && unreadable === 0) {
    sourceConfigMutate({
      repoRoot,
      env,
      name: "sourced-scan",
      guard,
      mutate(current) {
        return {
          ...current,
          policyRevalidation: {
            digest: policyDigest,
            checkedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
          },
        };
      },
    });
  }
  return {
    examined: activeRows.length,
    readable: offers.length,
    unreadable,
    hidden: reconciled.hidden,
    hiddenIds: reconciled.hiddenIds,
    skipped: false,
  };
}

export function sourcedPolicyDigest({ config, locationPolicy } = {}) {
  return createHash("sha256")
    .update(JSON.stringify({ config: config || {}, locationPolicy: locationPolicy || null }))
    .digest("hex");
}

function slug(value, fallback = "unknown") {
  const collapsed = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  const normalized = trimEdgeCharacter(collapsed, "-").slice(0, 80);
  return normalized || fallback;
}

function stableSourcedId(offer) {
  const company = slug(offer?.company || offer?.source);
  if (offer?.reqId) return `sourced-${company}-${slug(offer.reqId, "req")}`;
  const hash = createHash("sha256")
    .update([offer?.url, offer?.company, offer?.title].filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 12);
  return `sourced-${company}-${hash}`;
}

function compactNote(offer) {
  const parts = [
    `scanner fit ${offer.fit || "review"} ${offer.score ?? "?"}`,
    offer.gate ? `gate ${offer.gate}` : "",
    offer.ratingReason || "",
    Array.isArray(offer.ruleFlags) && offer.ruleFlags.length
      ? `flags ${offer.ruleFlags.slice(0, 3).join(", ")}`
      : "",
  ].filter(Boolean);
  return parts.join("; ").slice(0, 240);
}

function hasRequiredSourcedFields(offer) {
  return Boolean(offer?.company && offer?.title && offer?.url);
}

function offerBodyText(offer) {
  return String(offer?.bodyText || offer?.description || offer?.rawText || "").trim();
}

const EXPLICIT_BASE_COMPENSATION_RE = /\b(?:base\s+(?:salary|pay)|salary(?:\s+(?:range|band))?)\b/i;
const ADJACENT_BASE_COMPENSATION_LABEL_RE =
  /^(?:(?:estimated|annual|posted)\s+)*(?:base\s+(?:salary|pay)|salary)\s+(?:range|band)\s*:?$/i;
const NON_BASE_COMPENSATION_RE =
  /\b(?:bonus(?:es)?|ote|on[- ]target\s+earnings?|equity|stock(?:\s+(?:options?|grants?))?|total\s+(?:cash\s+)?comp(?:ensation)?|commission|variable\s+comp(?:ensation)?|incentive)\b/i;
const CURRENCY_CODE_SOURCE = currencyCodePatternSource();
const COMPENSATION_RANGE_RE = new RegExp(
  `(?:${CURRENCY_CODE_SOURCE}\\s*)?[$£€]?\\s*(\\d{2,6}(?:,\\d{3})*(?:\\.\\d+)?)\\s*([kK])?\\s*(?:-|–|—|to)\\s*(?:${CURRENCY_CODE_SOURCE}\\s*)?[$£€]?\\s*(\\d{2,6}(?:,\\d{3})*(?:\\.\\d+)?)\\s*([kK])?(?:\\s*${CURRENCY_CODE_SOURCE})?`,
  "gi"
);

function normalizedCompensationAmount(value, suffix) {
  const numeric = Number(String(value || "").replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return null;
  return suffix || numeric < 1000 ? numeric * 1000 : numeric;
}

function explicitBaseCompensationRange(bodyText) {
  const clauses = String(bodyText || "")
    .split(/\n+|[.;!?]\s+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  for (const [index, clause] of clauses.entries()) {
    const adjacentLabel = ADJACENT_BASE_COMPENSATION_LABEL_RE.test(clauses[index - 1] || "");
    if (!EXPLICIT_BASE_COMPENSATION_RE.test(clause) && !adjacentLabel) continue;
    if (NON_BASE_COMPENSATION_RE.test(clause)) continue;
    const compensationClause = adjacentLabel ? `${clauses[index - 1]} ${clause}` : clause;
    if (!extractCompBand(compensationClause, { baseOnly: true })) continue;
    for (const match of clause.matchAll(COMPENSATION_RANGE_RE)) {
      const min = normalizedCompensationAmount(match[1], match[2]);
      const max = normalizedCompensationAmount(match[3], match[4]);
      if (min >= 50_000 && max >= min && max <= 1_200_000) {
        return match[0].trim().replace(/\s+/g, " ");
      }
    }
  }
  return null;
}

function sourceMetaFromOffer(offer) {
  const meta = {};
  for (const key of [
    "sourceId",
    "sourceLabel",
    "sourceProvider",
    "searchUrl",
    "capturedUrl",
    "hiringCafeUrl",
  ]) {
    if (offer?.[key]) meta[key] = offer[key];
  }
  return Object.keys(meta).length ? meta : null;
}

function offerHash(offer) {
  return createHash("sha256")
    .update([offer?.url, offer?.company, offer?.title].filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 10);
}

function jobCaptureRelPath(offer) {
  const company = slug(offer?.company, "unknown-company");
  const role = slug(offer?.title, "open-role");
  const identity = slug(offer?.reqId, "") || offerHash(offer);
  return `workspace/jobs/${company}-${role}-${identity}.md`;
}

function renderCapturedJob({ offer, savedAt }) {
  const body = offerBodyText(offer);
  const compensation = resolveCompensationEvidence(offer);
  const dateSaved = savedAt.toISOString().slice(0, 10);
  const frontmatter = {
    company: offer.company || "",
    role: offer.title || "",
    reqId: offer.reqId || null,
    comp: compensation.baseComp || null,
    tc: compensation.annualEarningsComp || null,
    location: offer.location || null,
    source: offer.url || "",
    sourceName: offer.source || "capture",
    postedAt: offer.postedAt ?? null,
    dateSaved,
    channel: "board",
    status: "sourced",
    fitScore: Number.isFinite(Number(offer.score)) ? Number(offer.score) : null,
    fitBucket: offer.fit || null,
    fitBasis: "triage",
    gate: offer.gate || null,
    partial: jobDescriptionIsPartial(offer, body),
  };
  const triageLines = [
    offer.ratingReason ? `- Reason: ${offer.ratingReason}` : "",
    Array.isArray(offer.ruleFlags) && offer.ruleFlags.length
      ? `- Flags: ${offer.ruleFlags.join(", ")}`
      : "",
    offer.possibleDuplicate ? "- Possible duplicate of an existing company-role pair." : "",
  ].filter(Boolean);
  return [
    "---",
    stringifyYaml(frontmatter),
    "---",
    "",
    `# ${offer.title || "Open role"} - ${offer.company || "Unknown company"}`,
    "",
    offer.location ? `- Location: ${offer.location}` : "",
    compensation.baseComp ? `- Base pay: ${compensation.baseComp}` : "",
    compensation.annualEarningsComp ? `- Annual earnings: ${compensation.annualEarningsComp}` : "",
    compensation.unclassifiedComp ? `- Compensation shown: ${compensation.unclassifiedComp}` : "",
    offer.url ? `- Source: ${offer.url}` : "",
    "",
    "## Capture triage",
    "",
    ...(triageLines.length ? triageLines : ["- Captured from a browser/source snapshot."]),
    "",
    "## Job Description",
    "",
    body || "No job-description body was returned by the capture source.",
    "",
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

function jobDescriptionIsPartial(offer, body = offerBodyText(offer)) {
  return offer?.bodyPartial === true || body.length === 0;
}

// Computes the deterministic JD artifact path + rendered content WITHOUT
// touching disk. Split out of captureSourcedOfferJob so a caller that can't
// yet promise this offer wins its slot (dedupeCanonical's inner duplicate
// check, e.g.) can defer the actual write; see stageCapturedJob below,
// which stages content at a scratch path instead of writing here directly.
function preparedCapturedJob({ repoRoot, env, offer, savedAt }) {
  const relPath = jobCaptureRelPath(offer);
  const absPath = userPath({ repoRoot, env }, relPath);
  return { relPath, absPath, content: renderCapturedJob({ offer, savedAt }) };
}

function writeCapturedJob({ absPath, content }) {
  mkdirSync(dirname(absPath), { recursive: true });
  atomicWriteFile(absPath, content);
}

function captureSourcedOfferJob({ repoRoot, env, offer, savedAt = new Date() } = {}) {
  const prepared = preparedCapturedJob({ repoRoot, env, offer, savedAt });
  writeCapturedJob(prepared);
  return prepared.relPath;
}

function offerWithArtifactPath(offer, relPath) {
  const bodyText = offerBodyText(offer);
  const { rawText, description, ...rest } = offer;
  return {
    ...rest,
    ...(bodyText ? { bodyText } : {}),
    bodyChars: bodyText.length,
    artifacts: { ...(offer.artifacts || {}), jd: relPath },
  };
}

export function offersWithCapturedJobs({ repoRoot, env, offers, savedAt = new Date() } = {}) {
  return (Array.isArray(offers) ? offers : [])
    .filter(hasRequiredSourcedFields)
    .map((offer) => offerWithCapturedJob({ repoRoot, env, offer, savedAt }));
}

function offerWithCapturedJob({ repoRoot, env, offer, savedAt }) {
  const jd = captureSourcedOfferJob({ repoRoot, env, offer, savedAt });
  return offerWithArtifactPath(offer, jd);
}

function contentDigest(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// Computes a JD artifact's FINAL, content-addressed relative path (CR-29
// round 6): the last path component is a digest of the rendered content
// itself, so the path is immutable (the same offer + savedAt date always
// renders identical bytes and therefore the identical path) and
// collision-free (two different renders can never share a path). That
// immutability is what lets writeCanonicalCapturedJob below write straight
// to this path BEFORE any DB transaction opens, with no stage-then-rename
// step: a retry after a crash re-renders the same bytes to the same path (a
// harmless overwrite of identical content), so there is no pending state to
// recover and no window where a committed row can reference a path nothing
// ever wrote.
function contentAddressedJobCaptureRelPath(offer, content) {
  const company = slug(offer?.company, "unknown-company");
  const role = slug(offer?.title, "open-role");
  return `workspace/jobs/${company}-${role}-${contentDigest(content)}.md`;
}

// Writes a JD artifact straight to its FINAL deterministic path — the ONLY
// filesystem write in the DB-batch capture path, always called BEFORE
// captureAndPersistOffersIfDb opens sourcedUpsertBatch's transaction (CR-29
// round 6, replacing round 5's stage-then-rename dance, which left a window
// between a row's commit and its artifact's rename where a crash or rename
// failure could permanently orphan an already-committed row). Throws
// without writing partial content when the destination is blocked by
// something that isn't a plain file, so that failure surfaces here —
// "abort before insertion" — never after a row has already committed to
// reference it.
function writeCanonicalCapturedJob({ repoRoot, env, offer, savedAt }) {
  const content = renderCapturedJob({ offer, savedAt });
  const relPath = contentAddressedJobCaptureRelPath(offer, content);
  const absPath = userPath({ repoRoot, env }, relPath);
  if (existsSync(absPath) && !statSync(absPath).isFile()) {
    throw new Error(`sourced-persistence: JD artifact path is blocked: ${relPath}`);
  }
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
  return { relPath, absPath };
}

// True when SOME row currently committed in the DB (in this batch, an
// earlier batch, or an earlier run entirely) references `relPath` as its
// JD artifact. Used to decide whether a written-but-unaccepted artifact from
// THIS batch is safe to delete (CR-29 round 6): because the path is content-
// addressed, an identical offer resubmitted after an earlier partial
// failure re-renders the exact same path, so this batch's own duplicate hit
// or rollback must never delete a file a previously committed row still
// depends on.
function artifactPathIsReferenced({ repoRoot, env, relPath }) {
  if (!dbExists({ repoRoot, env })) return false;
  const db = requireDb({ repoRoot, env });
  for (const table of ["applications", "sourced"]) {
    for (const { data } of db.prepare(`SELECT data FROM ${table}`).all()) {
      let row;
      try {
        row = JSON.parse(data);
      } catch {
        continue;
      }
      if (row?.artifacts?.jd === relPath) return true;
    }
  }
  return false;
}

// Best-effort removal of a JD artifact this batch wrote but that ended up
// with no committed row referencing it: a duplicate hit, a sibling offer's
// pre-transaction write failure aborting the whole batch, or the whole
// transaction rolling back. Always re-checks the DB before deleting (see
// artifactPathIsReferenced) rather than trusting this batch's own
// accepted-id bookkeeping alone. A failed cleanup here is disk bloat, never
// a correctness problem, so it must never mask the real outcome.
function discardUnreferencedCapturedJob({ repoRoot, env, relPath, absPath }) {
  try {
    if (artifactPathIsReferenced({ repoRoot, env, relPath })) return;
    rmSync(absPath, { force: true });
  } catch {
    // best-effort
  }
}

export function sourcedRowsFromScanOffers(offers, nowIso = new Date().toISOString()) {
  if (!Array.isArray(offers)) return [];
  return offers.filter(hasRequiredSourcedFields).map((offer) => {
    const compensation = resolveCompensationEvidence(offer);
    const fitScore = Number(offer.score);
    const sourceMeta = sourceMetaFromOffer(offer);
    return {
      id: stableSourcedId(offer),
      company: offer.company,
      role: offer.title,
      status: "sourced",
      source: offer.source || "scanner",
      channel: "board",
      link: offer.url,
      loc: offer.location || "",
      base:
        compensation.baseComp ||
        (offer.bodyPartial === true ? null : explicitBaseCompensationRange(offerBodyText(offer))) ||
        "verify",
      tc: compensation.annualEarningsComp || null,
      ...(compensation.annualEarningsComp ? { compBasis: "annual-earnings" } : {}),
      fitScore: Number.isFinite(fitScore) ? fitScore : 0,
      fitBucket: offer.fit || "",
      fitBasis: "triage",
      gate: offer.gate || "review",
      sourcedAt: nowIso,
      updatedAt: nowIso,
      ...(offer.postedAt === null || offer.postedAt === undefined || offer.postedAt === ""
        ? {}
        : { postedAt: offer.postedAt }),
      artifacts: offer.artifacts || {},
      note: compactNote(offer),
      ...(sourceMeta ? { sourceMeta } : {}),
      // Carries forward any same-batch alias identities reconcileOffersBeforeCapture
      // merged onto this offer (CR-29 round 4, see mergeOfferIdentityAlias below) so
      // the freshly inserted row is born already answering for the duplicate's other
      // identity, instead of only picking that up on a LATER stand-alone merge.
      ...(Array.isArray(offer.aliasKeys) && offer.aliasKeys.length
        ? { aliasKeys: offer.aliasKeys }
        : {}),
      scanner: {
        reqId: offer.reqId || null,
        key: offer.key || null,
        bodyChars: Number.isFinite(Number(offer.bodyChars)) ? Number(offer.bodyChars) : null,
        bodyPartial: jobDescriptionIsPartial(offer),
        qualificationUnknowns: Array.isArray(offer.qualificationUnknowns)
          ? [...new Set(offer.qualificationUnknowns.map(String).filter(Boolean))].slice(0, 8)
          : [],
        unverified: offer.source === "ai-web-search",
        possibleDuplicate: Boolean(offer.possibleDuplicate),
      },
    };
  });
}

function persistScanOffersIfDb({
  repoRoot,
  env,
  offers,
  duplicateOffers,
  nowIso,
  guard,
  dedupeCanonical,
} = {}) {
  if (!dbExists({ repoRoot, env })) return null;
  const rows = sourcedRowsFromScanOffers(offers, nowIso);
  const hasDuplicateOffers = Array.isArray(duplicateOffers) && duplicateOffers.length > 0;
  // A duplicate-only batch (every offer matched an already-persisted row,
  // nothing new/updated to accept) must still reach sourcedUpsertBatch: its
  // guard(db) check and the alias merge itself both need to run inside that
  // verb's own transaction (CR-29 round 5) rather than being skipped here.
  if (rows.length === 0 && !hasDuplicateOffers) return null;
  const persisted = sourcedUpsertBatch({
    repoRoot,
    env,
    rows,
    duplicateOffers,
    guard,
    dedupeCanonical,
  });
  return { ...persisted, rows };
}

// Merges `duplicate`'s identity keys onto `canonicalOffer` IN MEMORY (CR-29
// round 4), for a duplicate whose match is another offer accepted earlier in
// THIS SAME BATCH rather than an already-persisted DB row. sourcedMergeIdentityAlias
// (the DB verb) only ever finds a match for a row that's already durable, so
// calling it here — before the canonical offer has even reached
// sourcedUpsertBatch — was always a silent no-op: the alias was dropped, and
// a LATER capture carrying only the duplicate's other representation (e.g. a
// HiringCafe-only republish with no outbound board URL) inserted as a second
// row instead of resolving back to the canonical one. Mutating the offer
// object directly means sourcedRowsFromScanOffers (see its aliasKeys
// passthrough above) carries the merge into the row sourcedUpsertBatch
// eventually inserts, so the canonical row is born already answering for it.
function mergeOfferIdentityAlias(canonicalOffer, duplicate, seenPostingKeys, acceptedByKey) {
  const additions = identityAliasAdditions(canonicalOffer, duplicate);
  if (!additions.length) return;
  canonicalOffer.aliasKeys = [...(canonicalOffer.aliasKeys || []), ...additions];
  for (const key of additions) {
    seenPostingKeys.add(key);
    acceptedByKey.set(key, canonicalOffer);
  }
}

// Read-only (CR-29 round 5): this used to call the sourcedMergeIdentityAliasBatch
// DB verb directly for every offer matching an already-persisted row, which
// committed that alias merge in its OWN transaction, before this batch's
// offers ever reached sourcedUpsertBatch's guard(db) check. A search
// superseded by a fresher one could therefore still mutate persisted rows'
// aliasKeys even though the guard would go on to reject its new/updated
// rows moments later — and a batch that turned out to be ALL duplicates
// bypassed the guard entirely, since sourcedUpsertBatch was never called for
// an empty `rows` array. Persisted-row matches are now only COLLECTED here
// (`persistedDuplicateOffers`) and merged by the caller inside
// sourcedUpsertBatch's own guarded transaction (see its `duplicateOffers`
// param) — including when they're the batch's only offers.
function reconcileOffersBeforeCapture({ repoRoot, env, offers, dedupeCanonical }) {
  if (!dedupeCanonical) return { offers, duplicates: 0, persistedDuplicateOffers: [] };
  const { seenPostingKeys } = buildDbSeenSets({ repoRoot, env });
  // Every identity key an offer ACCEPTED so far this batch answers for
  // (its own keys plus any aliases already merged onto it), so a LATER
  // duplicate in the same batch can be merged onto the right in-memory
  // offer instead of falling through to the persisted-duplicate path below.
  const acceptedByKey = new Map();
  const accepted = [];
  const persistedDuplicates = [];
  let duplicates = 0;
  for (const offer of offers) {
    const matchingKeys = postingIdentityKeys(offer).filter((key) => seenPostingKeys.has(key));
    if (matchingKeys.length) {
      // Inspect EVERY matching key, not just the first (CR-29 round 5):
      // a key seenPostingKeys knows about but acceptedByKey doesn't must
      // belong to an already-PERSISTED row (acceptedByKey only ever gains
      // keys as this batch accepts offers), so persisted ownership wins
      // over an in-memory match — merging this offer's other identities
      // onto an in-batch offer's aliasKeys instead would let a row insert
      // that duplicates the persisted row's own identity, since the final
      // upsert only merges onto the target ITS OWN keys can find.
      const persistedMatch = matchingKeys.find((key) => !acceptedByKey.has(key));
      if (persistedMatch) {
        persistedDuplicates.push(offer);
        continue;
      }
      duplicates++;
      const canonicalOffer = acceptedByKey.get(matchingKeys[0]);
      mergeOfferIdentityAlias(canonicalOffer, offer, seenPostingKeys, acceptedByKey);
      continue;
    }
    addPostingIdentity(seenPostingKeys, offer);
    for (const key of identityKeysWithAliases(offer)) acceptedByKey.set(key, offer);
    accepted.push(offer);
  }
  return { offers: accepted, duplicates, persistedDuplicateOffers: persistedDuplicates };
}

export function captureAndPersistOffersIfDb({
  repoRoot,
  env,
  offers,
  savedAt = new Date(),
  guard,
  dedupeCanonical = false,
} = {}) {
  if (!dbExists({ repoRoot, env })) return null;
  const reconciled = reconcileOffersBeforeCapture({
    repoRoot,
    env,
    offers: Array.isArray(offers) ? offers : [],
    dedupeCanonical,
  });
  // A duplicate-only reconciliation (every offer matched an already-persisted
  // row) still needs to reach sourcedUpsertBatch below (CR-29 round 5): the
  // guard(db) check and the alias merge itself both run inside its
  // transaction now, not a separate call before this function decided
  // whether to bother opening one.
  if (!reconciled.offers.length && !reconciled.persistedDuplicateOffers.length) {
    return {
      ok: true,
      persistedRows: 0,
      duplicates: reconciled.duplicates,
      failed: 0,
      offers: [],
      persisted: {
        created: 0,
        updated: 0,
        duplicates: 0,
        failed: 0,
        acceptedIds: [],
        failedIds: [],
      },
    };
  }
  // Every reconciled offer's JD artifact is written to its FINAL
  // content-addressed path HERE, BEFORE sourcedUpsertBatch ever opens its
  // transaction (CR-29 round 6). An offer whose write fails is excluded
  // from the batch entirely: it never reaches the DB ("abort before
  // insertion"), so it's neither a dangling row nor a silently-clobbered
  // artifact. Unlike round 5's stage-then-rename, there is no finalize step
  // afterward: the write already landed at the exact path the row's
  // artifacts.jd will reference inside the transaction, so a crash or
  // failure between this write and the transaction's commit can never
  // orphan a committed row — a retry just re-renders identical content to
  // the identical path. The only cleanup needed afterward is for artifacts
  // this batch wrote that DIDN'T end up referenced by any committed row
  // (a duplicate hit, a sibling's pre-transaction failure aborting the
  // whole batch, or the whole transaction rolling back) — see the
  // discardUnreferencedCapturedJob loop below.
  const acceptedOffersById = new Map();
  const writtenById = new Map();
  const preWriteFailedIds = [];
  const preparedOffers = [];
  for (const offer of reconciled.offers) {
    const [row] = sourcedRowsFromScanOffers([offer], savedAt.toISOString());
    if (!row) continue;
    const id = String(row.id);
    try {
      const written = writeCanonicalCapturedJob({ repoRoot, env, offer, savedAt });
      const preparedOffer = offerWithArtifactPath(offer, written.relPath);
      acceptedOffersById.set(id, preparedOffer);
      writtenById.set(id, written);
      preparedOffers.push(preparedOffer);
    } catch {
      preWriteFailedIds.push(id);
    }
  }

  let persisted = null;
  let pendingRethrow = null;
  if (preparedOffers.length || reconciled.persistedDuplicateOffers.length) {
    try {
      persisted = persistScanOffersIfDb({
        repoRoot,
        env,
        offers: preparedOffers,
        duplicateOffers: reconciled.persistedDuplicateOffers,
        nowIso: savedAt.toISOString(),
        guard,
        dedupeCanonical,
      });
    } catch (err) {
      if (err?.code === "EXPORT_FAILED") {
        // The db write already committed (runVerb's ExportFailedError
        // contract) — only the tracker.json/activity.jsonl compatibility
        // export failed AFTER it. The accepted rows' artifacts are already
        // at their final path (written before the transaction even opened),
        // so nothing more needs to happen for them before this rethrows.
        persisted = err.result;
        pendingRethrow = err;
      } else {
        // Nothing committed: every artifact this batch wrote is now
        // unreferenced, unless an earlier run already committed a row at
        // that exact content-addressed path.
        for (const written of writtenById.values()) {
          discardUnreferencedCapturedJob({ repoRoot, env, ...written });
        }
        throw err;
      }
    }
  }

  const acceptedIds = new Set((persisted?.acceptedIds || []).map(String));
  for (const [id, written] of writtenById) {
    if (!acceptedIds.has(id)) discardUnreferencedCapturedJob({ repoRoot, env, ...written });
  }
  if (pendingRethrow) throw pendingRethrow;

  const acceptedOffers = [...acceptedIds].map((id) => acceptedOffersById.get(id)).filter(Boolean);
  const failed = preWriteFailedIds.length + (persisted?.failed || 0);
  const failedIds = [...preWriteFailedIds, ...(persisted?.failedIds || [])];
  return {
    ok: failed === 0,
    persistedRows: (persisted?.created || 0) + (persisted?.updated || 0),
    duplicates: reconciled.duplicates + (persisted?.duplicates || 0),
    failed,
    failedIds,
    offers: acceptedOffers,
    persisted: { ...persisted, failed, failedIds },
  };
}
