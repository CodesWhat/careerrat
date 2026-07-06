// Phase 08 Wave 0 RED contracts for the SQLite-native Deep ingest lane.
// These tests intentionally fail until the 008 migration and deep-ingest DB
// verbs exist. They define the DB/readiness boundary for later implementation.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
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
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-deep-ingest-db-"));
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

  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 8);
  const logged = db.prepare("SELECT id, name FROM _migrations WHERE id = 8").get();
  assert.deepEqual(logged, { id: 8, name: "deep-ingest" });

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

  assert.equal(existsSync(userPath({ repoRoot }, "candidate/profile.yml")), false);
  assert.equal(existsSync(userPath({ repoRoot }, "candidate/evidence.yml")), false);
});

test("proposal decisions enforce expected-version conflicts and keep unconfirmed proposals out of trusted candidate state", async () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  seedSearchReadyCandidate(repoRoot);
  const {
    deepIngestConfirmProposal,
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
  assert.equal(candidateConfigGet({ repoRoot }).evidence.claims.length, beforeClaims + 1);
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
