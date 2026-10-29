import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { executeWorkspaceIntent } from "../src/core/agent/workspace-agent.mjs";
import { WORKSPACE_THREAD_ID, workspaceThreadRead } from "../src/core/agent/workspace-thread.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  candidateConfigGet,
  candidateEvidenceMerge,
  candidateSetupInitialize,
  deepIngestConfirmedForGeneration,
  deepIngestConfirmProposal,
  deepIngestProposalPut,
  deepIngestSourceCreate,
  deepIngestStateGet,
} from "../src/core/db/verbs.mjs";
import { autoApplyDeepIngestProposals } from "../src/core/deep-ingest/auto-apply.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-deep-ingest-auto-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TEXT = "Built the review queue. Led the migration. Cut triage time by half.";

let chunkCounter = 0;

function seedProposal(repoRoot, { lane, items, text = TEXT }) {
  chunkCounter += 1;
  const chunkId = `chunk-${lane}-${chunkCounter}`;
  const source = deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "auto",
      sourceKind: "paste",
      text,
      chunks: [{ id: chunkId, text }],
    },
  }).source;
  return deepIngestProposalPut({
    repoRoot,
    sourceId: source.id,
    targetShape: "auto",
    lane,
    proposal: {
      items: items.map((item) => ({ sourceId: source.id, chunkId, ...item })),
    },
  });
}

function messages(repoRoot) {
  return workspaceThreadRead({ repoRoot, env: {} }).messages.filter(
    (message) => message.metadata?.writer === "deep_ingest.auto"
  );
}

function undo(repoRoot, message, index) {
  return executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "knowledge.revert",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { messageId: message.id, index },
    },
  });
}

function stored(repoRoot, proposal) {
  return deepIngestStateGet({ repoRoot }).proposals.find((row) => row.id === proposal.id);
}

test("a grounded evidence proposal saves on its own, logs one entry with an Undo, and Undo removes the claim", async () => {
  const repoRoot = tempRepo();
  const proposal = seedProposal(repoRoot, {
    lane: "evidence_claims",
    items: [
      {
        id: "auto-claim",
        claim: "Built the review queue.",
        evidence: "Built the review queue.",
        supportingQuote: "Built the review queue.",
      },
    ],
  });
  const before = candidateConfigGet({ repoRoot }).evidence.claims.length;
  const result = autoApplyDeepIngestProposals({ repoRoot, proposals: [proposal] });

  assert.equal(result.applied.length, 1);
  assert.equal(result.proposals[0].status, "confirmed");
  assert.equal(result.proposals[0].decisionSource, "automatic");
  const claims = candidateConfigGet({ repoRoot }).evidence.claims;
  assert.equal(claims.length, before + 1);
  assert.ok(claims.some((claim) => claim.id === "auto-claim"));
  // The review list checks auto-saved evidence against the saved claim ids.
  assert.ok(deepIngestStateGet({ repoRoot }).confirmed.evidenceClaimIds.includes("auto-claim"));

  const [message] = messages(repoRoot);
  assert.equal(message.kind, "action_result");
  assert.equal(message.artifacts.length, 1);
  assert.equal(message.artifacts[0].kind, "knowledge_write");
  assert.equal(message.artifacts[0].target, "evidence");
  assert.equal(message.artifacts[0].op, "add");
  assert.equal(message.artifacts[0].id, "auto-claim");
  assert.equal(message.metadata.nextActions.length, 1);
  assert.equal(message.metadata.nextActions[0].intent.type, "knowledge.revert");

  await undo(repoRoot, message, 0);
  assert.equal(candidateConfigGet({ repoRoot }).evidence.claims.length, before);
  assert.ok(!deepIngestStateGet({ repoRoot }).confirmed.evidenceClaimIds.includes("auto-claim"));
});

