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
    canonicalReadable: true,
    discoveryLane: index === 2 ? "ai-web" : "deterministic",
    unverified: index === 2,
    source: `https://jobs.example.test/${fixtureId}/${index + 1}`,
  }));
}

function completeAiSummary() {
  return {
    searched: 3,
    errors: [],
    failedPromptIds: [],
    queryResults: ["primary", "secondary", "adjacent"].map((promptId) => ({
      promptId,
      status: "completed",
      queries: [{ query: `${promptId} exact jobs`, status: "completed" }],
    })),
  };
}

function runtimeVerification(runtimeId) {
  return {
    path: `/usr/local/bin/${runtimeId}`,
    realPath: `/usr/local/bin/${runtimeId}`,
    version: `${runtimeId} 1.2.3`,
    binaryFingerprint: "c".repeat(64),
    capabilities: {
      completion: true,
      structuredOutput: true,
      appWorkflows: true,
      exactRead: true,
      publicWeb: true,
      liveActivity: true,
      resumable: true,
    },
  };
}

const SUCCEEDED_LANES = { deterministic: "succeeded", aiWeb: "succeeded" };

async function acceptedReceipt(runtimeId, fixtureId) {
  const receiptModule = await loadReceiptModule();
  const receipt = receiptModule.buildLiveSearchReceipt({
    sourceRevision: SOURCE_REVISION,
    runtimeId,
    fixtureId,
    providerFallback: false,
    completedAt: "2026-08-27T12:00:00.000Z",
    runtimeVerification: runtimeVerification(runtimeId),
    laneStatuses: SUCCEEDED_LANES,
    summary: {
      presented: 3,
      fitFloor: 65,
      errors: [],
      failedPromptIds: [],
    },
    expectedPromptIds: ["primary", "secondary", "adjacent"],
    aiSummary: completeAiSummary(),
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

test("four reviewed native AI search receipts pass the release gate", async () => {
  const receiptModule = await loadReceiptModule();
  assert.equal(
    receiptModule.LIVE_SEARCH_ACCEPTANCE,
    receiptModule.NATIVE_AI_SEARCH_ACCEPTANCE,
    "the renamed acceptance contract must preserve its existing export"
  );
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

test("native AI search receipt gate rejects missing, stale, fallback, weak, or unreviewed evidence", async () => {
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

test("native AI search receipts require complete native AI coverage and one canonical AI row", async () => {
  const receiptModule = await loadReceiptModule();
  const build = ({ rows = resultRows("engineering"), aiSummary = completeAiSummary() } = {}) =>
    receiptModule.buildLiveSearchReceipt({
      sourceRevision: SOURCE_REVISION,
      runtimeId: "codex",
      fixtureId: "engineering",
      providerFallback: false,
      completedAt: "2026-08-27T12:00:00.000Z",
      runtimeVerification: runtimeVerification("codex"),
      laneStatuses: SUCCEEDED_LANES,
      summary: { presented: 3, fitFloor: 65, errors: [], failedPromptIds: [] },
      expectedPromptIds: ["primary", "secondary", "adjacent"],
      aiSummary,
      usefulSet: {
        presentedRoleCount: 3,
        presentedBucketCount: 2,
        presentedBuckets: ["primary", "secondary"],
      },
      rows,
    });

  const accepted = build();
  assert.equal(accepted.counts.presentedRows, 3);
  assert.equal(accepted.counts.distinctRoles, 3);
  assert.equal(accepted.counts.presentedBuckets, 2);
  assert.equal(accepted.counts.canonicalAiRows, 1);
  assert.equal(receiptModule.verifyLiveSearchReceiptForReview(accepted), "codex/engineering");

  assert.throws(
    () =>
      receiptModule.verifyLiveSearchReceiptForReview({
        ...accepted,
        lanes: { ...accepted.lanes, deterministic: "failed" },
      }),
    /deterministic lane did not succeed/i
  );
  assert.throws(
    () =>
      receiptModule.verifyLiveSearchReceiptForReview({
        ...accepted,
        lanes: { ...accepted.lanes, aiWeb: "failed" },
      }),
    /AI lane did not succeed/i
  );
  assert.throws(
    () =>
      receiptModule.verifyLiveSearchReceiptForReview({
        ...accepted,
        runtime: { ...accepted.runtime, binaryFingerprint: "bad" },
      }),
    /runtime execution identity/i
  );
  assert.throws(
    () =>
      receiptModule.verifyLiveSearchReceiptForReview({
        ...accepted,
        runtime: {
          ...accepted.runtime,
          capabilities: { ...accepted.runtime.capabilities, exactRead: false },
        },
      }),
    /runtime execution identity/i
  );

  const incompleteCoverage = build({
    aiSummary: {
      ...completeAiSummary(),
      searched: 2,
      queryResults: completeAiSummary().queryResults.slice(0, 2),
    },
  });
  assert.throws(
    () => receiptModule.verifyLiveSearchReceiptForReview(incompleteCoverage),
    /complete AI prompt coverage/i
  );

  const querylessCoverage = build({
    aiSummary: {
      ...completeAiSummary(),
      queryResults: completeAiSummary().queryResults.map((entry, index) =>
        index === 0 ? { ...entry, queries: [] } : entry
      ),
    },
  });
  assert.throws(
    () => receiptModule.verifyLiveSearchReceiptForReview(querylessCoverage),
    /real query coverage/i
  );

  const errored = build({
    aiSummary: { ...completeAiSummary(), errors: ["search failed"] },
  });
  assert.throws(
    () => receiptModule.verifyLiveSearchReceiptForReview(errored),
    /AI search failures/i
  );

  const deterministicOnly = build({
    rows: resultRows("engineering").map((row) => ({
      ...row,
      discoveryLane: "deterministic",
      unverified: false,
    })),
  });
  assert.throws(
    () => receiptModule.verifyLiveSearchReceiptForReview(deterministicOnly),
    /canonical AI contribution/i
  );
});

test("native AI search review must name every exact emitted row identity", async () => {
  const receiptModule = await loadReceiptModule();
  assert.equal(typeof receiptModule.reviewLiveSearchReceipt, "function");
  const draft = receiptModule.buildLiveSearchReceipt({
    sourceRevision: SOURCE_REVISION,
    runtimeId: "codex",
    fixtureId: "engineering",
    providerFallback: false,
    completedAt: "2026-08-27T12:00:00.000Z",
    runtimeVerification: runtimeVerification("codex"),
    laneStatuses: SUCCEEDED_LANES,
    summary: { presented: 3, fitFloor: 65, errors: [], failedPromptIds: [] },
    expectedPromptIds: ["primary", "secondary", "adjacent"],
    aiSummary: completeAiSummary(),
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

test("native AI search receipts count only canonically readable persisted rows", async () => {
  const receiptModule = await loadReceiptModule();
  assert.equal(typeof receiptModule.annotateCanonicalReadableRows, "function");
  const blockedRows = resultRows("hospitality").map((row, index) => ({
    ...row,
    company: `Blocked company ${index + 1}`,
    source: `https://www.indeed.com/viewjob?jk=blocked-${index + 1}`,
  }));
  const readableRows = resultRows("hospitality");
  const rows = receiptModule.annotateCanonicalReadableRows({
    rows: [...blockedRows, ...readableRows],
    sources: [
      ...blockedRows.map((row) => ({ url: row.source, status: "deferred" })),
      ...readableRows.map((row) => ({ url: row.source, status: "completed" })),
    ],
  });

  assert.equal(rows.length, 6, "the diagnostic must retain every persisted row");
  assert.deepEqual(
    rows.map((row) => row.canonicalReadable),
    [false, false, false, true, true, true]
  );

  const receipt = receiptModule.buildLiveSearchReceipt({
    sourceRevision: SOURCE_REVISION,
    runtimeId: "codex",
    fixtureId: "hospitality",
    providerFallback: false,
    completedAt: "2026-08-27T12:00:00.000Z",
    runtimeVerification: runtimeVerification("codex"),
    laneStatuses: SUCCEEDED_LANES,
    summary: { presented: 3, fitFloor: 65, errors: [], failedPromptIds: [] },
    expectedPromptIds: ["primary", "secondary", "adjacent"],
    aiSummary: completeAiSummary(),
    usefulSet: {
      presentedRoleCount: 3,
      presentedBucketCount: 2,
      presentedBuckets: ["primary", "secondary"],
    },
    rows,
  });

  assert.equal(receipt.counts.presentedRows, 3);
  assert.equal(receipt.rows.length, 3);
  assert.ok(receipt.rows.every((row) => row.canonicalReadable === true));
  assert.ok(receipt.rows.every((row) => row.source.includes("jobs.example.test")));
  assert.equal(receipt.rows.filter((row) => row.discoveryLane === "ai-web").length, 1);
  assert.ok(
    receipt.rows.filter((row) => row.discoveryLane === "ai-web").every((row) => row.unverified)
  );
  assert.equal(receiptModule.verifyLiveSearchReceiptForReview(receipt), "codex/hospitality");
  assert.equal(receipt.manualLiveness.verified, false);
});

test("combined canonical receipts accept only exact active full-body deterministic output", async () => {
  const receiptModule = await loadReceiptModule();
  assert.equal(typeof receiptModule.canonicalSourcesFromUnifiedSearch, "function");

  const sources = receiptModule.canonicalSourcesFromUnifiedSearch({
    deterministicResult: {
      sourceCoverage: [{ host: "jobs.example.test", status: "success", found: 3 }],
      offers: [
        {
          url: "https://jobs.example.test/company/active-full",
          bodyChars: 1200,
          bodyPartial: false,
          liveness: { result: "active" },
        },
        {
          url: "https://jobs.example.test/company/partial",
          bodyChars: 200,
          bodyPartial: true,
          liveness: { result: "active" },
        },
        {
          url: "https://jobs.example.test/company/uncertain",
          bodyChars: 1200,
          bodyPartial: false,
          liveness: { result: "uncertain" },
        },
      ],
    },
    aiResult: {
      offers: [{ url: "https://careers.example.test/company/ai-role" }],
      sources: [
        {
          url: "https://careers.example.test/company/ai-role",
          status: "completed",
        },
        {
          url: "https://careers.example.test/company/rejected-ai-role",
          status: "completed",
        },
      ],
    },
  });

  assert.deepEqual(sources, [
    {
      url: "https://jobs.example.test/company/active-full",
      status: "completed",
      discoveryLane: "deterministic",
    },
    {
      url: "https://careers.example.test/company/ai-role",
      status: "completed",
      discoveryLane: "ai-web",
    },
  ]);
  assert.deepEqual(
    receiptModule
      .annotateCanonicalReadableRows({
        rows: [
          {
            source: "https://careers.example.test/company/ai-role",
            discoveryLane: "deterministic",
          },
          {
            source: "https://careers.example.test/company/ai-role",
            discoveryLane: "ai-web",
          },
        ],
        sources,
      })
      .map((row) => row.canonicalReadable),
    [false, true]
  );
});

test("deferred-only native AI search evidence cannot become review-ready", async () => {
  const receiptModule = await loadReceiptModule();
  const rows = resultRows("engineering").map((row) => ({
    ...row,
    canonicalReadable: false,
  }));
  const receipt = receiptModule.buildLiveSearchReceipt({
    sourceRevision: SOURCE_REVISION,
    runtimeId: "codex",
    fixtureId: "engineering",
    providerFallback: false,
    completedAt: "2026-08-27T12:00:00.000Z",
    runtimeVerification: runtimeVerification("codex"),
    laneStatuses: SUCCEEDED_LANES,
    summary: { presented: 0, fitFloor: 65, errors: [], failedPromptIds: [] },
    expectedPromptIds: ["primary", "secondary", "adjacent"],
    aiSummary: completeAiSummary(),
    usefulSet: { presentedRoleCount: 0, presentedBucketCount: 0, presentedBuckets: [] },
    rows,
  });

  assert.equal(receipt.rows.length, 0);
  assert.throws(
    () => receiptModule.verifyLiveSearchReceiptForReview(receipt),
    /too few presented rows/i
  );
  assert.equal(receipt.manualLiveness.verified, false);
});
