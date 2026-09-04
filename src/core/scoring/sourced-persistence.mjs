import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { currencyCodePatternSource } from "../currency-format.mjs";
import { dbExists } from "../db/connection.mjs";
import { buildDbSeenSets, readDbScannerRows } from "../db/scan-context.mjs";
import { sourceConfigGet, sourceConfigMutate } from "../db/verbs/source-config.mjs";
import {
  sourcedMergeIdentityAliasBatch,
  sourcedReconcilePolicyBatch,
  sourcedUpsertBatch,
} from "../db/verbs/sourced.mjs";
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
// check, e.g.) can defer the actual write, see offerWithPendingCapturedJob.
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

// Same shape as offerWithCapturedJob, but the JD artifact write is deferred:
// the deterministic path lands in the returned offer's artifacts.jd exactly
// as offerWithCapturedJob would set it, but the content isn't written to
// disk until the caller invokes the returned `commit()`. Used by
// captureAndPersistOffersIfDb's dedupeCanonical path (CR-29 round 3): the
// caller there can't know until AFTER sourcedUpsertBatch's own duplicate
// check whether this offer wins its deterministic path or loses it to an
// already-accepted row with the same explicit reqId (different URL/body).
// Committing unconditionally, as the immediate-write path does, let a
// losing row's content silently overwrite the winner's artifact file.
function offerWithPendingCapturedJob({ repoRoot, env, offer, savedAt }) {
  const prepared = preparedCapturedJob({ repoRoot, env, offer, savedAt });
  return {
    preparedOffer: offerWithArtifactPath(offer, prepared.relPath),
    commit: () => writeCapturedJob(prepared),
  };
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
  nowIso,
  guard,
  dedupeCanonical,
  prepareAcceptedRow,
  commitAcceptedArtifact,
} = {}) {
  if (!dbExists({ repoRoot, env })) return null;
  const rows = sourcedRowsFromScanOffers(offers, nowIso);
  if (rows.length === 0) return null;
  const persisted = sourcedUpsertBatch({
    repoRoot,
    env,
    rows,
    guard,
    dedupeCanonical,
    prepareAcceptedRow,
    commitAcceptedArtifact,
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

function reconcileOffersBeforeCapture({ repoRoot, env, offers, dedupeCanonical }) {
  if (!dedupeCanonical) return { offers, duplicates: 0 };
  const { seenPostingKeys } = buildDbSeenSets({ repoRoot, env });
  // Every identity key an offer ACCEPTED so far this batch answers for
  // (its own keys plus any aliases already merged onto it), so a LATER
  // duplicate in the same batch can be merged onto the right in-memory
  // offer instead of falling through to the DB-only merge path below.
  const acceptedByKey = new Map();
  const accepted = [];
  const persistedDuplicates = [];
  let duplicates = 0;
  for (const offer of offers) {
    const matchKey = postingIdentityKeys(offer).find((key) => seenPostingKeys.has(key));
    if (matchKey) {
      duplicates++;
      const canonicalOffer = acceptedByKey.get(matchKey);
      if (canonicalOffer) {
        mergeOfferIdentityAlias(canonicalOffer, offer, seenPostingKeys, acceptedByKey);
      } else {
        // Matched an already-persisted DB row: batched below (CR-29 round 4)
        // instead of one standalone sourcedMergeIdentityAlias call per
        // offer, which rebuilt the whole stored posting index and opened
        // its own transaction/export for every suppressed duplicate.
        persistedDuplicates.push(offer);
      }
      continue;
    }
    addPostingIdentity(seenPostingKeys, offer);
    for (const key of identityKeysWithAliases(offer)) acceptedByKey.set(key, offer);
    accepted.push(offer);
  }
  if (persistedDuplicates.length) {
    sourcedMergeIdentityAliasBatch({ repoRoot, env, offers: persistedDuplicates });
  }
  return { offers: accepted, duplicates };
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
  if (!reconciled.offers.length) {
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
      },
    };
  }
  const acceptedOffersById = new Map();
  // JD artifact writes are deferred until each row's DB acceptance is known
  // (CR-29 round 3): prepareAcceptedRow runs for every reconciled offer
  // BEFORE sourcedUpsertBatch's own inner duplicate check decides which of
  // them actually lands, so writing the deterministic artifact path
  // immediately here let a row that loses that check (e.g. the same
  // explicit reqId arriving with a changed URL/body) overwrite the winning
  // row's already-accepted content.
  //
  // The actual write is committed from INSIDE sourcedUpsertBatch's write
  // transaction (CR-29 round 4, via commitAcceptedArtifact below), right
  // after the inner duplicate check decides a row IS the accepted one and
  // before that row's putRow lands. Previously the write happened here,
  // AFTER persistScanOffersIfDb (and the transaction/export inside it) had
  // already returned — so a compatibility-export failure, or the write
  // itself failing, left a durable row referencing a JD that was never
  // written, and reconciliation would reject a retry as a duplicate,
  // permanently losing the description. Committing pre-putRow means a write
  // failure is caught by sourcedUpsertBatch and that row is simply never
  // inserted (see commitAcceptedArtifact's try/catch there): no dangling
  // row, and the identity stays unseen so a retry can still succeed.
  const pendingWritesById = new Map();
  const uncapturedRows = sourcedRowsFromScanOffers(reconciled.offers, savedAt.toISOString());
  const offerById = new Map(
    uncapturedRows.map((row, index) => [String(row.id), reconciled.offers[index]])
  );
  const persisted = persistScanOffersIfDb({
    repoRoot,
    env,
    offers: reconciled.offers,
    nowIso: savedAt.toISOString(),
    guard,
    dedupeCanonical,
    prepareAcceptedRow: (row) => {
      const { preparedOffer, commit } = offerWithPendingCapturedJob({
        repoRoot,
        env,
        offer: offerById.get(String(row.id)),
        savedAt,
      });
      acceptedOffersById.set(String(row.id), preparedOffer);
      pendingWritesById.set(String(row.id), commit);
      return sourcedRowsFromScanOffers([preparedOffer], savedAt.toISOString())[0];
    },
    commitAcceptedArtifact: (acceptedRow) => {
      pendingWritesById.get(String(acceptedRow.id))?.();
    },
  });
  const acceptedOffers = (persisted?.acceptedIds || [])
    .map((id) => acceptedOffersById.get(String(id)))
    .filter(Boolean);
  return {
    ok: true,
    persistedRows: (persisted?.created || 0) + (persisted?.updated || 0),
    duplicates: reconciled.duplicates + (persisted?.duplicates || 0),
    failed: persisted?.failed || 0,
    offers: acceptedOffers,
    persisted,
  };
}
