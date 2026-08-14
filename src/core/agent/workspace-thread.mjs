import { randomUUID } from "node:crypto";

import { requireDb } from "../db/connection.mjs";
import { withTransaction } from "../db/transaction.mjs";

export const WORKSPACE_THREAD_ID = "workspace-main";

const ROLE_VALUES = new Set(["user", "assistant", "system", "tool"]);
const KIND_VALUES = new Set([
  "text",
  "intake",
  "intent",
  "action_result",
  "action_error",
  "agent_error",
  "status",
]);

export const WORKSPACE_INTENT_ENTITY_TYPES = Object.freeze({
  "interview.prepare": ["application"],
  "interview.schedule": ["application"],
  "interview.capture-context": ["intake"],
  "job.evaluate": ["application", "sourced"],
  "job.evaluate-request": ["workspace"],
  "job.prepare-request": ["workspace"],
  "job.generate-documents": ["application"],
  "job.export-documents": ["application"],
  "job.apply": ["application"],
  "application.record-external": ["application"],
  "search.run": ["workspace"],
  "sourced.promote": ["sourced"],
  "sourced.skip": ["sourced"],
  "communication.draft": ["communication"],
  "communication.send": ["communication"],
  "communication.add-note": ["communication"],
  "communication.record-external": ["communication"],
  "communication.capture-inbound": ["intake"],
  "outcome.record": ["application"],
  "profile.enrich": ["candidate"],
});

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function dateIso(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime()))
    throw makeError("invalid workspace message date", "BAD_DATE");
  return date.toISOString();
}

function cleanText(value, { required = false, max = 50_000 } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) throw makeError("message text is required", "EMPTY_TEXT");
  if (text.length > max) throw makeError(`message text exceeds ${max} characters`, "TEXT_TOO_LONG");
  return text;
}

function jsonClone(value, label) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw makeError(`${label} must be JSON-serializable`, "BAD_JSON");
  }
}

function readThreadRow(db) {
  const row = db
    .prepare("SELECT data FROM workspace_threads WHERE id = ?")
    .get(WORKSPACE_THREAD_ID);
  return row ? JSON.parse(row.data) : null;
}

function ensureThread(db, at) {
  const existing = readThreadRow(db);
  if (existing) return existing;
  const thread = {
    id: WORKSPACE_THREAD_ID,
    title: "Career workspace",
    status: "active",
    createdAt: at,
    updatedAt: at,
  };
  db.prepare("INSERT INTO workspace_threads (id, data) VALUES (?, ?)").run(
    WORKSPACE_THREAD_ID,
    JSON.stringify(thread)
  );
  return thread;
}

function readMessages(db) {
  return db
    .prepare("SELECT data FROM workspace_messages WHERE thread_id = ? ORDER BY sequence ASC")
    .all(WORKSPACE_THREAD_ID)
    .map((row) => JSON.parse(row.data));
}

export function workspaceThreadOpen({ repoRoot, env = process.env, now } = {}) {
  const db = requireDb({ repoRoot, env });
  const at = dateIso(now);
  const thread = withTransaction(db, () => ensureThread(db, at));
  return { ok: true, thread, messages: readMessages(db) };
}

export function workspaceThreadRead({ repoRoot, env = process.env } = {}) {
  const db = requireDb({ repoRoot, env });
  const thread = readThreadRow(db);
  if (!thread) return { ok: true, thread: null, messages: [] };
  return { ok: true, thread, messages: readMessages(db) };
}

