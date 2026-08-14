// Phase 08 Wave 0 RED contracts for the SQLite-native Deep ingest lane.
// These tests intentionally fail until the 008 migration and deep-ingest DB
// verbs exist. They define the DB/readiness boundary for later implementation.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { ALL_MIGRATIONS } from "../src/core/db/migrations.mjs";
import {
  candidateArtifactPut,
  candidateConfigGet,
  candidateConfigPatch,
  candidateEvidenceMerge,
  candidateSetupInitialize,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];

const REQUIRED_LANES = [
  "source_coverage",
  "evidence_claims",
  "story_bank",
  "honesty_boundaries",
  "writing_voice",
  "role_signals",
  "open_gaps",
];

const VALID_LANE_STATUSES = [
  "not_started",
  "needs_source",
  "scanning",
  "review_needed",
  "gap",
  "completed",
  "deferred",
  "not_available",
  "failed",
];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-deep-ingest-db-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

async function loadDeepIngestVerbs() {
  return import("../src/core/db/verbs/deep-ingest.mjs");
}

async function seedConfirmedReferenceItems(repoRoot) {
  const { deepIngestConfirmProposal, deepIngestProposalPut, deepIngestSourceCreate } =
    await loadDeepIngestVerbs();
  const source = deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "story",
      sourceKind: "paste",
      text: "Led a rollout that cut review time by 30%.",
      chunks: [
        { id: "chunk-confirmed-edit-1", text: "Led a rollout that cut review time by 30%." },
      ],
    },
  }).source;
  const fixtures = [
    {
      lane: "story_bank",
      id: "story-edit-1",
      item: {
        id: "story-edit-1",
        title: "Review workflow rollout",
        situation: "Manual review queue",
        result: "Cut review time by 30%",
      },
    },
    {
      lane: "story_bank",
      id: "story-keep-2",
      item: {
        id: "story-keep-2",
        title: "Second rollout story",
        situation: "A second manual queue",
        result: "Kept the second row intact",
      },
    },
    {
      lane: "honesty_boundaries",
      id: "honesty-edit-1",
      item: {
        id: "honesty-edit-1",
        boundaryType: "do_not_claim",
        text: "Do not claim ML training.",
      },
    },
    {
      lane: "writing_voice",
      id: "voice-edit-1",
      item: {
        id: "voice-edit-1",
        voiceStatus: "confirmed",
        summary: "Direct, concrete, technical.",
      },
    },
    {
      lane: "role_signals",
      id: "signal-edit-1",
      item: {
        id: "signal-edit-1",
        roleFamily: "applied-ai",
        signalType: "keep",
        text: "Agent workflow builder",
      },
    },
  ];

  for (const fixture of fixtures) {
    const item = {
      ...fixture.item,
      sourceId: source.id,
      chunkId: "chunk-confirmed-edit-1",
      supportingQuote: "Led a rollout that cut review time by 30%",
    };
    const proposal = deepIngestProposalPut({
      repoRoot,
      sourceId: source.id,
      targetShape: "story",
      lane: fixture.lane,
      proposal: {
        items: [{ ...item, validation: { status: "passed", blockedReasons: [] } }],
      },
    });
    deepIngestConfirmProposal({
      repoRoot,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      edits: { items: [item] },
    });
  }

  return fixtures;
}

function tableSql(db, name) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
    ?.sql;
}

function columnByName(db, table) {
  return new Map(
    db
      .prepare(`PRAGMA table_xinfo('${table}')`)
      .all()
      .map((row) => [row.name, row])
  );
}

function assertJsonTableWithGeneratedColumns(db, table, columns) {
  const sql = tableSql(db, table);
  assert.ok(sql, `expected ${table} table to exist`);
  assert.match(sql, /data\s+TEXT\s+NOT NULL\s+CHECK\s*\(\s*json_valid\(data\)\s*\)/i);

  const byName = columnByName(db, table);
  for (const name of columns) {
    assert.ok(byName.has(name), `expected generated column ${table}.${name}`);
    assert.notEqual(byName.get(name).hidden, 0, `${table}.${name} must be generated`);
  }
}

function seedSearchReadyCandidate(repoRoot) {
  candidateSetupInitialize({ repoRoot });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: { full_name: "Ada Lovelace", email: "ada@example.com" },
      location: { home: "New York, NY", remote: true },
      compensation: { minimum_base: 190000 },
      authorization: { work_authorized: true, requires_sponsorship: false },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Applied AI", titles: ["Applied AI Engineer"] }],
      keep_signals: ["agent workflow builder"],
    },
  });
  candidateArtifactPut({
    repoRoot,
    id: "source-resume",
    kind: "source-resume",
    data: { path: "workspace/intake/source-resume.md" },
  });
  candidateEvidenceMerge({
    repoRoot,
    claims: [{ claim: "Built an agentic intake workflow", evidence: "Resume" }],
  });
}

