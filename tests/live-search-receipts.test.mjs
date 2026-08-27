import assert from "node:assert/strict";
import test from "node:test";

async function loadReceiptModule() {
  return import("../scripts/lib/live-search-receipts.mjs").catch(() => ({}));
}

const SOURCE_REVISION = "a".repeat(40);
const CURRENT_REVISION = "b".repeat(40);

function resultRows(fixtureId) {
  return [0, 1, 2].map((index) => ({
    company: `${fixtureId} company ${index + 1}`,
    role: `${fixtureId} role ${index + 1}`,
    location: index === 0 ? "New York, NY" : "Remote, United States",
    fitScore: 80 - index,
    unverified: true,
    source: `https://jobs.example.test/${fixtureId}/${index + 1}`,
  }));
}

async function acceptedReceipt(runtimeId, fixtureId) {
  const receiptModule = await loadReceiptModule();
  const receipt = receiptModule.buildLiveSearchReceipt({
    sourceRevision: SOURCE_REVISION,
    runtimeId,
    fixtureId,
    providerFallback: false,
    completedAt: "2026-08-27T12:00:00.000Z",
    summary: {
      presented: 3,
      fitFloor: 65,
      errors: [],
      failedPromptIds: [],
    },
    usefulSet: {
      presentedRoleCount: 3,
      presentedBucketCount: 2,
      presentedBuckets: ["primary", "secondary"],
    },
    rows: resultRows(fixtureId),
  });
  return receiptModule.reviewLiveSearchReceipt({
    receipt,
    reviewer: "release-reviewer",
    verifiedAt: "2026-08-27T13:00:00.000Z",
    rowIdentities: receipt.rows.map((row) => row.identity),
  });
}

test("four reviewed current-source receipts pass the release gate", async () => {
  const receiptModule = await loadReceiptModule();
  assert.equal(typeof receiptModule.verifyLiveSearchReceiptSet, "function");
  const receipts = await Promise.all([
    acceptedReceipt("claude", "hospitality"),
    acceptedReceipt("claude", "engineering"),
    acceptedReceipt("codex", "hospitality"),
    acceptedReceipt("codex", "engineering"),
  ]);

  const result = receiptModule.verifyLiveSearchReceiptSet({
    receipts,
    currentRevision: CURRENT_REVISION,
    changedPathsSinceSource: receipts.map(
      (receipt) =>
        `.github/release-evidence/live-search/${receipt.runtimeId}-${receipt.fixtureId}.json`
    ),
  });

  assert.deepEqual(result.combinations, [
    "claude/engineering",
    "claude/hospitality",
    "codex/engineering",
    "codex/hospitality",
  ]);
  assert.equal(result.sourceRevision, SOURCE_REVISION);
});

test("receipt gate rejects missing, stale, fallback, weak, or manually-unverified evidence", async () => {
  const receiptModule = await loadReceiptModule();
  assert.equal(typeof receiptModule.verifyLiveSearchReceiptSet, "function");
  const receipts = await Promise.all([
    acceptedReceipt("claude", "hospitality"),
    acceptedReceipt("claude", "engineering"),
    acceptedReceipt("codex", "hospitality"),
    acceptedReceipt("codex", "engineering"),
  ]);
  const verify = (nextReceipts, overrides = {}) =>
    receiptModule.verifyLiveSearchReceiptSet({
      receipts: nextReceipts,
      currentRevision: SOURCE_REVISION,
      changedPathsSinceSource: [],
      ...overrides,
    });

  assert.throws(() => verify(receipts.slice(1)), /missing.*claude\/hospitality/i);
  assert.throws(
    () =>
      verify(receipts, {
        currentRevision: CURRENT_REVISION,
        changedPathsSinceSource: ["src/x.mjs"],
      }),
    /stale.*src\/x\.mjs/i
  );
  assert.throws(
    () =>
      verify(
        receipts.map((receipt, index) => (index ? receipt : { ...receipt, providerFallback: true }))
      ),
    /fallback/i
  );
  assert.throws(
    () =>
      verify(
        receipts.map((receipt, index) =>
          index ? receipt : { ...receipt, counts: { ...receipt.counts, presentedRows: 2 } }
        )
      ),
    /presented rows/i
  );
  assert.throws(
    () =>
      verify(
        receipts.map((receipt, index) =>
          index ? receipt : { ...receipt, manualLiveness: { verified: false } }
        )
      ),
    /manual liveness/i
  );
});

test("manual review must name every exact emitted row identity", async () => {
  const receiptModule = await loadReceiptModule();
  assert.equal(typeof receiptModule.reviewLiveSearchReceipt, "function");
  const draft = receiptModule.buildLiveSearchReceipt({
    sourceRevision: SOURCE_REVISION,
    runtimeId: "codex",
    fixtureId: "engineering",
    providerFallback: false,
    completedAt: "2026-08-27T12:00:00.000Z",
    summary: { presented: 3, fitFloor: 65, errors: [], failedPromptIds: [] },
    usefulSet: { presentedRoleCount: 3, presentedBucketCount: 2, presentedBuckets: ["a", "b"] },
    rows: resultRows("engineering"),
  });

  assert.throws(
    () =>
      receiptModule.reviewLiveSearchReceipt({
        receipt: draft,
        reviewer: "release-reviewer",
        verifiedAt: "2026-08-27T13:00:00.000Z",
        rowIdentities: draft.rows.slice(1).map((row) => row.identity),
      }),
    /every exact row identity/i
  );
});
