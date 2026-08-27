import { randomUUID } from "node:crypto";

import {
  choiceMetadataForMessage,
  resolvePendingMessageChoice,
} from "../../agent/choice-prompt.mjs";
import { normalizeSourceReviewArtifact } from "../../discovery/source-review-artifact.mjs";
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";

const CHAT_ROLES = new Set(["user", "assistant"]);
const CHAT_KINDS = new Set(["agent_error"]);
const TURN_STATES = new Set(["awaiting-assistant", "awaiting-user", "failed", "completed"]);
const DECISION_ACTIONS = new Set(["save", "discard"]);
const DECISION_STATES = new Set(["completed", "failed"]);

function cleanSkill(value) {
  const skill = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(skill)) {
    const error = new Error("skill is invalid");
    error.code = "BAD_SKILL";
    throw error;
  }
  return skill;
}

function cleanText(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    const error = new Error("chat message text is required");
    error.code = "EMPTY_TEXT";
    throw error;
  }
  if (text.length > 100_000) {
    const error = new Error("chat message text exceeds 100000 characters");
    error.code = "TEXT_TOO_LONG";
    throw error;
  }
  return text;
}

function cleanArtifacts(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 4) {
    const error = new Error("chat message artifacts are invalid");
    error.code = "BAD_ARTIFACTS";
    throw error;
  }
  const artifacts = value.map((artifact) => normalizeSourceReviewArtifact(artifact));
  if (artifacts.some((artifact) => !artifact)) {
    const error = new Error("chat message artifact is invalid");
    error.code = "BAD_ARTIFACT";
    throw error;
  }
  return artifacts;
}

function dateIso(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : value == null ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    const error = new Error("invalid chat message date");
    error.code = "BAD_DATE";
    throw error;
  }
  return date.toISOString();
}

function parseRow(row) {
  return row ? JSON.parse(row.data) : null;
}

function threadId(skill) {
  return `skill:${skill}`;
}

function readThread(db, skill) {
  return parseRow(db.prepare("SELECT data FROM skill_chat_threads WHERE skill = ?").get(skill));
}

function readMessages(db, id) {
  return db
    .prepare("SELECT data FROM skill_chat_messages WHERE thread_id = ? ORDER BY sequence ASC")
    .all(id)
    .map((row) => JSON.parse(row.data));
}

function createThread(skill, at, { messageCount = 0, turnState } = {}) {
  return {
    id: threadId(skill),
    skill,
    status: "active",
    messageCount,
    ...(turnState ? { turnState } : {}),
    createdAt: at,
    updatedAt: at,
  };
}

export function skillChatThreadRead({ repoRoot, env = process.env, skill } = {}) {
  const clean = cleanSkill(skill);
  const db = requireDb({ repoRoot, env });
  const thread = readThread(db, clean);
  return {
    ok: true,
    thread,
    messages: thread ? readMessages(db, thread.id) : [],
  };
}

