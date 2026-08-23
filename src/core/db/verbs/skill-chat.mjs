import { randomUUID } from "node:crypto";

import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";

const CHAT_ROLES = new Set(["user", "assistant"]);
const TURN_STATES = new Set(["awaiting-assistant", "awaiting-user", "failed", "completed"]);

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
  visibility,
  runtimeSessionId,
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
  const cleanVisibility = visibility === "internal" ? "internal" : null;
  const at = dateIso(now);
  const db = requireDb({ repoRoot, env });

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
    const message = {
      id: randomUUID(),
      threadId: thread.id,
      sequence,
      role: cleanRole,
      text: cleanMessage,
      createdAt: at,
      ...(cleanVisibility ? { visibility: cleanVisibility } : {}),
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

export function skillChatTranscriptAdopt({
  repoRoot,
  env = process.env,
  skill,
  messages,
  now,
} = {}) {
  const clean = cleanSkill(skill);
  const normalized = (Array.isArray(messages) ? messages : []).flatMap((message) => {
    const role = String(message?.role || "").trim();
    if (!CHAT_ROLES.has(role)) return [];
    try {
      return [{ role, text: cleanText(message?.text) }];
    } catch {
      return [];
    }
  });
  const at = dateIso(now);
  const db = requireDb({ repoRoot, env });

  return withTransaction(db, () => {
    const existing = readThread(db, clean);
    if (existing) {
      return {
        ok: true,
        adopted: false,
        thread: existing,
        messages: readMessages(db, existing.id),
      };
    }
    if (!normalized.length) return { ok: true, adopted: false, thread: null, messages: [] };

    const lastRole = normalized[normalized.length - 1].role;
    const thread = createThread(clean, at, {
      messageCount: normalized.length,
      turnState: lastRole === "assistant" ? "awaiting-user" : "awaiting-assistant",
    });
    thread.lastRole = lastRole;
    db.prepare("INSERT INTO skill_chat_threads (id, data) VALUES (?, ?)").run(
      thread.id,
      JSON.stringify(thread)
    );
    const insert = db.prepare(
      "INSERT INTO skill_chat_messages (id, thread_id, sequence, data) VALUES (?, ?, ?, ?)"
    );
    const adoptedMessages = normalized.map((message, index) => ({
      id: randomUUID(),
      threadId: thread.id,
      sequence: index + 1,
      ...message,
      createdAt: at,
    }));
    for (const message of adoptedMessages) {
      insert.run(message.id, thread.id, message.sequence, JSON.stringify(message));
    }
    return { ok: true, adopted: true, thread, messages: adoptedMessages };
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
