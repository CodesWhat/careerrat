// verbs/comm.mjs — communications[] domain actions. Pure comms writes — never
// outcome-changing, so none of these refresh the analytics block (AGENTS.md's
// Tracker Write Contract explicitly carves out "pure comms/scheduling writes").
import { randomUUID } from "node:crypto";
import { slugifyThreadId } from "../../comms/threads.mjs";
import { ensureJobThreadInDb } from "./chat-first.mjs";
import {
  appIdExists,
  bumpMeta,
  getRow,
  logActivityEvent,
  putRow,
  requireRow,
  runVerb,
} from "./shared.mjs";

function resolveApplicationId(db, comm) {
  return comm.applicationId && appIdExists(db, comm.applicationId) ? comm.applicationId : null;
}

function clean(value) {
  return String(value || "").trim();
}

function sameText(left, right) {
  return clean(left).toLowerCase() === clean(right).toLowerCase();
}

function assertArtifactPath(value) {
  const path = clean(value);
  if (!path) return null;
  if (!path.startsWith("workspace/") || path.includes("\0") || path.includes("../")) {
    const error = new Error("commCaptureInbound: artifactPath must be workspace-relative");
    error.code = "BAD_COMM_ARTIFACT";
    throw error;
  }
  return path;
}

function findInboundThread(db, { applicationId, company, role, channel }) {
  if (applicationId) {
    const rows = db
      .prepare("SELECT data FROM communications WHERE application_id = ? ORDER BY updated_at DESC")
      .all(applicationId);
    const matched = rows.map((row) => JSON.parse(row.data)).find((row) => row.channel === channel);
    if (matched) return matched;
  }
  return db
    .prepare("SELECT data FROM communications ORDER BY updated_at DESC")
    .all()
    .map((row) => JSON.parse(row.data))
    .find(
      (row) => row.channel === channel && sameText(row.company, company) && sameText(row.role, role)
    );
}

function mergeParticipant(participants, participant) {
  const current = Array.isArray(participants) ? participants.slice() : [];
  const name = clean(participant?.name);
  const email = clean(participant?.email);
  if (!name && !email) return current;
  const duplicate = current.some(
    (entry) =>
      (email && sameText(entry?.email, email)) || (!email && name && sameText(entry?.name, name))
  );
  if (!duplicate) current.push({ ...(name ? { name } : {}), ...(email ? { email } : {}) });
  return current;
}

