import { createHash, randomUUID } from "node:crypto";

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
const ONBOARDING_TRANSCRIPT_CHAR_LIMIT = 16_000;

export const WORKSPACE_INTENT_ENTITY_TYPES = Object.freeze({
  "interview.prepare": ["application"],
  "interview.prepare-request": ["workspace"],
  "interview.schedule": ["application"],
  "interview.capture-context": ["intake"],
  "scheduling.prepare": ["communication"],
  "scheduling.prepare-request": ["workspace"],
  "job.evaluate": ["application", "sourced"],
  "job.evaluate-request": ["workspace", "intake"],
  "job.prepare-request": ["workspace", "intake"],
  "job.tailor-request": ["workspace", "intake"],
  "job.generate-documents": ["application"],
  "job.export-documents": ["application"],
  "job.apply": ["application"],
  "screening.answer": ["workspace", "application"],
  "screening.answer-save": ["candidate"],
  "application.record-external": ["application"],
  "application.record-external-request": ["workspace"],
  "source.add": ["workspace"],
  "source.query-add": ["workspace"],
  "source.set-enabled": ["workspace"],
  "source.discover": ["workspace"],
  "company.discover": ["workspace"],
  "company.proposal-decide": ["company-proposal"],
  "research.company": ["workspace", "company"],
  "research.company-request": ["workspace"],
  "research.comp": ["workspace"],
  "research.record": ["workspace"],
  "company.health": ["application", "sourced"],
  "company.health-request": ["workspace"],
  "company.health-record": ["application", "sourced"],
  "strategy.review": ["workspace"],
  "strategy.apply": ["workspace"],
  "strategy.stamp": ["workspace"],
  "settings.explain": ["workspace"],
  "settings.apply": ["workspace"],
  "search.run": ["workspace"],
  "sourced.promote": ["sourced"],
  "sourced.skip": ["sourced"],
  "communication.draft": ["communication"],
  "communication.draft-request": ["workspace"],
  "communication.send": ["communication"],
  "communication.add-note": ["communication"],
  "communication.note-request": ["workspace"],
  "communication.record-external": ["communication"],
  "communication.record-external-request": ["workspace"],
  "communication.handoff": ["communication"],
  "communication.handoff-request": ["workspace"],
  "communication.capture-inbound": ["intake"],
  "outcome.record": ["application"],
  "outcome.record-request": ["workspace"],
  "calendar.record-write": ["workspace"],
  "relationship.record-lead": ["workspace"],
  "relationship.source-request": ["workspace"],
  "status.sync-request": ["workspace"],
  "mail.sync-request": ["workspace"],
  "messages.sync-request": ["workspace"],
  "linkedin.optimize-request": ["workspace"],
  "linkedin.proposal-decide": ["linkedin-proposal"],
  "status.record-portal-request": ["workspace"],
  "status.record-portal": ["application"],
  "status.apply-transition": ["application"],
  "issue.report": ["workspace"],
  "issue.record-filed": ["workspace"],
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

function normalizeOnboardingMessages(transcript) {
  const candidates = (Array.isArray(transcript) ? transcript : []).flatMap((message) => {
    const role = String(message?.role || "").trim();
    const text = String(message?.text || "").trim();
    return (role === "user" || role === "assistant") && text ? [{ role, text }] : [];
  });
  const bounded = [];
  let remaining = ONBOARDING_TRANSCRIPT_CHAR_LIMIT;
  for (let index = candidates.length - 1; index >= 0 && remaining > 0; index--) {
    const message = candidates[index];
    const text = message.text.length > remaining ? message.text.slice(-remaining) : message.text;
    bounded.push({ ...message, text });
    remaining -= text.length;
  }
  return bounded.reverse();
}

export function workspaceOnboardingHandoff({
  repoRoot,
  env = process.env,
  transcript,
  handoffText,
  finishedAt,
  now,
} = {}) {
  const messages = normalizeOnboardingMessages(transcript);
  const finalText = cleanText(handoffText, { required: true });
  const at = dateIso(now);
  const completedAt = dateIso(finishedAt || at);
  const transcriptHash = createHash("sha256")
    .update(JSON.stringify({ messages, handoffText: finalText }))
    .digest("hex");
  const db = requireDb({ repoRoot, env });

  return withTransaction(db, () => {
    const thread = ensureThread(db, at);
    const currentMessages = readMessages(db);
    const allOnboardingMessages = currentMessages.filter(
      (message) => message.metadata?.source === "onboarding"
    );
    const existingImported = currentMessages.filter(
      (message) =>
        message.metadata?.source === "onboarding" &&
        message.metadata?.handoffHash === transcriptHash
    );
    const expectedCount = messages.length + 1;
    if (
      thread.onboardingHandoff?.transcriptHash === transcriptHash &&
      allOnboardingMessages.length === expectedCount &&
      existingImported.length === expectedCount
    ) {
      return {
        ok: true,
        reused: true,
        thread,
        messages: existingImported,
        finishedAt: thread.onboardingHandoff.finishedAt,
      };
    }

    const preserved = currentMessages.filter(
      (message) => message.metadata?.source !== "onboarding"
    );
    const imported = [...messages, { role: "assistant", text: finalText }].map(
      (message, index) => ({
        id: `onboarding-${transcriptHash.slice(0, 20)}-${index + 1}`,
        threadId: WORKSPACE_THREAD_ID,
        sequence: index + 1,
        role: message.role,
        kind: "text",
        text: message.text,
        createdAt: completedAt,
        metadata: { source: "onboarding", handoffHash: transcriptHash },
      })
    );
    const ordered = [...imported, ...preserved].map((message, index) => ({
      ...message,
      sequence: index + 1,
    }));

    db.prepare("DELETE FROM workspace_messages WHERE thread_id = ?").run(WORKSPACE_THREAD_ID);
    const insert = db.prepare(
      "INSERT INTO workspace_messages (id, thread_id, sequence, data) VALUES (?, ?, ?, ?)"
    );
    for (const message of ordered) {
      insert.run(message.id, WORKSPACE_THREAD_ID, message.sequence, JSON.stringify(message));
    }

    const updatedThread = {
      ...thread,
      updatedAt: at,
      onboardingHandoff: {
        transcriptHash,
        messageCount: imported.length,
        finishedAt: completedAt,
        importedAt: at,
      },
    };
    db.prepare("UPDATE workspace_threads SET data = ? WHERE id = ?").run(
      JSON.stringify(updatedThread),
      WORKSPACE_THREAD_ID
    );
    return {
      ok: true,
      reused: false,
      thread: updatedThread,
      messages: imported,
      finishedAt: completedAt,
    };
  });
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
    "interview.prepare-request": "Resolve and prepare this interview",
    "interview.schedule": "Schedule this interview",
    "interview.capture-context": "Capture this interview context",
    "job.evaluate": "Evaluate this job",
    "job.evaluate-request": "Capture and evaluate this job",
    "job.prepare-request": "Evaluate and prepare this application",
    "job.tailor-request": "Evaluate and tailor documents for this job",
    "job.generate-documents": "Generate tailored application documents",
    "job.export-documents": "Export packaged application documents",
    "job.apply": "Apply on this site",
    "screening.answer": "Draft an evidence-backed screening answer",
    "screening.answer-save": "Save this reviewed answer for future applications",
    "application.record-external": "Record that I applied elsewhere",
    "application.record-external-request": "Resolve and record that I applied elsewhere",
    "source.add": "Add this job board",
    "source.query-add": "Add a job search",
    "source.set-enabled": "Change this search source",
    "source.discover": "Find and review new job boards",
    "company.discover": "Discover more matching companies",
    "company.proposal-decide": "Review this company proposal",
    "research.company": "Research this company",
    "research.company-request": "Resolve and research this company",
    "research.comp": "Research market comp",
    "research.record": "Save this research to your workspace",
    "company.health": "Check company health",
    "company.health-request": "Resolve and check company health",
    "company.health-record": "Save this company-health rating",
    "strategy.review": "Review my search strategy",
    "strategy.apply": "Apply this strategy recommendation",
    "strategy.stamp": "Finish this strategy review",
    "settings.explain": "Show my settings",
    "settings.apply": "Apply this settings change",
    "search.run": "Search for qualified jobs",
    "sourced.promote": "Promote this qualified role",
    "sourced.skip": "Skip this role",
    "communication.draft": "Draft a response",
    "communication.draft-request": "Resolve and draft a response",
    "communication.send": "Send the reviewed response",
    "communication.add-note": "Add a note to this conversation",
    "communication.note-request": "Resolve and add this note",
    "communication.record-external": "Record that I sent this response elsewhere",
    "communication.record-external-request": "Resolve and record this external response",
    "communication.handoff": "Prepare this reply to send",
    "communication.handoff-request": "Resolve and prepare this send",
    "communication.capture-inbound": "Capture this inbound recruiter message",
    "outcome.record": "Record this outcome",
    "outcome.record-request": "Resolve and record this outcome",
    "status.sync-request": "Check portal statuses",
    "mail.sync-request": "Check for new mail",
    "messages.sync-request": "Check for new messages",
    "linkedin.optimize-request": "Optimize LinkedIn profile",
    "linkedin.proposal-decide": "Decide a LinkedIn suggestion",
    "status.record-portal-request": "Resolve and record this portal status",
    "status.record-portal": "Record this portal status",
    "status.apply-transition": "Apply this proposed status update",
    "calendar.record-write": "Record a calendar event you added",
    "issue.report": "Prepare a redacted bug report",
    "issue.record-filed": "Record that I filed the issue",
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
