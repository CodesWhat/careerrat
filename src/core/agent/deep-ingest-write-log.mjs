// deep-ingest-write-log.mjs: puts what deep ingest saved on its own into the
// workspace thread.
//
// A proposal that clears every check saves with no click, so each one appends
// ONE action_result carrying a `knowledge_write` entry per saved row, with an
// Undo for each. The entries come from the same builder the Ask writers use, so
// `knowledge.revert` undoes them the same way (evidence through the evidence
// revert, lane rows through deepIngestConfirmedItemRemove).

import { randomUUID } from "node:crypto";

import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import { deepIngestStateGet } from "../db/verbs/deep-ingest.mjs";
import { buildKnowledgeWriteEntry, undoNextAction } from "./knowledge-write-log.mjs";
import { WORKSPACE_THREAD_ID, workspaceMessageAppend } from "./workspace-thread.mjs";

const SOURCE = Object.freeze({ kind: "deep_ingest.auto" });
const WRITER = "deep_ingest.auto";
const TITLE_MAX = 80;

const LANE_LABELS = {
  evidence_claims: "Evidence claim",
  story_bank: "Interview story",
  honesty_boundaries: "Honesty boundary",
  writing_voice: "Writing style",
  role_signals: "Role signal",
};

const LANE_KEYS = {
  story_bank: "storyBank",
  honesty_boundaries: "honestyBoundaries",
  writing_voice: "writingVoice",
  role_signals: "roleSignals",
};

function shortTitle(text) {
  const clean = String(text || "")
    .replaceAll(/\s+/g, " ")
    .trim();
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1)}…` : clean;
}

function rowTitle(row) {
  return shortTitle(row?.title || row?.claim || row?.summary || row?.text || "");
}

// The saved rows of one auto-applied proposal, read back as stored so the entry's
// `after` is exactly what an undo has to find.
function savedRows({ repoRoot, env, proposal }) {
  if (proposal.lane === "evidence_claims") {
    const ids = new Set(proposal.output?.evidence?.insertedIds || []);
    return (candidateConfigGet({ repoRoot, env }).evidence?.claims || []).filter((claim) =>
      ids.has(claim.id)
    );
  }
  const key = LANE_KEYS[proposal.lane];
  if (!key) return [];
  const ids = new Set(
    (proposal.output?.rows || []).filter((row) => !row.existed).map((row) => row.id)
  );
  return (deepIngestStateGet({ repoRoot, env }).confirmed[key] || []).filter((row) =>
    ids.has(row.id)
  );
}

function deepIngestAutoEntries({ repoRoot, env, proposal }) {
  const label = LANE_LABELS[proposal.lane] || "Deep ingest item";
  const evidence = proposal.lane === "evidence_claims";
  return savedRows({ repoRoot, env, proposal }).map((row) => ({
    entry: buildKnowledgeWriteEntry({
      target: evidence ? "evidence" : `deep_ingest:${proposal.lane}`,
      op: "add",
      id: row.id,
      before: undefined,
      after: row,
      source: { ...SOURCE, proposalId: proposal.id },
      writer: WRITER,
      label,
    }),
    title: rowTitle(row),
  }));
}

// One thread message per auto-applied proposal. Returns the stored message id, or
// null when nothing new was saved (an identical row was already there).
export function appendDeepIngestWriteLog({ repoRoot, env, proposal, now } = {}) {
  const saved = deepIngestAutoEntries({ repoRoot, env, proposal });
  if (!saved.length) return null;
  const entries = saved.map((item) => item.entry);
  const id = randomUUID();
  const nextActions = entries.flatMap((entry, index) =>
    entry.revertible ? [undoNextAction({ messageId: id, index, entry })] : []
  );
  const label = LANE_LABELS[proposal.lane] || "Deep ingest item";
  const titles = saved.map((item) => item.title).filter(Boolean);
  workspaceMessageAppend({
    repoRoot,
    env,
    id,
    role: "assistant",
    kind: "action_result",
    text: `Deep ingest saved ${entries.length} ${label.toLowerCase()}${entries.length === 1 ? "" : "s"}${
      titles.length ? `: ${titles.join("; ")}` : ""
    }.`,
    entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
    artifacts: entries,
    metadata: { writer: WRITER, ...(nextActions.length ? { nextActions } : {}) },
    now,
  });
  return id;
}