export function skillChatMessageAppend({
  repoRoot,
  env = process.env,
  skill,
  role,
  text,
  kind,
  visibility,
  metadata,
  choice,
  artifacts,
  runtimeSessionId,
  id,
  now,
} = {}) {
  const clean = cleanSkill(skill);
  const cleanRole = String(role ?? "").trim();
  if (!CHAT_ROLES.has(cleanRole)) {
    const error = new Error(`unsupported chat message role: ${cleanRole}`);
    error.code = "BAD_ROLE";
    throw error;
  }
  const cleanMessage = cleanText(text);
  const cleanKind = kind == null ? null : String(kind).trim();
  if (cleanKind && !CHAT_KINDS.has(cleanKind)) {
    const error = new Error(`unsupported chat message kind: ${cleanKind}`);
    error.code = "BAD_KIND";
    throw error;
  }
  const cleanVisibility = visibility === "internal" ? "internal" : null;
  const cleanMetadata = {
    ...(metadata?.answerMode === "yes-no" ? { answerMode: "yes-no" } : {}),
    ...(metadata?.choicePrompt ? { choicePrompt: metadata.choicePrompt } : {}),
  };
  const cleanMessageArtifacts = cleanArtifacts(artifacts);
  const at = dateIso(now);
  const db = requireDb({ repoRoot, env });
  const messageId = id ? String(id).trim() : randomUUID();
  if (!messageId || messageId.length > 500 || messageId.includes("\0")) {
    const error = new Error("chat message id is invalid");
    error.code = "BAD_MESSAGE_ID";
    throw error;
  }

  return withTransaction(db, () => {
    let thread = readThread(db, clean);
    if (!thread) {
      thread = createThread(clean, at);
      db.prepare("INSERT INTO skill_chat_threads (id, data) VALUES (?, ?)").run(
        thread.id,
        JSON.stringify(thread)
      );
    }

    const sequence = db
      .prepare(
        "SELECT coalesce(max(sequence), 0) + 1 AS next FROM skill_chat_messages WHERE thread_id = ?"
      )
      .get(thread.id).next;
    const choiceResult =
      cleanRole === "user"
        ? resolvePendingMessageChoice(readMessages(db, thread.id), {
            text: cleanMessage,
            choice,
            now: at,
          })
        : null;
    if (choiceResult) {
      db.prepare("UPDATE skill_chat_messages SET data = ? WHERE id = ?").run(
        JSON.stringify(choiceResult.message),
        choiceResult.message.id
      );
    }
    const messageMetadata = choiceMetadataForMessage({
      metadata: cleanMetadata,
      role: cleanRole,
      threadId: thread.id,
      messageId,
      text: cleanMessage,
    });
    if (choiceResult) messageMetadata.choiceResolution = choiceResult.resolution;
    const message = {
      id: messageId,
      threadId: thread.id,
      sequence,
      role: cleanRole,
      text: cleanMessage,
      createdAt: at,
      ...(cleanKind ? { kind: cleanKind } : {}),
      ...(cleanVisibility ? { visibility: cleanVisibility } : {}),
      ...(Object.keys(messageMetadata).length ? { metadata: messageMetadata } : {}),
      ...(cleanMessageArtifacts ? { artifacts: cleanMessageArtifacts } : {}),
      ...(runtimeSessionId ? { runtimeSessionId: String(runtimeSessionId).slice(0, 500) } : {}),
    };
    db.prepare(
      "INSERT INTO skill_chat_messages (id, thread_id, sequence, data) VALUES (?, ?, ?, ?)"
    ).run(message.id, thread.id, sequence, JSON.stringify(message));

    const updatedThread = {
      ...thread,
      status: "active",
      messageCount: sequence,
      lastRole: cleanRole,
      turnState:
        cleanRole === "user" ? "awaiting-assistant" : thread.turnState || "awaiting-assistant",
      updatedAt: at,
    };
    db.prepare("UPDATE skill_chat_threads SET data = ? WHERE id = ?").run(
      JSON.stringify(updatedThread),
      thread.id
    );
    return { ok: true, thread: updatedThread, message };
  });
}

export function skillChatThreadSetTurnState({
  repoRoot,
  env = process.env,
  skill,
  turnState,
  now,
} = {}) {
  const clean = cleanSkill(skill);
  const cleanState = String(turnState || "").trim();
  if (!TURN_STATES.has(cleanState)) {
    const error = new Error(`unsupported chat turn state: ${cleanState}`);
    error.code = "BAD_TURN_STATE";
    throw error;
  }
  const at = dateIso(now);
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const thread = readThread(db, clean);
    if (!thread) {
      const error = new Error(`no durable chat thread for skill "${clean}"`);
      error.code = "NOT_FOUND";
      throw error;
    }
    const updated = { ...thread, turnState: cleanState, updatedAt: at };
    db.prepare("UPDATE skill_chat_threads SET data = ? WHERE id = ?").run(
      JSON.stringify(updated),
      updated.id
    );
    return { ok: true, thread: updated };
  });
}

export function skillChatDecisionSet({
  repoRoot,
  env = process.env,
  skill,
  decisionId,
  action,
  status = "completed",
  resultText,
  now,
} = {}) {
  const clean = cleanSkill(skill);
  const id = String(decisionId ?? "").trim();
  if (!id || id.length > 500 || id.includes("\0")) {
    const error = new Error("chat decision id is invalid");
    error.code = "BAD_DECISION_ID";
    throw error;
  }
  const cleanAction = String(action || "").trim();
  if (!DECISION_ACTIONS.has(cleanAction)) {
    const error = new Error(`unsupported chat decision action: ${cleanAction}`);
    error.code = "BAD_DECISION_ACTION";
    throw error;
  }
  const cleanStatus = String(status || "").trim();
  if (!DECISION_STATES.has(cleanStatus)) {
    const error = new Error(`unsupported chat decision status: ${cleanStatus}`);
    error.code = "BAD_DECISION_STATUS";
    throw error;
  }
  const summary = cleanText(resultText);
  const at = dateIso(now);
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const thread = readThread(db, clean);
    if (!thread) {
      const error = new Error(`no durable chat thread for skill "${clean}"`);
      error.code = "NOT_FOUND";
      throw error;
    }
    const decision = {
      id,
      action: cleanAction,
      status: cleanStatus,
      resultText: summary,
      updatedAt: at,
    };
    const decisions = (Array.isArray(thread.decisions) ? thread.decisions : []).filter(
      (candidate) => candidate?.id !== id
    );
    decisions.push(decision);
    const updated = { ...thread, decisions: decisions.slice(-200), updatedAt: at };
    db.prepare("UPDATE skill_chat_threads SET data = ? WHERE id = ?").run(
      JSON.stringify(updated),
      updated.id
    );
    return { ok: true, thread: updated, decision };
  });
}
