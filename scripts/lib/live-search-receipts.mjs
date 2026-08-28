import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hasCompleteCareerRatCapabilities } from "../../src/core/ai/installed-runtimes.mjs";

export const LIVE_SEARCH_RECEIPT_DIRECTORY = ".github/release-evidence/live-search";

const RUNTIME_IDS = ["claude", "codex"];
const FIXTURE_IDS = ["hospitality", "engineering"];
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/i;

export const EXPECTED_LIVE_SEARCH_PROMPT_IDS = Object.freeze({
  hospitality: Object.freeze([
    "nyc-bar-leadership",
    "nyc-hospitality-operations",
    "event-and-venue-operations",
  ]),
  engineering: Object.freeze([
    "us-remote-engineering",
    "nyc-hybrid-engineering",
    "developer-infrastructure",
  ]),
});

export const NATIVE_AI_SEARCH_ACCEPTANCE = Object.freeze({
  fitFloor: 65,
  minimumPresentedRows: 3,
  minimumDistinctRoles: 3,
  minimumPresentedBuckets: 2,
});
export const LIVE_SEARCH_ACCEPTANCE = NATIVE_AI_SEARCH_ACCEPTANCE;

export const EXPECTED_LIVE_SEARCH_COMBINATIONS = Object.freeze(
  RUNTIME_IDS.flatMap((runtimeId) =>
    FIXTURE_IDS.map((fixtureId) => `${runtimeId}/${fixtureId}`)
  ).sort()
);

export function liveSearchReceiptFilename(runtimeId, fixtureId) {
  return `${runtimeId}-${fixtureId}.json`;
}

function expectedReceiptPaths() {
  return new Set(
    EXPECTED_LIVE_SEARCH_COMBINATIONS.map((combination) => {
      const [runtimeId, fixtureId] = combination.split("/");
      return `${LIVE_SEARCH_RECEIPT_DIRECTORY}/${liveSearchReceiptFilename(runtimeId, fixtureId)}`;
    })
  );
}

function nonEmptyString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function validDate(value, label) {
  const normalized = nonEmptyString(value, label);
  if (Number.isNaN(Date.parse(normalized))) throw new Error(`${label} must be an ISO date.`);
  return normalized;
}

function exactIdentitySet(receipt, rowIdentities) {
  const expected = receipt.rows.map((row) => row.identity).sort();
  const actual = [...new Set((rowIdentities || []).map((value) => String(value).trim()))].sort();
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error("Manual liveness review must name every exact row identity.");
  }
  return actual;
}

function rowIdentity({ runtimeId, fixtureId, company, role, location, source }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        runtimeId,
        fixtureId,
        company: String(company || "").trim(),
        role: String(role || "").trim(),
        location: String(location || "").trim(),
        source: String(source || "").trim(),
      })
    )
    .digest("hex");
}

function normalizedHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.href;
  } catch {
    return raw;
  }
}

export function annotateCanonicalReadableRows({ rows, sources } = {}) {
  const readableUrls = new Set();
  for (const source of Array.isArray(sources) ? sources : []) {
    if (source?.status !== "completed") continue;
    const lane = String(source.discoveryLane || "").trim() || "*";
    for (const value of [source.url, source.canonicalUrl]) {
      const url = normalizedHttpUrl(value);
      if (url) readableUrls.add(`${lane}|${url}`);
    }
  }
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const url = normalizedHttpUrl(row?.source);
    const lane = String(row?.discoveryLane || "").trim();
    return {
      ...row,
      canonicalReadable: readableUrls.has(`${lane}|${url}`) || readableUrls.has(`*|${url}`),
    };
  });
}

