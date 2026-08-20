// verbs/relationship.mjs — relationshipLeads[] domain actions.
//
// relationshipLeads[] is top-level tracker state rendered by the Network page,
// so it lives in kv like calendarBusy[]/calendarWrites[]. The verb still owns
// domain behavior: lead dedupe, review/approval status, and the linked app CTA
// clear/update that relationship-sourcing needs in the same transaction.
import { createHash } from "node:crypto";
import { bumpMeta, getRow, logActivityEvent, NotFoundError, putRow, runVerb } from "./shared.mjs";

const RELATIONSHIP_LEADS_KEY = "relationshipLeads";
const STATUSES = new Set(["review", "approved", "rejected"]);

function readLeads(db) {
  const row = db.prepare("SELECT data FROM kv WHERE key = ?").get(RELATIONSHIP_LEADS_KEY);
  if (!row) return [];
  const parsed = JSON.parse(row.data);
  return Array.isArray(parsed) ? parsed : [];
}

function putLeads(db, leads) {
  db.prepare(
    `INSERT INTO kv (key, data) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET data=excluded.data`
  ).run(RELATIONSHIP_LEADS_KEY, JSON.stringify(leads));
}

function trimOrNull(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function slug(value) {
  return (
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

function stableLeadId(company, name, platform) {
  const base = `lead-${slug(company)}-${slug(name)}-${slug(platform || "unknown")}`;
  if (base.length <= 96) return base;
  const digest = createHash("sha256")
    .update(`${company}\0${name}\0${platform || ""}`)
    .digest("hex")
    .slice(0, 12);
  return `${base.slice(0, 83)}-${digest}`;
}

function dedupeKey(lead) {
  return `${slug(lead.company)}\0${slug(lead.name)}\0${slug(lead.platform || "unknown")}`;
}

function normalizeStatus(status, fallback = "review") {
  const normalized = String(status || fallback)
    .trim()
    .toLowerCase();
  if (!STATUSES.has(normalized)) {
    throw new Error(`relationshipLead: status must be one of ${[...STATUSES].join(", ")}`);
  }
  return normalized;
}

function normalizeLead(input, { existing, app, now }) {
  if (!input || typeof input !== "object") {
    throw new Error("relationshipLeadUpsertBatch: every lead must be an object");
  }

  const company = trimOrNull(input.company) || trimOrNull(app?.company);
  const name = trimOrNull(input.name);
  if (!company || !name) {
    throw new Error("relationshipLeadUpsertBatch: every lead requires company and name");
  }
  const platform = trimOrNull(input.platform) || trimOrNull(existing?.platform) || "linkedin";
  const status = normalizeStatus(input.status, existing?.status || "review");
  const foundAt = trimOrNull(input.foundAt) || trimOrNull(existing?.foundAt) || now;

  const normalized = {
    ...(existing || {}),
    id: trimOrNull(input.id) || trimOrNull(existing?.id) || stableLeadId(company, name, platform),
    applicationId:
      trimOrNull(input.applicationId) || trimOrNull(existing?.applicationId) || trimOrNull(app?.id),
    company,
    role: trimOrNull(input.role) || trimOrNull(existing?.role) || trimOrNull(app?.role),
    name,
    type: trimOrNull(input.type) || trimOrNull(existing?.type) || "Contact",
    title: trimOrNull(input.title) || trimOrNull(existing?.title),
    platform,
    url: trimOrNull(input.url) || trimOrNull(existing?.url),
    basis: trimOrNull(input.basis) || trimOrNull(existing?.basis),
    note: trimOrNull(input.note) || trimOrNull(existing?.note),
    status,
    foundAt,
    updatedAt: now,
  };

  for (const [key, value] of Object.entries(normalized)) {
    if (value === null || value === undefined) delete normalized[key];
  }
  return normalized;
}

function sourcingText(app) {
  return [app?.nextAction, app?.followUp?.kind, app?.followUp?.title, app?.followUp?.note]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function shouldClearSourcingCta(app) {
  const text = sourcingText(app);
  if (!text) return false;
  // Only CTA-shaped sourcing prompts clear: explicit sourcing vocabulary, or
  // a find/source verb paired with a sourcing noun. Bare nouns are not
  // enough — "Call the recruiter back at 3pm", "Confirm contact info with
  // HR", or "Build a relationship with the hiring manager" are real
  // reminders, and a lead landing for that company must never silently
  // replace them (or wipe their due date).
  return (
    /\brelationship[ -]sourcing\b|\bsourcing\b|\bwarm path\b/.test(text) ||
    /\b(?:find|source)\b[^.!?]*\b(?:recruiter|contact|warm|referral)\b/.test(text)
  );
}

function appendConversation(app, conversation) {
  const conversations = Array.isArray(app.conversations) ? app.conversations.slice() : [];
  conversations.push(conversation);
  return conversations;
}

function updateAppForReview(db, appId) {
  if (!appId) return false;
  const app = getRow(db, "applications", appId);
  if (!app || !shouldClearSourcingCta(app)) return false;
  putRow(db, "applications", appId, {
    ...app,
    nextAction: "Review relationship leads: approve or reject in Network tab",
    nextActionDue: null,
  });
  return true;
}

function otherActionableLeads(leads, lead) {
  return leads.filter(
    (candidate) =>
      candidate.id !== lead.id &&
      candidate.applicationId === lead.applicationId &&
      (candidate.status === "review" || candidate.status === "approved")
  );
}

function updateAppForLeadStatus(db, leads, lead, { at, dueAt }) {
  const appId = lead.applicationId;
  if (!appId) return null;
  const app = getRow(db, "applications", appId);
  if (!app) return null;

  if (lead.status === "approved") {
    const summary = `Relationship lead approved: ${lead.name} (${lead.title || lead.type || lead.platform}). Outreach queued to email-comms.`;
    const updated = {
      ...app,
      nextAction: `Send outreach to ${lead.name} via email-comms`,
      nextActionDue: dueAt || null,
      conversations: appendConversation(app, {
        date: at,
        kind: "relationship lead approved",
        who: lead.name,
        notes: summary.slice(0, 200),
      }),
    };
    putRow(db, "applications", appId, updated);
    return updated;
  }

  if (lead.status === "rejected") {
    const noOtherActionable = otherActionableLeads(leads, lead).length === 0;
    const updated = {
      ...app,
      conversations: appendConversation(app, {
        date: at,
        kind: "relationship lead rejected",
        who: lead.name,
        notes: `Relationship lead rejected: ${lead.note || "Not a useful path."}`.slice(0, 200),
      }),
    };
    if (noOtherActionable) {
      updated.nextAction = `Re-run relationship-sourcing for ${lead.company}`;
      updated.nextActionDue = null;
    }
    putRow(db, "applications", appId, updated);
    return updated;
  }

  return app;
}

// relationshipLeadUpsertBatch({leads}) — capture candidate-review leads and,
// when a linked app has a sourcing CTA, clear it to the Network review action
// in the same transaction.
export function relationshipLeadUpsertBatch({ repoRoot, env, leads } = {}) {
  if (!Array.isArray(leads) || leads.length === 0) {
    throw new Error("relationshipLeadUpsertBatch: leads must be a non-empty array");
  }

  return runVerb({ repoRoot, env }, (db) => {
    const now = new Date().toISOString();
    const merged = new Map();
    for (const existing of readLeads(db)) {
      merged.set(dedupeKey(existing), normalizeLead(existing, { existing, now }));
    }

    const updatedApplications = new Set();
    for (const lead of leads) {
      const app =
        lead.applicationId && getRow(db, "applications", lead.applicationId)
          ? getRow(db, "applications", lead.applicationId)
          : null;
      const keyProbe = {
        company: trimOrNull(lead.company) || trimOrNull(app?.company),
        name: trimOrNull(lead.name),
        platform: trimOrNull(lead.platform) || "linkedin",
      };
      const existing = merged.get(dedupeKey(keyProbe));
      const normalized = normalizeLead(lead, { existing, app, now });
      merged.set(dedupeKey(normalized), normalized);
      if (updateAppForReview(db, normalized.applicationId)) {
        updatedApplications.add(normalized.applicationId);
      }
    }

    const nextLeads = [...merged.values()];
    putLeads(db, nextLeads);

    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "system",
      title: "Relationship leads found",
      summary: "Review leads captured for candidate approval.",
      tags: ["relationship"],
      needsUser: true,
      operation: "relationship:lead-upsert-batch",
      cta: { label: "Review leads" },
    });
    return {
      key: RELATIONSHIP_LEADS_KEY,
      count: nextLeads.length,
      leads: nextLeads,
      updatedApplications: [...updatedApplications].sort(),
      meta,
      event,
    };
  });
}

// relationshipLeadSetStatus({id,status}) — candidate approval/rejection. The
// lead state and linked app action/conversation update happen in one transaction.
export function relationshipLeadSetStatus({ repoRoot, env, id, status, at, dueAt, note } = {}) {
  if (!id) throw new Error("relationshipLeadSetStatus: id is required");
  if (!status) throw new Error("relationshipLeadSetStatus: status is required");
  const nextStatus = normalizeStatus(status);

  return runVerb({ repoRoot, env }, (db) => {
    const timestamp = at || new Date().toISOString();
    const leads = readLeads(db).map((lead) =>
      normalizeLead(lead, { existing: lead, now: timestamp })
    );
    const index = leads.findIndex((lead) => lead.id === id);
    if (index === -1) throw new NotFoundError(`no relationship lead with id "${id}"`);

    const lead = {
      ...leads[index],
      status: nextStatus,
      updatedAt: timestamp,
    };
    if (note) lead.note = note;
    if (nextStatus === "approved") lead.approvedAt = timestamp;
    if (nextStatus === "rejected") lead.rejectedAt = timestamp;
    leads[index] = lead;

    updateAppForLeadStatus(db, leads, lead, { at: timestamp, dueAt });
    putLeads(db, leads);

    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: nextStatus === "approved" ? "message" : "system",
      title:
        nextStatus === "approved"
          ? `Relationship lead approved: ${lead.name}`
          : `Relationship lead declined: ${lead.name}`,
      summary:
        nextStatus === "approved"
          ? `Lead approved; outreach to ${lead.name} (${lead.title || lead.type || lead.platform}) queued to email-comms.`
          : "Lead rejected; brief reason noted on lead record.",
      refs: { applicationId: lead.applicationId, company: lead.company, role: lead.role },
      operation: `relationship:lead-${nextStatus}`,
    });

    return { key: RELATIONSHIP_LEADS_KEY, id, lead, meta, event };
  });
}
