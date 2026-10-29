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

// The profile normalizer stamps this on whenever a location mode field is saved.
const LOCATION_MODE_FIELDS = new Set([
  "remote",
  "remote_scope",
  "hybrid",
  "onsite",
  "relocation",
  "max_commute_days_per_week",
]);
const LOCATION_CONFIRMED_PATH = "location.mode_preferences_confirmed";

// Entries for one onboarding config save: a path per value the patch set.
// `mirror` ({ name, patch, before, after }) is a second doc written in the same
// request. Its values ride as companions of ONE entry, so a single Undo puts
// back both docs, and a change to either since makes the Undo refuse.
export function onboardingConfigEntries({ name, patch, before, after, mirror }) {
  const paths = patchLeafPaths(patch);
  const beforeDocs = { [name]: before };
  const afterDocs = { [name]: after };
  if (mirror) {
    beforeDocs[mirror.name] = mirror.before;
    afterDocs[mirror.name] = mirror.after;
    const [first, ...rest] = paths;
    const writes = first
      ? [
          {
            name,
            path: first,
            label: labelFor(first),
            companions: [
              ...rest,
              ...patchLeafPaths(mirror.patch).map((path) => ({ name: mirror.name, path })),
            ],
          },
        ]
      : [];
    return configWriteEntries({
      before: beforeDocs,
      after: afterDocs,
      writes,
      source: SOURCE,
      writer: WRITER,
    });
  }
  let confirmedPending = name === "profile";
  const writes = paths.map((path) => {
    const write = { name, path, label: labelFor(path) };
    const [section, field] = path.split(".");
    if (confirmedPending && section === "location" && LOCATION_MODE_FIELDS.has(field)) {
      confirmedPending = false;
      write.companions = [LOCATION_CONFIRMED_PATH];
    }
    return write;
  });
  return configWriteEntries({
    before: beforeDocs,
    after: afterDocs,
    writes,
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