export function canonicalSourcesFromUnifiedSearch({ deterministicResult, aiResult } = {}) {
  const receipts = [];
  const seen = new Set();
  const add = (value, discoveryLane) => {
    const url = normalizedHttpUrl(value);
    const key = `${discoveryLane}|${url}`;
    if (!url || seen.has(key)) return;
    seen.add(key);
    receipts.push({ url, status: "completed", discoveryLane });
  };

  for (const offer of Array.isArray(deterministicResult?.offers)
    ? deterministicResult.offers
    : []) {
    if (
      offer?.bodyPartial !== false ||
      Number(offer?.bodyChars) <= 0 ||
      offer?.liveness?.result !== "active"
    ) {
      continue;
    }
    add(offer.url, "deterministic");
  }
  const completedAiUrls = new Set(
    (Array.isArray(aiResult?.sources) ? aiResult.sources : [])
      .filter((source) => source?.status === "completed")
      .flatMap((source) => [source.url, source.canonicalUrl])
      .map(normalizedHttpUrl)
      .filter(Boolean)
  );
  for (const offer of Array.isArray(aiResult?.offers) ? aiResult.offers : []) {
    const url = normalizedHttpUrl(offer?.url);
    if (completedAiUrls.has(url)) add(url, "ai-web");
  }
  return receipts;
}

function automaticRows({ runtimeId, fixtureId, rows, fitFloor }) {
  return (rows || [])
    .filter(
      (row) =>
        row.canonicalReadable === true &&
        row.partial !== true &&
        Number.isFinite(Number(row.fitScore)) &&
        Number(row.fitScore) >= fitFloor
    )
    .map((row) => ({
      identity: rowIdentity({ runtimeId, fixtureId, ...row }),
      company: String(row.company || "").trim(),
      role: String(row.role || "").trim(),
      location: String(row.location || "").trim(),
      fitScore: Number(row.fitScore),
      canonicalReadable: true,
      discoveryLane: String(row.discoveryLane || "").trim(),
      partial: false,
      unverified: row.unverified === true,
      source: String(row.source || "").trim(),
    }));
}