test("a grounded story proposal saves as a lane row and Undo removes that row", async () => {
  const repoRoot = tempRepo();
  const proposal = seedProposal(repoRoot, {
    lane: "story_bank",
    items: [
      {
        id: "auto-story",
        title: "Led the migration",
        summary: "Led the migration.",
        supportingQuote: "Led the migration.",
      },
    ],
  });
  const result = autoApplyDeepIngestProposals({ repoRoot, proposals: [proposal] });
  assert.equal(result.applied.length, 1);
  assert.equal(deepIngestStateGet({ repoRoot }).confirmed.storyBank.length, 1);

  const [message] = messages(repoRoot);
  assert.equal(message.artifacts[0].target, "deep_ingest:story_bank");
  assert.equal(message.artifacts[0].op, "add");
  assert.equal(message.artifacts[0].id, "auto-story");

  await undo(repoRoot, message, 0);
  assert.equal(deepIngestStateGet({ repoRoot }).confirmed.storyBank.length, 0);
});

test("a placeholder claim is refused by the evidence firewall and stays in review", () => {
  const repoRoot = tempRepo();
  const proposal = seedProposal(repoRoot, {
    lane: "evidence_claims",
    items: [
      {
        id: "auto-placeholder",
        claim: "Led the [Company] migration.",
        evidence: "Led the migration.",
        supportingQuote: "Led the migration.",
      },
    ],
  });
  const before = candidateConfigGet({ repoRoot }).evidence.claims.length;
  const result = autoApplyDeepIngestProposals({ repoRoot, proposals: [proposal] });

  assert.equal(result.applied.length, 0);
  assert.equal(result.held.length, 1);
  const row = stored(repoRoot, proposal);
  assert.equal(row.status, "review_needed");
  assert.equal(row.autoApply.status, "held");
  assert.match(row.autoApply.reasons.join(" "), /evidence check refused/i);
  assert.equal(candidateConfigGet({ repoRoot }).evidence.claims.length, before);
  assert.equal(messages(repoRoot).length, 0);
});

test("a different claim already saved under the same id stays in review and the original is untouched", () => {
  const repoRoot = tempRepo();
  candidateEvidenceMerge({
    repoRoot,
    claims: [{ id: "same-id", claim: "Shipped the first version.", evidence: "Original proof." }],
  });
  const proposal = seedProposal(repoRoot, {
    lane: "evidence_claims",
    items: [
      {
        id: "same-id",
        claim: "Built the review queue.",
        evidence: "Built the review queue.",
        supportingQuote: "Built the review queue.",
      },
    ],
  });
  const result = autoApplyDeepIngestProposals({ repoRoot, proposals: [proposal] });
  assert.equal(result.applied.length, 0);
  assert.match(stored(repoRoot, proposal).autoApply.reasons.join(" "), /different claim/i);
  const saved = candidateConfigGet({ repoRoot }).evidence.claims.find(
    (claim) => claim.id === "same-id"
  );
  assert.equal(saved.claim, "Shipped the first version.");
  assert.equal(saved.evidence, "Original proof.");
});

test("an identical claim already saved is skipped with no new entry", () => {
  const repoRoot = tempRepo();
  candidateEvidenceMerge({
    repoRoot,
    claims: [
      { id: "same-id", claim: "Built the review queue.", evidence: "Built the review queue." },
    ],
  });
  const proposal = seedProposal(repoRoot, {
    lane: "evidence_claims",
    items: [
      {
        id: "same-id",
        claim: "Built the review queue.",
        evidence: "Built the review queue.",
        supportingQuote: "Built the review queue.",
      },
    ],
  });
  const result = autoApplyDeepIngestProposals({ repoRoot, proposals: [proposal] });
  assert.equal(result.applied.length, 1);
  assert.equal(messages(repoRoot).length, 0);
});

