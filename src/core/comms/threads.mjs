// Communication thread helpers for CareerRat.
// Zero runtime dependencies. All functions are immutable — inputs are never mutated.

const VALID_CHANNELS = new Set(["email", "linkedin", "portal", "phone", "sms", "other"]);
const VALID_STATUSES = new Set([
  "needs-reply",
  "drafted",
  "waiting",
  "scheduled",
  "closed",
  "blocked",
]);
const TERMINAL_STATUSES = new Set(["closed", "blocked"]);

// ---------------------------------------------------------------------------
// slugifyThreadId
// ---------------------------------------------------------------------------

/**
 * slugifyThreadId({ company, role, channel })
 * → deterministic id like "comm-<company-slug>-<role-slug>-<channel>"
 */
export function slugifyThreadId({ company = "", role = "", channel = "" }) {
  const slugify = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .replace(/-{2,}/g, "-");

  const parts = [slugify(company), slugify(role), slugify(channel)].filter(Boolean);
  return `comm-${parts.join("-")}`;
}

// ---------------------------------------------------------------------------
// createThread
// ---------------------------------------------------------------------------

/**
 * createThread({ company, role, channel, applicationId, sourcedId,
 *                subject, participants, status, summary, nextAction,
 *                nextActionDue, id })
 * → a new schema-valid communication object.
 */
export function createThread({
  company = "",
  role = "",
  channel = "email",
  applicationId,
  sourcedId,
  subject,
  participants,
  status = "needs-reply",
  summary = "",
  nextAction,
  nextActionDue,
  id,
} = {}) {
  if (!company && !role && !channel) {
    throw new Error(
      "Cannot create thread: at least one of company, role, or channel must be non-empty."
    );
  }
  if (!VALID_CHANNELS.has(channel)) {
    throw new Error(
      `Invalid channel "${channel}". Must be one of: ${[...VALID_CHANNELS].join(", ")}.`
    );
  }
  if (!VALID_STATUSES.has(status)) {
    throw new Error(
      `Invalid status "${status}". Must be one of: ${[...VALID_STATUSES].join(", ")}.`
    );
  }

  const resolvedId = id || slugifyThreadId({ company, role, channel });

  const thread = {
    id: resolvedId,
    threadId: resolvedId,
    status,
    summary,
    messages: [],
  };

  if (company) thread.company = company;
  if (role) thread.role = role;
  if (channel) thread.channel = channel;
  if (applicationId !== undefined) thread.applicationId = applicationId;
  if (sourcedId !== undefined) thread.sourcedId = sourcedId;
  if (subject !== undefined) thread.subject = subject;
  if (participants !== undefined) thread.participants = participants;
  if (nextAction !== undefined) thread.nextAction = nextAction;
  if (nextActionDue !== undefined) thread.nextActionDue = nextActionDue;

  return thread;
}

// ---------------------------------------------------------------------------
// findThread
// ---------------------------------------------------------------------------

/**
 * findThread(communications, selector)
 * → first matching communication or null.
 * Match priority: id/threadId > applicationId/sourcedId > company+role > subject.
 */
export function findThread(communications, selector = {}) {
  if (!Array.isArray(communications) || communications.length === 0) return null;

  // 1. Exact id or threadId match
  if (selector.id !== undefined || selector.threadId !== undefined) {
    const target = selector.id || selector.threadId;
    const found = communications.find((c) => c.id === target || c.threadId === target);
    if (found) return found;
  }

  // 2. applicationId or sourcedId
  if (selector.applicationId !== undefined) {
    const found = communications.find((c) => c.applicationId === selector.applicationId);
    if (found) return found;
  }
  if (selector.sourcedId !== undefined) {
    const found = communications.find((c) => c.sourcedId === selector.sourcedId);
    if (found) return found;
  }

  // 3. company + role (case-insensitive)
  if (selector.company !== undefined && selector.role !== undefined) {
    const co = selector.company.toLowerCase();
    const ro = selector.role.toLowerCase();
    const found = communications.find(
      (c) => (c.company || "").toLowerCase() === co && (c.role || "").toLowerCase() === ro
    );
    if (found) return found;
  }

  // 4. subject (case-insensitive contains)
  if (selector.subject !== undefined) {
    const sub = selector.subject.toLowerCase();
    const found = communications.find((c) => (c.subject || "").toLowerCase().includes(sub));
    if (found) return found;
  }

  return null;
}

// ---------------------------------------------------------------------------
// appendMessage
// ---------------------------------------------------------------------------

/**
 * appendMessage(thread, message, { now } = {})
 * → new thread with message appended; direction→status/timestamp side effects applied.
 */
