/**
 * Follow-up cadence rules and computation for the CareerRat tracker dashboard.
 *
 * Each follow-up KIND can be independently toggled on/off and given its own
 * timing threshold, so a candidate decides which nudges they actually want
 * (e.g. never chase a cold application, but always follow up after an
 * interview). Defaults are domain-neutral — every kind on, conventional
 * timings — and a candidate's `follow_up:` config block (targeting.yml)
 * overrides them per kind via {@link rulesFromConfig}.
 */

/** Default maximum number of app-nudge follow-ups per application row. */
const APP_NUDGE_MAX_COUNT_DEFAULT = 2;

/**
 * Domain-neutral default rules, one block per follow-up kind:
 *   { enabled: boolean, afterDays?: number, afterHours?: number, maxCount?: number }
 * These are the code defaults assumed when the candidate sets no `follow_up:`
 * config. They encode no personal preference — every kind is on.
 */
const FOLLOWUP_RULES = Object.freeze({
  /** Nudge when an application gets no response (pre-interview stage). */
  appNudge: Object.freeze({ enabled: true, afterDays: 7, maxCount: APP_NUDGE_MAX_COUNT_DEFAULT }),
  /** Nudge when an interviewed application goes quiet. */
  postInterview: Object.freeze({ enabled: true, afterDays: 5 }),
  /** A "waiting" comm thread whose last outbound has gone stale. */
  waitingStale: Object.freeze({ enabled: true, afterDays: 5 }),
  /** Thank-you note owed shortly after a logged interview. */
  interviewThankYou: Object.freeze({ enabled: true, afterHours: 24 }),
  /** Someone is waiting on your reply (comm marked needs-reply). */
  needsReply: Object.freeze({ enabled: true }),
  /** An explicitly scheduled next action has come due. */
  commDue: Object.freeze({ enabled: true }),
});

/** Statuses considered terminal — no follow-up needed. */
const TERMINAL_STATUSES = new Set([
  "rejected",
  "closed",
  "offer",
  "withdrawn",
  "declined",
  "accepted",
]);

/** Pre-interview "submitted" statuses that drive the application nudge. */
const APPLIED_STATUSES = new Set(["applied", "submitted", "awaiting", "reviewing", "screening"]);

/** Interview-or-later (non-terminal) status detector — drives post-interview. */
function isInterviewStage(status) {
  return /interview|onsite|on-site|panel|\bfinal\b|technical/.test(status);
}

/**
 * Does this application have an actual contact to follow up with? A linked
 * communication thread (recruiter / email you can reply to), a logged conversation
 * with a named person, or an explicit contact recorded on the row. A black-hole
 * portal or cold application with none of these has no one to nudge — chasing it is
 * noise. The app-nudge is suppressed for those rows; the real move is
 * relationship-sourcing (find a contact) or a wait/archive decision, not a
 * follow-up email sent to nobody.
 * @param {object} app
 * @param {Set<string>} applicationIdsWithComm - app ids that have a replyable thread
 * @returns {boolean}
 */
function appHasContactPath(app, applicationIdsWithComm) {
  if (app.id && applicationIdsWithComm.has(app.id)) return true;
  const convs = Array.isArray(app.conversations) ? app.conversations : [];
  if (convs.some((c) => c && String(c.who || "").trim())) return true;
  return Boolean(app.contactEmail || app.recruiter || app.contactName || app.contact);
}

/** Floor a millisecond difference to whole days. */
function msToDays(ms) {
  return Math.floor(ms / 86400000);
}

/**
 * Parse a date value (Date or ISO string) to a Date.
 * Returns null on failure — never throws.
 * @param {Date|string|undefined} val
 * @returns {Date|null}
 */