test("migration 008 creates Deep ingest JSON tables with generated query columns", () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });

  assert.equal(db.prepare("PRAGMA user_version").get().user_version, ALL_MIGRATIONS.at(-1).id);
  const logged = db.prepare("SELECT id, name FROM _migrations WHERE id = 8").get();
  assert.deepEqual([logged?.id, logged?.name], [8, "deep-ingest"]);

  assertJsonTableWithGeneratedColumns(db, "deep_ingest_sources", [
    "target_shape",
    "status",
    "source_kind",
    "updated_at",
  ]);
  assertJsonTableWithGeneratedColumns(db, "deep_ingest_source_chunks", [
    "source_id",
    "chunk_kind",
    "updated_at",
  ]);
  assertJsonTableWithGeneratedColumns(db, "deep_ingest_proposals", [
    "source_id",
    "target_shape",
    "status",
    "lane",
    "updated_at",
  ]);
  assertJsonTableWithGeneratedColumns(db, "deep_ingest_lane_states", [
    "lane",
    "status",
    "updated_at",
  ]);
  assertJsonTableWithGeneratedColumns(db, "deep_ingest_story_bank", ["story_status", "updated_at"]);
  assertJsonTableWithGeneratedColumns(db, "deep_ingest_writing_voice", [
    "voice_status",
    "updated_at",
  ]);
  assertJsonTableWithGeneratedColumns(db, "deep_ingest_honesty_boundaries", [
    "boundary_type",
    "updated_at",
  ]);
  assertJsonTableWithGeneratedColumns(db, "deep_ingest_role_signals", [
    "role_family",
    "signal_type",
    "updated_at",
  ]);

  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_deep_ingest_%'"
    )
    .all()
    .map((row) => row.name);
  assert.ok(indexes.includes("idx_deep_ingest_sources_status"));
  assert.ok(indexes.includes("idx_deep_ingest_sources_updated_at"));
  assert.ok(indexes.includes("idx_deep_ingest_proposals_status_lane"));
  assert.ok(indexes.includes("idx_deep_ingest_proposals_updated_at"));
  assert.ok(indexes.includes("idx_deep_ingest_lane_states_lane_status"));
  assert.ok(indexes.includes("idx_deep_ingest_lane_states_updated_at"));

  const laneSql = tableSql(db, "deep_ingest_lane_states") || "";
  for (const status of VALID_LANE_STATUSES) {
    assert.match(laneSql, new RegExp(`'${status}'`), `expected lane status ${status} in schema`);
  }
});

test("source and proposal verbs persist reviewable state without requiring candidate compatibility files", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  seedSearchReadyCandidate(repoRoot);
  const {
    deepIngestProposalPut,
    deepIngestSourceCreate,
    deepIngestSourceList,
    deepIngestStateGet,
  } = await loadDeepIngestVerbs();

  const created = deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "evidence",
      sourceKind: "paste",
      label: "Project note",
      text: "Built a bounded extraction workflow with source-grounded evidence.",
    },
  });
  assert.equal(created.source.targetShape, "evidence");
  assert.equal(created.source.status, "proposal_ready");
  assert.equal(created.outcome.status, "proposal_ready");

  const proposal = deepIngestProposalPut({
    repoRoot,
    sourceId: created.source.id,
    targetShape: "evidence",
    lane: "evidence_claims",
    proposal: {
      items: [
        {
          claim: "Built a bounded extraction workflow.",
          sourceId: created.source.id,
          supportingQuote: "Built a bounded extraction workflow",
          confidence: "high",
        },
      ],
      validation: { status: "grounded" },
    },
  });
  assert.equal(proposal.status, "review_needed");
  assert.equal(proposal.version, 1);

  const sources = deepIngestSourceList({ repoRoot });
  assert.deepEqual(
    sources.map((source) => [source.id, source.status, source.targetShape]),
    [[created.source.id, "proposal_ready", "evidence"]]
  );

  const state = deepIngestStateGet({ repoRoot });
  assert.equal(state.sources.length, 1);
  assert.equal(state.proposals.length, 1);
  assert.equal(state.proposals[0].sourceId, created.source.id);
  assert.equal(state.laneStates.source_coverage.status, "review_needed");
  assert.equal(state.laneStates.open_gaps.status, "not_started");

  assert.equal(existsSync(userPath({ repoRoot }, "candidate/profile.yml")), false);
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/evidence.yml")), false);
});

test("adding more Deep ingest material reopens completed coverage and gap review", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const { deepIngestLaneSetState, deepIngestSourceCreate, deepIngestStateGet } =
    await loadDeepIngestVerbs();
  deepIngestLaneSetState({ repoRoot, lane: "source_coverage", status: "completed" });
  deepIngestLaneSetState({ repoRoot, lane: "open_gaps", status: "completed" });

  deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "auto",
      sourceKind: "paste",
      text: "New material that still needs proposal and gap review.",
    },
  });

  const state = deepIngestStateGet({ repoRoot });
  assert.equal(state.laneStates.source_coverage.status, "review_needed");
  assert.equal(state.laneStates.open_gaps.status, "not_started");
  assert.equal(state.readiness.ready, false);
});

