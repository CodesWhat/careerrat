import { requireDb } from "../db/connection.mjs";
import { deepIngestStateGet } from "../db/verbs/deep-ingest.mjs";

const CONFIRMED_TABLES = {
  storyBank: "deep_ingest_story_bank",
  writingVoice: "deep_ingest_writing_voice",
  honestyBoundaries: "deep_ingest_honesty_boundaries",
  roleSignals: "deep_ingest_role_signals",
};

export function buildDeepIngestViewModel({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  const state = deepIngestStateGet({ repoRoot, env });
  const reviewQueue = state.proposals.filter((proposal) => proposal.status === "review_needed");
  const openGaps = state.proposals
    .filter((proposal) => proposal.lane === "open_gaps" && proposal.status !== "confirmed")
    .map((proposal) => ({
      ...proposal,
      reason:
        proposal.reason ||
        proposal.proposal?.reason ||
        proposal.proposal?.items?.[0]?.reason ||
        proposal.proposal?.items?.[0]?.prompt ||
        null,
    }));

  return {
    ...state,
    lanes: state.lanes.map((lane) => ({
      ...lane,
      terminal: lane.terminal ?? state.terminalSummary.terminalLanes.includes(lane.key),
      todo: lane.status === "deferred" ? lane.reason : null,
    })),
    readiness: state.readiness,
    todos: state.todos,
    gaps: state.gaps,
    reviewQueue,
    openGaps,
    confirmed: {
      evidence: confirmedEvidence(db),
      storyBank: readRows(db, CONFIRMED_TABLES.storyBank),
      writingVoice: readRows(db, CONFIRMED_TABLES.writingVoice),
      honestyBoundaries: readRows(db, CONFIRMED_TABLES.honestyBoundaries),
      roleSignals: readRows(db, CONFIRMED_TABLES.roleSignals),
    },
    counts: {
      sources: state.sources.length,
      proposals: state.proposals.length,
      reviewQueue: reviewQueue.length,
      openGaps: openGaps.length,
      confirmed:
        confirmedEvidence(db).length +
        readRows(db, CONFIRMED_TABLES.storyBank).length +
        readRows(db, CONFIRMED_TABLES.writingVoice).length +
        readRows(db, CONFIRMED_TABLES.honestyBoundaries).length +
        readRows(db, CONFIRMED_TABLES.roleSignals).length,
    },
  };
}

function confirmedEvidence(db) {
  return readRows(db, "candidate_evidence_claims").filter(
    (row) => row.sourceProposalId || row.sourceId
  );
}

function readRows(db, table) {
  return db
    .prepare(`SELECT id, data FROM ${table} ORDER BY updated_at ASC, id ASC`)
    .all()
    .map((row) => JSON.parse(row.data));
}