// Capture a confirmed inbound message and open/reuse its communication thread
// in one transaction. The raw body remains in the referenced workspace
// artifact; tracker state keeps the actionable summary and durable provenance.
export function commCaptureInbound({
  repoRoot,
  env,
  applicationId,
  sourcedId,
  company,
  role,
  channel = "email",
  subject,
  participant,
  summary,
  artifactPath,
  sourceId,
  at,
} = {}) {
  const cleanChannel = clean(channel) || "email";
  if (!["email", "linkedin", "portal", "phone", "sms", "other"].includes(cleanChannel)) {
    const error = new Error(`commCaptureInbound: unsupported channel "${cleanChannel}"`);
    error.code = "BAD_COMM_CHANNEL";
    throw error;
  }
  const cleanSummary = clean(summary);
  if (!cleanSummary) throw new Error("commCaptureInbound: summary is required");
  const cleanArtifactPath = assertArtifactPath(artifactPath);
  const cleanCompany = clean(company);
  const cleanRole = clean(role);
  const cleanApplicationId = clean(applicationId);
  if (!cleanApplicationId && !cleanCompany && !cleanRole) {
    const error = new Error(
      "commCaptureInbound: an application, company, or role is required to identify the thread"
    );
    error.code = "COMMUNICATION_IDENTITY_REQUIRED";
    throw error;
  }

  return runVerb({ repoRoot, env }, (db) => {
    const linkedApplicationId =
      cleanApplicationId && appIdExists(db, cleanApplicationId) ? cleanApplicationId : null;
    if (!linkedApplicationId && !cleanCompany && !cleanRole) {
      const error = new Error(
        "commCaptureInbound: the referenced application does not exist and no company or role was supplied"
      );
      error.code = "COMMUNICATION_IDENTITY_REQUIRED";
      throw error;
    }
    const existing = findInboundThread(db, {
      applicationId: linkedApplicationId,
      company: cleanCompany,
      role: cleanRole,
      channel: cleanChannel,
    });
    const fallbackIdentity = cleanCompany || cleanRole || linkedApplicationId;
    let id =
      existing?.id ||
      slugifyThreadId({
        company: cleanCompany || fallbackIdentity,
        role: cleanRole,
        channel: cleanChannel,
      });
    if (!existing && id === `comm-${cleanChannel}` && linkedApplicationId) {
      id = slugifyThreadId({ company: linkedApplicationId, channel: cleanChannel });
    }
    const messageId = sourceId ? `intake:${clean(sourceId)}` : `inbound:${randomUUID()}`;
    const existingMessages = Array.isArray(existing?.messages) ? existing.messages.slice() : [];
    if (existingMessages.some((message) => message.id === messageId)) {
      return { id, created: false, duplicate: true, meta: null, event: null };
    }

    const receivedAt = at || new Date().toISOString();
    const cleanSubject = clean(subject);
    const from = clean(participant?.email) || clean(participant?.name);
    const message = {
      id: messageId,
      direction: "inbound",
      at: receivedAt,
      summary: cleanSummary,
      ...(from ? { from } : {}),
      ...(cleanSubject ? { subject: cleanSubject } : {}),
      ...(cleanArtifactPath ? { artifactPath: cleanArtifactPath } : {}),
      nextAction: "Review and reply",
    };
    existingMessages.push(message);

    const updated = {
      ...(existing || {}),
      id,
      threadId: existing?.threadId || id,
      status: existing?.status === "blocked" ? "blocked" : "needs-reply",
      summary: cleanSummary,
      channel: cleanChannel,
      messages: existingMessages,
      lastInboundAt: receivedAt,
      ...(cleanCompany ? { company: cleanCompany } : {}),
      ...(cleanRole ? { role: cleanRole } : {}),
      ...(linkedApplicationId ? { applicationId: linkedApplicationId } : {}),
      ...(sourcedId ? { sourcedId: clean(sourcedId) } : {}),
      ...(cleanSubject ? { subject: cleanSubject } : {}),
      participants: mergeParticipant(existing?.participants, participant),
    };
    if (updated.status !== "blocked") {
      updated.nextAction = "Review and reply";
      delete updated.nextActionDue;
    }

    putRow(db, "communications", id, updated, {
      application_id: resolveApplicationId(db, updated),
    });
    if (linkedApplicationId) {
      ensureJobThreadInDb(db, {
        applicationId: linkedApplicationId,
        reason: "human-entered",
        now: receivedAt,
      });
    }
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "message",
      title: `${updated.company || id}: inbound message captured`,
      summary: cleanSummary,
      refs: {
        applicationId: updated.applicationId || null,
        company: updated.company,
        role: updated.role,
      },
      tags: ["operation:communication:capture-inbound"],
    });
    return { id, created: !existing, duplicate: false, meta, event };
  });
}

// commUpsert({row}) — full-row insert/replace, same "capture-intake" shape as
// appUpsert.
export function commUpsert({ repoRoot, env, row } = {}) {
  if (!row?.id) throw new Error("commUpsert: row.id is required");
  return runVerb({ repoRoot, env }, (db) => {
    const existed = Boolean(getRow(db, "communications", row.id));
    putRow(db, "communications", row.id, row, { application_id: resolveApplicationId(db, row) });
    if (
      resolveApplicationId(db, row) &&
      Array.isArray(row.messages) &&
      row.messages.some((message) => message?.direction === "inbound")
    ) {
      ensureJobThreadInDb(db, {
        applicationId: row.applicationId,
        reason: "human-entered",
        now: row.lastInboundAt,
      });
    }
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "message",
      title: `${row.company || row.id}: thread ${existed ? "updated" : "opened"}`,
      refs: { applicationId: row.applicationId || null, company: row.company, role: row.role },
    });
    return { id: row.id, meta, event };
  });
}