test("ISSUE-015: removing an undrafted source cascades its scan stub but protects drafted work", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const {
    deepIngestProposalPut,
    deepIngestSourceCreate,
    deepIngestSourceRemove,
    deepIngestStateGet,
  } = await loadDeepIngestVerbs();

  const removable = deepIngestSourceCreate({
    repoRoot,
    input: {
      id: "deep_src_removable",
      targetShape: "auto",
      sourceKind: "url",
      text: "Example source text.",
    },
  }).source;
  deepIngestProposalPut({
    repoRoot,
    sourceId: removable.id,
    targetShape: "auto",
    lane: "open_gaps",
    proposal: {
      status: "review_needed",
      validation: { status: "source_scanned" },
    },
  });

  const removed = deepIngestSourceRemove({ repoRoot, sourceId: removable.id });
  assert.deepEqual(removed, {
    ok: true,
    sourceId: removable.id,
    removedProposals: 1,
    removedChunks: 1,
  });
  assert.equal(deepIngestStateGet({ repoRoot }).sources.length, 0);
  assert.equal(deepIngestStateGet({ repoRoot }).proposals.length, 0);
  assert.equal(deepIngestStateGet({ repoRoot }).sourceChunks.length, 0);

  const protectedSource = deepIngestSourceCreate({
    repoRoot,
    input: {
      id: "deep_src_with_drafts",
      targetShape: "evidence",
      sourceKind: "paste",
      text: "Built a real system.",
    },
  }).source;
  deepIngestProposalPut({
    repoRoot,
    sourceId: protectedSource.id,
    targetShape: "evidence",
    lane: "evidence_claims",
    proposal: {
      status: "review_needed",
      payload: { claim: "Built a real system." },
      supportingQuote: "Built a real system.",
      validation: { status: "passed", blockedReasons: [] },
    },
  });

  assert.throws(
    () => deepIngestSourceRemove({ repoRoot, sourceId: protectedSource.id }),
    (err) => err.code === "SOURCE_HAS_DRAFTS"
  );
  assert.equal(deepIngestStateGet({ repoRoot }).sources.length, 1);
});

test("proposal decisions enforce expected-version conflicts and keep unconfirmed proposals out of trusted candidate state", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  seedSearchReadyCandidate(repoRoot);
  const {
    deepIngestConfirmProposal,
    deepIngestStateGet,
    deepIngestProposalDecision,
    deepIngestProposalPut,
    deepIngestSourceCreate,
  } = await loadDeepIngestVerbs();

  const before = candidateConfigGet({ repoRoot });
  const beforeClaims = before.evidence.claims.length;
  const source = deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "evidence",
      sourceKind: "paste",
      label: "Resume note",
      text: "Shipped a local-first SQLite app surface.",
    },
  }).source;
  const proposal = deepIngestProposalPut({
    repoRoot,
    sourceId: source.id,
    targetShape: "evidence",
    lane: "evidence_claims",
    proposal: {
      items: [
        {
          claim: "Shipped a local-first SQLite app surface.",
          sourceId: source.id,
          supportingQuote: "Shipped a local-first SQLite app surface",
          confidence: "high",
        },
      ],
      validation: { status: "grounded" },
    },
  });

  assert.equal(candidateConfigGet({ repoRoot }).evidence.claims.length, beforeClaims);

  const deferred = deepIngestProposalDecision({
    repoRoot,
    proposalId: proposal.id,
    expectedVersion: proposal.version,
    decision: "defer",
    reason: "Need a stronger metric before confirming.",
  });
  assert.equal(deferred.status, "deferred");
  assert.equal(deferred.version, proposal.version + 1);

  assert.throws(
    () =>
      deepIngestProposalDecision({
        repoRoot,
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        decision: "reject",
        reason: "Stale decision.",
      }),
    (err) => err.code === "VERSION_CONFLICT"
  );

  assert.equal(
    candidateConfigGet({ repoRoot }).evidence.claims.length,
    beforeClaims,
    "deferred proposals must not write trusted evidence"
  );

  const confirmed = deepIngestConfirmProposal({
    repoRoot,
    proposalId: proposal.id,
    expectedVersion: deferred.version,
    edits: {
      items: [
        {
          id: "deep-evidence-001",
          claim: "Shipped a local-first SQLite app surface.",
          evidence: `Deep ingest source ${source.id}`,
        },
      ],
    },
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.event.title, "Evidence added from deep intake");
  assert.ok(confirmed.event.tags.includes("operation:deep-intake:confirm"));
  assert.equal(candidateConfigGet({ repoRoot }).evidence.claims.length, beforeClaims + 1);
  assert.equal(deepIngestStateGet({ repoRoot }).laneStates.evidence_claims.status, "completed");
});

test("confirmed generic evidence edits write trusted claims and complete the lane", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  seedSearchReadyCandidate(repoRoot);
  const {
    deepIngestConfirmProposal,
    deepIngestProposalPut,
    deepIngestSourceCreate,
    deepIngestStateGet,
  } = await loadDeepIngestVerbs();

  const beforeClaims = candidateConfigGet({ repoRoot }).evidence.claims.length;
  const source = deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "evidence",
      sourceKind: "paste",
      label: "Manual evidence",
      text: "Built source-grounded review workflows for local candidate setup.",
      chunks: [
        {
          id: "chunk-generic-evidence-1",
          text: "Built source-grounded review workflows for local candidate setup.",
        },
      ],
    },
  }).source;
  const proposal = deepIngestProposalPut({
    repoRoot,
    sourceId: source.id,
    targetShape: "evidence",
    lane: "evidence_claims",
    proposal: {
      items: [
        {
          title: "Built source-grounded review workflows.",
          summary: "Local candidate setup now uses proposal-first review.",
          sourceId: source.id,
          chunkId: "chunk-generic-evidence-1",
          supportingQuote: "Built source-grounded review workflows",
        },
      ],
    },
  });

  const confirmed = deepIngestConfirmProposal({
    repoRoot,
    proposalId: proposal.id,
    expectedVersion: proposal.version,
    edits: {
      items: [
        {
          id: "generic-evidence-claim",
          title: "Built source-grounded review workflows.",
          summary: "Local candidate setup now uses proposal-first review.",
          sourceId: source.id,
          chunkId: "chunk-generic-evidence-1",
          supportingQuote: "Built source-grounded review workflows",
        },
      ],
    },
  });

  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.output.evidence.accepted, 1);
  const claims = candidateConfigGet({ repoRoot }).evidence.claims;
  assert.equal(claims.length, beforeClaims + 1);
  assert.equal(claims.at(-1).claim, "Built source-grounded review workflows.");
  assert.equal(deepIngestStateGet({ repoRoot }).laneStates.evidence_claims.status, "completed");
});

