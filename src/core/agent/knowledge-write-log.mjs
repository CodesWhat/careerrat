// knowledge-write-log.mjs: the reversible log for candidate-knowledge writes.
//
// A direct writer (no confirm pause) records what it changed as a
// `knowledge_write` artifact in its thread result. The entry is scoped to the
// ONE path (or row id) the write touched, never a whole doc, so it can ride in
// the durable thread without carrying anything the writer didn't change. The
// `knowledge.revert` intent reads that stored entry back (never client-supplied
// before/after), checks the value is still what the write left, and writes the
// prior value through the same writer.

import {
  candidateConfigGet,
  candidateConfigPatch,
  candidateEvidenceMerge,
  candidateEvidenceRemoveOne,
} from "../db/verbs/candidate.mjs";
import {
  deepIngestConfirmedItemRemove,
  deepIngestConfirmedItemUpdate,
  deepIngestStateGet,
} from "../db/verbs/deep-ingest.mjs";
import { findCompLeak, findCurrentBaseToken } from "../profile/comp-guard.mjs";
import { computeEvidenceWrite } from "../profile/evidence-writer.mjs";
import { WORKSPACE_THREAD_ID } from "./workspace-thread.mjs";

const PRIVATE_MARKER = "[private]";
const PRIVATE_NOTE = "This value is private, so it can't be undone from the thread.";
const STALE_NOTE = "This changed again since, so CareerRat didn't undo it.";
const EVIDENCE_IN_USE_NOTE = "Other work cites this claim now, so it can't be removed.";
const NO_INVERSE_NOTE = "This kind of change can't be undone from the thread.";
const UNDO_NOTE = "This undo can't be undone from the thread.";

