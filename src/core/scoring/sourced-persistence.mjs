import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dbExists } from "../db/connection.mjs";
import { buildDbSeenSets } from "../db/scan-context.mjs";
import { sourcedUpsertBatch } from "../db/verbs/sourced.mjs";
import { userPath } from "../paths/workspace.mjs";
import { atomicWriteFile } from "../profile/gate-writer.mjs";
import { stringifyYaml } from "../profile/yaml.mjs";
import { trimEdgeCharacter } from "../text/slug.mjs";
import { addPostingIdentity, postingIdentityIsSeen } from "./sourced-identity.mjs";

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
  const dateSaved = savedAt.toISOString().slice(0, 10);
  const frontmatter = {
    company: offer.company || "",
    role: offer.title || "",
    reqId: offer.reqId || null,
    comp: offer.comp || null,
    location: offer.location || null,
    source: offer.url || "",
    sourceName: offer.source || "capture",
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
    offer.comp ? `- Compensation: ${offer.comp}` : "",
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

function captureSourcedOfferJob({ repoRoot, env, offer, savedAt = new Date() } = {}) {
  const pathCtx = { repoRoot, env };
  const relPath = jobCaptureRelPath(offer);
  const absPath = userPath(pathCtx, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  atomicWriteFile(absPath, renderCapturedJob({ offer, savedAt }));
  return relPath;
}

export function offersWithCapturedJobs({ repoRoot, env, offers, savedAt = new Date() } = {}) {
  return (Array.isArray(offers) ? offers : [])
    .filter(hasRequiredSourcedFields)
    .map((offer) => offerWithCapturedJob({ repoRoot, env, offer, savedAt }));
}

function offerWithCapturedJob({ repoRoot, env, offer, savedAt }) {
  const jd = captureSourcedOfferJob({ repoRoot, env, offer, savedAt });
  const bodyText = offerBodyText(offer);
  const { rawText, description, ...rest } = offer;
  return {
    ...rest,
    ...(bodyText ? { bodyText } : {}),
    bodyChars: bodyText.length,
    artifacts: { ...(offer.artifacts || {}), jd },
  };
}

export function sourcedRowsFromScanOffers(offers, nowIso = new Date().toISOString()) {
  if (!Array.isArray(offers)) return [];
  return offers.filter(hasRequiredSourcedFields).map((offer) => {
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
      base: offer.comp || "verify",
      fitScore: Number.isFinite(fitScore) ? fitScore : 0,
      fitBucket: offer.fit || "",
      fitBasis: "triage",
      gate: offer.gate || "review",
      sourcedAt: nowIso,
      updatedAt: nowIso,
      artifacts: offer.artifacts || {},
      note: compactNote(offer),
      ...(sourceMeta ? { sourceMeta } : {}),
      scanner: {
        reqId: offer.reqId || null,
        key: offer.key || null,
        bodyChars: Number.isFinite(Number(offer.bodyChars)) ? Number(offer.bodyChars) : null,
        bodyPartial: jobDescriptionIsPartial(offer),
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
  });
  return { ...persisted, rows };
}

function reconcileOffersBeforeCapture({ repoRoot, env, offers, dedupeCanonical }) {
  if (!dedupeCanonical) return { offers, duplicates: 0 };
  const { seenPostingKeys } = buildDbSeenSets({ repoRoot, env });
  const accepted = [];
  let duplicates = 0;
  for (const offer of offers) {
    if (postingIdentityIsSeen(offer, seenPostingKeys)) {
      duplicates++;
      continue;
    }
    addPostingIdentity(seenPostingKeys, offer);
    accepted.push(offer);
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
      offers: [],
      persisted: {
        created: 0,
        updated: 0,
        duplicates: 0,
        acceptedIds: [],
      },
    };
  }
  const acceptedOffersById = new Map();
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
      const captured = offerWithCapturedJob({
        repoRoot,
        env,
        offer: offerById.get(String(row.id)),
        savedAt,
      });
      acceptedOffersById.set(String(row.id), captured);
      return sourcedRowsFromScanOffers([captured], savedAt.toISOString())[0];
    },
  });
  const acceptedOffers = (persisted?.acceptedIds || [])
    .map((id) => acceptedOffersById.get(String(id)))
    .filter(Boolean);
  return {
    ok: true,
    persistedRows: (persisted?.created || 0) + (persisted?.updated || 0),
    duplicates: reconciled.duplicates + (persisted?.duplicates || 0),
    offers: acceptedOffers,
    persisted,
  };
}