test("lane state verbs accept the documented statuses and reject invalid lane state", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  seedSearchReadyCandidate(repoRoot);
  const { deepIngestLaneSetState, deepIngestStateGet } = await loadDeepIngestVerbs();

  for (const status of VALID_LANE_STATUSES) {
    const result = deepIngestLaneSetState({
      repoRoot,
      lane: "open_gaps",
      status,
      reason: ["gap", "deferred", "not_available", "failed"].includes(status)
        ? `Reason for ${status}`
        : undefined,
    });
    assert.equal(result.laneState.status, status);
  }

  const state = deepIngestStateGet({ repoRoot });
  assert.equal(state.laneStates.open_gaps.status, "failed");

  assert.throws(
    () => deepIngestLaneSetState({ repoRoot, lane: "open_gaps", status: "bogus" }),
    /status/i
  );
  assert.throws(
    () => deepIngestLaneSetState({ repoRoot, lane: "not_a_lane", status: "completed" }),
    /lane/i
  );
  assert.throws(
    () => deepIngestLaneSetState({ repoRoot, lane: "open_gaps", status: "deferred" }),
    /reason/i
  );
});

test("deep_ingest_complete is computed only from terminal lane states and stays independent from search readiness", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  seedSearchReadyCandidate(repoRoot);
  const { deepIngestLaneSetState, deepIngestStateGet } = await loadDeepIngestVerbs();

  let config = candidateConfigGet({ repoRoot });
  assert.equal(config.setup.readiness.search_ready, true);
  assert.equal(config.setup.readiness.deep_ingest_complete, false);

  for (const lane of REQUIRED_LANES.slice(0, -1)) {
    deepIngestLaneSetState({ repoRoot, lane, status: "completed" });
  }
  deepIngestLaneSetState({
    repoRoot,
    lane: REQUIRED_LANES.at(-1),
    status: "review_needed",
    reason: "One gap still needs review.",
  });
  config = candidateConfigGet({ repoRoot });
  assert.equal(config.setup.readiness.search_ready, true);
  assert.equal(config.setup.readiness.deep_ingest_complete, false);
  assert.match(config.setup.missing.deep_ingest_complete.join("\n"), /open gaps/i);

  deepIngestLaneSetState({
    repoRoot,
    lane: "open_gaps",
    status: "deferred",
    reason: "Review after first sourcing run.",
  });
  config = candidateConfigGet({ repoRoot });
  assert.equal(config.setup.readiness.search_ready, true);
  assert.equal(config.setup.readiness.deep_ingest_complete, true);
  assert.deepEqual(config.setup.missing.deep_ingest_complete, []);

  const state = deepIngestStateGet({ repoRoot });
  assert.equal(state.terminalLaneCount, REQUIRED_LANES.length);
  assert.equal(state.requiredLaneCount, REQUIRED_LANES.length);
});

test("proposal decisions require explicit actions, rerun validation, and keep unsafe edits out of trusted state", async () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  seedSearchReadyCandidate(repoRoot);
  const {
    deepIngestConfirmProposal,
    deepIngestProposalDecision,
    deepIngestProposalPut,
    deepIngestSourceCreate,
  } = await loadDeepIngestVerbs();

  const beforeClaims = candidateConfigGet({ repoRoot }).evidence.claims.length;
  const beforeRuns = db.prepare("SELECT COUNT(*) AS count FROM sourcing_runs").get().count;
  const source = deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "evidence",
      sourceKind: "paste",
      label: "Evidence note",
      text: "Built a source-grounded proposal review workflow.",
      chunks: [
        {
          id: "chunk-evidence-1",
          text: "Built a source-grounded proposal review workflow.",
        },
      ],
    },
  }).source;

  const blocked = deepIngestProposalPut({
    repoRoot,
    sourceId: source.id,
    targetShape: "evidence",
    lane: "evidence_claims",
    proposal: {
      items: [
        {
          claim: "Current base is $200000.",
          sourceId: source.id,
          chunkId: "chunk-evidence-1",
          supportingQuote: "Built a source-grounded proposal review workflow",
          payload: { blocked: true },
          validation: { status: "blocked", blockedReasons: ["current_base"] },
        },
      ],
      validation: { status: "blocked", blockedReasons: ["current_base"] },
    },
  });

  assert.throws(
    () =>
      deepIngestConfirmProposal({
        repoRoot,
        proposalId: blocked.id,
        expectedVersion: blocked.version,
        edits: {},
      }),
    (err) => err.code === "PROPOSAL_BLOCKED" && /blocked/i.test(err.message)
  );
  assert.equal(candidateConfigGet({ repoRoot }).evidence.claims.length, beforeClaims);

  const saved = deepIngestProposalDecision({
    repoRoot,
    proposalId: blocked.id,
    expectedVersion: blocked.version,
    decision: "save_edits",
    edits: {
      items: [
        {
          id: "deep-evidence-needs-quote",
          claim: "Built a workflow with a different unsupported metric.",
          evidence: "Deep ingest source",
          sourceId: source.id,
          chunkId: "chunk-evidence-1",
          supportingQuote: "quote that is not in the source chunk",
        },
      ],
    },
  });
  assert.equal(saved.status, "review_needed");
  assert.equal(saved.version, blocked.version + 1);
  assert.equal(saved.proposal.items[0].validation.status, "needs_quote");
  assert.ok(saved.proposal.items[0].validation.blockedReasons.includes("ungrounded"));
  assert.equal(candidateConfigGet({ repoRoot }).evidence.claims.length, beforeClaims);

  const confirmed = deepIngestConfirmProposal({
    repoRoot,
    proposalId: blocked.id,
    expectedVersion: saved.version,
    edits: {
      items: [
        {
          id: "deep-evidence-confirmed",
          claim: "Built a source-grounded proposal review workflow.",
          evidence: "Deep ingest source",
          sourceId: source.id,
          chunkId: "chunk-evidence-1",
          supportingQuote: "Built a source-grounded proposal review workflow",
        },
      ],
    },
  });
  assert.equal(confirmed.status, "confirmed");
  const claims = candidateConfigGet({ repoRoot }).evidence.claims;
  assert.equal(claims.length, beforeClaims + 1);
  assert.equal(claims.at(-1).sourceId, source.id);
  assert.equal(claims.at(-1).sourceProposalId, blocked.id);
  assert.equal(claims.at(-1).supportingQuote, "Built a source-grounded proposal review workflow");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sourcing_runs").get().count, beforeRuns);
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/tracker.json")), false);
});