test("adding an honesty boundary saves, but removing or relaxing one waits for review", () => {
  const repoRoot = tempRepo();
  const add = seedProposal(repoRoot, {
    lane: "honesty_boundaries",
    items: [
      {
        id: "boundary-add",
        title: "No claim of managing people",
        summary: "Do not claim to manage people.",
        supportingQuote: "Led the migration.",
      },
    ],
  });
  const remove = seedProposal(repoRoot, {
    lane: "honesty_boundaries",
    items: [
      {
        id: "boundary-remove",
        title: "Drop the people-management boundary",
        summary: "Stop holding back on people management.",
        action: "remove",
        supportingQuote: "Led the migration.",
      },
    ],
  });
  const result = autoApplyDeepIngestProposals({ repoRoot, proposals: [add, remove] });
  assert.equal(result.applied.length, 1);
  assert.equal(result.held.length, 1);
  assert.equal(stored(repoRoot, remove).status, "review_needed");
  assert.match(stored(repoRoot, remove).autoApply.reasons.join(" "), /honesty boundaries/i);
  const rows = deepIngestStateGet({ repoRoot }).confirmed.honestyBoundaries;
  assert.deepEqual(
    rows.map((row) => row.id),
    ["boundary-add"]
  );
});

test("a role signal that carries a pay floor waits for review", () => {
  const repoRoot = tempRepo();
  const proposal = seedProposal(repoRoot, {
    lane: "role_signals",
    items: [
      {
        id: "signal-floor",
        title: "Pay floor",
        summary: "Lower the floor.",
        minimum_base: 90000,
        supportingQuote: "Led the migration.",
      },
    ],
  });
  const result = autoApplyDeepIngestProposals({ repoRoot, proposals: [proposal] });
  assert.equal(result.applied.length, 0);
  assert.equal(stored(repoRoot, proposal).status, "review_needed");
  assert.equal(deepIngestStateGet({ repoRoot }).confirmed.roleSignals.length, 0);
});

test("an ungrounded proposal stays out of trusted state and in review", () => {
  const repoRoot = tempRepo();
  const proposal = seedProposal(repoRoot, {
    lane: "evidence_claims",
    items: [
      {
        id: "auto-ungrounded",
        claim: "Won an industry award.",
        evidence: "Won an industry award.",
        supportingQuote: "Won an industry award.",
      },
    ],
  });
  const before = candidateConfigGet({ repoRoot }).evidence.claims.length;
  const result = autoApplyDeepIngestProposals({ repoRoot, proposals: [proposal] });
  assert.equal(result.applied.length, 0);
  assert.equal(stored(repoRoot, proposal).status, "review_needed");
  assert.match(stored(repoRoot, proposal).autoApply.reasons.join(" "), /supporting quote/i);
  assert.equal(candidateConfigGet({ repoRoot }).evidence.claims.length, before);
  assert.equal(messages(repoRoot).length, 0);
});

test("an open question proposal is never saved on its own", () => {
  const repoRoot = tempRepo();
  const proposal = seedProposal(repoRoot, {
    lane: "open_gaps",
    items: [{ id: "gap-1", reason: "Which team did you lead?" }],
  });
  const result = autoApplyDeepIngestProposals({ repoRoot, proposals: [proposal] });
  assert.equal(result.applied.length, 0);
  assert.equal(stored(repoRoot, proposal).status, "review_needed");
});

// A builder row as the real pipeline stores it: content under `payload`, status
// review_needed, the quote and chunk on the row itself.
function seedBuilderProposal(repoRoot, { lane, payload, id, text = TEXT }) {
  chunkCounter += 1;
  const chunkId = `chunk-${lane}-${chunkCounter}`;
  const source = deepIngestSourceCreate({
    repoRoot,
    input: { targetShape: "auto", sourceKind: "paste", text, chunks: [{ id: chunkId, text }] },
  }).source;
  return deepIngestProposalPut({
    repoRoot,
    sourceId: source.id,
    targetShape: "auto",
    lane,
    proposal: {
      id,
      lane,
      sourceId: source.id,
      chunkId,
      status: "review_needed",
      confidence: 0.9,
      payload,
      validation: { status: "passed", blockedReasons: [] },
      supportingQuote: "Led the migration.",
    },
  });
}