export function appendMessage(thread, message, { now } = {}) {
  if (!message?.direction) {
    throw new Error("message.direction is required.");
  }
  if (message.summary === undefined || message.summary === null) {
    throw new Error("message.summary is required.");
  }

  const isTerminal = TERMINAL_STATUSES.has(thread.status);

  // Resolve timestamp
  const timestamp =
    message.at ||
    (now instanceof Date ? now.toISOString() : typeof now === "string" ? now : undefined);

  // Build the stored message — omit undefined keys
  const storedMessage = { direction: message.direction, summary: message.summary };
  if (timestamp !== undefined) storedMessage.at = timestamp;
  if (message.id !== undefined) storedMessage.id = message.id;
  if (message.from !== undefined) storedMessage.from = message.from;
  if (message.to !== undefined) storedMessage.to = message.to;
  if (message.subject !== undefined) storedMessage.subject = message.subject;
  if (message.artifactPath !== undefined) storedMessage.artifactPath = message.artifactPath;
  if (message.nextAction !== undefined) storedMessage.nextAction = message.nextAction;

  // Compute updated thread fields
  const updates = {
    messages: [...(thread.messages || []), storedMessage],
  };

  if (!isTerminal) {
    if (message.direction === "inbound") {
      updates.status = "needs-reply";
      if (timestamp !== undefined) updates.lastInboundAt = timestamp;
    } else if (message.direction === "outbound-sent") {
      updates.status = "waiting";
      if (timestamp !== undefined) updates.lastOutboundAt = timestamp;
    } else if (message.direction === "outbound-draft") {
      updates.status = "drafted";
    }
    // "note" → no status/timestamp change
  } else {
    // terminal: still record timestamps but don't change status
    if (message.direction === "inbound" && timestamp !== undefined) {
      updates.lastInboundAt = timestamp;
    } else if (message.direction === "outbound-sent" && timestamp !== undefined) {
      updates.lastOutboundAt = timestamp;
    }
  }

  // Carry message.nextAction to thread.nextAction if present
  if (message.nextAction !== undefined) {
    updates.nextAction = message.nextAction;
  }

  return Object.assign({}, thread, updates);
}

// ---------------------------------------------------------------------------
// setStatus
// ---------------------------------------------------------------------------

/**
 * setStatus(thread, status, { nextAction, nextActionDue } = {})
 * → new thread with status (and optional nextAction/nextActionDue).
 */
export function setStatus(thread, status, { nextAction, nextActionDue } = {}) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(
      `Invalid status "${status}". Must be one of: ${[...VALID_STATUSES].join(", ")}.`
    );
  }
  const updates = { status };
  if (nextAction !== undefined) updates.nextAction = nextAction;
  if (nextActionDue !== undefined) updates.nextActionDue = nextActionDue;
  return Object.assign({}, thread, updates);
}

// ---------------------------------------------------------------------------
// upsertCommunication
// ---------------------------------------------------------------------------

/**
 * upsertCommunication(trackerData, thread)
 * → new trackerData with communications containing thread (replace by id if present, else append).
 */
export function upsertCommunication(trackerData, thread) {
  const existing = Array.isArray(trackerData.communications) ? trackerData.communications : [];
  const idx = existing.findIndex((c) => c.id === thread.id);
  let communications;
  if (idx === -1) {
    communications = [...existing, thread];
  } else {
    communications = existing.map((c, i) => (i === idx ? thread : c));
  }
  return Object.assign({}, trackerData, { communications });
}

// ---------------------------------------------------------------------------
// summarizeThread
// ---------------------------------------------------------------------------

/**
 * summarizeThread(thread)
 * → "[<status>] <company> – <role> (<channel>): <summary> · next: <nextAction or "—">"
 */
export function summarizeThread(thread) {
  const company = thread.company || "";
  const role = thread.role || "";
  const channel = thread.channel || "";
  const summary = thread.summary || "";
  const next = thread.nextAction || "N/A";
  return `[${thread.status}] ${company} – ${role} (${channel}): ${summary} · next: ${next}`;
}

// ---------------------------------------------------------------------------
// renderThreadNote
// ---------------------------------------------------------------------------

/**
 * renderThreadNote(thread)
 * → markdown for workspace/comms/<id>.md
 */
export function renderThreadNote(thread) {
  const lines = [];

  // YAML frontmatter
  lines.push("---");
  lines.push(`id: ${thread.id}`);
  if (thread.company) lines.push(`company: ${thread.company}`);
  if (thread.role) lines.push(`role: ${thread.role}`);
  if (thread.channel) lines.push(`channel: ${thread.channel}`);
  lines.push(`status: ${thread.status}`);
  if (thread.applicationId) lines.push(`applicationId: ${thread.applicationId}`);
  if (thread.sourcedId) lines.push(`sourcedId: ${thread.sourcedId}`);
  lines.push("---");
  lines.push("");

  // Title
  lines.push(`# ${thread.company || ""} – ${thread.role || ""}`);
  lines.push("");

  // Summary section
  lines.push("## Summary");
  lines.push("");
  lines.push(thread.summary || "");
  lines.push("");

  // Next Action
  lines.push(`**Next Action:** ${thread.nextAction || "N/A"}`);
  if (thread.nextActionDue) lines.push(`**Due:** ${thread.nextActionDue}`);
  lines.push("");

  // Messages
  lines.push("## Messages");
  lines.push("");
  const messages = thread.messages || [];
  if (messages.length === 0) {
    lines.push("_No messages yet._");
  } else {
    for (const msg of messages) {
      const at = msg.at || "N/A";
      lines.push(`- ${at} **${msg.direction}**: ${msg.summary}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}