test("confirmed lane outputs and terminal todos are readable through the DB-backed view model", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  seedSearchReadyCandidate(repoRoot);
  const {
    deepIngestConfirmProposal,
    deepIngestLaneSetState,
    deepIngestProposalDecision,
    deepIngestProposalPut,
    deepIngestSourceCreate,
  } = await loadDeepIngestVerbs();
  const { buildDeepIngestViewModel } = await import("../src/core/deep-ingest/view-model.mjs");
  const { validateDeepIngestLaneTransition } = await import(
    "../src/core/deep-ingest/validators/lane-state.mjs"
  );

  const source = deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "story",
      sourceKind: "paste",
      text: "Led a rollout that cut review time by 30%.",
      chunks: [{ id: "chunk-story-1", text: "Led a rollout that cut review time by 30%." }],
    },
  }).source;

  for (const [lane, item] of [
    [
      "story_bank",
      {
        title: "Review workflow rollout",
        situation: "Manual review queue",
        result: "Cut review time by 30%",
      },
    ],
    ["honesty_boundaries", { boundaryType: "do_not_claim", text: "Do not claim ML training." }],
    ["writing_voice", { voiceStatus: "confirmed", summary: "Direct, concrete, technical." }],
    [
      "role_signals",
      { roleFamily: "applied-ai", signalType: "keep", text: "Agent workflow builder" },
    ],
  ]) {
    const proposal = deepIngestProposalPut({
      repoRoot,
      sourceId: source.id,
      targetShape: "story",
      lane,
      proposal: {
        items: [
          {
            ...item,
            sourceId: source.id,
            chunkId: "chunk-story-1",
            supportingQuote: "Led a rollout that cut review time by 30%",
            validation: { status: "passed", blockedReasons: [] },
          },
        ],
      },
    });
    deepIngestConfirmProposal({
      repoRoot,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      edits: {
        items: [
          {
            ...item,
            sourceId: source.id,
            chunkId: "chunk-story-1",
            supportingQuote: "Led a rollout that cut review time by 30%",
          },
        ],
      },
    });
  }

  const gapProposal = deepIngestProposalPut({
    repoRoot,
    sourceId: source.id,
    targetShape: "gap",
    lane: "open_gaps",
    proposal: {
      items: [{ prompt: "Add a quantified leadership story.", sourceId: source.id }],
    },
  });
  deepIngestProposalDecision({
    repoRoot,
    proposalId: gapProposal.id,
    expectedVersion: gapProposal.version,
    decision: "mark_not_available",
    reason: "No public metric is available yet.",
  });
  deepIngestLaneSetState({
    repoRoot,
    lane: "open_gaps",
    status: "deferred",
    reason: "Review after first sourcing run.",
  });

  const invalid = validateDeepIngestLaneTransition({
    lane: "writing_voice",
    status: "not_available",
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /reason/i);

  const model = buildDeepIngestViewModel({ repoRoot });
  assert.equal(model.confirmed.storyBank.length, 1);
  assert.equal(model.confirmed.honestyBoundaries.length, 1);
  assert.equal(model.confirmed.writingVoice.length, 1);
  assert.equal(model.confirmed.roleSignals.length, 1);
  assert.equal(model.confirmed.storyBank[0].sourceId, source.id);
  assert.match(model.confirmed.storyBank[0].sourceProposalId, /^deep_prop_/);
  assert.equal(model.openGaps[0].reason, "No public metric is available yet.");
  assert.equal(
    model.lanes.find((lane) => lane.key === "open_gaps").todo,
    "Review after first sourcing run."
  );
  assert.equal(model.terminalSummary.terminalLanes.includes("open_gaps"), true);
  assert.ok(model.reviewQueue.every((row) => row.status === "review_needed"));
});

test("Library snapshot includes confirmed onboarding evidence without Deep ingest provenance", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  candidateSetupInitialize({ repoRoot });
  candidateEvidenceMerge({
    repoRoot,
    claims: [
      {
        id: "onboarding-evidence-library",
        claim: "Shipped a production RAG pipeline used by 200 people.",
        evidence: "Confirmed during onboarding.",
        metrics: ["200 users"],
        role_signals: ["prototype-to-production"],
        allowed_wording: ["production RAG pipeline"],
      },
    ],
  });

  const { loadLibrarySnapshot } = await import("../src/core/tracker/library-snapshot.mjs");
  const snapshot = loadLibrarySnapshot({ root: repoRoot });

  assert.equal(snapshot.metrics.claims, 1);
  assert.equal(snapshot.cards.length, 1);
  assert.equal(snapshot.cards[0].id, "onboarding-evidence-library");
  assert.equal(snapshot.cards[0].kind, "evidence");
});

