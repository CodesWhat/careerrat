import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { candidateSetupInitialize } from "../src/core/db/verbs.mjs";

const cleanupRoots = [];
const NOW = new Date("2026-07-06T12:00:00.000Z");

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-public-review-"));
  cleanupRoots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

async function publicIntelVerbs() {
  return import("../src/core/db/verbs/public-intel.mjs");
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review queue lists only ambiguous or conflicting public-intel items", async () => {
  const repoRoot = tempRepo();
  const { publicIntelReviewItemUpsert, publicIntelReviewList } = await publicIntelVerbs();

  publicIntelReviewItemUpsert({
    repoRoot,
    item: {
      id: "review-ambiguous",
      status: "pending",
      reason: "ambiguous_public_page",
      companyKey: "ambiguous-co",
      companyName: "Ambiguous Co",
      candidates: [
        { url: "https://boards.example/ambiguous", providerHint: "custom", confidence: "low" },
        { url: "https://jobs.example/ambiguous", providerHint: "custom", confidence: "low" },
      ],
      version: 1,
    },
    now: NOW,
  });
  publicIntelReviewItemUpsert({
    repoRoot,
    item: {
      id: "review-conflict",
      status: "pending",
      reason: "provider_conflict",
      companyKey: "conflict-co",
      currentProvider: "greenhouse",
      proposedProvider: "lever",
      version: 1,
    },
    now: NOW,
  });
  publicIntelReviewItemUpsert({
    repoRoot,
    item: {
      id: "clean-no-result",
      status: "metadata_only",
      reason: "clean_no_result",
      companyKey: "quiet-co",
      version: 1,
    },
    now: NOW,
  });

  const list = publicIntelReviewList({ repoRoot, status: "pending" });
  assert.equal(list.ok, true);
  assert.deepEqual(
    list.items.map((item) => item.id),
    ["review-ambiguous", "review-conflict"]
  );
});

test("review decisions enforce expected version and supported ATS separation", async () => {
  const repoRoot = tempRepo();
  const {
    publicBoardIntelUpsert,
    publicIntelReviewDecision,
    publicIntelReviewItemUpsert,
    publicIntelReviewList,
  } = await publicIntelVerbs();
  let companyAtsWrites = 0;

  publicIntelReviewItemUpsert({
    repoRoot,
    item: {
      id: "review-1",
      status: "pending",
      reason: "ambiguous_public_page",
      companyKey: "custom-co",
      companyName: "Custom Co",
      proposedBoardUrl: "https://custom.example/jobs",
      proposedProvider: "custom",
      version: 3,
    },
    now: NOW,
  });

  assert.throws(
    () =>
      publicIntelReviewDecision({
        repoRoot,
        itemId: "review-1",
        expectedVersion: 2,
        action: "keep-public-metadata",
        now: NOW,
      }),
    (err) => err?.code === "CONFLICT"
  );

  const kept = publicIntelReviewDecision({
    repoRoot,
    itemId: "review-1",
    expectedVersion: 3,
    action: "keep-public-metadata",
    companyAtsUpsertImpl: async () => {
      companyAtsWrites += 1;
    },
    now: NOW,
  });
  assert.equal(kept.ok, true);
  assert.equal(kept.item.status, "resolved");
  assert.equal(kept.item.decision.action, "keep-public-metadata");
  assert.equal(companyAtsWrites, 0, "custom public metadata must not write private source config");

  publicBoardIntelUpsert({
    repoRoot,
    record: {
      id: "board-supported",
      companyKey: "supported-co",
      boardUrl: "https://jobs.lever.co/supported",
      atsProvider: "lever",
      sourceKind: "supported_ats",
      confidence: "high",
      provenance: [{ source: "resolver", url: "https://jobs.lever.co/supported" }],
    },
    now: NOW,
  });
  publicIntelReviewItemUpsert({
    repoRoot,
    item: {
      id: "review-supported",
      status: "pending",
      reason: "provider_conflict",
      companyKey: "supported-co",
      proposedBoardId: "board-supported",
      proposedProvider: "lever",
      version: 1,
    },
    now: NOW,
  });

  const approved = publicIntelReviewDecision({
    repoRoot,
    itemId: "review-supported",
    expectedVersion: 1,
    action: "use-supported-ats",
    companyAtsUpsertImpl: async (entry) => {
      companyAtsWrites += 1;
      assert.equal(entry.atsProvider, "lever");
      assert.equal(entry.jobBoardUrl, "https://jobs.lever.co/supported");
    },
    now: NOW,
  });
  assert.equal(approved.ok, true);
  assert.equal(companyAtsWrites, 1);

  assert.equal(publicIntelReviewList({ repoRoot, status: "pending" }).items.length, 0);
});

test("review UI action labels stay stable for the scanner review panel", async () => {
  const { PUBLIC_INTEL_REVIEW_ACTIONS } = await publicIntelVerbs();
  assert.deepEqual(
    PUBLIC_INTEL_REVIEW_ACTIONS.map((action) => action.label),
    [
      "Use supported ATS",
      "Keep public metadata",
      "Refresh scan",
      "Suppress review",
      "Escalate to agent",
    ]
  );
});