export function buildLiveSearchReceipt({
  sourceRevision,
  runtimeId,
  fixtureId,
  providerFallback,
  completedAt,
  runtimeVerification,
  laneStatuses,
  summary,
  expectedPromptIds,
  aiSummary,
  usefulSet,
  rows,
}) {
  if (!SOURCE_REVISION_PATTERN.test(String(sourceRevision || ""))) {
    throw new Error("Native AI search source revision must be a full commit SHA.");
  }
  if (!RUNTIME_IDS.includes(runtimeId))
    throw new Error(`Unsupported native AI search runtime: ${runtimeId}`);
  if (!FIXTURE_IDS.includes(fixtureId))
    throw new Error(`Unsupported native AI search fixture: ${fixtureId}`);

  const fitFloor = Number(summary?.fitFloor);
  if (fitFloor !== NATIVE_AI_SEARCH_ACCEPTANCE.fitFloor) {
    throw new Error(`Native AI search fit floor must be ${NATIVE_AI_SEARCH_ACCEPTANCE.fitFloor}.`);
  }
  const emittedRows = automaticRows({ runtimeId, fixtureId, rows, fitFloor });
  const distinctRoles = new Set(emittedRows.map((row) => row.role.toLowerCase()).filter(Boolean))
    .size;
  const presentedBuckets = [...new Set((usefulSet?.presentedBuckets || []).map(String))].sort();
  const expectedAiPromptIds = (expectedPromptIds || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const aiQueryResults = (Array.isArray(aiSummary?.queryResults) ? aiSummary.queryResults : []).map(
    (entry) => ({
      promptId: String(entry?.promptId || "").trim(),
      status: String(entry?.status || "").trim(),
      queries: (Array.isArray(entry?.queries) ? entry.queries : []).map((query) => ({
        query: String(query?.query || "").trim(),
        status: String(query?.status || "").trim(),
      })),
    })
  );
  const aiErrors = Array.isArray(aiSummary?.errors) ? [...aiSummary.errors] : [];
  const failedAiPromptIds = Array.isArray(aiSummary?.failedPromptIds)
    ? [...aiSummary.failedPromptIds]
    : [];
  const canonicalAiRows = emittedRows.filter((row) => row.discoveryLane === "ai-web").length;
  const emittedRowsByUrl = new Map(emittedRows.map((row) => [normalizedHttpUrl(row.source), row]));
  const canonicalOverlapRowsByIdentity = new Map();
  for (const overlap of Array.isArray(aiSummary?.canonicalOverlaps)
    ? aiSummary.canonicalOverlaps
    : []) {
    const promptId = String(overlap?.promptId || "").trim();
    const row = emittedRowsByUrl.get(normalizedHttpUrl(overlap?.url));
    if (!promptId || row?.discoveryLane !== "deterministic") continue;
    const existing = canonicalOverlapRowsByIdentity.get(row.identity) || {
      promptIds: new Set(),
      rowIdentity: row.identity,
      source: row.source,
    };
    existing.promptIds.add(promptId);
    canonicalOverlapRowsByIdentity.set(row.identity, existing);
  }
  const canonicalAiOverlapRows = [...canonicalOverlapRowsByIdentity.values()]
    .map((entry) => ({
      promptIds: [...entry.promptIds].sort(),
      rowIdentity: entry.rowIdentity,
      source: entry.source,
    }))
    .sort((left, right) => left.rowIdentity.localeCompare(right.rowIdentity));

  return {
    schemaVersion: 1,
    sourceRevision: String(sourceRevision).toLowerCase(),
    runtimeId,
    fixtureId,
    providerFallback: providerFallback === true,
    runtime: {
      id: runtimeId,
      path: String(runtimeVerification?.path || "").trim(),
      realPath: String(runtimeVerification?.realPath || "").trim(),
      version: String(runtimeVerification?.version || "").trim(),
      binaryFingerprint: String(runtimeVerification?.binaryFingerprint || "")
        .trim()
        .toLowerCase(),
      capabilities:
        runtimeVerification?.capabilities && typeof runtimeVerification.capabilities === "object"
          ? { ...runtimeVerification.capabilities }
          : null,
    },
    lanes: {
      deterministic: String(laneStatuses?.deterministic || "").trim(),
      aiWeb: String(laneStatuses?.aiWeb || "").trim(),
    },
    completedAt: validDate(completedAt, "Native AI search completion time"),
    thresholds: { ...NATIVE_AI_SEARCH_ACCEPTANCE },
    counts: {
      presentedRows: emittedRows.length,
      distinctRoles,
      presentedBuckets: presentedBuckets.length,
      canonicalAiRows,
      canonicalAiOverlapRows: canonicalAiOverlapRows.length,
    },
    summary: {
      presented: Number(summary?.presented || 0),
      fitFloor,
      errors: aiErrors,
      failedPromptIds: failedAiPromptIds,
    },
    ai: {
      expectedPromptIds: expectedAiPromptIds,
      searched: Number(aiSummary?.searched || 0),
      queryResults: aiQueryResults,
      errors: aiErrors,
      failedPromptIds: failedAiPromptIds,
      canonicalRows: canonicalAiRows,
      canonicalOverlapRows: canonicalAiOverlapRows,
    },
    presentedBuckets,
    rows: emittedRows,
    manualLiveness: {
      verified: false,
      reviewer: null,
      verifiedAt: null,
      rowIdentities: [],
    },
  };
}

export function reviewLiveSearchReceipt({ receipt, reviewer, verifiedAt, rowIdentities }) {
  const exactRows = exactIdentitySet(receipt, rowIdentities);
  return {
    ...receipt,
    manualLiveness: {
      verified: true,
      reviewer: nonEmptyString(reviewer, "Native AI search reviewer"),
      verifiedAt: validDate(verifiedAt, "Native AI search review time"),
      rowIdentities: exactRows,
    },
  };
}

function assertReceipt(receipt, { requireManualLiveness = true } = {}) {
  const combination = `${receipt?.runtimeId}/${receipt?.fixtureId}`;
  if (!EXPECTED_LIVE_SEARCH_COMBINATIONS.includes(combination)) {
    throw new Error(`Unexpected native AI search receipt ${combination}.`);
  }
  if (receipt.schemaVersion !== 1) throw new Error(`${combination} has an unsupported schema.`);
  if (!SOURCE_REVISION_PATTERN.test(String(receipt.sourceRevision || ""))) {
    throw new Error(`${combination} has no full source revision.`);
  }
  if (receipt.providerFallback !== false) {
    throw new Error(`${combination} used provider fallback.`);
  }
  if (
    receipt.runtime?.id !== receipt.runtimeId ||
    !String(receipt.runtime?.path || "").trim() ||
    !String(receipt.runtime?.realPath || "").trim() ||
    !String(receipt.runtime?.version || "").trim() ||
    !/^[a-f0-9]{64}$/.test(String(receipt.runtime?.binaryFingerprint || "")) ||
    !hasCompleteCareerRatCapabilities(receipt.runtime?.capabilities, receipt.runtimeId)
  ) {
    throw new Error(`${combination} has no verified runtime execution identity.`);
  }
  if (receipt.lanes?.deterministic !== "succeeded") {
    throw new Error(`${combination} deterministic lane did not succeed.`);
  }
  if (receipt.lanes?.aiWeb !== "succeeded") {
    throw new Error(`${combination} AI lane did not succeed.`);
  }
  if (
    Object.entries(NATIVE_AI_SEARCH_ACCEPTANCE).some(
      ([name, value]) => receipt.thresholds?.[name] !== value
    )
  ) {
    throw new Error(`${combination} does not use the release acceptance thresholds.`);
  }
  if (receipt.summary?.fitFloor !== NATIVE_AI_SEARCH_ACCEPTANCE.fitFloor) {
    throw new Error(`${combination} does not expose the fit floor.`);
  }
  if (receipt.ai?.errors?.length || receipt.ai?.failedPromptIds?.length) {
    throw new Error(`${combination} completed with AI search failures.`);
  }
  const expectedPromptIds = Array.isArray(receipt.ai?.expectedPromptIds)
    ? receipt.ai.expectedPromptIds.map(String)
    : [];
  const fixturePromptIds = EXPECTED_LIVE_SEARCH_PROMPT_IDS[receipt.fixtureId];
  if (
    expectedPromptIds.length !== fixturePromptIds.length ||
    expectedPromptIds.some((promptId, index) => promptId !== fixturePromptIds[index])
  ) {
    throw new Error(`${combination} does not match its fixture prompt contract.`);
  }
  const queryResults = Array.isArray(receipt.ai?.queryResults) ? receipt.ai.queryResults : [];
  const coveredPromptIds = queryResults
    .filter((entry) => entry?.status === "completed")
    .map((entry) => String(entry.promptId || ""));
  if (
    expectedPromptIds.length === 0 ||
    new Set(expectedPromptIds).size !== expectedPromptIds.length ||
    receipt.ai?.searched !== expectedPromptIds.length ||
    queryResults.length !== expectedPromptIds.length ||
    new Set(coveredPromptIds).size !== expectedPromptIds.length ||
    expectedPromptIds.some((promptId) => !coveredPromptIds.includes(promptId))
  ) {
    throw new Error(`${combination} does not have complete AI prompt coverage.`);
  }
  if (
    queryResults.some(
      (entry) =>
        !Array.isArray(entry?.queries) ||
        entry.queries.length === 0 ||
        entry.queries.some(
          (query) => !String(query?.query || "").trim() || query?.status !== "completed"
        )
    )
  ) {
    throw new Error(`${combination} does not have real query coverage for every AI prompt.`);
  }
  if (receipt.counts?.presentedRows < NATIVE_AI_SEARCH_ACCEPTANCE.minimumPresentedRows) {
    throw new Error(`${combination} has too few presented rows.`);
  }
  if (receipt.counts?.distinctRoles < NATIVE_AI_SEARCH_ACCEPTANCE.minimumDistinctRoles) {
    throw new Error(`${combination} has too few distinct roles.`);
  }
  if (receipt.counts?.presentedBuckets < NATIVE_AI_SEARCH_ACCEPTANCE.minimumPresentedBuckets) {
    throw new Error(`${combination} has too few target buckets.`);
  }
  if (receipt.rows?.length !== receipt.counts.presentedRows) {
    throw new Error(`${combination} presented-row count does not match its exact rows.`);
  }
  const distinctRoles = new Set(receipt.rows.map((row) => String(row.role || "").toLowerCase()))
    .size;
  if (distinctRoles !== receipt.counts.distinctRoles) {
    throw new Error(`${combination} distinct-role count does not match its exact rows.`);
  }
  if (receipt.presentedBuckets?.length !== receipt.counts.presentedBuckets) {
    throw new Error(`${combination} bucket count does not match its receipt.`);
  }
  const canonicalAiRows = receipt.rows.filter((row) => row.discoveryLane === "ai-web").length;
  const canonicalAiOverlapRows = Array.isArray(receipt.ai?.canonicalOverlapRows)
    ? receipt.ai.canonicalOverlapRows
    : [];
  const receiptRowsByIdentity = new Map(receipt.rows.map((row) => [row.identity, row]));
  const overlapIdentitySet = new Set();
  for (const overlap of canonicalAiOverlapRows) {
    const row = receiptRowsByIdentity.get(String(overlap?.rowIdentity || ""));
    const promptIds = Array.isArray(overlap?.promptIds) ? overlap.promptIds.map(String) : [];
    if (
      row?.discoveryLane !== "deterministic" ||
      normalizedHttpUrl(overlap?.source) !== normalizedHttpUrl(row.source) ||
      promptIds.length === 0 ||
      new Set(promptIds).size !== promptIds.length ||
      promptIds.some((promptId) => !coveredPromptIds.includes(promptId)) ||
      overlapIdentitySet.has(row.identity)
    ) {
      throw new Error(`${combination} has invalid canonical AI overlap evidence.`);
    }
    overlapIdentitySet.add(row.identity);
  }
  if (
    canonicalAiRows + canonicalAiOverlapRows.length < 1 ||
    receipt.counts?.canonicalAiRows !== canonicalAiRows ||
    receipt.ai?.canonicalRows !== canonicalAiRows
  ) {
    throw new Error(`${combination} has no canonical AI evidence.`);
  }
  if (
    receipt.counts?.canonicalAiOverlapRows !== canonicalAiOverlapRows.length ||
    overlapIdentitySet.size !== canonicalAiOverlapRows.length
  ) {
    throw new Error(`${combination} canonical AI overlap count does not match its evidence.`);
  }
  if (receipt.summary?.presented !== receipt.counts.presentedRows) {
    throw new Error(`${combination} search summary does not match its exact presented rows.`);
  }
  for (const row of receipt.rows) {
    if (!row.company || !row.role || !row.location) {
      throw new Error(`${combination} contains an incomplete emitted row.`);
    }
    if (!Number.isFinite(row.fitScore) || row.fitScore < NATIVE_AI_SEARCH_ACCEPTANCE.fitFloor) {
      throw new Error(`${combination} contains a row below the visible fit floor.`);
    }
    if (row.canonicalReadable !== true) {
      throw new Error(`${combination} contains a row without canonical readable evidence.`);
    }
    if (!new Set(["deterministic", "ai-web"]).has(row.discoveryLane)) {
      throw new Error(`${combination} contains a row without a discovery lane.`);
    }
    if (row.discoveryLane === "ai-web" && row.unverified !== true) {
      throw new Error(`${combination} does not preserve the AI unverified state.`);
    }
    let url;
    try {
      url = new URL(row.source);
    } catch {
      throw new Error(`${combination} contains a row without a direct HTTPS posting URL.`);
    }
    if (url.protocol !== "https:") {
      throw new Error(`${combination} contains a row without a direct HTTPS posting URL.`);
    }
    if (
      row.identity !==
      rowIdentity({ ...row, runtimeId: receipt.runtimeId, fixtureId: receipt.fixtureId })
    ) {
      throw new Error(`${combination} contains a changed row identity.`);
    }
  }
  if (!requireManualLiveness) return combination;
  if (receipt.manualLiveness?.verified !== true) {
    throw new Error(`${combination} has no manual liveness verification.`);
  }
  nonEmptyString(receipt.manualLiveness.reviewer, `${combination} reviewer`);
  validDate(receipt.manualLiveness.verifiedAt, `${combination} review time`);
  exactIdentitySet(receipt, receipt.manualLiveness.rowIdentities);
  return combination;
}

export function verifyLiveSearchReceiptForReview(receipt) {
  return assertReceipt(receipt, { requireManualLiveness: false });
}

export function verifyLiveSearchReceiptSet({
  receipts,
  currentRevision,
  changedPathsSinceSource = [],
}) {
  const byCombination = new Map();
  for (const receipt of receipts || []) {
    const combination = assertReceipt(receipt);
    if (byCombination.has(combination))
      throw new Error(`Duplicate native AI search receipt ${combination}.`);
    byCombination.set(combination, receipt);
  }
  for (const combination of EXPECTED_LIVE_SEARCH_COMBINATIONS) {
    if (!byCombination.has(combination))
      throw new Error(`Missing native AI search receipt ${combination}.`);
  }
  if (byCombination.size !== EXPECTED_LIVE_SEARCH_COMBINATIONS.length) {
    throw new Error("Unexpected extra native AI search receipts are present.");
  }

  const sourceRevisions = new Set(
    [...byCombination.values()].map((receipt) => receipt.sourceRevision)
  );
  if (sourceRevisions.size !== 1)
    throw new Error("Native AI search receipts do not share one source revision.");
  const [sourceRevision] = sourceRevisions;
  if (!SOURCE_REVISION_PATTERN.test(String(currentRevision || ""))) {
    throw new Error("Current release revision must be a full commit SHA.");
  }
  if (String(currentRevision).toLowerCase() !== sourceRevision) {
    const allowedPaths = expectedReceiptPaths();
    const stalePath = changedPathsSinceSource.find((path) => !allowedPaths.has(String(path)));
    if (stalePath) {
      throw new Error(`Native AI search evidence is stale because ${stalePath} changed.`);
    }
    if (changedPathsSinceSource.length === 0) {
      throw new Error(
        "Native AI search evidence is stale because its source revision is not current."
      );
    }
  }

  return {
    sourceRevision,
    combinations: [...byCombination.keys()].sort(),
  };
}

export function verifyLiveSearchReceiptDirectory({
  repoRoot,
  receiptDirectory = LIVE_SEARCH_RECEIPT_DIRECTORY,
  execFileSyncImpl = execFileSync,
  readFileSyncImpl = readFileSync,
  readdirSyncImpl = readdirSync,
}) {
  const root = resolve(repoRoot);
  const status = execFileSyncImpl("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    encoding: "utf8",
  });
  if (String(status).trim()) {
    throw new Error("Native AI search release verification requires a clean worktree.");
  }
  const currentRevision = String(
    execFileSyncImpl("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
  ).trim();
  const directoryPath = resolve(root, receiptDirectory);
  const names = readdirSyncImpl(directoryPath)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const expectedNames = EXPECTED_LIVE_SEARCH_COMBINATIONS.map((combination) => {
    const [runtimeId, fixtureId] = combination.split("/");
    return liveSearchReceiptFilename(runtimeId, fixtureId);
  }).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `Native AI search receipt directory must contain exactly: ${expectedNames.join(", ")}.`
    );
  }
  const receipts = names.map((name) =>
    JSON.parse(readFileSyncImpl(join(directoryPath, name), "utf8"))
  );
  const sourceRevision = receipts[0]?.sourceRevision;
  const changedPathsSinceSource =
    sourceRevision && sourceRevision !== currentRevision
      ? String(
          execFileSyncImpl(
            "git",
            ["diff", "--name-only", `${sourceRevision}..${currentRevision}`],
            {
              cwd: root,
              encoding: "utf8",
            }
          )
        )
          .split(/\r?\n/)
          .filter(Boolean)
      : [];
  return verifyLiveSearchReceiptSet({ receipts, currentRevision, changedPathsSinceSource });
}