test("Library snapshot projects only confirmed Deep ingest rows from SQLite", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const {
    deepIngestConfirmProposal,
    deepIngestProposalDecision,
    deepIngestProposalPut,
    deepIngestSourceCreate,
  } = await loadDeepIngestVerbs();
  const { loadLibrarySnapshot } = await import("../src/core/tracker/library-snapshot.mjs");

  const source = deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "evidence",
      sourceKind: "paste",
      label: "Deep profile note",
      text: [
        "Built source-grounded evidence review.",
        "Led a STAR rollout that cut review time by 30%.",
        "Write in direct, concrete language.",
        "Do not claim model training.",
        "Agent workflow builder signal.",
      ].join("\n"),
      chunks: [
        {
          id: "chunk-library-1",
          text: [
            "Built source-grounded evidence review.",
            "Led a STAR rollout that cut review time by 30%.",
            "Write in direct, concrete language.",
            "Do not claim model training.",
            "Agent workflow builder signal.",
          ].join("\n"),
        },
      ],
    },
  }).source;

  const confirm = (lane, targetShape, item) => {
    const proposal = deepIngestProposalPut({
      repoRoot,
      sourceId: source.id,
      targetShape,
      lane,
      proposal: {
        items: [
          {
            ...item,
            sourceId: source.id,
            chunkId: "chunk-library-1",
            supportingQuote: item.supportingQuote,
            validation: { status: "passed", blockedReasons: [] },
          },
        ],
      },
    });
    return deepIngestConfirmProposal({
      repoRoot,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      edits: {
        items: [
          {
            ...item,
            sourceId: source.id,
            chunkId: "chunk-library-1",
            supportingQuote: item.supportingQuote,
          },
        ],
      },
    });
  };

  const evidence = confirm("evidence_claims", "evidence", {
    id: "deep-evidence-library",
    claim: "Built source-grounded evidence review.",
    evidence: "Deep profile note",
    role_signals: ["agent workflow builder"],
    metrics: ["source-grounded"],
    allowed_wording: ["Built source-grounded evidence review."],
    supportingQuote: "Built source-grounded evidence review",
  });
  const story = confirm("story_bank", "story", {
    id: "story-library-rollout",
    title: "Cut review time with STAR rollout",
    situation: "Review was manual.",
    task: "Make the workflow reusable.",
    action: "Led a STAR rollout.",
    result: "Cut review time by 30%.",
    reflection: "Grounding keeps claims honest.",
    role_signals: ["agent workflow builder"],
    competencies: ["measurable-impact"],
    metrics: ["30% review-time reduction"],
    supportingQuote: "Led a STAR rollout that cut review time by 30%",
  });
  const voice = confirm("writing_voice", "writing_voice", {
    id: "voice-library-direct",
    voiceStatus: "confirmed",
    summary: "Direct, concrete, evidence-backed writing.",
    doPhrases: ["Lead with the concrete result."],
    avoidPhrases: ["unsupported hype"],
    supportingQuote: "Write in direct, concrete language",
  });
  const honesty = confirm("honesty_boundaries", "honesty_boundary", {
    id: "honesty-library-training",
    boundaryType: "do_not_claim",
    text: "Do not claim model training.",
    allowedWording: "Built model-adjacent workflow tooling.",
    supportingQuote: "Do not claim model training",
  });
  const signal = confirm("role_signals", "role_signal", {
    id: "signal-library-agent-builder",
    roleFamily: "applied-ai",
    signalType: "keep",
    text: "Agent workflow builder signal.",
    rationale: "Matches applied AI builder roles.",
    supportingQuote: "Agent workflow builder signal",
  });

  const unconfirmedSource = deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "evidence",
      sourceKind: "paste",
      label: "Unconfirmed note",
      text: "Pending, rejected, deferred, failed, and not-available material stays untrusted.",
    },
  }).source;
  const pending = deepIngestProposalPut({
    repoRoot,
    sourceId: unconfirmedSource.id,
    targetShape: "evidence",
    lane: "evidence_claims",
    proposal: {
      items: [{ claim: "Pending claim must not appear.", sourceId: unconfirmedSource.id }],
    },
  });
  deepIngestProposalDecision({
    repoRoot,
    proposalId: pending.id,
    expectedVersion: pending.version,
    decision: "reject",
    reason: "Rejected by reviewer.",
  });
  const deferred = deepIngestProposalPut({
    repoRoot,
    sourceId: unconfirmedSource.id,
    targetShape: "story",
    lane: "story_bank",
    proposal: {
      items: [{ title: "Deferred story must not appear.", sourceId: unconfirmedSource.id }],
    },
  });
  deepIngestProposalDecision({
    repoRoot,
    proposalId: deferred.id,
    expectedVersion: deferred.version,
    decision: "defer",
    reason: "Needs more context.",
  });
  const notAvailable = deepIngestProposalPut({
    repoRoot,
    sourceId: unconfirmedSource.id,
    targetShape: "role_signal",
    lane: "role_signals",
    proposal: {
      items: [{ text: "Not available signal must not appear.", sourceId: unconfirmedSource.id }],
    },
  });
  deepIngestProposalDecision({
    repoRoot,
    proposalId: notAvailable.id,
    expectedVersion: notAvailable.version,
    decision: "mark_not_available",
    reason: "No source support.",
  });
  deepIngestSourceCreate({
    repoRoot,
    input: {
      targetShape: "evidence",
      sourceKind: "paste",
      status: "failed",
      label: "Failed source",
      text: "Failed source must not appear.",
    },
  });

  const snapshot = loadLibrarySnapshot({ root: repoRoot });
  const byKind = new Map(snapshot.cards.map((card) => [card.kind, card]));
  const body = JSON.stringify(snapshot);

  assert.equal(existsSync(userPath({ repoRoot }, "candidate/stories.yml")), false);
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/writing-style.md")), false);
  assert.equal(snapshot.metrics.claims, 1);
  assert.equal(snapshot.metrics.stories, 1);
  assert.equal(snapshot.metrics.voice, 1);
  assert.equal(snapshot.metrics.honesty, 1);
  assert.equal(snapshot.metrics.roleSignals, 1);
  assert.equal(snapshot.readiness.proof, 1);
  assert.equal(snapshot.readiness.stories, 1);
  assert.equal(snapshot.readiness.voice, 1);
  assert.equal(snapshot.readiness.honesty, 1);
  assert.equal(snapshot.readiness.roleSignals, 1);

  assert.equal(byKind.get("evidence")?.sourceId, source.id);
  assert.equal(byKind.get("evidence")?.sourceProposalId, evidence.id);
  assert.equal(byKind.get("story")?.sourceProposalId, story.id);
  assert.equal(byKind.get("story")?.metadata?.star?.situation, "Review was manual.");
  assert.equal(byKind.get("story")?.metadata?.star?.result, "Cut review time by 30%.");
  assert.equal(byKind.get("voice")?.sourceProposalId, voice.id);
  assert.equal(byKind.get("honesty")?.sourceProposalId, honesty.id);
  assert.equal(byKind.get("role_signal")?.sourceProposalId, signal.id);
  assert.ok(snapshot.filters.some((filter) => filter.label === "Agent Workflow Builder"));

  assert.doesNotMatch(body, /Pending claim must not appear/);
  assert.doesNotMatch(body, /Deferred story must not appear/);
  assert.doesNotMatch(body, /Not available signal must not appear/);
  assert.doesNotMatch(body, /Failed source must not appear/);
});