test("auto-saved builder rows are flat, confirmed, and visible to generation in every lane", () => {
  const repoRoot = tempRepo();
  const rows = [
    {
      lane: "story_bank",
      id: "b-story",
      payload: { title: "Led the migration", situation: "A legacy stack.", summary: "Led it." },
    },
    {
      lane: "writing_voice",
      id: "b-voice",
      payload: { title: "Plain voice", summary: "Short sentences.", doPhrases: ["I led"] },
    },
    {
      lane: "honesty_boundaries",
      id: "b-honesty",
      payload: {
        title: "No people management",
        boundaryType: "do_not_claim",
        text: "Do not claim to manage people.",
        summary: "Do not claim to manage people.",
      },
    },
    {
      lane: "role_signals",
      id: "b-signal",
      payload: {
        title: "Platform work",
        roleFamily: "platform",
        text: "Wants platform roles.",
        summary: "Wants platform roles.",
      },
    },
  ];
  const proposals = rows.map((row) => seedBuilderProposal(repoRoot, row));
  const result = autoApplyDeepIngestProposals({ repoRoot, proposals });
  assert.equal(result.applied.length, 4);

  const generation = deepIngestConfirmedForGeneration({ repoRoot });
  assert.equal(generation.storyBank[0].id, "b-story");
  assert.equal(generation.storyBank[0].situation, "A legacy stack.");
  assert.equal(generation.writingVoice[0].id, "b-voice");
  assert.deepEqual(generation.writingVoice[0].doPhrases, ["I led"]);
  assert.equal(generation.honestyBoundaries[0].id, "b-honesty");
  assert.equal(generation.honestyBoundaries[0].text, "Do not claim to manage people.");
  assert.equal(generation.roleSignals[0].id, "b-signal");
  assert.equal(generation.roleSignals[0].text, "Wants platform roles.");

  const confirmed = deepIngestStateGet({ repoRoot }).confirmed;
  for (const row of [
    ...confirmed.storyBank,
    ...confirmed.writingVoice,
    ...confirmed.honestyBoundaries,
    ...confirmed.roleSignals,
  ]) {
    assert.equal(row.status, "confirmed");
    assert.equal(row.payload, undefined);
  }
});

test("a confirm that loses the version race saves no evidence claims", () => {
  const repoRoot = tempRepo();
  const proposal = seedProposal(repoRoot, {
    lane: "evidence_claims",
    items: [
      {
        id: "race-claim",
        claim: "Built the review queue.",
        evidence: "Built the review queue.",
        supportingQuote: "Built the review queue.",
      },
    ],
  });
  const before = candidateConfigGet({ repoRoot }).evidence.claims.length;
  assert.throws(
    () =>
      deepIngestConfirmProposal({
        repoRoot,
        proposalId: proposal.id,
        expectedVersion: proposal.version + 1,
      }),
    { code: "VERSION_CONFLICT" }
  );
  assert.equal(candidateConfigGet({ repoRoot }).evidence.claims.length, before);
  assert.equal(stored(repoRoot, proposal).status, "review_needed");
});