// commAppendMessage({id, message}) — append one message and roll the thread's
// summary/last-activity timestamps forward.
export function commAppendMessage({ repoRoot, env, id, message } = {}) {
  if (!message || typeof message !== "object") {
    throw new Error("commAppendMessage: message is required");
  }
  return runVerb({ repoRoot, env }, (db) => {
    const comm = requireRow(db, "communications", id, "communication");
    const messages = Array.isArray(comm.messages) ? comm.messages.slice() : [];
    messages.push(message);

    const updated = { ...comm, messages };
    if (message.direction === "inbound")
      updated.lastInboundAt = message.at || updated.lastInboundAt;
    if (message.direction === "outbound-sent" || message.direction === "outbound-draft") {
      updated.lastOutboundAt = message.at || updated.lastOutboundAt;
    }
    if (message.summary) updated.summary = message.summary;
    if (message.nextAction) updated.nextAction = message.nextAction;

    putRow(db, "communications", id, updated, {
      application_id: resolveApplicationId(db, updated),
    });
    if (message.direction === "inbound" && resolveApplicationId(db, updated)) {
      ensureJobThreadInDb(db, {
        applicationId: updated.applicationId,
        reason: "human-entered",
        now: message.at,
      });
    }
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "message",
      title: `${comm.company || id}: ${message.direction || "message"} logged`,
      refs: { applicationId: comm.applicationId || null, company: comm.company, role: comm.role },
    });
    return { id, meta, event };
  });
}

function normalizeDraft(draft) {
  const source = typeof draft === "string" ? { body: draft } : draft;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("commSetDraft: draft is required");
  }
  const body = String(source.body || "").trim();
  if (!body) throw new Error("commSetDraft: draft.body is required");
  const normalized = { body };
  const subject = String(source.subject || "").trim();
  if (subject) normalized.subject = subject;
  return normalized;
}

// Persist a generated reply as a reviewable draft and append its durable
// history in the same transaction. Drafting never claims delivery;
// commMarkSent remains the only send writer.
export function commSetDraft({ repoRoot, env, id, draft, summary, at } = {}) {
  const normalizedDraft = normalizeDraft(draft);
  const messageSummary = String(summary || "Reply drafted for review.").trim();
  return runVerb({ repoRoot, env }, (db) => {
    const comm = requireRow(db, "communications", id, "communication");
    if (comm.status === "closed" || comm.status === "blocked") {
      const error = new Error(`cannot draft a reply for a ${comm.status} communication`);
      error.code = "COMMUNICATION_NOT_DRAFTABLE";
      throw error;
    }
    const draftedAt = at || new Date().toISOString();
    const messages = Array.isArray(comm.messages) ? comm.messages.slice() : [];
    messages.push({
      direction: "outbound-draft",
      at: draftedAt,
      summary: messageSummary,
      ...(normalizedDraft.subject ? { subject: normalizedDraft.subject } : {}),
      body: normalizedDraft.body,
    });
    const updated = {
      ...comm,
      status: "drafted",
      draft: normalizedDraft,
      summary: messageSummary,
      nextAction: "Review and send reply",
      nextActionDue: null,
      messages,
    };
    putRow(db, "communications", id, updated, {
      application_id: resolveApplicationId(db, updated),
    });
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "message",
      title: `${comm.company || id}: reply drafted`,
      summary: "A reply is ready for review; nothing was sent.",
      refs: { applicationId: comm.applicationId || null, company: comm.company, role: comm.role },
      tags: ["operation:communication:draft"],
    });
    return { id, draft: normalizedDraft, meta, event };
  });
}