test("deepIngestConfirmedItemUpdate partially merges edits across all four confirmed lane tables", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  await seedConfirmedReferenceItems(repoRoot);
  const { deepIngestConfirmedItemUpdate } = await loadDeepIngestVerbs();

  const cases = [
    {
      lane: "story_bank",
      id: "story-edit-1",
      fields: { title: "Edited rollout title" },
      changed: ["title", "Edited rollout title"],
      preserved: ["situation", "Manual review queue"],
    },
    {
      lane: "honesty_boundaries",
      id: "honesty-edit-1",
      fields: { reason: "User clarified the boundary." },
      changed: ["reason", "User clarified the boundary."],
      preserved: ["text", "Do not claim ML training."],
    },
    {
      lane: "writing_voice",
      id: "voice-edit-1",
      fields: { summary: "Edited, concise, concrete." },
      changed: ["summary", "Edited, concise, concrete."],
      preserved: ["voiceStatus", "confirmed"],
    },
    {
      lane: "role_signals",
      id: "signal-edit-1",
      fields: { rationale: "Matches hands-on builder roles." },
      changed: ["rationale", "Matches hands-on builder roles."],
      preserved: ["text", "Agent workflow builder"],
    },
  ];

  for (const entry of cases) {
    const result = deepIngestConfirmedItemUpdate({
      repoRoot,
      lane: entry.lane,
      id: entry.id,
      fields: entry.fields,
    });
    assert.equal(result.ok, true);
    assert.equal(result.lane, entry.lane);
    assert.equal(result.item.id, entry.id);
    assert.equal(result.item[entry.changed[0]], entry.changed[1]);
    assert.equal(result.item[entry.preserved[0]], entry.preserved[1]);
    assert.match(result.event.title, /updated$/);
    assert.ok(result.event.tags.includes("operation:library:item-update"));
  }
});

test("deepIngestConfirmedItemUpdate reports unknown lane/id and privacy-block reasons", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  await seedConfirmedReferenceItems(repoRoot);
  const { deepIngestConfirmedItemUpdate } = await loadDeepIngestVerbs();

  assert.throws(
    () =>
      deepIngestConfirmedItemUpdate({
        repoRoot,
        lane: "not_a_lane",
        id: "story-edit-1",
        fields: { title: "No-op" },
      }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.match(error.message, /unsupported Deep ingest lane "not_a_lane"/);
      return true;
    }
  );
  assert.throws(
    () =>
      deepIngestConfirmedItemUpdate({
        repoRoot,
        lane: "story_bank",
        id: "missing-story",
        fields: { title: "No-op" },
      }),
    (error) => {
      assert.equal(error.code, "NOT_FOUND");
      assert.equal(error.message, 'Deep ingest confirmed item not found: "missing-story"');
      return true;
    }
  );
  assert.throws(
    () =>
      deepIngestConfirmedItemUpdate({
        repoRoot,
        lane: "story_bank",
        id: "story-edit-1",
        fields: {
          result: "My current salary is $210,000; contact me at private@example.com.",
        },
      }),
    (error) => {
      assert.equal(error.code, "PRIVACY_BLOCKED");
      assert.equal(
        error.message,
        "Deep ingest confirmed item update is blocked by the privacy guard"
      );
      assert.deepEqual(error.reasons, ["contact_detail", "current_base"]);
      return true;
    }
  );
});