test("evidence claims commit with the proposal write: a failure after the merge leaves none saved", () => {
  const repoRoot = tempRepo();
  const proposal = seedProposal(repoRoot, {
    lane: "evidence_claims",
    items: [
      {
        id: "atomic-claim",
        claim: "Built the review queue.",
        evidence: "Built the review queue.",
        supportingQuote: "Built the review queue.",
      },
    ],
  });
  const before = candidateConfigGet({ repoRoot }).evidence.claims.length;
  const db = openDb({ repoRoot });
  db.exec(`CREATE TEMP TRIGGER fail_proposal_write BEFORE UPDATE ON deep_ingest_proposals
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
  try {
    assert.throws(() =>
      deepIngestConfirmProposal({
        repoRoot,
        proposalId: proposal.id,
        expectedVersion: proposal.version,
      })
    );
  } finally {
    db.exec("DROP TRIGGER fail_proposal_write");
  }
  assert.equal(candidateConfigGet({ repoRoot }).evidence.claims.length, before);
  assert.equal(stored(repoRoot, proposal).status, "review_needed");
});

test("role signals hold on a nested pay field and on a string amount", () => {
  const repoRoot = tempRepo();
  const nested = seedProposal(repoRoot, {
    lane: "role_signals",
    items: [
      {
        id: "signal-nested",
        title: "Pay",
        summary: "Wants more.",
        details: { ranges: [{ baseSalary: 120000 }] },
        supportingQuote: "Led the migration.",
      },
    ],
  });
  const text = seedProposal(repoRoot, {
    lane: "role_signals",
    items: [
      {
        id: "signal-text",
        title: "Pay",
        summary: "Wants more.",
        target_comp: "$150,000",
        supportingQuote: "Led the migration.",
      },
    ],
  });
  const plain = seedProposal(repoRoot, {
    lane: "role_signals",
    items: [
      {
        id: "signal-plain",
        title: "Platform work",
        summary: "Wants platform roles.",
        confidence: 0.8,
        supportingQuote: "Led the migration.",
      },
    ],
  });
  const result = autoApplyDeepIngestProposals({ repoRoot, proposals: [nested, text, plain] });
  assert.equal(result.held.length, 2);
  assert.equal(result.applied.length, 1);
  assert.match(stored(repoRoot, nested).autoApply.reasons.join(" "), /pay floor or target/);
  assert.match(stored(repoRoot, text).autoApply.reasons.join(" "), /pay floor or target/);
});

test("honesty items with an explicit loosening transition are held", () => {
  const repoRoot = tempRepo();
  const loosen = (id, from, to) =>
    seedProposal(repoRoot, {
      lane: "honesty_boundaries",
      items: [
        {
          id,
          title: "Boundary change",
          summary: "A boundary moves.",
          from,
          to,
          supportingQuote: "Led the migration.",
        },
      ],
    });
  const toConfirmed = loosen("h-1", "do-not-claim", "confirmed");
  const underscored = loosen("h-2", "do_not_claim", "confirmed");
  const adjacent = loosen("h-3", "adjacent", "confirmed");
  const removed = loosen("h-4", "confirmed", "removed");
  const tightened = loosen("h-5", "confirmed", "do_not_claim");
  const result = autoApplyDeepIngestProposals({
    repoRoot,
    proposals: [toConfirmed, underscored, adjacent, removed, tightened],
  });
  assert.equal(result.held.length, 4);
  assert.deepEqual(
    result.applied.map((row) => row.id),
    [tightened.id]
  );
});

test("a partly saved evidence proposal logs one entry with one Undo and keeps the refused claim in review", async () => {
  const repoRoot = tempRepo();
  const proposal = seedProposal(repoRoot, {
    lane: "evidence_claims",
    items: [
      {
        id: "part-good",
        claim: "Built the review queue.",
        evidence: "Built the review queue.",
        supportingQuote: "Built the review queue.",
      },
      {
        id: "part-bad",
        claim: "Led the [Company] migration.",
        evidence: "Led the migration.",
        supportingQuote: "Led the migration.",
      },
    ],
  });
  const before = candidateConfigGet({ repoRoot }).evidence.claims.length;
  const result = autoApplyDeepIngestProposals({ repoRoot, proposals: [proposal] });

  assert.equal(result.applied.length, 0);
  assert.equal(result.held.length, 1);
  assert.equal(stored(repoRoot, proposal).status, "review_needed");
  assert.equal(candidateConfigGet({ repoRoot }).evidence.claims.length, before + 1);

  const logged = messages(repoRoot);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].artifacts.length, 1);
  assert.equal(logged[0].artifacts[0].id, "part-good");
  assert.equal(logged[0].metadata.nextActions.length, 1);

  await undo(repoRoot, logged[0], 0);
  assert.equal(candidateConfigGet({ repoRoot }).evidence.claims.length, before);
});