const DEEP_INGEST_LANE_KEYS = {
  story_bank: "storyBank",
  honesty_boundaries: "honestyBoundaries",
  writing_voice: "writingVoice",
  role_signals: "roleSignals",
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

function sameValue(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// Value at a dotted path, or undefined when any branch is missing.
function readConfigPath(doc, path) {
  let cursor = doc;
  for (const part of String(path).split(".")) {
    cursor = isPlainObject(cursor) ? cursor[part] : undefined;
  }
  return cursor;
}

function nestPatch(path, value) {
  let patch = value;
  const parts = String(path).split(".");
  for (let i = parts.length - 1; i >= 0; i--) patch = { [parts[i]]: patch };
  return patch;
}

function flagsPrivate(...values) {
  const text = values.map((value) => (value === undefined ? "" : JSON.stringify(value))).join("\n");
  return Boolean(text && (findCurrentBaseToken(text) || findCompLeak(text)));
}

// buildKnowledgeWriteEntry: the `knowledge_write` artifact for one applied
// write. `before`/`after` are scoped to the touched path; undefined means the
// value was absent (recorded as beforeAbsent/afterAbsent, since JSON drops it).
export function buildKnowledgeWriteEntry({
  target,
  op,
  path,
  id,
  before,
  after,
  source,
  writer,
  label,
  revertOf,
  revertible = true,
  revertNote,
} = {}) {
  let entryBefore = clone(before);
  let entryAfter = clone(after);
  let entryPath = path;
  let canRevert = revertible !== false;
  let note = canRevert ? undefined : revertNote || NO_INVERSE_NOTE;

  // Backstop, reusing the shared comp guard: a private current-comp value (or
  // the field name) never lands in the durable thread, and can't be undone from it.
  if (flagsPrivate(path, id, before, after)) {
    if (path !== undefined && flagsPrivate(path)) entryPath = PRIVATE_MARKER;
    entryBefore = before === undefined ? undefined : PRIVATE_MARKER;
    entryAfter = after === undefined ? undefined : PRIVATE_MARKER;
    canRevert = false;
    note = PRIVATE_NOTE;
  }

  return {
    kind: "knowledge_write",
    target,
    op,
    ...(entryPath !== undefined ? { path: entryPath } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(label ? { label } : {}),
    ...(entryBefore !== undefined ? { before: entryBefore } : { beforeAbsent: true }),
    ...(entryAfter !== undefined ? { after: entryAfter } : { afterAbsent: true }),
    source: source || { kind: "unknown" },
    writer,
    ...(revertOf ? { revertOf } : {}),
    revertible: canRevert,
    ...(note ? { revertNote: note } : {}),
  };
}

// Entries for a direct candidate-config write: one per path whose scoped value
// actually changed between the snapshots taken around the write.
export function configWriteEntries({ before, after, writes, source, writer }) {
  const entries = [];
  for (const { name, path, label, op } of writes) {
    const was = readConfigPath(before?.[name], path);
    const now = readConfigPath(after?.[name], path);
    if (sameValue(was, now)) continue;
    entries.push(
      buildKnowledgeWriteEntry({
        target: `candidate_config:${name}`,
        op: op || (was === undefined ? "add" : now === undefined ? "remove" : "set"),
        path,
        before: was,
        after: now,
        source,
        writer,
        label,
      })
    );
  }
  return entries;
}

export function undoNextAction({ messageId, index, entry }) {
  return {
    label: entry.label ? `Undo ${entry.label}` : "Undo",
    intent: {
      type: "knowledge.revert",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { messageId, index },
    },
  };
}

function entryValue(entry, key) {
  return entry[`${key}Absent`] === true ? undefined : entry[key];
}

function describe(entry) {
  return entry.label || entry.path || entry.id || entry.target;
}

function inverseEntry(entry, { messageId, index, writer }) {
  return buildKnowledgeWriteEntry({
    target: entry.target,
    op: entry.op === "add" ? "remove" : entry.op === "remove" ? "add" : entry.op,
    path: entry.path,
    id: entry.id,
    before: entryValue(entry, "after"),
    after: entryValue(entry, "before"),
    source: { kind: "knowledge.revert", messageId, index },
    writer,
    label: entry.label,
    revertOf: { messageId, index },
    revertible: false,
    revertNote: UNDO_NOTE,
  });
}

function refuse(note, reason) {
  return { ok: false, note, reason };
}

function currentClaims(repoRoot, env) {
  return candidateConfigGet({ repoRoot, env }).evidence?.claims || [];
}

function revertConfig({ repoRoot, env, entry }) {
  const name = entry.target.slice("candidate_config:".length);
  const current = readConfigPath(candidateConfigGet({ repoRoot, env })[name], entry.path);
  if (!sameValue(current, entryValue(entry, "after"))) return refuse(STALE_NOTE, "stale");
  const prior = entryValue(entry, "before");
  candidateConfigPatch({
    repoRoot,
    env,
    name,
    patch: prior === undefined ? {} : nestPatch(entry.path, prior),
    unset: [entry.path],
  });
  return { ok: true };
}

function revertEvidence({ repoRoot, env, entry }) {
  const claims = currentClaims(repoRoot, env);
  const live = claims.find((claim) => claim.id === entry.id);
  const wasAfter = entryValue(entry, "after");
  if (!sameValue(live, wasAfter)) return refuse(STALE_NOTE, "stale");
  const prior = entryValue(entry, "before");
  if (prior === undefined) {
    try {
      candidateEvidenceRemoveOne({ repoRoot, env, id: entry.id });
    } catch (error) {
      if (error?.code === "EVIDENCE_IN_USE") return refuse(EVIDENCE_IN_USE_NOTE, "in-use");
      throw error;
    }
    return { ok: true };
  }
  // Same firewall as a normal evidence write before the prior claim goes back.
  const plan = computeEvidenceWrite({ newClaim: prior, currentClaims: claims });
  if (!plan.ok) {
    return refuse(`CareerRat could not put this claim back: ${plan.error}`, "rejected");
  }
  candidateEvidenceMerge({ repoRoot, env, claims: [plan.claim] });
  return { ok: true };
}

function revertDeepIngest({ repoRoot, env, entry }) {
  const lane = entry.target.slice("deep_ingest:".length);
  const key = DEEP_INGEST_LANE_KEYS[lane];
  if (!key) return refuse(NO_INVERSE_NOTE, "unsupported");
  const rows = deepIngestStateGet({ repoRoot, env }).confirmed[key] || [];
  const live = rows.find((row) => row.id === entry.id);
  const wasAfter = entryValue(entry, "after");
  const prior = entryValue(entry, "before");
  if (entry.op === "add") {
    if (!sameValue(live, wasAfter)) return refuse(STALE_NOTE, "stale");
    deepIngestConfirmedItemRemove({ repoRoot, env, lane, id: entry.id });
    return { ok: true };
  }
  if (!live || !sameValue(live[entry.path], wasAfter)) return refuse(STALE_NOTE, "stale");
  if (prior === undefined) return refuse(NO_INVERSE_NOTE, "unsupported");
  deepIngestConfirmedItemUpdate({
    repoRoot,
    env,
    lane,
    id: entry.id,
    fields: { [entry.path]: prior },
  });
  return { ok: true };
}

// revertKnowledgeWrite: runs one stored entry's inverse. Never throws for the
// plain refusals (stale, in use, private, already undone); those come back as
// { ok:false, note }. `existing` is the knowledge_write artifacts already in the
// thread, used to refuse a double undo.
export function revertKnowledgeWrite({ repoRoot, env, entry, messageId, index, existing = [] }) {
  if (entry?.kind !== "knowledge_write") {
    return refuse("CareerRat couldn't find that change to undo.", "missing");
  }
  const alreadyUndone = existing.some(
    (other) => other?.revertOf?.messageId === messageId && other?.revertOf?.index === index
  );
  if (alreadyUndone) return refuse("This was already undone.", "already-reverted");
  if (entry.revertible !== true)
    return refuse(entry.revertNote || NO_INVERSE_NOTE, "not-revertible");

  let outcome;
  if (entry.target?.startsWith("candidate_config:") && entry.path) {
    outcome = revertConfig({ repoRoot, env, entry });
  } else if (entry.target === "evidence" && entry.id) {
    outcome = revertEvidence({ repoRoot, env, entry });
  } else if (entry.target?.startsWith("deep_ingest:") && entry.id) {
    outcome = revertDeepIngest({ repoRoot, env, entry });
  } else {
    outcome = refuse(NO_INVERSE_NOTE, "unsupported");
  }
  if (!outcome.ok) return outcome;
  return {
    ok: true,
    summary: `Undid: ${describe(entry)}.`,
    entry: inverseEntry(entry, { messageId, index, writer: "knowledge.revert" }),
  };
}