test("deepIngestConfirmedItemRemove deletes one row and rejects unknown lane/id", async () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  await seedConfirmedReferenceItems(repoRoot);
  const { deepIngestConfirmedItemRemove } = await loadDeepIngestVerbs();

  const removed = deepIngestConfirmedItemRemove({
    repoRoot,
    lane: "story_bank",
    id: "story-edit-1",
  });

  assert.equal(removed.ok, true);
  assert.equal(removed.lane, "story_bank");
  assert.equal(removed.removed, "story-edit-1");
  assert.equal(removed.event.title, "Interview story removed");
  assert.ok(removed.event.tags.includes("operation:library:item-remove"));
  assert.deepEqual(
    db
      .prepare("SELECT id FROM deep_ingest_story_bank ORDER BY id")
      .all()
      .map((row) => row.id),
    ["story-keep-2"]
  );
  assert.throws(
    () =>
      deepIngestConfirmedItemRemove({
        repoRoot,
        lane: "not_a_lane",
        id: "story-keep-2",
      }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.match(error.message, /unsupported Deep ingest lane "not_a_lane"/);
      return true;
    }
  );
  assert.throws(
    () =>
      deepIngestConfirmedItemRemove({
        repoRoot,
        lane: "story_bank",
        id: "missing-story",
      }),
    (error) => {
      assert.equal(error.code, "NOT_FOUND");
      assert.equal(error.message, 'Deep ingest confirmed item not found: "missing-story"');
      return true;
    }
  );
});

test("deepIngestConfirmedForGeneration projects confirmed lanes, skips privacy failures and malformed stories, and fails closed on malformed honesty", async () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  await seedConfirmedReferenceItems(repoRoot);
  const { deepIngestConfirmedForGeneration } = await loadDeepIngestVerbs();

  db.prepare("INSERT INTO deep_ingest_story_bank (id, data) VALUES (?, ?)").run(
    "story-private-comp",
    JSON.stringify({
      id: "story-private-comp",
      status: "confirmed",
      title: "Private compensation note",
      situation: "A private note was captured.",
      task: "Keep it out of generation.",
      action: "Recorded that my current salary is 231000 dollars.",
      result: "The reader must skip this row.",
      supportingQuote: "private note",
    })
  );
  db.prepare("INSERT INTO deep_ingest_story_bank (id, data) VALUES (?, ?)").run(
    "story-malformed",
    JSON.stringify("not an object")
  );

  const result = deepIngestConfirmedForGeneration({ repoRoot });

  assert.deepEqual(result.storyBank.map((row) => row.id).sort(), ["story-edit-1", "story-keep-2"]);
  assert.ok(result.storyBank.every((row) => row.status === "confirmed"));
  assert.deepEqual(
    result.writingVoice.map((row) => row.id),
    ["voice-edit-1"]
  );
  assert.deepEqual(
    result.honestyBoundaries.map((row) => row.id),
    ["honesty-edit-1"]
  );
  assert.deepEqual(
    result.roleSignals.map((row) => row.id),
    ["signal-edit-1"]
  );
  assert.ok(
    result.skipped.some(
      (row) =>
        row.lane === "story_bank" &&
        row.id === "story-private-comp" &&
        /privacy: current_base/.test(row.reason)
    )
  );
  assert.ok(
    result.skipped.some(
      (row) => row.lane === "story_bank" && /malformed: row is not an object/.test(row.reason)
    ),
    "a malformed story row should be diagnosed and skipped"
  );

  db.prepare("INSERT INTO deep_ingest_honesty_boundaries (id, data) VALUES (?, ?)").run(
    "honesty-malformed",
    JSON.stringify("not an object")
  );
  assert.throws(
    () => deepIngestConfirmedForGeneration({ repoRoot }),
    /row is not an object/,
    "honesty parsing must fail closed instead of skipping the row"
  );
});

test("deep-ingest confirm, edit, and remove never materialize or rewrite legacy promotion files", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const guardedFiles = new Map(
    [
      "candidate/stories.yml",
      "candidate/writing-style.md",
      "candidate/targeting.yml",
      "candidate/honesty.yml",
    ].map((relativePath) => [relativePath, `sentinel:${relativePath}\n`])
  );
  await seedConfirmedReferenceItems(repoRoot);
  for (const relativePath of guardedFiles.keys()) {
    assert.equal(
      existsSync(userPath({ repoRoot }, relativePath)),
      false,
      `confirm must not create ${relativePath}`
    );
  }
  for (const [relativePath, contents] of guardedFiles) {
    const path = userPath({ repoRoot }, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }

  const { deepIngestConfirmedItemRemove, deepIngestConfirmedItemUpdate } =
    await loadDeepIngestVerbs();
  deepIngestConfirmedItemUpdate({
    repoRoot,
    lane: "story_bank",
    id: "story-edit-1",
    fields: { title: "Edited without compatibility promotion" },
  });
  deepIngestConfirmedItemRemove({
    repoRoot,
    lane: "story_bank",
    id: "story-keep-2",
  });

  for (const [relativePath, contents] of guardedFiles) {
    assert.equal(
      readFileSync(userPath({ repoRoot }, relativePath), "utf8"),
      contents,
      `${relativePath} must remain byte-identical across confirm/edit/remove`
    );
  }
});
