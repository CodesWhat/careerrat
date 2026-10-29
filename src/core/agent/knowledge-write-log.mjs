// knowledge-write-log.mjs: the reversible log for candidate-knowledge writes.
//
// A direct writer (no confirm pause) records what it changed as a
// `knowledge_write` artifact in its thread result. The entry is scoped to the
// ONE path (or row id) the write touched, never a whole doc, so it can ride in
// the durable thread without carrying anything the writer didn't change. The
// `knowledge.revert` intent reads that stored entry back (never client-supplied
// before/after), checks the value is still what the write left, and writes the
// prior value through the same writer.

import { normalizeAutomationConfig } from "../automation/consent.mjs";
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
const CLAIM_TEXT_TAKEN_NOTE =
  "Another claim already has that text, so CareerRat couldn't restore it.";
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

function mergePatch(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] =
      isPlainObject(value) && isPlainObject(out[key]) ? mergePatch(out[key], value) : value;
  }
  return out;
}

// The effective view of a stored doc. Automation reads through its normalizer,
// so a legacy doc's stored value never stands in for what is actually in force.
function configView(name, doc) {
  return name === "automation" ? normalizeAutomationConfig(doc) : doc;
}

function absentAware(prefix, value) {
  return value === undefined ? { [`${prefix}Absent`]: true } : { [prefix]: value };
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
  companions,
} = {}) {
  let entryBefore = clone(before);
  let entryAfter = clone(after);
  let entryPath = path;
  let entryCompanions = (companions || []).map((item) => ({
    ...(item.name ? { name: item.name } : {}),
    path: item.path,
    ...absentAware("before", clone(item.before)),
    ...absentAware("after", clone(item.after)),
  }));
  let canRevert = revertible !== false;
  let note = canRevert ? undefined : revertNote || NO_INVERSE_NOTE;

  // Backstop, reusing the shared comp guard: a private current-comp value (or
  // the field name) never lands in the durable thread, and can't be undone from it.
  const companionValues = (companions || []).flatMap((item) => [
    item.path,
    item.before,
    item.after,
  ]);
  if (flagsPrivate(path, id, before, after, ...companionValues)) {
    entryCompanions = [];
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
    ...(entryCompanions.length ? { companions: entryCompanions } : {}),
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
  for (const { name, path, label, op, companions = [] } of writes) {
    const beforeDoc = configView(name, before?.[name]);
    const afterDoc = configView(name, after?.[name]);
    // A companion is a path on this doc, or { name, path } on another config doc.
    const changed = [
      { path },
      ...companions.map((item) => (typeof item === "string" ? { path: item } : item)),
    ]
      .map((item) => {
        const other = item.name && item.name !== name ? item.name : undefined;
        return {
          ...(other ? { name: other } : {}),
          path: item.path,
          before: readConfigPath(other ? configView(other, before?.[other]) : beforeDoc, item.path),
          after: readConfigPath(other ? configView(other, after?.[other]) : afterDoc, item.path),
        };
      })
      .filter((item) => !sameValue(item.before, item.after));
    if (!changed.length) continue;
    const [primary, ...rest] = changed;
    entries.push(
      buildKnowledgeWriteEntry({
        target: `candidate_config:${name}`,
        op:
          (primary.path === path && op) ||
          (primary.before === undefined ? "add" : primary.after === undefined ? "remove" : "set"),
        path: primary.path,
        before: primary.before,
        after: primary.after,
        companions: rest,
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
    companions: (entry.companions || []).map((item) => ({
      ...(item.name ? { name: item.name } : {}),
      path: item.path,
      before: entryValue(item, "after"),
      after: entryValue(item, "before"),
    })),
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
  const primaryName = entry.target.slice("candidate_config:".length);
  const stored = candidateConfigGet({ repoRoot, env });
  const items = [entry, ...(entry.companions || [])].map((item) => ({
    ...item,
    name: item.name || primaryName,
  }));
  const view = (name) => configView(name, stored[name]);
  const stale = items.some(
    (item) => !sameValue(readConfigPath(view(item.name), item.path), entryValue(item, "after"))
  );
  if (stale) return refuse(STALE_NOTE, "stale");
  const byName = new Map();
  for (const item of items) {
    const group = byName.get(item.name) || { patch: {}, unset: [] };
    const prior = entryValue(item, "before");
    if (prior === undefined) group.unset.push(item.path);
    else group.patch = mergePatch(group.patch, nestPatch(item.path, prior));
    byName.set(item.name, group);
  }
  for (const [name, { patch, unset }] of byName) {
    candidateConfigPatch({ repoRoot, env, name, patch, unset });
    // A patch that touches location mode fields makes the profile normalizer
    // stamp mode_preferences_confirmed back on, so an absent prior is unset again.
    const now = candidateConfigGet({ repoRoot, env })[name];
    const lingering = unset.filter((path) => readConfigPath(now, path) !== undefined);
    if (lingering.length)
      candidateConfigPatch({ repoRoot, env, name, patch: {}, unset: lingering });
  }
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
  const merged = candidateEvidenceMerge({ repoRoot, env, claims: [plan.claim] });
  // The merge skips a claim whose text another claim already holds; nothing
  // was restored then, so that is a refusal, not a success.
  if (!merged || merged.added < 1) return refuse(CLAIM_TEXT_TAKEN_NOTE, "text-taken");
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
// thread, used to refuse a double undo. `afterRevert(entry)` runs once the
// inverse succeeded and may return a note appended to the summary (a coaching
// claim's undo uses it to reopen its gap).
export function revertKnowledgeWrite({
  repoRoot,
  env,
  entry,
  messageId,
  index,
  existing = [],
  afterRevert,
}) {
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
  const extra = afterRevert ? afterRevert(entry) : undefined;
  return {
    ok: true,
    summary: `Undid: ${describe(entry)}.${extra ? ` ${extra}` : ""}`,
    entry: inverseEntry(entry, { messageId, index, writer: "knowledge.revert" }),
  };
}