function sentMessageFromDraft(draft, { at, summary }) {
  const normalized = draft ? normalizeDraft(draft) : null;
  const bodySummary = normalized?.body
    ? normalized.body.replace(/\s+/g, " ").trim().slice(0, 200)
    : "Message sent.";
  return {
    direction: "outbound-sent",
    at,
    summary: String(summary || bodySummary),
    ...(normalized?.subject ? { subject: normalized.subject } : {}),
    ...(normalized?.body ? { body: normalized.body } : {}),
  };
}

// Verification tiers for a recorded send. "verified" is executor-confirmed
// delivery evidence (communication.send with a connected executor);
// "supervised" is CareerRat-prepared (a draft existed) with the user
// confirming the send; "user_report" is an out-of-band self report with
// nothing CareerRat can vouch for. The verb derives the tier itself when the
// caller omits it, so every surface (Ask intent, CLI, REST) records the same
// tier for the same real-world event; unknown explicit values normalize to
// "user_report" — the least-trusted tier — rather than silently upgrading to
// a stronger claim than the caller actually made.
const COMM_VERIFICATION_TIERS = new Set(["verified", "supervised", "user_report"]);

// "verified" is an executor-only claim: without delivery evidence to back it,
// an explicit "verified" from any caller (CLI, REST, a skill) records at the
// derived tier instead, so the strongest word in the tracker always has
// something behind it.
function normalizeCommVerification(value, { hadDraft = false, hasEvidence = false } = {}) {
  const clean = String(value || "").trim();
  if (clean === "verified") {
    return hasEvidence ? "verified" : hadDraft ? "supervised" : "user_report";
  }
  if (COMM_VERIFICATION_TIERS.has(clean)) return clean;
  if (!clean) return hadDraft ? "supervised" : "user_report";
  return "user_report";
}

// commMarkSent({id, at?, summary?}) — the "sent clears draft" hard invariant
// (AGENTS.md): status → waiting, comm.draft cleared, and — if the draft was
// backed by app.followUp.draft — that's cleared too, in the SAME write.
export function commMarkSent({
  repoRoot,
  env,
  id,
  at,
  summary,
  verification,
  deliveryEvidence,
} = {}) {
  return runVerb({ repoRoot, env }, (db) => {
    const comm = requireRow(db, "communications", id, "communication");
    const sentAt = at || new Date().toISOString();
    const evidence = String(deliveryEvidence || "").trim();
    const messages = Array.isArray(comm.messages) ? comm.messages.slice() : [];
    const sentMessage = sentMessageFromDraft(comm.draft, { at: sentAt, summary });
    if (evidence) sentMessage.deliveryEvidence = evidence;
    messages.push(sentMessage);
    const updated = {
      ...comm,
      status: "waiting",
      draft: null,
      lastOutboundAt: sentAt,
      nextAction: null,
      nextActionDue: null,
      messages,
    };
    updated.summary = sentMessage.summary;

    putRow(db, "communications", id, updated, {
      application_id: resolveApplicationId(db, updated),
    });

    const applicationId = resolveApplicationId(db, updated);
    let clearedAppFollowUpDraft = false;
    if (applicationId) {
      const app = getRow(db, "applications", applicationId);
      if (app?.followUp?.draft != null) {
        putRow(db, "applications", applicationId, {
          ...app,
          followUp: { ...app.followUp, draft: null },
        });
        clearedAppFollowUpDraft = true;
      }
    }

    const tier = normalizeCommVerification(verification, {
      hadDraft: comm.draft != null,
      hasEvidence: Boolean(evidence),
    });
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "message",
      title: `${comm.company || id}: message sent`,
      summary:
        tier === "verified"
          ? "Delivery was verified and the saved draft was cleared."
          : tier === "supervised"
            ? "CareerRat prepared this message; the user confirmed it was sent and the saved draft was cleared."
            : "User reported the message sent; the saved draft was cleared.",
      refs: { applicationId, company: comm.company, role: comm.role },
      tags: ["operation:communication:send"],
    });
    return { id, meta, event, clearedAppFollowUpDraft, verification: tier };
  });
}
