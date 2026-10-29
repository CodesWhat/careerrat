// onboarding-write-log.mjs: puts what onboarding saved into the workspace thread.
//
// Onboarding saves apply with no click, so each save call appends ONE
// action_result carrying a `knowledge_write` entry per changed value, with an
// Undo for each reversible one. The entries come from the same builders the Ask
// writers use, so `knowledge.revert` undoes them the same way.

import { randomUUID } from "node:crypto";

import { findCompLeak } from "../profile/comp-guard.mjs";
import {
  buildKnowledgeWriteEntry,
  configWriteEntries,
  undoNextAction,
} from "./knowledge-write-log.mjs";
import { WORKSPACE_THREAD_ID, workspaceMessageAppend } from "./workspace-thread.mjs";

const SOURCE = Object.freeze({ kind: "onboarding" });
const WRITER = "onboarding";
const SUMMARY_LABELS = 4;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Dotted paths of the values a patch sets. Arrays replace wholesale on write, so
// an array is one leaf, not one per item.
function patchLeafPaths(patch, prefix = []) {
  if (!isPlainObject(patch)) return prefix.length ? [prefix.join(".")] : [];
  const paths = [];
  for (const [key, value] of Object.entries(patch)) {
    const next = [...prefix, key];
    if (isPlainObject(value)) paths.push(...patchLeafPaths(value, next));
    else paths.push(next.join("."));
  }
  return paths;
}

function labelFor(path) {
  // A pay field name never goes in a label; the entry itself already redacts it.
  if (findCompLeak(path)) return "Private pay detail";
  const text = String(path).replaceAll(/[._]/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "Setting";
}

// Entries for one onboarding config save: a path per value the patch set.
export function onboardingConfigEntries({ name, patch, before, after }) {
  return configWriteEntries({
    before: { [name]: before },
    after: { [name]: after },
    writes: patchLeafPaths(patch).map((path) => ({ name, path, label: labelFor(path) })),
    source: SOURCE,
    writer: WRITER,
  });
}

// Entries for claims the evidence seed added: one "add" per new claim id.
export function onboardingEvidenceEntries({ beforeClaims, afterClaims }) {
  const known = new Set((beforeClaims || []).map((claim) => String(claim?.id ?? "")));
  return (afterClaims || [])
    .filter((claim) => !known.has(String(claim?.id ?? "")))
    .map((claim) =>
      buildKnowledgeWriteEntry({
        target: "evidence",
        op: "add",
        id: claim.id,
        before: undefined,
        after: claim,
        source: SOURCE,
        writer: WRITER,
        label: "Evidence claim",
      })
    );
}

function summaryText(entries) {
  const labels = [...new Set(entries.map((entry) => entry.label).filter(Boolean))];
  const shown = labels.slice(0, SUMMARY_LABELS).join(", ");
  const more = labels.length > SUMMARY_LABELS ? ` and ${labels.length - SUMMARY_LABELS} more` : "";
  const count = entries.length;
  return `Onboarding saved ${count} ${count === 1 ? "change" : "changes"}${
    shown ? `: ${shown}${more}` : ""
  }.`;
}

// One thread message per save call. Returns the stored message id, or null when
// there was nothing to log.
export function appendOnboardingWriteLog({ repoRoot, env, entries, now } = {}) {
  if (!entries?.length) return null;
  const id = randomUUID();
  const nextActions = entries.flatMap((entry, index) =>
    entry.revertible ? [undoNextAction({ messageId: id, index, entry })] : []
  );
  workspaceMessageAppend({
    repoRoot,
    env,
    id,
    role: "assistant",
    kind: "action_result",
    text: summaryText(entries),
    entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
    artifacts: entries,
    metadata: { writer: WRITER, ...(nextActions.length ? { nextActions } : {}) },
    now,
  });
  return id;
}