function toDate(val) {
  if (!val) return null;
  try {
    const d = val instanceof Date ? val : new Date(val);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/** Deep-merge a partial rules object over the frozen defaults, per kind. */
function normalizeRules(rules) {
  const out = {};
  for (const kind of Object.keys(FOLLOWUP_RULES)) {
    out[kind] = { ...FOLLOWUP_RULES[kind], ...(rules?.[kind] || {}) };
  }
  return out;
}

/**
 * Map a candidate `follow_up:` config block (snake_case YAML) to the camelCase
 * rules object {@link computeFollowUps} expects. Unknown keys are ignored;
 * omitted keys fall back to the neutral defaults. Returns undefined when there
 * is nothing to override, so callers can pass the result straight through.
 *
 *   follow_up:
 *     app_nudge:           { enabled: false, after_days: 7, max_count: 2 }
 *     post_interview:      { enabled: true,  after_days: 5 }
 *     waiting_stale:       { enabled: true,  after_days: 5 }
 *     interview_thank_you: { enabled: true,  after_hours: 24 }
 *     needs_reply:         { enabled: true }
 *     comm_due:            { enabled: true }
 *
 * @param {object|undefined} followUp - the parsed `follow_up` config block
 * @returns {object|undefined} rules override, or undefined if empty
 */
export function rulesFromConfig(followUp) {
  if (!followUp || typeof followUp !== "object") return undefined;
  const pick = (block, withHours, withMaxCount) => {
    if (!block || typeof block !== "object") return undefined;
    const r = {};
    if (typeof block.enabled === "boolean") r.enabled = block.enabled;
    if (typeof block.after_days === "number") r.afterDays = block.after_days;
    if (withHours && typeof block.after_hours === "number") r.afterHours = block.after_hours;
    if (withMaxCount && typeof block.max_count === "number") r.maxCount = block.max_count;
    return Object.keys(r).length ? r : undefined;
  };
  const map = {
    appNudge: pick(followUp.app_nudge, false, true),
    postInterview: pick(followUp.post_interview),
    waitingStale: pick(followUp.waiting_stale),
    interviewThankYou: pick(followUp.interview_thank_you, true),
    needsReply: pick(followUp.needs_reply),
    commDue: pick(followUp.comm_due),
  };
  const out = {};
  for (const k of Object.keys(map)) if (map[k]) out[k] = map[k];
  return Object.keys(out).length ? out : undefined;
}

/**
 * Compute all outstanding follow-ups across the tracker, sorted most-overdue
 * first. Each kind is gated by its rule's `enabled` flag, so disabling a kind
 * (e.g. `appNudge`) means those reminders never appear — that is how a
 * candidate opts out of chasing, say, cold applications.
 *
 * Each result carries a `draft` ({ subject, body }) when one has been baked
 * onto the source record (`comm.draft` for comm kinds, `app.followUp.draft`
 * for application kinds) — null otherwise.
 *
 * @param {object} trackerData
 * @param {{ now?: Date|string, rules?: object }} [opts]
 * @returns {Array<{ kind: string, id: string, applicationId: string, company: string, role: string, dueAt: string, overdueDays: number, reason: string, draft: object|null }>}
 */
export function computeFollowUps(trackerData, { now, rules } = {}) {
  if (!now) return [];

  const nowDate = toDate(now);
  if (!nowDate) return [];

  const r = normalizeRules(rules);

  const applications = trackerData?.applications || [];
  const communications = trackerData?.communications || [];

  const results = [];

  // ── Communications ────────────────────────────────────────────────────────
  for (const comm of communications) {
    const id = comm.id || "";
    const applicationId = comm.applicationId || "";
    const company = comm.company || "";
    const role = comm.role || "";
    const status = comm.status || "";
    const draft = comm.draft || null;

    // Rule: comm-due — nextActionDue in the past
    if (r.commDue.enabled && comm.nextActionDue) {
      const dueDate = toDate(comm.nextActionDue);
      if (dueDate && nowDate > dueDate) {
        results.push({
          kind: "comm-due",
          id,
          applicationId,
          company,
          role,
          dueAt: dueDate.toISOString(),
          overdueDays: msToDays(nowDate - dueDate),
          reason: comm.nextAction || "Follow-up action due",
          draft,
        });
        continue; // don't double-flag the same comm
      }
    }

    // Rule: needs-reply — comm status is "needs-reply"
    if (r.needsReply.enabled && status === "needs-reply") {
      const lastInbound = toDate(comm.lastInboundAt);
      const overdueDays = lastInbound ? msToDays(nowDate - lastInbound) : 0;
      results.push({
        kind: "needs-reply",
        id,
        applicationId,
        company,
        role,
        dueAt: nowDate.toISOString(),
        overdueDays: Math.max(0, overdueDays),
        reason: comm.nextAction || "Reply needed",
        draft,
      });
      continue;
    }

    // Rule: waiting-stale — waiting and lastOutboundAt is old
    if (r.waitingStale.enabled && status === "waiting" && comm.lastOutboundAt) {
      const outDate = toDate(comm.lastOutboundAt);
      if (outDate) {
        const staleDays = msToDays(nowDate - outDate);
        if (staleDays >= r.waitingStale.afterDays) {
          results.push({
            kind: "waiting-stale",
            id,
            applicationId,
            company,
            role,
            dueAt: outDate.toISOString(),
            overdueDays: staleDays - r.waitingStale.afterDays,
            reason: "Waiting thread gone stale",
            draft,
          });
        }
      }
    }
  }

  // Which applications have a real, replyable contact thread (recruiter/email).
  // A bare portal confirmation isn't a contact path — see appHasContactPath.
  const applicationIdsWithComm = new Set();
  for (const comm of communications) {
    if (!comm || !comm.applicationId) continue;
    const replyable =
      (comm.channel && comm.channel !== "portal") ||
      (Array.isArray(comm.messages) && comm.messages.length > 0) ||
      (Array.isArray(comm.participants) && comm.participants.length > 0);
    if (replyable) applicationIdsWithComm.add(comm.applicationId);
  }

  // ── Applications ──────────────────────────────────────────────────────────
  for (const app of applications) {
    const id = app.id || "";
    const company = app.company || "";
    const role = app.role || "";
    const status = (app.status || "").toLowerCase();

    // Skip terminal statuses — nothing to chase.
    if (TERMINAL_STATUSES.has(status)) continue;

    const draft = app.followUp?.draft || null;

    // Most-recent dated conversation (used by post-interview + thank-you).
    const convs = (Array.isArray(app.conversations) ? app.conversations : [])
      .map((c) => ({ kind: c?.kind || "", at: toDate(c?.date) }))
      .filter((c) => c.at)
      .sort((a, b) => b.at - a.at);
    const lastConv = convs[0] || null;

    // Rule: app-nudge — pre-interview, no response after applying.
    // Capped by maxCount (default APP_NUDGE_MAX_COUNT_DEFAULT): once that many
    // follow-ups have been sent for this row (app.followUp?.sentCount), stop.
    if (
      r.appNudge.enabled &&
      (APPLIED_STATUSES.has(status) || status === "") &&
      app.appliedAt &&
      appHasContactPath(app, applicationIdsWithComm)
    ) {
      const maxCount =
        typeof r.appNudge.maxCount === "number" ? r.appNudge.maxCount : APP_NUDGE_MAX_COUNT_DEFAULT;
      const sentCount = typeof app.followUp?.sentCount === "number" ? app.followUp.sentCount : 0;
      if (sentCount < maxCount) {
        const appliedDate = toDate(app.appliedAt);
        if (appliedDate) {
          const daysSince = msToDays(nowDate - appliedDate);
          if (daysSince >= r.appNudge.afterDays) {
            results.push({
              kind: "app-nudge",
              id,
              applicationId: id,
              company,
              role,
              dueAt: new Date(
                appliedDate.getTime() + r.appNudge.afterDays * 86400000
              ).toISOString(),
              overdueDays: daysSince - r.appNudge.afterDays,
              reason: "No response after application",
              draft,
            });
          }
        }
      }
    }

    // Rule: interview thank-you — owed shortly after a logged interview
    if (r.interviewThankYou.enabled && lastConv && /interview/i.test(lastConv.kind)) {
      const hoursSince = (nowDate - lastConv.at) / 3600000;
      const capHours = (r.postInterview.afterDays || 5) * 24; // hand off to the nudge after this
      if (hoursSince >= r.interviewThankYou.afterHours && hoursSince < capHours) {
        const dueDate = new Date(lastConv.at.getTime() + r.interviewThankYou.afterHours * 3600000);
        results.push({
          kind: "thank-you",
          id,
          applicationId: id,
          company,
          role,
          dueAt: dueDate.toISOString(),
          overdueDays: Math.max(0, msToDays(nowDate - dueDate)),
          reason: "Send a thank-you note",
          draft,
        });
      }
    }

    // Rule: post-interview-nudge — interviewed but gone quiet
    if (r.postInterview.enabled && isInterviewStage(status)) {
      const refDate = lastConv?.at || toDate(app.appliedAt);
      if (refDate) {
        const daysSince = msToDays(nowDate - refDate);
        if (daysSince >= r.postInterview.afterDays) {
          results.push({
            kind: "post-interview-nudge",
            id,
            applicationId: id,
            company,
            role,
            dueAt: new Date(refDate.getTime() + r.postInterview.afterDays * 86400000).toISOString(),
            overdueDays: daysSince - r.postInterview.afterDays,
            reason: "No response after interview",
            draft,
          });
        }
      }
    }
  }

  // Sort most-overdue first
  results.sort((a, b) => b.overdueDays - a.overdueDays);

  return results;
}
