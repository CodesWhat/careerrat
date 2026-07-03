// verbs/comm.mjs — communications[] domain actions. Pure comms writes — never
// outcome-changing, so none of these refresh the analytics block (AGENTS.md's
// Tracker Write Contract explicitly carves out "pure comms/scheduling writes").
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

// commUpsert({row}) — full-row insert/replace, same "capture-intake" shape as
// appUpsert.
export function commUpsert({ repoRoot, env, row } = {}) {
  if (!row?.id) throw new Error("commUpsert: row.id is required");
  return runVerb({ repoRoot, env }, (db) => {
    const existed = Boolean(getRow(db, "communications", row.id));
    putRow(db, "communications", row.id, row, { application_id: resolveApplicationId(db, row) });
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "message",
      title: `${row.company || row.id} — thread ${existed ? "updated" : "opened"}`,
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
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "message",
      title: `${comm.company || id} — ${message.direction || "message"} logged`,
      refs: { applicationId: comm.applicationId || null, company: comm.company, role: comm.role },
    });
    return { id, meta, event };
  });
}

// commMarkSent({id, at?, summary?}) — the "sent clears draft" hard invariant
// (AGENTS.md): status → waiting, comm.draft cleared, and — if the draft was
// backed by app.followUp.draft — that's cleared too, in the SAME write.
export function commMarkSent({ repoRoot, env, id, at, summary } = {}) {
  return runVerb({ repoRoot, env }, (db) => {
    const comm = requireRow(db, "communications", id, "communication");
    const updated = {
      ...comm,
      status: "waiting",
      draft: null,
      lastOutboundAt: at || new Date().toISOString(),
    };
    if (summary) updated.summary = summary;

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

    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "message",
      title: `${comm.company || id} — message sent`,
      refs: { applicationId, company: comm.company, role: comm.role },
    });
    return { id, meta, event, clearedAppFollowUpDraft };
  });
}
