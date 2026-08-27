import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const LIVE_SEARCH_RECEIPT_DIRECTORY = ".github/release-evidence/live-search";

const RUNTIME_IDS = ["claude", "codex"];
const FIXTURE_IDS = ["hospitality", "engineering"];
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/i;

export const LIVE_SEARCH_ACCEPTANCE = Object.freeze({
  fitFloor: 65,
  minimumPresentedRows: 3,
  minimumDistinctRoles: 3,
  minimumPresentedBuckets: 2,
});

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

function automaticRows({ runtimeId, fixtureId, rows, fitFloor }) {
  return (rows || [])
    .filter((row) => Number.isFinite(Number(row.fitScore)) && Number(row.fitScore) >= fitFloor)
    .map((row) => ({
      identity: rowIdentity({ runtimeId, fixtureId, ...row }),
      company: String(row.company || "").trim(),
      role: String(row.role || "").trim(),
      location: String(row.location || "").trim(),
      fitScore: Number(row.fitScore),
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
  summary,
  usefulSet,
  rows,
}) {
  if (!SOURCE_REVISION_PATTERN.test(String(sourceRevision || ""))) {
    throw new Error("Live-search source revision must be a full commit SHA.");
  }
  if (!RUNTIME_IDS.includes(runtimeId))
    throw new Error(`Unsupported live-search runtime: ${runtimeId}`);
  if (!FIXTURE_IDS.includes(fixtureId))
    throw new Error(`Unsupported live-search fixture: ${fixtureId}`);

  const fitFloor = Number(summary?.fitFloor);
  if (fitFloor !== LIVE_SEARCH_ACCEPTANCE.fitFloor) {
    throw new Error(`Live-search fit floor must be ${LIVE_SEARCH_ACCEPTANCE.fitFloor}.`);
  }
  const emittedRows = automaticRows({ runtimeId, fixtureId, rows, fitFloor });
  const distinctRoles = new Set(emittedRows.map((row) => row.role.toLowerCase()).filter(Boolean))
    .size;
  const presentedBuckets = [...new Set((usefulSet?.presentedBuckets || []).map(String))].sort();

  return {
    schemaVersion: 1,
    sourceRevision: String(sourceRevision).toLowerCase(),
    runtimeId,
    fixtureId,
    providerFallback: providerFallback === true,
    completedAt: validDate(completedAt, "Live-search completion time"),
    thresholds: { ...LIVE_SEARCH_ACCEPTANCE },
    counts: {
      presentedRows: emittedRows.length,
      distinctRoles,
      presentedBuckets: presentedBuckets.length,
    },
    summary: {
      presented: Number(summary?.presented || 0),
      fitFloor,
      errors: Array.isArray(summary?.errors) ? [...summary.errors] : [],
      failedPromptIds: Array.isArray(summary?.failedPromptIds) ? [...summary.failedPromptIds] : [],
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
      reviewer: nonEmptyString(reviewer, "Live-search reviewer"),
      verifiedAt: validDate(verifiedAt, "Live-search review time"),
      rowIdentities: exactRows,
    },
  };
}

function assertReceipt(receipt, { requireManualLiveness = true } = {}) {
  const combination = `${receipt?.runtimeId}/${receipt?.fixtureId}`;
  if (!EXPECTED_LIVE_SEARCH_COMBINATIONS.includes(combination)) {
    throw new Error(`Unexpected live-search receipt ${combination}.`);
  }
  if (receipt.schemaVersion !== 1) throw new Error(`${combination} has an unsupported schema.`);
  if (!SOURCE_REVISION_PATTERN.test(String(receipt.sourceRevision || ""))) {
    throw new Error(`${combination} has no full source revision.`);
  }
  if (receipt.providerFallback !== false) {
    throw new Error(`${combination} used provider fallback.`);
  }
  if (
    Object.entries(LIVE_SEARCH_ACCEPTANCE).some(
      ([name, value]) => receipt.thresholds?.[name] !== value
    )
  ) {
    throw new Error(`${combination} does not use the release acceptance thresholds.`);
  }
  if (receipt.summary?.fitFloor !== LIVE_SEARCH_ACCEPTANCE.fitFloor) {
    throw new Error(`${combination} does not expose the fit floor.`);
  }
  if (receipt.summary?.errors?.length || receipt.summary?.failedPromptIds?.length) {
    throw new Error(`${combination} completed with search failures.`);
  }
  if (receipt.counts?.presentedRows < LIVE_SEARCH_ACCEPTANCE.minimumPresentedRows) {
    throw new Error(`${combination} has too few presented rows.`);
  }
  if (receipt.counts?.distinctRoles < LIVE_SEARCH_ACCEPTANCE.minimumDistinctRoles) {
    throw new Error(`${combination} has too few distinct roles.`);
  }
  if (receipt.counts?.presentedBuckets < LIVE_SEARCH_ACCEPTANCE.minimumPresentedBuckets) {
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
  if (receipt.summary?.presented !== receipt.counts.presentedRows) {
    throw new Error(`${combination} search summary does not match its exact presented rows.`);
  }
  for (const row of receipt.rows) {
    if (!row.company || !row.role || !row.location) {
      throw new Error(`${combination} contains an incomplete emitted row.`);
    }
    if (!Number.isFinite(row.fitScore) || row.fitScore < LIVE_SEARCH_ACCEPTANCE.fitFloor) {
      throw new Error(`${combination} contains a row below the visible fit floor.`);
    }
    if (row.unverified !== true) {
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
      throw new Error(`Duplicate live-search receipt ${combination}.`);
    byCombination.set(combination, receipt);
  }
  for (const combination of EXPECTED_LIVE_SEARCH_COMBINATIONS) {
    if (!byCombination.has(combination))
      throw new Error(`Missing live-search receipt ${combination}.`);
  }
  if (byCombination.size !== EXPECTED_LIVE_SEARCH_COMBINATIONS.length) {
    throw new Error("Unexpected extra live-search receipts are present.");
  }

  const sourceRevisions = new Set(
    [...byCombination.values()].map((receipt) => receipt.sourceRevision)
  );
  if (sourceRevisions.size !== 1)
    throw new Error("Live-search receipts do not share one source revision.");
  const [sourceRevision] = sourceRevisions;
  if (!SOURCE_REVISION_PATTERN.test(String(currentRevision || ""))) {
    throw new Error("Current release revision must be a full commit SHA.");
  }
  if (String(currentRevision).toLowerCase() !== sourceRevision) {
    const allowedPaths = expectedReceiptPaths();
    const stalePath = changedPathsSinceSource.find((path) => !allowedPaths.has(String(path)));
    if (stalePath) throw new Error(`Live-search evidence is stale because ${stalePath} changed.`);
    if (changedPathsSinceSource.length === 0) {
      throw new Error("Live-search evidence is stale because its source revision is not current.");
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
  if (String(status).trim()) throw new Error("Release verification requires a clean worktree.");
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
      `Live-search receipt directory must contain exactly: ${expectedNames.join(", ")}.`
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
