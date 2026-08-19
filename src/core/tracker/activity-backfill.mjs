// activity-backfill.mjs — derive Activity Pulse events from existing tracker state.
//
// M19 keeps the feed current two ways: (1) skills append as they act, and (2) this
// backfill/reconcile pass, which derives recent events from what's already in
// workspace/tracker.json so the feed isn't empty for work done before the feed
// existed (or outside a skill). It is PURE — it returns event objects; the caller
// (the `activity backfill` CLI) appends them through the same guarded primitive,
// and because every event id is content-derived, re-running is idempotent.
//
// Honesty rule: we only emit an event when we have a REAL timestamp for it. Applied
// events are dated by `appliedAt`; inbound replies and status outcomes are dated by
// the actual inbound message in the application's comm thread. We never fabricate a
// date for a status change we can't time (those land via the live skill path, where
// the real timestamp exists).

// "YYYY-MM-DD" (or a full ISO) → a noon-UTC ISO, so the dashboard's relative-time
// day bucketing ("Today"/"Yesterday") never flips across a timezone boundary.
function toIso(dateish) {
  const s = String(dateish || "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T12:00:00.000Z`;
  const d = new Date(s);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

function isInbound(direction) {
  return /inbound|received/i.test(String(direction || ""));
}

// The latest real inbound message date per applicationId — the only honest date we
// have for a status outcome (a rejection/interview email arrives inbound).
function latestInboundByApp(communications) {
  const map = new Map();
  for (const comm of communications || []) {
    const appId = comm.applicationId;
    if (!appId) continue;
    for (const m of comm.messages || []) {
      if (!isInbound(m.direction)) continue;
      const iso = toIso(m.at);
      if (!iso) continue;
      const prev = map.get(appId);
      if (!prev || iso > prev) map.set(appId, iso);
    }
  }
  return map;
}

// Map a tracker status to a feed event shape (type/tone/title/needsUser), or null
// to skip (e.g. still awaiting — nothing happened yet).
function statusEventShape(status, company) {
  const s = String(status || "").toLowerCase();
  if (/interview|screen|onsite|panel|final|loop/.test(s)) {
    return {
      type: "interview",
      title: `Interview stage: ${company}`,
      summary: "Advanced past application.",
    };
  }
  if (/offer|accepted|signed|hired/.test(s)) {
    return { type: "offer", title: `Offer: ${company}`, summary: "Reached the offer stage." };
  }
  if (/withdraw/.test(s)) {
    return {
      type: "status_change",
      tone: "neutral",
      title: `Withdrew: ${company}`,
      summary: "Candidate withdrew from consideration.",
    };
  }
  if (/reject|declined|denied|closed|no longer/.test(s)) {
    return {
      type: "status_change",
      tone: "warning",
      title: `Closed: ${company}`,
      summary: "No longer moving forward.",
    };
  }
  if (/block/.test(s)) {
    return {
      type: "failure",
      needsUser: true,
      title: `Blocked: ${company}`,
      summary: "Application blocked, needs a manual step.",
    };
  }
  return null;
}

export function deriveActivityEvents(trackerData, { limit = 60 } = {}) {
  const applications = trackerData?.applications || [];
  const communications = trackerData?.communications || [];
  const inboundByApp = latestInboundByApp(communications);
  const events = [];

  for (const app of applications) {
    const company = app.company || app.role || "a role";
    const refs = { applicationId: app.id, company: app.company, role: app.role, url: app.link };

    // 1. Applied — dated by appliedAt (reliable).
    const appliedIso = toIso(app.appliedAt);
    if (appliedIso) {
      events.push({
        type: "applied",
        actor: "agent",
        at: appliedIso,
        title: `Submitted application: ${company}`,
        summary:
          [app.role, app.channel ? `via ${app.channel}` : null].filter(Boolean).join(" · ") || null,
        refs,
      });
    }

    // 2. Status outcome — ONLY when a real inbound date exists to anchor it.
    const shape = statusEventShape(app.status, company);
    const statusIso = inboundByApp.get(app.id);
    if (shape && statusIso) {
      events.push({
        type: shape.type,
        actor: "world",
        at: statusIso,
        title: shape.title,
        summary: shape.summary,
        tone: shape.tone,
        needsUser: shape.needsUser === true,
        refs,
      });
    }
  }

  // 3. Inbound replies — dated by the real message, deduped against status events
  // (same app + same date as a status outcome means it IS that outcome's email).
  const statusKeys = new Set(
    events.filter((e) => e.actor === "world").map((e) => `${e.refs?.applicationId}|${e.at}`)
  );
  for (const comm of communications) {
    for (const m of comm.messages || []) {
      if (!isInbound(m.direction)) continue;
      const iso = toIso(m.at);
      if (!iso) continue;
      if (statusKeys.has(`${comm.applicationId}|${iso}`)) continue;
      events.push({
        type: "message",
        actor: "world",
        at: iso,
        title: `${comm.company || "A company"} replied`,
        summary: m.summary || m.subject || comm.subject || null,
        refs: { applicationId: comm.applicationId, company: comm.company, role: comm.role },
      });
    }
  }

  // 4. Drafted events — from comm records with status=drafted and a non-null draft.
  // Dated by lastOutboundAt (the time the draft was last written), falling back to
  // lastInboundAt (the inbound that prompted it) or the first message we find.
  // Track which comms we emit here so step 5 doesn't double-emit for the same draft.
  const draftedComms = new Set();
  for (const comm of communications) {
    if (
      String(comm.status || "").toLowerCase() !== "drafted" ||
      comm.draft == null ||
      typeof comm.draft !== "object"
    )
      continue;
    const company = comm.company || "a company";
    const dateSource =
      toIso(comm.lastOutboundAt) ||
      toIso(comm.lastInboundAt) ||
      (() => {
        for (const m of comm.messages || []) {
          const iso = toIso(m.at);
          if (iso) return iso;
        }
        return null;
      })();
    if (!dateSource) continue;
    draftedComms.add(comm);
    events.push({
      type: "drafted",
      actor: "agent",
      at: dateSource,
      title: `Drafted reply: ${company}`,
      summary: comm.draft.subject || comm.summary || null,
      needsUser: false,
      refs: {
        applicationId: comm.applicationId,
        company: comm.company,
        role: comm.role,
      },
    });
  }

  // 5. Outbound message events — from messages[] with direction outbound-sent or
  // outbound-draft. These reconstruct sent/drafted history that skills should have
  // logged live but may not have (pre-feed work or skill gaps).
  // Skip outbound-draft messages for comms already covered by step 4 (draft object
  // on comm.draft) to avoid emitting two drafted events for the same draft.
  for (const comm of communications) {
    const company = comm.company || "a company";
    const commRefs = {
      applicationId: comm.applicationId,
      company: comm.company,
      role: comm.role,
    };
    for (const m of comm.messages || []) {
      const dir = String(m.direction || "").toLowerCase();
      if (dir !== "outbound-sent" && dir !== "outbound-draft") continue;
      const iso = toIso(m.at);
      if (!iso) continue;
      const isOutboundDraft = dir === "outbound-draft";
      // Step 4 already emitted a drafted event for this comm — skip to avoid duplicates.
      if (isOutboundDraft && draftedComms.has(comm)) continue;
      events.push({
        type: isOutboundDraft ? "drafted" : "message",
        actor: "agent",
        at: iso,
        title: isOutboundDraft ? `Drafted reply: ${company}` : `Sent: ${company}`,
        summary: m.summary || m.subject || null,
        needsUser: false,
        refs: commRefs,
      });
    }
  }

  // Newest first, capped — the caller appends them (idempotent on content id).
  return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}