export function workspaceMessageAppend({
  repoRoot,
  env = process.env,
  role,
  kind = "text",
  text,
  intent,
  entity,
  artifacts,
  error,
  metadata,
  now,
  id,
} = {}) {
  const cleanRole = String(role || "").trim();
  const cleanKind = String(kind || "").trim();
  if (!ROLE_VALUES.has(cleanRole))
    throw makeError(`unsupported message role: ${cleanRole}`, "BAD_ROLE");
  if (!KIND_VALUES.has(cleanKind))
    throw makeError(`unsupported message kind: ${cleanKind}`, "BAD_KIND");
  const cleanMessageText = cleanText(text, {
    required: cleanKind === "text" || cleanKind === "intake",
    max: cleanKind === "intake" ? 1024 * 1024 : 50_000,
  });
  const at = dateIso(now);
  const db = requireDb({ repoRoot, env });

  const result = withTransaction(db, () => {
    const thread = ensureThread(db, at);
    const sequence = db
      .prepare(
        "SELECT coalesce(max(sequence), 0) + 1 AS next FROM workspace_messages WHERE thread_id = ?"
      )
      .get(WORKSPACE_THREAD_ID).next;
    const message = {
      id: String(id || randomUUID()),
      threadId: WORKSPACE_THREAD_ID,
      sequence,
      role: cleanRole,
      kind: cleanKind,
      text: cleanMessageText,
      createdAt: at,
    };
    if (intent !== undefined) message.intent = jsonClone(intent, "intent");
    if (entity !== undefined) message.entity = jsonClone(entity, "entity");
    if (artifacts !== undefined) message.artifacts = jsonClone(artifacts, "artifacts");
    if (error !== undefined) message.error = jsonClone(error, "error");
    if (metadata !== undefined) message.metadata = jsonClone(metadata, "metadata");

    db.prepare(
      "INSERT INTO workspace_messages (id, thread_id, sequence, data) VALUES (?, ?, ?, ?)"
    ).run(message.id, WORKSPACE_THREAD_ID, sequence, JSON.stringify(message));

    const updatedThread = { ...thread, updatedAt: at };
    db.prepare("UPDATE workspace_threads SET data = ? WHERE id = ?").run(
      JSON.stringify(updatedThread),
      WORKSPACE_THREAD_ID
    );
    return { thread: updatedThread, message };
  });

  return { ok: true, ...result };
}

export function normalizeWorkspaceIntent(value) {
  const type = String(value?.type || "").trim();
  const allowedEntityTypes = WORKSPACE_INTENT_ENTITY_TYPES[type];
  if (!allowedEntityTypes)
    throw makeError(`unsupported workspace intent: ${type}`, "UNSUPPORTED_INTENT");

  const entityType = String(value?.entity?.type || "").trim();
  const entityId = String(value?.entity?.id || "").trim();
  if (!allowedEntityTypes.includes(entityType)) {
    throw makeError(
      `${type} requires entity type ${allowedEntityTypes.join(" or ")}`,
      "BAD_INTENT_ENTITY"
    );
  }
  if (!entityId) throw makeError(`${type} requires an entity id`, "BAD_INTENT_ENTITY");

  const intent = { type, entity: { type: entityType, id: entityId } };
  if (value.input !== undefined) intent.input = jsonClone(value.input, "intent input");
  return intent;
}

function intentText(intent) {
  const descriptions = {
    "interview.prepare": "Prepare this interview",
    "interview.schedule": "Schedule this interview",
    "interview.capture-context": "Capture this interview context",
    "job.evaluate": "Evaluate this job",
    "job.evaluate-request": "Capture and evaluate this job",
    "job.prepare-request": "Evaluate and prepare this application",
    "job.generate-documents": "Generate tailored application documents",
    "job.export-documents": "Export packaged application documents",
    "job.apply": "Apply on this site",
    "application.record-external": "Record that I applied elsewhere",
    "search.run": "Search for qualified jobs",
    "sourced.promote": "Promote this qualified role",
    "sourced.skip": "Skip this role",
    "communication.draft": "Draft a response",
    "communication.send": "Send the reviewed response",
    "communication.add-note": "Add a note to this conversation",
    "communication.record-external": "Record that I sent this response elsewhere",
    "communication.capture-inbound": "Capture this inbound recruiter message",
    "outcome.record": "Record this outcome",
    "profile.enrich": "Enrich my profile",
  };
  return `${descriptions[intent.type]} (${intent.entity.type}:${intent.entity.id}).`;
}

export function workspaceIntentAppend({ repoRoot, env = process.env, intent, now, id } = {}) {
  const normalized = normalizeWorkspaceIntent(intent);
  return workspaceMessageAppend({
    repoRoot,
    env,
    role: "user",
    kind: "intent",
    text: intentText(normalized),
    intent: normalized,
    entity: normalized.entity,
    now,
    id,
  });
}
