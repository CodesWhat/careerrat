// Canonical round vocabulary (SSOT — mirrored in AGENTS.md "Round Vocabulary" and
// the interview-prep / schedule-meeting / track-outcomes / sync-status skills).
// Ordered DEEPEST-FIRST so first-match wins: a "leadership interview" lands on
// hiring-manager (not the generic interview rung), "onsite panel" lands on onsite,
// and "recruiter screen" lands on screen. The generic `interview` rung is a
// fallback for a bare "interview" with no finer signal — it never numbers itself.
const STAGE_RULES = [
  ["accepted", ["accept", "signed", "hired"]],
  ["offer", ["offer"]],
  ["final", ["final", "exec interview", "executive interview", "bar raiser", "bar-raiser"]],
  [
    "onsite",
    ["onsite", "on-site", "on site", "panel", "loop", "super day", "superday", "super-day"],
  ],
  [
    "hiring-manager",
    [
      "hiring manager",
      "hiring-manager",
      "hm call",
      "hm interview",
      "hm round",
      "leadership",
      "manager interview",
      "manager screen",
      "director interview",
      "skip level",
      "skip-level",
    ],
  ],
  [
    "technical",
    [
      "technical",
      "system design",
      "coding interview",
      "live coding",
      "pair programming",
      "pairing",
    ],
  ],
  [
    "assessment",
    [
      "assessment",
      "codesignal",
      "code signal",
      "hackerrank",
      "leetcode",
      "online assessment",
      "coding test",
      "coding challenge",
      "take-home",
      "take home",
      "screening test",
    ],
  ],
  ["interview", ["interview", "passed"]],
  ["screen", ["screen", "recruiter", "phone screen", "intro call", "hr screen"]],
  ["rejected", ["reject", "declined", "denied", "closed", "no longer"]],
  ["manual-apply", ["blocked", "manual blocked", "manual apply", "manual", "needs manual"]],
  // reviewed-hold MUST precede withdrawn ("hold" substring) and applied ("review"
  // substring) so a parked-but-recoverable role isn't mislabelled as Withdrawn.
  ["reviewed-hold", ["reviewed-hold"]],
  ["withdrawn", ["withdraw", "cut", "hold", "skipped", "app-limit"]],
  [
    "applied",
    ["applied", "submitted", "awaiting", "waiting", "pending", "reviewing", "in review", "review"],
  ],
];

// Semantic interview band, ordered so a SPECIFIC round always outranks the generic
// `interview` fallback (2.1) — an app with a bare "interview" status plus a known
// "hiring manager" conversation surfaces as Hiring manager, not Interview.
const STAGE_ORDER = {
  sourced: 0,
  "reviewed-hold": 0.5,
  "manual-apply": 1,
  applied: 1,
  screen: 2,
  interview: 2.1,
  assessment: 2.3,
  technical: 2.5,
  "hiring-manager": 2.7,
  onsite: 3,
  final: 4,
  offer: 5,
  accepted: 6,
  rejected: 90,
  withdrawn: 91,
};

const TERMINAL_STAGES = new Set(["rejected", "withdrawn"]);

const JOB_FUNNEL_STAGES = [
  { id: "sourced", label: "Sourced", color: "#B4B2A9", icon: "search" },
  { id: "reviewed-hold", label: "Reviewed — hold", color: "#b08948", icon: "clock" },
  { id: "manual-apply", label: "Manual apply needed", color: "#e8553d", icon: "alert" },
  { id: "applied", label: "Applied", color: "#9C998F", icon: "send" },
  { id: "screen", label: "Screen", color: "#E0A93B", icon: "chat" },
  { id: "interview", label: "Interview", color: "#7FCBA6", icon: "calendar" },
  { id: "assessment", label: "Assessment", color: "#5BC4A0", icon: "calendar" },
  { id: "technical", label: "Technical", color: "#34B488", icon: "calendar" },
  { id: "hiring-manager", label: "Hiring manager", color: "#1D9E75", icon: "calendar" },
  { id: "onsite", label: "Onsite", color: "#179069", icon: "calendar" },
  { id: "final", label: "Final", color: "#14795A", icon: "clock" },
  { id: "offer", label: "Offer", color: "#34A853", icon: "star" },
  { id: "accepted", label: "Accepted", color: "#2F9E55", icon: "check" },
];

const SANKEY_SOURCE_META = {
  "src-cold": {
    id: "src-cold",
    label: "Direct apply",
    color: "#8E8B84",
    col: 0,
    order: 0,
    filter: "src-cold",
  },
  "src-recruiter": {
    id: "src-recruiter",
    label: "Recruiter sourced",
    color: "#6E6B62",
    col: 0,
    order: 1,
    filter: "src-recruiter",
  },
  "src-referral": {
    id: "src-referral",
    label: "Referral",
    color: "#9C998F",
    col: 0,
    order: 2,
    filter: "src-referral",
  },
};

const SANKEY_RESPONSE_META = {
  awaiting: {
    id: "awaiting",
    label: "Awaiting",
    color: "#A8A59C",
    col: 1,
    order: 0,
    filter: "awaiting",
  },
  heard: {
    id: "heardback",
    label: "Heard back",
    color: "#8E8B84",
    col: 1,
    order: 1,
    filter: "heardback",
  },
};

const MODE_META = {
  remote: { label: "Remote", icon: "home" },
  hybrid: { label: "Hybrid", icon: "hybrid" },
  onsite: { label: "On-site", icon: "building-2" },
  relo: { label: "Relo", icon: "truck" },
};

const SOURCE_META = {
  referral: { label: "Referral", icon: "flag" },
  recruiter: { label: "Recruiter", icon: "chat" },
  board: { label: "Job board", icon: "list" },
  linkedin: { label: "LinkedIn", icon: "list" },
  portal: { label: "ATS portal", icon: "search" },
  sourced: { label: "Sourced", icon: "search" },
};

// Benefit key → display chip. Mirrors src/core/tracker/benefits.mjs BENEFIT_DISPLAY
// (kept in sync by hand because this module runs in the browser and can't import
// the server module). Rows store `benefits: [key]`; jobDetailFromRow resolves them.
const BENEFIT_EMOJI = {
  health: { emoji: "🏥", label: "Health insurance" },
  dental: { emoji: "🦷", label: "Dental" },
  vision: { emoji: "👁️", label: "Vision" },
  hsa: { emoji: "🏦", label: "HSA / FSA" },
  retirement: { emoji: "💰", label: "401(k) match" },
  equity: { emoji: "📈", label: "Equity" },
  bonus: { emoji: "💵", label: "Bonus" },
  pto: { emoji: "🏖️", label: "Paid time off" },
  parental: { emoji: "👶", label: "Parental / family leave" },
  fertility: { emoji: "🍼", label: "Fertility / family planning" },
  mental_health: { emoji: "🧠", label: "Mental health" },
  wellness: { emoji: "🏋️", label: "Wellness / gym" },
  remote_stipend: { emoji: "🏠", label: "Remote / home-office stipend" },
  learning: { emoji: "📚", label: "Learning budget" },
  commuter: { emoji: "🚆", label: "Commuter" },
  meals: { emoji: "🍴", label: "Meals" },
  sabbatical: { emoji: "🌴", label: "Sabbatical" },
  pet: { emoji: "🐶", label: "Pet-friendly" },
};

const MODE_STATUS_COPY = {
  usage: {
    lean: {
      label: "Lean",
      tone: "constraint",
      title:
        "Lean usage: core work stays full quality; discretionary research, sweeps, and deep prep can downshift.",
    },
    standard: {
      label: "Standard",
      tone: "default",
      title: "Standard usage: normal discretionary scope.",
    },
    full: {
      label: "Full",
      tone: "expanded",
      title: "Full usage: deepest discretionary work when asked.",
    },
  },
  application: {
    selective: {
      label: "Selective",
      tone: "constraint",
      title:
        "Selective apply posture: discovery stays broad; medium-fit roles require manual review.",
    },
    balanced: {
      label: "Balanced",
      tone: "default",
      title: "Balanced apply posture: normal promotion and review posture after discovery.",
    },
    "high-volume": {
      label: "High-volume",
      tone: "expanded",
      title:
        "High-volume apply posture: discovery stays broad; more medium-fit roles can move into review or application.",
    },
  },
};

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function classifyStage(status) {
  const raw = String(status || "").toLowerCase();
  for (const [id, patterns] of STAGE_RULES) {
    if (patterns.some((pattern) => raw.includes(pattern))) return id;
  }
  return raw ? "applied" : "sourced";
}

// Scheduling / logistics chatter — describes an upcoming or just-booked touchpoint,
// not a completed evaluation round. These must never advance the furthest stage or
// count as an interview round (e.g. "interview scheduling", "recruiter screen
// scheduling", "interview logistics").
const SCHEDULING_CONV_RE = /\b(?:reschedul|schedul|logistic|booking|invite|confirm)\w*/i;
// A genuine interview-or-deeper round. Excludes a recruiter/phone screen, which is
// the "screen" stage, not an interview round.
const INTERVIEW_ROUND_RE =
  /\b(?:interview|panel|technical|assessment|onsite|on-site|loop|final|deep[\s-]?dive)\w*/i;
// Non-evaluative touchpoints that are real history but are NOT interview rounds: a
// referral intro, an offer/negotiation call, an internal debrief, a reference check.
// They must never inflate round DEPTH (the funnel's ordinal axis) — only
// candidate-facing evaluative rounds (screens + interviews) count. Without this, an
// accepted role's referral + offer + negotiation + debrief beats would read as extra
// "rounds" (e.g. a 4-round loop showing as a 9th-round outlier).
const NON_ROUND_CONV_RE = /\b(?:referral|offer|negotiat|debrief|reference)\w*/i;

// A genuine screen-or-deeper evaluative round, expressed as the typed stage ids a
// conversations[] entry can carry. Mirrors what INTERVIEW_ROUND_RE matches by text
// (interview/panel/technical/assessment/onsite/final) — screen is deliberately
// excluded (a recruiter/phone screen isn't "an interview round"), same as the legacy
// regex path.
const ROUND_STAGE_IDS = new Set([
  "interview",
  "assessment",
  "technical",
  "hiring-manager",
  "onsite",
  "final",
]);

// Newer conversations[] rows carry structured `stage` (a STAGE_ORDER id) and `outcome`
// ("pending"|"advanced"|"rejected"|"cancelled") fields written by schedule-meeting /
// track-outcomes. Prefer them when present — they're authoritative — and fall back to
// the free-text kind/title heuristic only for legacy rows that predate the typed schema.
function conversationStageId(conv) {
  const typed = String(conv?.stage || "");
  return typed && STAGE_ORDER[typed] != null ? typed : null;
}

function conversationIsWashedOut(conv, text) {
  const outcome = String(conv?.outcome || "").toLowerCase();
  if (outcome) return outcome === "rejected" || outcome === "cancelled";
  return /\b(?:reject|declin|withdraw)\w*/i.test(text);
}

// The deepest stage an application has actually reached, derived from BOTH the
// status string and the conversation history. The status string alone tops out
// wherever the agent last set it (often a generic "interview"), so we also classify
// every non-scheduling conversation and take the deepest. With the semantic round
// vocabulary (STAGE_RULES), that deepest classification IS the round name — a role
// whose last conversation kind is "onsite panel" surfaces as Onsite, a "leadership
// interview" as Hiring manager. We never count rounds into "Interview 1/2/3" and
// never auto-assign "Final"; both come from the actual round kind, not a tally.
// `rounds` is still returned (completed interview-or-deeper touchpoints) for callers
// that want a raw count, but it no longer drives the displayed stage.
function furthestStageForApp(app, statusStage = classifyStage(app?.status)) {
  let stage = statusStage;
  let order = STAGE_ORDER[statusStage] ?? 0;
  let rounds = 0;
  const convs = Array.isArray(app?.conversations) ? app.conversations : [];
  for (const conv of convs) {
    const text = `${conv?.kind || ""} ${conv?.title || ""}`;
    if (conversationIsWashedOut(conv, text)) continue;
    const typedStage = conversationStageId(conv);
    const scheduling = !typedStage && SCHEDULING_CONV_RE.test(text);
    const isRound = typedStage
      ? ROUND_STAGE_IDS.has(typedStage)
      : !scheduling && INTERVIEW_ROUND_RE.test(text);
    if (isRound) rounds += 1;
    if (scheduling) continue; // a pending touchpoint never advances the stage
    const convStage = typedStage || classifyStage(text);
    const convOrder = STAGE_ORDER[convStage] ?? 0;
    if (convOrder > order && convOrder < STAGE_ORDER.rejected) {
      order = convOrder;
      stage = convStage;
    }
  }
  return { stage, order, rounds };
}

// The deepest screen-or-deeper round an app reached, derived from conversations ALONE
// (ignoring the status string). Unlike furthestStageForApp this still works for a
// terminal app — a rejection after the HM round returns "hiring-manager", a rejection
// after a recruiter screen returns "screen". Returns null when the app never advanced
// past applied (a pre-response rejection). Lets the funnel separate the roles the
// candidate actually interviewed for and then lost from the bulk of form-rejections.
function deepestRoundStage(app) {
  let bestStage = null;
  let bestOrder = 0;
  for (const conv of Array.isArray(app?.conversations) ? app.conversations : []) {
    const text = `${conv?.kind || ""} ${conv?.title || ""}`;
    if (conversationIsWashedOut(conv, text)) continue;
    const typedStage = conversationStageId(conv);
    if (!typedStage && SCHEDULING_CONV_RE.test(text)) continue;
    const stage = typedStage || classifyStage(text);
    const order = STAGE_ORDER[stage] ?? 0;
    if (order >= STAGE_ORDER.screen && order < STAGE_ORDER.rejected && order > bestOrder) {
      bestOrder = order;
      bestStage = stage;
    }
  }
  return bestStage ? { stage: bestStage, order: bestOrder } : null;
}

// How many real interview ROUNDS an app has actually done — the count of
// conversations that are a genuine touchpoint (recruiter/phone screen, technical,
// panel, onsite, HM call …), excluding pure scheduling/logistics chatter and
// rejection notes. This is the ordinal the Jobs funnel buckets on: round DEPTH is
// genuinely cumulative (a 4th round means you also did rounds 1-3), unlike the
// semantic round TYPE (you can have a HM call without an Assessment), so it never
// fabricates a stage the candidate skipped. Reads conversations, not the status
// string, so it's correct for terminal apps too — a role rejected after one HM
// call reports 1 round, not "hiring-manager" parked five columns deep.
function roundCount(app) {
  let rounds = 0;
  for (const conv of Array.isArray(app?.conversations) ? app.conversations : []) {
    const text = `${conv?.kind || ""} ${conv?.title || ""}`;
    if (conversationIsWashedOut(conv, text)) continue;
    const typedStage = conversationStageId(conv);
    if (typedStage) {
      if (ROUND_STAGE_IDS.has(typedStage)) rounds += 1;
      continue;
    }
    if (SCHEDULING_CONV_RE.test(text)) continue;
    if (NON_ROUND_CONV_RE.test(text)) continue; // referral/offer/negotiation/debrief ≠ a round
    rounds += 1;
  }
  return rounds;
}

// The most recent conversations[] entry carrying a typed `stage` — the structured
// source of truth for "what round just happened and how did it go" (conv.outcome),
// used to decide whether a passed interview still needs its outcome logged. Returns
// null for legacy rows with no typed conversations so callers fall back to treating
// the outcome as unknown/pending rather than fabricating one.
function latestTypedConversation(app) {
  const convs = (Array.isArray(app?.conversations) ? app.conversations : []).filter((conv) =>
    conversationStageId(conv)
  );
  if (!convs.length) return null;
  return convs.reduce((latest, conv) => {
    if (!latest) return conv;
    return (parseTime(conv.date) ?? -Infinity) >= (parseTime(latest.date) ?? -Infinity)
      ? conv
      : latest;
  }, null);
}

function isAdvanced(app) {
  const stage = classifyStage(app.status);
  if (TERMINAL_STAGES.has(stage)) return false;
  return (STAGE_ORDER[stage] ?? 0) >= STAGE_ORDER.screen;
}

function isActive(app) {
  return !TERMINAL_STAGES.has(classifyStage(app.status));
}

function daysBetween(dueDate, now) {
  const due = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - due) / 86_400_000);
}

function dueText(rawDueAt, now) {
  if (!rawDueAt) return "Review";
  const due = new Date(rawDueAt);
  if (Number.isNaN(due.valueOf())) return "Review";
  const days = daysBetween(due, now);
  if (days > 0) return `${days}d overdue`;
  if (days === 0) return "due today";
  if (days === -1) return "tomorrow";
  return `in ${Math.abs(days)}d`;
}

function dueTone(rawDueAt, now) {
  if (!rawDueAt) return "secondary";
  const due = new Date(rawDueAt);
  if (Number.isNaN(due.valueOf())) return "secondary";
  const days = daysBetween(due, now);
  if (days > 0) return "error";
  if (days === 0) return "warning";
  return "secondary";
}

function hasRealActionText(value) {
  const action = String(value || "")
    .trim()
    .toLowerCase();
  return Boolean(
    action && action !== "none" && action !== "n/a" && action !== "na" && !/^none\b/.test(action)
  );
}

function queueSupportingText(company, stepDueText, tone) {
  if (tone === "error") return company;
  return `${company} · ${stepDueText}`;
}

function sortByQueuePriority(a, b) {
  if (a.source !== b.source) return a.source === "communication" ? -1 : 1;
  return new Date(a.dueAt || 0) - new Date(b.dueAt || 0);
}

function followUpTitle(app) {
  const kind = app.followUp?.kind || "";
  const status = String(app.status || "application").trim();
  if (kind === "post-interview-nudge") return `Follow up after ${status}`;
  if (kind === "app-nudge") return "Nudge application";
  return "Follow up";
}

function nextStepActionLabel({ title = "", detail = "", source = "", app = {}, comm = {} } = {}) {
  const text = [title, detail, comm.subject, app.status, app.role]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (source === "follow-up" || /\b(follow up|follow-up|nudge)\b/.test(text)) return "Follow-up";
  if (/\b(codesignal|assessment|take-home|take home|exercise)\b/.test(text)) return "Assessment";
  if (/\b(interview|hiring[- ]?manager|hm|onsite|on-site|panel|loop)\b/.test(text))
    return "Interview";
  if (/\b(screen|screening)\b/.test(text)) return "Screen";
  if (/\b(offer|counter|negotiat)\b/.test(text)) return "Offer";
  if (/\b(blocked|captcha|manual)\b/.test(text)) return "Manual apply";
  if (/\b(reply|respond|email|message)\b/.test(text)) return "Reply";
  return "Review";
}

function nextStepActionToneClass(label, tone = "secondary") {
  if (label === "Manual apply") return "text-error";
  if (label === "Interview") return "text-on-tertiary-container";
  if (label === "Assessment" || label === "Screen" || label === "Reply") {
    return tone === "error" ? "text-error" : "text-secondary";
  }
  if (label === "Offer" || label === "Follow-up") {
    return tone === "error" ? "text-error" : "text-[#e0a93b]";
  }
  if (tone === "error") return "text-error";
  if (tone === "warning") return "text-[#e0a93b]";
  return "text-secondary";
}

function buildStats(trackerData) {
  const applications = trackerData?.applications || [];
  const sourced = trackerData?.sourced || trackerData?.prospects || [];
  const advanced = applications.filter(isAdvanced).length;
  const rejected = applications.filter((app) => classifyStage(app.status) === "rejected").length;
  const withdrawn = applications.filter((app) => classifyStage(app.status) === "withdrawn").length;
  const active = applications.filter(isActive).length;
  // Candidate withdrawals remove the app from the market-response sample — a withdrawal
  // is not a market signal. Exclude withdrawn from both numerator and denominator so
  // responseRate measures only the market's reply rate on apps that stayed in play.
  const rateBase = applications.length - withdrawn;

  return {
    inPlay: active,
    responseRate: rateBase > 0 ? Math.round(((advanced + rejected) / rateBase) * 100) : 0,
    interviews: advanced,
    sourced: sourced.length,
    applied: applications.length,
    rejected,
    withdrawn,
  };
}

function modeStatusItem(kind, value, valid) {
  const normalized = String(value || "").toLowerCase();
  if (!valid || !MODE_STATUS_COPY[kind][normalized]) {
    return {
      value: normalized || "invalid",
      label: "Invalid",
      tone: "warning",
      title: "Mode config is invalid. Run rolester modes status.",
    };
  }
  return { value: normalized, ...MODE_STATUS_COPY[kind][normalized] };
}

function buildModeStatus(modes = {}) {
  const valid = modes?.valid !== false;
  const configured = Boolean(modes?.configured ?? modes?.exists);
  const usageValue = modes?.usageMode || modes?.usage_mode || modes?.data?.usage_mode || "standard";
  const applicationValue =
    modes?.applicationMode ||
    modes?.application_mode ||
    modes?.data?.application_mode ||
    "balanced";

  return {
    valid,
    configured,
    source: configured ? "configured" : "defaults",
    usage: modeStatusItem("usage", usageValue, valid),
    application: modeStatusItem("application", applicationValue, valid),
  };
}

function buildAgentGuidanceStatus(guidance = null) {
  const data = guidance && typeof guidance === "object" ? guidance : {};
  const nextSkill = String(data.nextSkill || "").trim();
  const command = String(data.command || "").trim();
  const message =
    String(data.message || "").trim() ||
    "Run rolester doctor, then ask the agent to follow the Agent guidance block.";
  const reason =
    String(data.reason || "").trim() || "The dashboard could not load a specific handoff yet.";
  return {
    ...data,
    title: "Next agent task",
    nextSkill,
    command,
    message,
    reason,
    ctaLabel: nextSkill ? `Run ${nextSkill}` : command ? "Run helper" : "Run doctor",
  };
}

function stringOrFallback(value, fallback = "Not set") {
  const text = String(value == null ? "" : value).trim();
  return text || fallback;
}

function listOrEmpty(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function buildSettingsStatus(settings = {}) {
  const profile = settings?.profile || {};
  const targeting = settings?.targeting || {};
  const honesty = settings?.honesty || {};
  const automation = settings?.automation || {};

  return {
    profile: {
      candidate: stringOrFallback(profile.candidate),
      headline: stringOrFallback(profile.headline),
      location: stringOrFallback(profile.location),
      minimumBase: stringOrFallback(profile.minimumBase),
      targetBase: stringOrFallback(profile.targetBase),
      expectedBase: stringOrFallback(profile.expectedBase),
      workAuthorization: stringOrFallback(profile.workAuthorization),
    },
    targeting: {
      primaryRoles: listOrEmpty(targeting.primaryRoles),
      excludedCompanies: listOrEmpty(targeting.excludedCompanies),
    },
    honesty: {
      boundaries: listOrEmpty(honesty.boundaries),
    },
    automation: {
      sessionProvider: stringOrFallback(automation.sessionProvider),
      enabledCapabilities: listOrEmpty(automation.enabledCapabilities),
    },
    files: listOrEmpty(settings?.files),
  };
}

// The candidate's real compensation floor/target for the Jobs drawer's
// Compensation Range pins (see compRangeView) — sourced from the settings
// snapshot's raw $K figures (candidate/profile.yml's compensation.minimum_base
// / target_base / expected_base, via settings-snapshot.mjs), never a
// fabricated placeholder. floorK/askK are null when the candidate hasn't set
// that field.
function profileCompFromSettings(settings) {
  const profile = settings?.profile || {};
  const minimumBaseK = Number(profile.minimumBaseK);
  const targetBaseK = Number(profile.targetBaseK);
  const expectedBaseK = Number(profile.expectedBaseK);
  return {
    floorK: Number.isFinite(minimumBaseK) ? minimumBaseK : null,
    askK: Number.isFinite(targetBaseK)
      ? targetBaseK
      : Number.isFinite(expectedBaseK)
        ? expectedBaseK
        : null,
  };
}

function objectList(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function buildLibraryStatus(library = {}) {
  const metrics = library?.metrics || {};
  const readiness = library?.readiness || {};
  return {
    metrics: {
      claims: Number(metrics.claims || 0),
      stories: Number(metrics.stories || 0),
      gaps: Number(metrics.gaps || 0),
    },
    index: objectList(library?.index),
    filters: objectList(library?.filters),
    cards: objectList(library?.cards),
    readiness: {
      proof: Number(readiness.proof || 0),
      stories: Number(readiness.stories || 0),
      voice: Number(readiness.voice || 0),
    },
    gaps: objectList(library?.gaps),
    storyLanes: objectList(library?.storyLanes),
  };
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compactUiText(value, max = 132) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

function firstSentence(value, fallback = "") {
  const text = compactUiText(value, 500);
  if (!text) return fallback;
  const [first] = text.split(/(?<=[.!?])\s+/);
  return first || fallback;
}

function networkRecord(records, company) {
  const name = String(company || "").trim();
  if (!name) return null;
  const key = normalizeName(name);
  if (!records.has(key)) {
    records.set(key, {
      company: name,
      apps: [],
      comms: [],
      contactMap: new Map(),
      leads: [],
      notes: [],
      latestAt: "",
    });
  }
  return records.get(key);
}

// Shared "this looks like an automated/system sender, not a person" check —
// used both to reject junk names in cleanContactName() and to skip the
// email-derived display-name fallback in addNetworkContact() below.
const SYSTEM_SENDER_RE =
  /\b(no[\s._-]?reply|do[\s._-]?not[\s._-]?reply|notification|candidate portal|portal|workday|ashby|greenhouse)\b/i;

// Loose but reliable email-shape check — reused everywhere dashboard-data.js
// needs to tell an address apart from a plain name string, instead of each
// call site hand-rolling its own regex.
function isEmailLike(value) {
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(String(value || "").trim());
}

// Last-resort display name for a contact we only know by email address (e.g.
// an inbound message whose `from` is a bare address with no display name):
// "jane.doe@co.example" -> "Jane Doe". Domain-neutral — no assumptions beyond
// the address's own separators.
function nameFromEmail(email) {
  const local = String(email || "")
    .split("@")[0]
    .trim();
  const parts = local
    .split(/[._+-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
  return parts.join(" ");
}

function cleanContactName(value, company) {
  const companyName = normalizeName(company);
  // Strip HTML tags in a loop so nested-tag patterns don't leave fragments.
  let text = String(value || "");
  let _prev;
  do {
    _prev = text;
    text = _prev.replace(/<[^>]*>/g, "");
  } while (text !== _prev);
  text = text
    .replace(/\([^)]*\)/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  text = text.split(/[;,]/)[0].trim();
  text = text.split(/\s+(?:--|-|—)\s+/)[0].trim();
  if (!text) return "";
  const normalized = normalizeName(text);
  if (
    !normalized ||
    normalized === companyName ||
    (activeCandidateName && normalized === activeCandidateName)
  )
    return "";
  if (/@/.test(text) || SYSTEM_SENDER_RE.test(text)) {
    return "";
  }
  return text;
}

function contactTypeFromText(value, fallback = "Recruiter") {
  const text = String(value || "").toLowerCase();
  if (/\b(portal|workday|ashby|greenhouse)\b/.test(text)) return "Portal";
  if (/\b(recruit\w*|talent|sourc\w*|people)\b/.test(text)) return "Recruiter";
  if (/\b(hiring manager|engineering manager|manager|director|vp|head|decision)\b/.test(text)) {
    return "Decision maker";
  }
  return fallback;
}

function addNetworkContact(
  record,
  rawName,
  { company, type, context = "", note = "", email = "", title = "", platform = "" } = {}
) {
  let name = cleanContactName(rawName, company || record.company);
  // Prefer an explicitly-passed email; fall back to rawName itself when the
  // caller handed us a bare address (e.g. message.from/to in an email thread).
  const emailValue = isEmailLike(email)
    ? String(email).trim()
    : isEmailLike(rawName)
      ? String(rawName).trim()
      : "";
  // No usable display name (common when all we have is a bare email) — derive
  // one from the address rather than dropping the contact entirely, unless it
  // looks like an automated/system sender.
  if (!name && emailValue && !SYSTEM_SENDER_RE.test(emailValue)) {
    name = nameFromEmail(emailValue);
  }
  if (!name) return;
  const contactType = type || contactTypeFromText(`${rawName} ${context} ${note}`);
  if (contactType === "Portal") return;
  const key = `${normalizeName(contactType)}:${normalizeName(name)}`;
  const existing = record.contactMap.get(key);
  const summary = firstSentence(note || context, "Relationship context captured in tracker.");
  const titleValue = compactUiText(title, 80);
  const platformValue = compactUiText(platform, 40);
  if (existing) {
    existing.note = existing.note || summary;
    existing.email = existing.email || emailValue;
    existing.title = existing.title || titleValue;
    existing.platform = existing.platform || platformValue;
    return;
  }
  record.contactMap.set(key, {
    type: contactType,
    name,
    note: compactUiText(summary, 96),
    email: emailValue,
    title: titleValue,
    platform: platformValue,
  });
}

function latestNetworkDate(record, ...values) {
  const latest = latestIso(record.latestAt, ...values);
  if (latest) record.latestAt = latest;
}

function addNetworkConversation(record, conversation) {
  const who = conversation?.who || "";
  const type = contactTypeFromText(`${conversation?.kind || ""} ${who}`, "Recruiter");
  addNetworkContact(record, who, {
    company: record.company,
    type,
    context: conversation?.kind,
    note: conversation?.notes,
  });
  if (conversation?.notes) record.notes.push(conversation.notes);
  latestNetworkDate(record, conversation?.at, conversation?.date);
}

function addNetworkCommunication(record, comm) {
  record.comms.push(comm);
  if (comm.summary) record.notes.push(comm.summary);
  latestNetworkDate(
    record,
    comm.updatedAt,
    comm.lastInboundAt,
    comm.lastOutboundAt,
    comm.nextActionDue,
    ...(comm.messages || []).map((message) => message.at)
  );

  for (const participant of arrayOrEmpty(comm.participants)) {
    addNetworkContact(record, participant.name || participant.email, {
      company: record.company,
      type: contactTypeFromText(participant.role, "Recruiter"),
      context: participant.role,
      note: comm.summary,
      email: participant.email,
      title: participant.role,
      platform: comm.channel,
    });
  }

  for (const message of comm.messages || []) {
    if (message.summary) record.notes.push(message.summary);
    if (message.direction === "inbound") {
      addNetworkContact(record, message.from, {
        company: record.company,
        type: contactTypeFromText(`${message.from} ${message.summary}`, "Recruiter"),
        context: message.subject,
        note: message.summary,
        email: message.from,
        platform: comm.channel,
      });
    }
    if (message.direction === "outbound-sent" || message.direction === "outbound-draft") {
      for (const to of message.to || []) {
        addNetworkContact(record, to, {
          company: record.company,
          type: contactTypeFromText(`${to} ${message.summary}`, "Recruiter"),
          context: message.subject,
          note: message.summary,
          email: to,
          platform: comm.channel,
        });
      }
    }
  }
}

function relationshipLeadStatus(lead) {
  const status = normalizeName(lead?.status || "review").replace(/\s+/g, "-");
  if (["approved", "accepted", "ready"].includes(status)) return "approved";
  if (["rejected", "dismissed", "ignored", "cut"].includes(status)) return "rejected";
  return "review";
}

function normalizeRelationshipLead(lead, app) {
  const company = String(lead?.company || app?.company || "").trim();
  const name = cleanContactName(lead?.name || lead?.person || lead?.contact || "", company);
  if (!company || !name) return null;
  const type = contactTypeFromText(
    `${lead?.type || ""} ${lead?.title || ""} ${lead?.basis || ""}`,
    "Contact"
  );
  const status = relationshipLeadStatus(lead);
  const platform = normalizeName(lead?.platform || "linkedin") || "linkedin";
  const note = firstSentence(
    lead?.note || lead?.basis || lead?.title || "Possible relationship path found for review.",
    "Possible relationship path found for review."
  );
  return {
    id: lead?.id || `lead-${calendarSlug(`${company}-${name}`)}`,
    applicationId: lead?.applicationId || app?.id || "",
    company,
    role: app?.role || lead?.role || "",
    name,
    type,
    title: lead?.title || type,
    platform,
    status,
    label: status === "approved" ? "Approved lead" : "Review lead",
    url: lead?.url || "",
    note: compactUiText(note, 110),
  };
}

function addNetworkRelationshipLead(record, lead, app) {
  const normalized = normalizeRelationshipLead(lead, app);
  if (!normalized) return null;
  record.leads.push(normalized);
  latestNetworkDate(record, lead?.updatedAt, lead?.foundAt, lead?.createdAt);
  if (normalized.status === "approved") {
    addNetworkContact(record, normalized.name, {
      company: record.company,
      type: normalized.type,
      context: normalized.title,
      note: normalized.note,
      title: normalized.title,
      platform: normalized.platform,
    });
  }
  return normalized;
}

function primaryNetworkApp(apps) {
  return [...apps].sort((a, b) => {
    const aTerminal = TERMINAL_STAGES.has(classifyStage(a.status));
    const bTerminal = TERMINAL_STAGES.has(classifyStage(b.status));
    if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
    const stageDelta =
      (STAGE_ORDER[classifyStage(b.status)] || 0) - (STAGE_ORDER[classifyStage(a.status)] || 0);
    if (stageDelta) return stageDelta;
    return Number(b.fitScore || 0) - Number(a.fitScore || 0);
  })[0];
}

function buildRelationshipSourcingTargets(applications, records) {
  return arrayOrEmpty(applications)
    .filter((app) => app?.company && !TERMINAL_STAGES.has(classifyStage(app.status)))
    .filter((app) => {
      const record = records.get(normalizeName(app.company));
      return !record || record.contactMap.size === 0;
    })
    .map((app) => ({
      id: app.id || calendarSlug(`${app.company}-${app.role}`),
      company: app.company,
      role: app.role || "Tracked role",
      fit: normalizeFit(app.fitScore),
      label: "Search contact path",
      summary: "No recruiter, hiring-team member, referral, or warm contact is tracked yet.",
      capability: "relationship_sourcing",
      platform: "linkedin",
    }))
    .sort((a, b) => b.fit - a.fit || a.company.localeCompare(b.company))
    .slice(0, 5);
}

function networkReuseState(app, comms) {
  const stage = classifyStage(app?.status);
  if (TERMINAL_STAGES.has(stage)) return "closed";
  if ((STAGE_ORDER[stage] || 0) >= STAGE_ORDER.screen) return "caution";
  if (comms.some((comm) => comm.status === "blocked")) return "caution";
  return "safe";
}

function networkDueLabel(state, app, comms, now) {
  const due =
    comms.find((comm) => comm.nextActionDue)?.nextActionDue ||
    app?.followUp?.dueAt ||
    comms.find((comm) => comm.lastInboundAt)?.lastInboundAt;
  if (state === "closed") return "New role only";
  if (state === "caution" && !due) return "After screen";
  if (!due) return state === "safe" ? "When specific" : "After active loop";
  return formatDateShort(String(due).slice(0, 10), dueText(due, now));
}

function networkReuseCopy(state, app, comms, now) {
  if (state === "closed") {
    return {
      title: "Closed: memory only",
      body: "Do not use as an immediate reach-out path; keep the objection memory for future screens.",
      scope: "Reuse scope: none now",
      due: networkDueLabel(state, app, comms, now),
    };
  }
  if (state === "caution") {
    return {
      title: "Caution: active loop first",
      body: "Use this relationship for the current process; broaden the ask only after the active loop resolves.",
      scope: "Reuse scope: same practice",
      due: networkDueLabel(state, app, comms, now),
    };
  }
  return {
    title: "Safe reuse: same-company routing",
    body: "Good reach-out point for adjacent roles when the ask is specific, low-pressure, and tied to known context.",
    scope: "Same-company routing",
    due: networkDueLabel(state, app, comms, now),
  };
}

function networkWarmth({ app, contacts, state, notes }) {
  const fit = normalizeFit(app?.fitScore);
  const stage = classifyStage(app?.status);
  let score = 34 + Math.round(fit * 0.25) + contacts.length * 8 + (STAGE_ORDER[stage] || 0) * 7;
  if (contacts.some((contact) => contact.type === "Decision maker")) score += 8;
  if (notes.length) score += 4;
  if (state === "closed") score -= 24;
  if (state === "caution") score += 4;
  return Math.max(24, Math.min(96, score));
}

function networkTone(state) {
  if (state === "safe") return "var(--teal)";
  if (state === "caution") return "var(--mustard)";
  return "var(--plum)";
}

// A relationship is one of: actively in a live process, a warm path we can reuse,
// or closed (outcome reached — keep as memory). Conveys STATE/outcome, not a meter.
function networkStateLabel(state) {
  if (state === "safe") return "Warm path";
  if (state === "caution") return "In process";
  return "Closed";
}

function buildNetworkCompany(record, now) {
  const app = primaryNetworkApp(record.apps) || {};
  const contacts = [...record.contactMap.values()].slice(0, 3);
  const state = networkReuseState(app, record.comms);
  const reuse = networkReuseCopy(state, app, record.comms, now);
  const warmth = networkWarmth({ app, contacts, state, notes: record.notes });
  return {
    company: record.company,
    domain: app.domain || app.companyDomain || "",
    initials: initials(record.company),
    role: app.role || record.comms.find((comm) => comm.role)?.role || "Relationship record",
    status: titleCase(app.status || record.comms.find((comm) => comm.status)?.status || "tracked"),
    warmth,
    contacts,
    reuseState: state,
    reuseTitle: reuse.title,
    reuseBody: reuse.body,
    reuseScope: reuse.scope,
    nextTouch: reuse.due,
    progressTone: networkTone(state),
    stateLabel: networkStateLabel(state),
    latestAt: record.latestAt,
    notes: record.notes,
  };
}

function relationshipRecordHasSignal(record) {
  // The Network page is a people map, not an application log: a company belongs
  // here only once an actual human is captured (a named conversation participant
  // or a real recruiter/hiring-team email thread). Threads whose only sender is
  // an automated no-reply/portal address contribute zero contacts (see
  // SYSTEM_SENDER_RE) — they must NOT surface a relationship. The previous
  // fallback passed on any non-portal, non-closed comm channel, which let
  // no-reply@ auto-confirmations masquerade as warm relationships and crowd the
  // real ones out of the top-6 slice.
  return record.contactMap.size > 0;
}

function buildNetwork(trackerData, { now = new Date() } = {}) {
  const records = new Map();
  const applications = trackerData?.applications || [];
  const communications = trackerData?.communications || [];
  const relationshipLeads = trackerData?.relationshipLeads || [];

  for (const app of applications) {
    const record = networkRecord(records, app.company);
    if (!record) continue;
    record.apps.push(app);
    latestNetworkDate(record, app.updatedAt, app.statusUpdatedAt, app.appliedAt);
    for (const conversation of app.conversations || []) {
      addNetworkConversation(record, conversation);
    }
  }

  for (const comm of communications) {
    const app = applications.find(
      (candidate) => candidate.id && candidate.id === comm.applicationId
    );
    const record = networkRecord(records, comm.company || app?.company);
    if (!record) continue;
    if (app && !record.apps.includes(app)) record.apps.push(app);
    addNetworkCommunication(record, comm);
  }

  const reviewLeads = [];
  for (const lead of relationshipLeads) {
    const app = applications.find(
      (candidate) => candidate.id && candidate.id === lead.applicationId
    );
    const record = networkRecord(records, lead.company || app?.company);
    if (!record) continue;
    if (app && !record.apps.includes(app)) record.apps.push(app);
    const normalized = addNetworkRelationshipLead(record, lead, app);
    if (normalized?.status === "review") reviewLeads.push(normalized);
  }

  const companies = [...records.values()]
    .filter(relationshipRecordHasSignal)
    .map((record) => buildNetworkCompany(record, now))
    .sort((a, b) => {
      const stateOrder = { safe: 0, caution: 1, closed: 2 };
      const stateDelta = (stateOrder[a.reuseState] ?? 9) - (stateOrder[b.reuseState] ?? 9);
      if (stateDelta) return stateDelta;
      return b.warmth - a.warmth;
    })
    .slice(0, 6);

  const recruiterNames = new Set();
  const hmNames = new Set();
  for (const company of companies) {
    for (const contact of company.contacts) {
      if (contact.type === "Decision maker") hmNames.add(normalizeName(contact.name));
      else if (contact.type === "Recruiter") recruiterNames.add(normalizeName(contact.name));
    }
  }

  const warmPaths = companies.filter((company) => company.reuseState !== "closed").length;
  const dormant = companies.filter((company) => company.reuseState === "closed").length;
  const gaps = [];
  if (recruiterNames.size > hmNames.size) {
    gaps.push("Most live companies only have recruiter coverage, not hiring-manager coverage.");
  }
  if (
    !companies.some((company) => company.contacts.some((contact) => /referral/i.test(contact.type)))
  ) {
    gaps.push("Referral nodes are absent from the warmest active loops.");
  }
  // "Map gaps" is the to-do list — actionable coverage holes only. Past-screen
  // memory is reference, not a gap, so it lives in objections/asks below, not here.
  if (!gaps.length) gaps.push("No open coverage gaps in the warm-path map.");

  const noteText = companies
    .flatMap((company) => company.notes)
    .join(" ")
    .toLowerCase();
  // Reference/memory from past screens — domain-neutral phrasing (no role/industry
  // assumptions baked in; see code-must-be-domain-neutral).
  const objections = [];
  if (/adoption|metric|proof|outcome/.test(noteText)) {
    objections.push("Proof points raised in past screens belong in the relationship record.");
  }
  if (/comp|salary|job-code|level/.test(noteText)) {
    objections.push("Comp/job-code ambiguity belongs to the relationship record.");
  }
  if (/onsite|office|hybrid|remote/.test(noteText)) {
    objections.push("Office-policy caveats should stay attached to company memory.");
  }
  if (/reject|moved forward|gap/.test(noteText)) {
    objections.push("Closed-loop objections should feed prep, not immediate re-pings.");
  }
  if (!objections.length) {
    objections.push(
      "Keep asks specific: one adjacent role, one clear context point, one low-pressure next step."
    );
  }

  const targets = buildRelationshipSourcingTargets(applications, records);

  return {
    metrics: {
      warmPaths,
      companies: companies.length,
      dormant,
    },
    companies,
    coverage: {
      recruiters: recruiterNames.size,
      hiringManagers: hmNames.size,
      signals: companies.filter((company) => company.notes.length).length,
    },
    gaps: gaps.slice(0, 3),
    guardrails: [
      "Same-company routing is a good use when the new role is specific and adjacent.",
      "Adjacent-team context is fair to ask for when the contact already knows your profile.",
      "Do not over-ping or ask one recruiter to spray referrals across unrelated roles.",
    ],
    objections: objections.slice(0, 3),
    sourcing: {
      capability: "relationship_sourcing",
      platforms: ["linkedin", "wellfound"],
      reviewLeads: reviewLeads.slice(0, 5),
      targets,
      guardrails: [
        "Found people are leads for candidate review, not outreach targets yet.",
        "A submitted application with no contact path stays waiting until a reviewed path exists.",
        "Draft outreach only after the candidate approves the lead and the ask is specific.",
      ],
    },
  };
}

// Comm statuses where the ball is with the OTHER party — the thread is healthy and
// waiting on them, not on the candidate. A descriptive nextAction ("Await their call")
// on one of these is a note about what we're waiting for, NOT a task for the user; it
// only becomes actionable when a follow-up timer fires (nextActionDue today or past →
// they've gone quiet, time to nudge). Without this gate a freshly-replied thread shows
// as something to do the moment you set it waiting. See AGENTS.md actionable-only CTAs.
const PASSIVE_COMM_STATUSES = new Set(["waiting", "scheduled"]);

function commActionDue(comm = {}, now = new Date()) {
  const dueAt = comm.nextActionDue;
  if (!dueAt) return false;
  const due = new Date(dueAt);
  if (Number.isNaN(due.valueOf())) return false;
  return daysBetween(due, now) >= 0;
}

// A "scheduled" comm thread whose follow-up point WAS a specific interview — nextAction
// like "Final onsite 2026-06-28" — stops being independently actionable once that
// interview's grace window has passed with no newer round booked (interviewFocusActive
// false). Without this gate commActionDue never expires: it only checks
// daysBetween>=0, so a comm row pinned to a now-past interview date reads as "due" every
// day forever and floats to #1 by oldest-date-wins. buildInterviewFollowUpSteps emits the
// real, structured "log the outcome" item in its place — see buildNextSteps.
function isStaleInterviewComm(comm, app, now) {
  if (!app || comm.status !== "scheduled") return false;
  const at = scheduledInterviewAt(app);
  if (!at) return false;
  if (interviewFocusActive(app, now)) return false; // still upcoming / within grace
  const interviewTime = parseTime(at);
  if (interviewTime == null) return false;
  const commDue = parseTime(comm.nextActionDue) ?? parseTime(comm.lastInboundAt);
  if (commDue == null) return false;
  // The comm's own follow-up point is at-or-before that interview — it was pinned to
  // this round, not a newer ask raised after it (which stays live on its own merits).
  return commDue <= interviewTime;
}

// Whether a comm thread is the candidate's to act on right now. Passive (waiting-on-them)
// statuses surface only when their follow-up timer has fired; everything else open does.
function commIsActionable(comm = {}, now = new Date(), app = null) {
  if (comm.status === "closed") return false;
  if (isStaleInterviewComm(comm, app, now)) return false;
  if (PASSIVE_COMM_STATUSES.has(comm.status)) return commActionDue(comm, now);
  return true;
}

function buildNextSteps(trackerData, now, { limit = 3 } = {}) {
  const applications = trackerData?.applications || [];
  const communications = trackerData?.communications || [];
  const appById = new Map(applications.map((app) => [app.id, app]));
  const openCommStatuses = new Set(["needs-reply", "drafted", "blocked"]);

  const commSteps = communications
    .filter((comm) => {
      const app = appById.get(comm.applicationId);
      return (
        commIsActionable(comm, now, app) &&
        (openCommStatuses.has(comm.status) || hasRealActionText(comm.nextAction))
      );
    })
    .map((comm) => {
      const app = appById.get(comm.applicationId);
      const dueAt = comm.nextActionDue || comm.lastInboundAt;
      const company = comm.company || app?.company || "Unknown company";
      const stepDueText = dueText(dueAt, now);
      const tone = dueTone(dueAt, now);
      const title = comm.nextAction || "Reply needed";
      // Queue/focus-visible text stays templated, never the freeform comm.summary prose
      // (that belongs in the drawer only) — the role title is the short, factual stand-in.
      const detail = app?.role || comm.subject || "";
      const actionLabel = nextStepActionLabel({
        title,
        detail,
        source: "communication",
        app,
        comm,
      });
      return {
        title,
        company,
        detail,
        dueAt,
        dueText: stepDueText,
        supportingText: queueSupportingText(company, stepDueText, tone),
        tone,
        actionLabel,
        actionToneClass: nextStepActionToneClass(actionLabel, tone),
        detailId: app?.id || comm.applicationId || "",
        source: "communication",
      };
    });

  // A structured "log the interview outcome" item for every active application whose
  // scheduled interview has passed (grace window elapsed, no newer round booked) and
  // whose latest typed conversation outcome is still pending/unset. This is the
  // legitimate replacement for the stale comm masquerade gated out by
  // isStaleInterviewComm above — it counts exactly once, reads only structured fields
  // (interviewAt/nextInterviewAt + conversations[].outcome), and never touches prose.
  const interviewFollowUpSteps = buildInterviewFollowUpSteps(trackerData, now);

  const followUpSteps = applications
    .filter((app) => {
      if (!app.followUp) return false;
      // Only surface follow-ups whose due date has arrived. A follow-up scheduled
      // for the future is not yet an action item — it belongs in Next Steps only
      // once the due date fires (matching the overdue gate in followUpAction()).
      const due = app.followUp.dueAt || app.followUp.nextActionDue || app.followUp.generatedAt;
      if (due && new Date(due) > now) return false;
      return true;
    })
    .map((app) => {
      const dueAt = app.followUp.dueAt || app.followUp.generatedAt || app.appliedAt;
      const company = app.company || "Unknown company";
      const stepDueText = dueText(dueAt, now);
      const tone = dueTone(dueAt, now);
      const title = followUpTitle(app);
      // Templated, non-prose: the role title only. statusNote/note are drawer-only.
      const detail = app.role || "";
      const actionLabel = nextStepActionLabel({ title, detail, source: "follow-up", app });
      return {
        title,
        company,
        detail,
        dueAt,
        dueText: stepDueText,
        supportingText: queueSupportingText(company, stepDueText, tone),
        tone,
        actionLabel,
        actionToneClass: nextStepActionToneClass(actionLabel, tone),
        detailId: app.id || "",
        source: "follow-up",
      };
    });

  // Closed/rejected/withdrawn apps are terminal — their residual nextAction strings
  // are historical notes, not live tasks. Exclude them so they don't surface here.
  const TERMINAL_APP_STATUSES = new Set(["rejected", "withdrawn", "closed", "archived"]);
  const applicationSteps = applications
    .filter((app) => hasRealActionText(app.nextAction) && !TERMINAL_APP_STATUSES.has(app.status))
    .map((app) => {
      const dueAt = app.nextActionDue || app.updatedAt || app.appliedAt;
      const company = app.company || "Unknown company";
      const stepDueText = dueText(dueAt, now);
      const tone = dueTone(dueAt, now);
      const title = String(app.nextAction || "").trim();
      // Templated, non-prose: the role title only. statusNote/note are drawer-only.
      const detail = app.role || "";
      const actionLabel = nextStepActionLabel({ title, detail, source: "application", app });
      return {
        title,
        company,
        detail,
        dueAt,
        dueText: stepDueText,
        supportingText: queueSupportingText(company, stepDueText, tone),
        tone,
        actionLabel,
        actionToneClass: nextStepActionToneClass(actionLabel, tone),
        detailId: app.id || "",
        source: "application",
      };
    });

  const ordered = [
    ...commSteps,
    ...interviewFollowUpSteps,
    ...applicationSteps,
    ...followUpSteps,
  ].sort(sortByQueuePriority);
  return limit == null ? ordered : ordered.slice(0, limit);
}

// The structured post-interview item: once an application's scheduled interview has
// passed (grace window elapsed, no newer round booked — same interviewFocusActive gate
// buildInterviewFocus uses) and its latest typed conversation outcome is still
// "pending" (or unset, for legacy rows with no typed conversations), the candidate owes
// a real action — log what happened — not a resurrected "reply" to a thread about a call
// that already happened. Reads ONLY structured fields (interviewAt/nextInterviewAt +
// conversations[].outcome), never comm.summary or freeform notes, and fires at most once
// per application (there is exactly one "latest" interview per app at any time).
function buildInterviewFollowUpSteps(trackerData, now) {
  const applications = trackerData?.applications || [];
  return applications
    .filter((app) => isActive(app))
    .map((app) => {
      const at = scheduledInterviewAt(app);
      if (!at || interviewFocusActive(app, now)) return null;
      const interviewTime = parseTime(at);
      if (interviewTime == null) return null;
      const latestConv = latestTypedConversation(app);
      const outcome = String(latestConv?.outcome || "")
        .trim()
        .toLowerCase();
      if (outcome && outcome !== "pending") return null; // already logged elsewhere
      const stageId = furthestStageForApp(app).stage;
      const stageLabel = stageGroupLabel(stageId);
      const company = app.company || "Unknown company";
      const stepDueText = dueText(at, now);
      const tone = dueTone(at, now);
      const title = `Log ${company} ${stageLabel} outcome`;
      const dateLabel = formatDateShort(String(at).slice(0, 10));
      const meta = `${stageLabel} was ${dateLabel} · awaiting your outcome note`;
      const actionLabel = nextStepActionLabel({
        title,
        detail: stageLabel,
        source: "interview-followup",
        app,
      });
      return {
        title,
        company,
        detail: app.role || "",
        meta,
        dueAt: at,
        dueText: stepDueText,
        supportingText: queueSupportingText(company, stepDueText, tone),
        tone,
        actionLabel,
        actionToneClass: nextStepActionToneClass(actionLabel, tone),
        detailId: app.id || "",
        // Sorts alongside real comm asks (oldest-due-wins) — a 12-day-overdue outcome is
        // exactly as urgent as a 12-day-overdue reply, so it earns the same queue slot.
        source: "communication",
        kind: "interview-followup",
        stageId,
        stageLabel,
      };
    })
    .filter(Boolean);
}

// Turn tracker.storyEnrichment (mirrored from each story's open_questions by
// `stories sync-enrichment`) into Next-Steps cards. These are agent→user prompts:
// a story was banked thin and needs context only the candidate can give. They are
// static (no drawer) and self-clear — when the story's open_questions empty, the
// sync drops the entry and the card disappears. Source of truth lives in
// candidate/stories.yml; this only renders the persisted mirror.
function buildStoryEnrichmentSteps(trackerData) {
  const entries = Array.isArray(trackerData?.storyEnrichment) ? trackerData.storyEnrichment : [];
  return entries
    .map((entry) => {
      const missing = (Array.isArray(entry?.missing) ? entry.missing : [])
        .map((m) => String(m ?? "").trim())
        .filter(Boolean);
      if (!missing.length) return null;
      const title = String(entry.title ?? entry.storyId ?? "Story").trim() || "Story";
      const lead = compactUiText(missing[0], 96);
      const more = missing.length - 1;
      const supportingText =
        more > 0 ? `Story added — ${lead} (+${more} more)` : `Story added — ${lead}`;
      return {
        title,
        company: "",
        detail: missing.join(" · "),
        dueAt: null,
        dueText: "",
        supportingText,
        tone: "info",
        actionLabel: "Give context",
        actionToneClass: "text-secondary",
        detailId: "",
        source: "story-enrichment",
      };
    })
    .filter(Boolean);
}

function buildLatestRoles(trackerData) {
  const sourced = trackerData?.sourced || trackerData?.prospects || [];
  return [...sourced]
    .sort((a, b) => Number(b.fitScore || 0) - Number(a.fitScore || 0))
    .slice(0, 3)
    .map((role) => ({
      detailId: role.id || "",
      company: role.company || "Unknown company",
      role: role.role || "Open role",
      fit: Number(role.fitScore || 0),
      status: role.fitBucket || role.fitBasis || "sourced",
    }));
}

function parseTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

// Canonical scheduled-interview datetime for an application. The schedule-meeting skill
// writes interviewAt (first booked round) and nextInterviewAt (each later round) as ISO
// datetime strings; nextInterviewDate/interviewDate are legacy aliases kept read-only. We
// read the NEXT round first so a booked follow-on supersedes an earlier round. This reads
// ONLY structured fields — never freeform notes or conversations — so a job description
// that mentions "onsite" or "technical" can't manufacture a phantom interview.
function scheduledInterviewAt(app) {
  return (
    app?.nextInterviewAt || app?.interviewAt || app?.nextInterviewDate || app?.interviewDate || ""
  );
}

// Keep a scheduled interview as the Focus through the session, then auto-advance. The
// grace window means a 12:00 interview stays featured until mid-afternoon (covering the
// call + debrief) and then the Focus card promotes the next real item on its own.
const INTERVIEW_FOCUS_GRACE_MS = 3 * 60 * 60 * 1000;

// Is there a real, scheduled interview that should own the Focus card right now? True only
// when a structured interview datetime exists and has not yet passed (plus the grace
// window). A past interview with no new round booked returns false, so the card advances.
function interviewFocusActive(app, now) {
  const at = scheduledInterviewAt(app);
  if (!at) return false;
  const time = parseTime(at);
  if (time == null) return false;
  return time + INTERVIEW_FOCUS_GRACE_MS >= now.getTime();
}

// Structured logistics + prep-dossier snapshot for a single application — the same
// richness buildInterviewFocus always featured, now shared so the action AND
// interview-followup Focus branches reach it too instead of leaving facts/dossier
// empty. Safe to call with a missing app (a comm with no linked application resolves
// to sensible, empty defaults rather than throwing).
function focusAppContext(app) {
  const role = app?.role || "Open role";
  const company = app?.company || "Unknown company";
  // Logistics only — comp/fit stay in the drawer (Tracker Content Register).
  const facts = [
    app?.mode ? { label: "Format", value: titleCase(app.mode) } : null,
    app?.loc ? { label: "Location", value: app.loc } : null,
  ].filter(Boolean);
  const rawDossier = app?.artifacts?.interviewDossier || null;
  const hasDossier = Boolean(rawDossier?.markdown);
  const dossier = {
    title: rawDossier?.title || `${company} — ${role}`,
    subtitle: app?.interviewNote || `${company} · ${role}`,
    round: rawDossier?.round || "",
    generatedAt: rawDossier?.generatedAt || "",
    markdown: rawDossier?.markdown || "",
  };
  return { role, company, facts, dossier, hasDossier };
}

// The Focus card's generic-action CTA verb, derived from the same nextStepActionLabel
// classification the Next Steps queue already uses — never a hardcoded "Handle next
// action" that reads wrong once the underlying item is legitimately something else.
function focusCtaForActionLabel(label) {
  return label === "Interview" ? "Prep this interview" : "Handle reply";
}

function buildInterviewFocus(trackerData, now) {
  // The Focus card features an interview ONLY when a real round is scheduled and still
  // upcoming (within the grace window). An interview-stage app with no booked next round
  // is NOT a phantom Focus item — it falls through to the action/follow-up queue and the
  // cadence watch/stale rules surface the silence instead.
  const selected = (trackerData?.applications || [])
    .filter((app) => isActive(app) && interviewFocusActive(app, now))
    .map((app) => ({ app, dueAt: scheduledInterviewAt(app) }))
    .sort(
      (a, b) =>
        (parseTime(a.dueAt) ?? Number.MAX_SAFE_INTEGER) -
        (parseTime(b.dueAt) ?? Number.MAX_SAFE_INTEGER)
    )[0];
  if (!selected) return null;

  const app = selected.app;
  const { role, company, facts, dossier, hasDossier } = focusAppContext(app);
  // Focus card interview slot reads ONLY the typed interviewNote — logistics, nothing
  // about comp/fit (those route to the drawer). Legacy rows with only app.note fall
  // back to a generic line, not the old mixed-topic blob.
  const meta =
    app.interviewNote ||
    (hasDossier
      ? "Dossier ready — open to review prep context."
      : "Interview scheduled — generate your prep dossier.");
  return {
    kind: "interview",
    // The round the app has actually reached (typed conversations preferred) — e.g.
    // "Onsite" / "Final" / "Hiring manager" — not a generic "Interview" bucket.
    type: stageGroupLabel(furthestStageForApp(app).stage),
    title: hasDossier ? "Interview dossier" : "Upcoming interview",
    company,
    role,
    meta,
    dueText: selected.dueAt ? dueText(selected.dueAt, now) : "Prep",
    dueAt: selected.dueAt || "",
    tone: dueTone(selected.dueAt, now),
    facts,
    dossier,
    hasDossier,
    detailId: app.id || "",
    // Only offer "Open dossier" when one actually exists, so the CTA never opens empty.
    cta: hasDossier ? "Open dossier" : "Prep this interview",
  };
}

function buildFocusCard(trackerData, { now, nextSteps, latestRoles } = {}) {
  const interview = buildInterviewFocus(trackerData, now);
  if (interview) return interview;

  const applications = trackerData?.applications || [];
  const appById = new Map(applications.map((app) => [app.id, app]));

  const primary = nextSteps?.[0];
  if (primary) {
    const app = appById.get(primary.detailId);
    const ctx = focusAppContext(app);

    if (primary.kind === "interview-followup") {
      // Same structured richness as the interview branch (facts/dossier/hasDossier
      // resolved off the actual application) — the item just points at a round that
      // already happened and needs its outcome logged, not a phantom reply.
      return {
        kind: "interview-followup",
        type: primary.stageLabel || stageGroupLabel(primary.stageId || ""),
        title: primary.title,
        company: primary.company,
        role: app?.role || primary.detail || "Open role",
        meta: primary.meta || primary.supportingText || "",
        dueText: primary.dueText,
        dueAt: primary.dueAt || "",
        tone: primary.tone,
        facts: ctx.facts,
        dossier: ctx.dossier,
        hasDossier: ctx.hasDossier,
        detailId: primary.detailId || "",
        cta: "Log outcome",
      };
    }

    // Generic next action (comm reply, application follow-up nudge, …). Resolve the
    // underlying application so role/facts/dossier reach the same richness as the
    // interview branches instead of leaking the queue item's own templated stand-ins.
    const type = primary.actionLabel || "Review";
    const meta = primary.supportingText || `${primary.company} · ${primary.dueText}`;
    return {
      kind: "action",
      type,
      title: primary.title,
      company: primary.company,
      role: app?.role || primary.detail || "Open role",
      meta,
      dueText: primary.dueText,
      dueAt: primary.dueAt || "",
      tone: primary.tone,
      facts: ctx.facts,
      dossier: ctx.dossier,
      hasDossier: ctx.hasDossier,
      detailId: primary.detailId || "",
      cta: focusCtaForActionLabel(type),
    };
  }

  const role = latestRoles?.[0];
  if (role) {
    const meta = `${role.fit} fit · ${titleCase(role.status)}`;
    return {
      kind: "review",
      type: "Review",
      title: "Best new role",
      company: role.company,
      role: role.role,
      meta,
      dueText: "Review",
      dueAt: "",
      tone: "secondary",
      facts: [],
      dossier: null,
      hasDossier: false,
      detailId: role.detailId || "",
      cta: "Review roles",
    };
  }

  const clearMeta =
    "When new tracker activity arrives, the focus card will promote the next useful item.";
  return {
    kind: "clear",
    type: "",
    title: "No urgent action",
    company: "Rolester",
    role: "",
    meta: clearMeta,
    dueText: "Clear",
    dueAt: "",
    tone: "secondary",
    facts: [],
    dossier: null,
    hasDossier: false,
    detailId: "",
    cta: "Review dashboard",
  };
}

const CALENDAR_WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CALENDAR_KIND_LABELS = {
  reply: "Reply",
  prep: "Prep",
  "follow-up": "Follow-up",
  interview: "Interview",
  assessment: "Assessment",
  deadline: "Deadline",
  busy: "Busy",
};
const CALENDAR_ACTIONABLE_KINDS = new Set(["reply", "follow-up", "assessment", "deadline"]);
const CALENDAR_SYNC_PROVIDERS = [
  {
    key: "apple_calendar",
    label: "Apple Calendar",
    channel: "Local writer",
    summary: "Confirm-first local calendar event creation.",
  },
  {
    key: "google_calendar",
    label: "Google Calendar",
    channel: "Provider writer",
    summary: "Confirm-first Google Calendar event creation.",
  },
  {
    key: "outlook_calendar",
    label: "Outlook Calendar",
    channel: "Provider writer",
    summary: "Confirm-first Outlook Calendar event creation.",
  },
  {
    key: "automation_tools",
    label: "Automation tools",
    channel: "Script handoff",
    summary: "Confirm-first handoff to approved local automation.",
  },
];

function isoDate(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const date = new Date(text);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString().slice(0, 10);
}

function utcDateFromIso(iso) {
  return new Date(`${iso}T00:00:00.000Z`);
}

function addDaysToIso(iso, days) {
  const date = utcDateFromIso(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function compareIsoDate(a, b) {
  return a.localeCompare(b);
}

function mondayForIso(iso) {
  const date = utcDateFromIso(iso);
  const day = date.getUTCDay();
  const delta = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function daysBetweenIso(a, b) {
  return Math.round((utcDateFromIso(b) - utcDateFromIso(a)) / 86_400_000);
}

function monthTitleFromIso(iso) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(utcDateFromIso(iso));
}

function monthShortFromIso(iso) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    timeZone: "UTC",
  }).format(utcDateFromIso(iso));
}

function weekLabel(startIso, endIso) {
  const startMonth = monthShortFromIso(startIso);
  const endMonth = monthShortFromIso(endIso);
  const startDay = utcDateFromIso(startIso).getUTCDate();
  const endDay = utcDateFromIso(endIso).getUTCDate();
  return startMonth === endMonth
    ? `${startMonth} ${startDay}-${endDay}`
    : `${startMonth} ${startDay}-${endMonth} ${endDay}`;
}

function calendarTimeLabel(value) {
  if (!value || !String(value).includes("T")) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function calendarKindFromText(value, fallback = "deadline") {
  const text = String(value || "").toLowerCase();
  // A "Prep for <round>" / "Prepare for <round>" ACTION is a prep commitment, not
  // the interview itself. Classify it as prep BEFORE the interview check so the
  // prep reminder doesn't render as a phantom interview (duplicating the real
  // conversation-sourced event) on the day its prep is due. Only fires when the
  // text leads with the prep verb, so an interview note that merely mentions
  // "prep" later (e.g. a conversation kind + notes) still classifies as interview.
  if (/^\s*prep(are|ping)?\b/.test(text)) return "prep";
  if (/\b(codesignal|assessment|take[- ]?home|exercise|technical test)\b/.test(text)) {
    return "assessment";
  }
  if (
    /\b(interview|hiring[- ]?manager|hm\b|panel|loop|onsite|on-site|screen|screening|call)\b/.test(
      text
    )
  ) {
    return "interview";
  }
  if (/\b(reply|respond|availability|message|email)\b/.test(text)) return "reply";
  if (/\b(follow up|follow-up|nudge|recap)\b/.test(text)) return "follow-up";
  if (/\b(prep|prepare|packet|dossier)\b/.test(text)) return "prep";
  return fallback;
}

// The calendar holds only actionable, time-bound commitments the candidate must DO
// at a moment — interviews, prep, scheduled sends, deadlines. Passive monitoring
// ("await their reply", "awaiting a scheduling request") is NOT a calendar item; it
// belongs in Next Steps / open loops. This gate keeps those off the time grid.
function isPassiveWaitAction(value) {
  const text = String(value || "")
    .toLowerCase()
    .trim();
  if (!text) return false;
  return (
    /\b(await|awaiting|waiting (?:on|for)|listen(?:ing)? for|monitor(?:ing)? for|hear back|no response(?: yet)?|expect(?:ing)? (?:a )?(?:reply|response|word|update))\b/.test(
      text
    ) || /\bpending\b(?!\s+(?:offer|decision|deadline))/.test(text)
  );
}

function calendarKindLabel(kind) {
  return CALENDAR_KIND_LABELS[kind] || "Review";
}

function calendarEventCta(kind) {
  if (kind === "interview" || kind === "assessment" || kind === "prep") return "Open prep";
  if (kind === "reply") return "Open thread";
  return "Open item";
}

function calendarEventMeta(rawDate, now, company, fallback = "") {
  const time = calendarTimeLabel(rawDate);
  const due = dueText(rawDate, now);
  if (time) return `${time} · ${company || fallback || "Tracked item"}`;
  return `${company || fallback || "Tracked item"} · ${due}`;
}

// An interview/assessment is "done" once it is in the past: an earlier calendar day,
// or today with an explicit start time already elapsed. An untimed round logged for
// today reads as completed (it is recorded as the day's round, not a future slot).
// Done rounds render muted and sink within their day — history, not next action.
function calendarEventDone(event, todayIso, now) {
  if (event.kind !== "interview" && event.kind !== "assessment") return false;
  const cmp = compareIsoDate(event.iso, todayIso);
  if (cmp < 0) return true;
  if (cmp > 0) return false;
  if (calendarHasExplicitTime(event.rawDate)) {
    const start = new Date(event.rawDate);
    return !Number.isNaN(start.valueOf()) && start.getTime() < now.getTime();
  }
  return true;
}

function calendarEventPriority(event, todayIso) {
  // Opaque free/busy blocks are context, not actions — always sort below the
  // actionable items within a day.
  if (event.kind === "busy") return 9;
  // Completed rounds sink to the bottom of their day — they're history, not next action.
  if (event.done) return 8.5;
  const delta = daysBetweenIso(todayIso, event.iso);
  if (event.source === "conversation" && delta < 0) return 8;
  if (delta < 0 && CALENDAR_ACTIONABLE_KINDS.has(event.kind)) return 0;
  if (delta === 0) {
    if (CALENDAR_ACTIONABLE_KINDS.has(event.kind)) return 1;
    // Prep precedes the interview it prepares for, even when they share a day.
    if (event.kind === "prep") return 1.5;
    if (event.kind === "interview") return 2;
  }
  if (delta > 0) {
    if (event.kind === "prep") return 2.8;
    if (event.kind === "interview" || event.kind === "assessment") return 3;
    return 4;
  }
  return 7;
}

function sortCalendarEvents(todayIso) {
  return (a, b) =>
    calendarEventPriority(a, todayIso) - calendarEventPriority(b, todayIso) ||
    compareIsoDate(a.iso, b.iso) ||
    Number(a.sortTime || 0) - Number(b.sortTime || 0) ||
    a.title.localeCompare(b.title);
}

function calendarDateSortTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 0 : date.getTime();
}

function calendarSlug(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "calendar";
}

function calendarIcsEscape(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function calendarUtcStamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function calendarDateToken(iso) {
  return String(iso || "").replace(/-/g, "");
}

function calendarHasExplicitTime(value) {
  const text = String(value || "");
  return text.includes("T") || /\b\d{1,2}:\d{2}\b/.test(text);
}

function calendarEventDurationMinutes(kind) {
  if (kind === "interview") return 45;
  if (kind === "assessment" || kind === "prep") return 60;
  return 30;
}

function calendarEventTiming(event) {
  const start = calendarHasExplicitTime(event.rawDate) ? new Date(event.rawDate) : null;
  if (start && !Number.isNaN(start.valueOf())) {
    const end = new Date(start.getTime() + calendarEventDurationMinutes(event.kind) * 60_000);
    return {
      kind: "timed",
      start,
      end,
      googleDates: `${calendarUtcStamp(start)}/${calendarUtcStamp(end)}`,
      outlookStart: start.toISOString(),
      outlookEnd: end.toISOString(),
      icsStart: `DTSTART:${calendarUtcStamp(start)}`,
      icsEnd: `DTEND:${calendarUtcStamp(end)}`,
    };
  }
  const startIso = event.iso;
  const endIso = addDaysToIso(startIso, 1);
  return {
    kind: "all-day",
    startIso,
    endIso,
    googleDates: `${calendarDateToken(startIso)}/${calendarDateToken(endIso)}`,
    outlookStart: startIso,
    outlookEnd: endIso,
    icsStart: `DTSTART;VALUE=DATE:${calendarDateToken(startIso)}`,
    icsEnd: `DTEND;VALUE=DATE:${calendarDateToken(endIso)}`,
  };
}

function calendarEventDetails(event) {
  return [
    event.meta,
    [event.company, event.role].filter(Boolean).join(" - "),
    event.cta ? `Rolester action: ${event.cta}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function calendarEventVevent(event, timing = calendarEventTiming(event)) {
  const stamp = calendarUtcStamp(utcDateFromIso(event.iso));
  return [
    "BEGIN:VEVENT",
    `UID:${calendarIcsEscape(`${event.id || calendarSlug(event.title)}@rolester.local`)}`,
    `DTSTAMP:${stamp}`,
    `SUMMARY:${calendarIcsEscape(event.title)}`,
    `DESCRIPTION:${calendarIcsEscape(calendarEventDetails(event))}`,
    timing.icsStart,
    timing.icsEnd,
    "END:VEVENT",
  ].join("\r\n");
}

function calendarIcsDocument(vevents) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Rolester//Calendar Export//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...vevents,
    "END:VCALENDAR",
  ].join("\r\n");
}

function calendarGoogleUrl(event, timing) {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: timing.googleDates,
    details: calendarEventDetails(event),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function calendarOutlookUrl(event, timing) {
  const params = new URLSearchParams({
    subject: event.title,
    body: calendarEventDetails(event),
    startdt: timing.outlookStart,
    enddt: timing.outlookEnd,
  });
  if (timing.kind === "all-day") params.set("allday", "true");
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

function calendarEventExport(event) {
  const timing = calendarEventTiming(event);
  return {
    kind: timing.kind,
    filename: `${calendarSlug(event.title)}-${event.iso}.ics`,
    ics: calendarIcsDocument([calendarEventVevent(event, timing)]),
    googleUrl: calendarGoogleUrl(event, timing),
    outlookUrl: calendarOutlookUrl(event, timing),
  };
}

function calendarBundleExport(events, label) {
  const rows = objectList(events);
  return {
    count: rows.length,
    filename: `rolester-calendar-${calendarSlug(label)}.ics`,
    ics: calendarIcsDocument(rows.map((event) => calendarEventVevent(event))),
  };
}

function calendarSyncProviderLabel(provider) {
  return (
    CALENDAR_SYNC_PROVIDERS.find((item) => item.key === provider)?.label || titleCase(provider)
  );
}

function normalizeCalendarWrite(record) {
  if (!record || typeof record !== "object") return null;
  const provider = record.provider || record.platform || "";
  const title = compactUiText(record.title || record.eventTitle || "Calendar event", 84);
  const status = String(record.status || "written").toLowerCase();
  const wroteAt = record.wroteAt || record.createdAt || record.at || "";
  return {
    id:
      record.id ||
      `${provider || "calendar"}-${calendarSlug(title)}-${isoDate(wroteAt) || "write"}`,
    eventId: record.eventId || record.calendarEventId || "",
    provider,
    providerLabel: calendarSyncProviderLabel(provider),
    title,
    status,
    statusLabel: titleCase(status),
    wroteAt,
    atLabel: formatDateShort(isoDate(wroteAt), "Recent"),
    eventIso: record.eventIso || isoDate(record.eventAt || record.date || ""),
    summary: compactUiText(record.summary || record.note || "Confirmed calendar write.", 120),
  };
}

function buildCalendarSync(trackerData) {
  const writes = [
    ...arrayOrEmpty(trackerData?.calendarWrites),
    ...arrayOrEmpty(trackerData?.calendarSync?.writes),
  ]
    .map(normalizeCalendarWrite)
    .filter(Boolean)
    .sort((a, b) => calendarDateSortTime(b.wroteAt) - calendarDateSortTime(a.wroteAt))
    .slice(0, 5);

  return {
    capability: "calendar_sync",
    posture: "Confirm-first",
    providers: CALENDAR_SYNC_PROVIDERS.map((provider) => ({
      ...provider,
      status: "Consent gated",
    })),
    history: writes,
  };
}

function addCalendarEvent(events, seen, event) {
  if (!event?.iso || !event?.title) return;
  const detailKey = event.detailId || event.id || "";
  // For a scheduled round (interview/assessment) the app + day + kind IS the identity:
  // a conversation entry and a comm "attend the interview" reminder for the same
  // app on the same day are the same event, so dedupe them regardless of title
  // (the first-added, richer conversation event wins — see buildCalendarEvents order).
  const key =
    event.kind === "interview" || event.kind === "assessment"
      ? `${detailKey}:${event.iso}:${event.kind}`
      : `${detailKey}:${event.iso}:${event.kind}:${normalizeName(event.title)}`;
  if (seen.has(key)) return;
  seen.add(key);
  const normalized = {
    ...event,
    id: event.id || `${event.kind}-${detailKey || events.length + 1}-${event.iso}`,
    label: calendarKindLabel(event.kind),
    // Carry the clock time separately so list views can show it alongside the date
    // (the meta string folds it in, but the date-led list columns render time on its own).
    time: event.time || calendarTimeLabel(event.rawDate),
    cta: event.cta || calendarEventCta(event.kind),
  };
  events.push({
    ...normalized,
    export: calendarEventExport(normalized),
  });
}

function communicationCalendarEvent(comm, app, now) {
  // Only surface comms the candidate has something to DO right now. Passive/closed
  // threads belong in Next Steps or nowhere — not on the calendar time grid.
  if (!commIsActionable(comm, now, app)) return null;
  const action = String(comm.nextAction || "").trim();
  if (!action || /^none|n\/a$/i.test(action)) return null;
  const dueAt = comm.nextActionDue || comm.lastInboundAt;
  const iso = isoDate(dueAt);
  if (!iso) return null;
  const company = comm.company || app?.company || "Unknown company";
  const kind = calendarKindFromText(action);
  const title =
    kind === "interview"
      ? `${company} interview`
      : kind === "follow-up" && !/^follow/i.test(action)
        ? `Follow up with ${company}`
        : compactUiText(action, 82);
  return {
    id: comm.id || `comm-${company}-${iso}`,
    iso,
    rawDate: dueAt,
    sortTime: calendarDateSortTime(dueAt),
    title,
    meta: calendarEventMeta(dueAt, now, company, app?.role || comm.role),
    kind,
    detailId: app?.id || comm.applicationId || "",
    company,
    role: app?.role || comm.role || "",
    source: "communication",
  };
}

function followUpCalendarEvent(app, now) {
  const dueAt = app.followUp?.dueAt || app.followUp?.nextActionDue || app.followUp?.generatedAt;
  const iso = isoDate(dueAt);
  if (!iso) return null;
  // A follow-up the candidate SENDS is actionable; a passive "await response" is not.
  if (isPassiveWaitAction(`${app.followUp?.kind || ""} ${app.followUp?.title || ""}`)) return null;
  const company = app.company || "Unknown company";
  const kind = calendarKindFromText(
    `${app.followUp?.kind || ""} ${app.followUp?.title || ""}`,
    "follow-up"
  );
  const title =
    kind === "interview"
      ? `${company} interview`
      : kind === "assessment"
        ? `${company} assessment`
        : `Follow up with ${company}`;
  return {
    id: app.id ? `follow-up-${app.id}` : `follow-up-${company}-${iso}`,
    iso,
    rawDate: dueAt,
    sortTime: calendarDateSortTime(dueAt),
    title,
    meta: calendarEventMeta(dueAt, now, company, app.role),
    kind,
    detailId: app.id || "",
    company,
    role: app.role || "",
    source: "follow-up",
  };
}

function explicitInterviewCalendarEvent(app, rawDate, now) {
  const iso = isoDate(rawDate);
  if (!iso) return null;
  const company = app.company || "Unknown company";
  return {
    id: app.id ? `interview-${app.id}-${iso}` : `interview-${company}-${iso}`,
    iso,
    rawDate,
    sortTime: calendarDateSortTime(rawDate),
    title: `${company} interview`,
    meta: calendarEventMeta(rawDate, now, company, app.role),
    kind: "interview",
    detailId: app.id || "",
    company,
    role: app.role || "",
    source: "application",
  };
}

function conversationCalendarEvent(app, conversation, now) {
  const iso = isoDate(conversation?.date || conversation?.at);
  if (!iso) return null;
  const kind = calendarKindFromText(`${conversation?.kind || ""} ${conversation?.notes || ""}`, "");
  if (!["interview", "assessment"].includes(kind)) return null;
  const company = app.company || "Unknown company";
  const label = calendarKindLabel(kind).toLowerCase();
  return {
    id: conversation.id || `conversation-${app.id || company}-${iso}`,
    iso,
    rawDate: conversation.date || conversation.at,
    sortTime: calendarDateSortTime(conversation.date || conversation.at),
    title: `${company} ${label}`,
    meta:
      conversation.who ||
      app.role ||
      calendarEventMeta(conversation.date || conversation.at, now, company),
    kind,
    detailId: app.id || "",
    company,
    role: app.role || "",
    source: "conversation",
  };
}

function busyCalendarEvent(busy) {
  const startIso = busy?.startIso || busy?.start || busy?.from || "";
  const iso = isoDate(startIso);
  if (!iso) return null;
  const endIso = busy?.endIso || busy?.end || busy?.to || "";
  const allDay = Boolean(busy?.allDay);
  const startLabel = calendarTimeLabel(startIso);
  const endLabel = calendarTimeLabel(endIso);
  const meta = allDay
    ? "All day"
    : startLabel && endLabel
      ? `${startLabel} – ${endLabel}`
      : startLabel || "Busy";
  return {
    id: busy?.id || `busy-${busy?.provider || "cal"}-${startIso || iso}`,
    iso,
    rawDate: startIso,
    sortTime: calendarDateSortTime(startIso),
    title: compactUiText(busy?.label || "Busy", 40),
    meta,
    kind: "busy",
    detailId: "",
    company: "",
    role: "",
    source: "busy",
    provider: busy?.provider || "",
    allDay,
    endIso,
  };
}

// Opaque free/busy blocks ingested under calendar_read. Kept separate from the
// actionable event set so they never inflate metrics, today, or upcoming — they
// only render as muted context on the week grid and month dots.
function buildCalendarBusy(trackerData) {
  const blocks = arrayOrEmpty(trackerData?.calendarBusy);
  const events = [];
  const seen = new Set();
  for (const block of blocks) {
    const event = busyCalendarEvent(block);
    if (!event) continue;
    const key = `${event.provider}:${event.rawDate}:${event.endIso}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  return events;
}

function buildCalendarEvents(trackerData, now) {
  const applications = trackerData?.applications || [];
  const communications = trackerData?.communications || [];
  const appById = new Map(applications.map((app) => [app.id, app]));
  const events = [];
  const seen = new Set();

  // Conversations + explicit interview dates are the authoritative scheduled rounds,
  // so add them FIRST. A comm "attend the interview" reminder for the same app+day
  // then dedupes against the richer conversation entry (interviewer name in meta)
  // rather than the reverse.
  for (const app of applications) {
    for (const rawDate of [app.nextInterviewAt, app.interviewAt]) {
      addCalendarEvent(events, seen, explicitInterviewCalendarEvent(app, rawDate, now));
    }
    for (const conversation of app.conversations || []) {
      addCalendarEvent(events, seen, conversationCalendarEvent(app, conversation, now));
    }
  }

  for (const comm of communications) {
    addCalendarEvent(
      events,
      seen,
      communicationCalendarEvent(comm, appById.get(comm.applicationId), now)
    );
  }

  for (const app of applications) {
    if (app.followUp) addCalendarEvent(events, seen, followUpCalendarEvent(app, now));
  }

  const todayIso = isoDate(now);
  for (const event of events) {
    event.done = calendarEventDone(event, todayIso, now);
  }
  return events.sort(sortCalendarEvents(todayIso));
}

function eventsBetween(events, startIso, endIso) {
  return events.filter(
    (event) => compareIsoDate(event.iso, startIso) >= 0 && compareIsoDate(event.iso, endIso) <= 0
  );
}

function buildCalendarWeek(events, startIso, todayIso, busyEvents = []) {
  const days = Array.from({ length: 5 }, (_, index) => {
    const iso = addDaysToIso(startIso, index);
    const date = utcDateFromIso(iso);
    const dayEvents = events
      .filter((event) => event.iso === iso)
      .sort(sortCalendarEvents(todayIso));
    // Busy blocks are context, not actions — append them after the actionable
    // items so the day card leads with what the candidate must do.
    const dayBusy = busyEvents
      .filter((event) => event.iso === iso)
      .sort((a, b) => Number(a.sortTime || 0) - Number(b.sortTime || 0));
    return {
      dow: CALENDAR_WEEKDAY_LABELS[date.getUTCDay()],
      date: String(date.getUTCDate()),
      iso,
      state: compareIsoDate(iso, todayIso) < 0 ? "past" : iso === todayIso ? "today" : "",
      events: [...dayEvents, ...dayBusy],
    };
  });
  const endIso = addDaysToIso(startIso, 4);
  const weekEvents = eventsBetween(events, startIso, endIso).sort(sortCalendarEvents(todayIso));
  const actionable = weekEvents.filter(
    (event) => event.source !== "conversation" && CALENDAR_ACTIONABLE_KINDS.has(event.kind)
  );
  const nextUp =
    weekEvents.find((event) => event.source !== "conversation") || weekEvents[0] || null;
  const stats = {
    interviews: weekEvents.filter((event) => event.kind === "interview").length,
    replies: weekEvents.filter((event) => event.kind === "reply").length,
    deadlines: weekEvents.filter(
      (event) => event.kind === "deadline" || event.kind === "assessment"
    ).length,
  };
  return {
    label: weekLabel(startIso, endIso),
    startIso,
    endIso,
    export: calendarBundleExport(weekEvents, weekLabel(startIso, endIso)),
    days,
    events: weekEvents,
    nextUp: nextUp
      ? {
          ...nextUp,
          note:
            nextUp.kind === "interview" || nextUp.kind === "assessment"
              ? "Prep context, job notes, artifacts, and open questions are ready from the tracker."
              : "This is the next dated item from the tracker. Handle it before adding more work.",
        }
      : {
          label: "Clear",
          title: "No dated action",
          note: "No interviews, replies, assessments, or follow-ups are dated in this week.",
          meta: "Calendar clear",
          kind: "deadline",
          detailId: "",
          cta: "Review jobs",
        },
    loops: actionable.slice(0, 4),
    stats,
  };
}

function buildCalendarMonth(events, todayIso, busyEvents = []) {
  const today = utcDateFromIso(todayIso);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const monthIso = monthStart.toISOString().slice(0, 10);
  const gridStart = mondayForIso(monthIso);
  const cells = Array.from({ length: 42 }, (_, index) => {
    const iso = addDaysToIso(gridStart, index);
    const date = utcDateFromIso(iso);
    // Full per-day event set (actionable leads, busy fills) — the week-expansion
    // reads these; the dot row slices them down at render time.
    const dayEvents = [
      ...events.filter((event) => event.iso === iso),
      ...busyEvents.filter((event) => event.iso === iso),
    ];
    const isMonthStart = date.getUTCDate() === 1;
    return {
      iso,
      date: String(date.getUTCDate()),
      // A short month tag on each 1st-of-month cell marks where the grid crosses
      // into a new month (e.g. the July spillover below the current month).
      monthLabel: isMonthStart ? monthShortFromIso(iso) : "",
      muted: date.getUTCMonth() !== today.getUTCMonth(),
      isToday: iso === todayIso,
      state: compareIsoDate(iso, todayIso) < 0 ? "past" : iso === todayIso ? "today" : "",
      events: dayEvents,
    };
  });
  const monthEvents = events.filter((event) => {
    const date = utcDateFromIso(event.iso);
    return (
      date.getUTCMonth() === today.getUTCMonth() && date.getUTCFullYear() === today.getUTCFullYear()
    );
  });
  return {
    title: monthTitleFromIso(todayIso),
    count: monthEvents.length,
    countLabel: `${monthEvents.length} tracked`,
    days: cells,
  };
}

function buildCalendarProtectedPrep(events, todayIso) {
  const prep = events
    .filter(
      (event) =>
        compareIsoDate(event.iso, todayIso) >= 0 &&
        (event.kind === "interview" || event.kind === "assessment" || event.kind === "prep")
    )
    .sort(sortCalendarEvents(todayIso))[0];
  if (!prep) {
    return {
      title: "No prep block needed",
      label: "Clear",
      note: "No dated interview or assessment prep is waiting in the tracker.",
      detailId: "",
      cta: "Review jobs",
    };
  }
  return {
    title: prep.title,
    label: prep.label,
    note: "Block prep before this item unless a reply is overdue.",
    detailId: prep.detailId,
    cta: "Open prep",
  };
}

function buildCalendar(trackerData, { now = new Date() } = {}) {
  const todayIso = isoDate(now);
  const events = buildCalendarEvents(trackerData, now);
  const busyEvents = buildCalendarBusy(trackerData);
  const currentWeekStart = mondayForIso(todayIso);
  const weeks = [0, 7, 14].map((offset) =>
    buildCalendarWeek(events, addDaysToIso(currentWeekStart, offset), todayIso, busyEvents)
  );
  const currentWeek = weeks[0];
  const todayEvents = events.filter((event) => event.iso === todayIso);
  // "Upcoming" spans the next dated items from today forward, regardless of week
  // boundary. A today-only or this-week slice goes empty on a quiet day (e.g. a
  // Sunday whose next interview is Monday), which read as "nothing coming up."
  const upcomingEvents = events
    .filter((event) => compareIsoDate(event.iso, todayIso) >= 0)
    .sort((a, b) => compareIsoDate(a.iso, b.iso))
    .slice(0, 6);
  return {
    todayIso,
    currentWeekIndex: 0,
    metrics: {
      thisWeek: currentWeek.events.length,
      interviews: currentWeek.events.filter((event) => event.kind === "interview").length,
      dueToday: todayEvents.filter((event) => event.source !== "conversation").length,
    },
    weeks,
    month: buildCalendarMonth(events, todayIso, busyEvents),
    today: {
      label: formatDateShort(todayIso, "Today"),
      events: todayEvents,
    },
    upcoming: {
      events: upcomingEvents,
    },
    protectedPrep: buildCalendarProtectedPrep(events, todayIso),
    sync: buildCalendarSync(trackerData),
  };
}

function latestIso(...values) {
  let latest = null;
  for (const value of values.flat(Infinity)) {
    if (!value) continue;
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) continue;
    if (!latest || date > latest) latest = date;
  }
  return latest ? latest.toISOString() : "";
}

function earliestIso(...values) {
  let earliest = null;
  for (const value of values.flat(Infinity)) {
    if (!value) continue;
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) continue;
    if (!earliest || date < earliest) earliest = date;
  }
  return earliest ? earliest.toISOString() : "";
}

function durableUpdatedAt(trackerData) {
  const meta = trackerData?.meta || {};
  // The canonical freshness stamp: the true last data-changing write. Every
  // writing skill bumps meta.lastUpdatedAt (see AGENTS.md Tracker Write
  // Contract). meta.lastSweepAt is deliberately NOT here — a mail sweep that
  // changed nothing must not reset the pill; it lives in the scatter-scan
  // fallback below so it only counts when no real write timestamp exists.
  const explicit = latestIso(
    meta.lastUpdatedAt,
    meta.updatedAt,
    trackerData?.lastUpdatedAt,
    trackerData?.updatedAt
  );
  if (explicit) return explicit;

  const applications = trackerData?.applications || [];
  const sourced = trackerData?.sourced || trackerData?.prospects || [];
  const sources = trackerData?.sources || [];
  const communications = trackerData?.communications || [];

  return latestIso(
    meta.lastSweepAt,
    sources.map((source) => source.lastRunAt),
    applications.flatMap((app) => [
      app.updatedAt,
      app.statusUpdatedAt,
      app.appliedAt,
      app.followUp?.generatedAt,
      app.followUp?.dueAt,
      ...(app.conversations || []).flatMap((conv) => [conv.at, conv.date]),
    ]),
    sourced.flatMap((role) => [role.updatedAt, role.sourcedAt, role.createdAt, role.date]),
    communications.flatMap((comm) => [
      comm.updatedAt,
      comm.lastInboundAt,
      comm.lastOutboundAt,
      comm.nextActionDue,
      ...(comm.messages || []).map((message) => message.at),
    ])
  );
}

const STRATEGY_STALE_AFTER_DAYS = 14;
// A no-response application goes "stale" after ~2 weeks quiet, then "ghosted" once
// it crosses ~30 days with no inbound or outbound touch. Both are domain-neutral
// best-practice cadence defaults (nudge ~1wk, stale ~2wk, ghosted ~30d).
const STRATEGY_GHOSTED_AFTER_DAYS = 30;

// Decay reads as draining signal, not its own colour: one neutral (cool) grey,
// going translucent as the app rots. Stale stays clearly visible; ghosted fades
// almost to nothing. Used for both the funnel node bars and their inflow links.
const DECAY_STALE_COLOR = "#6f7479cc"; // grey @ ~80% — visible
const DECAY_GHOSTED_COLOR = "#6f747933"; // grey @ ~20% — faded to almost nothing

function strategySourceLabel(app) {
  if (String(app?.channel || "").toLowerCase() === "portal") return "Find Jobs surfacing";
  return sourceInfo("application", app.channel || "board").label;
}

function strategyRoleLane(role) {
  const text = String(role || "").toLowerCase();
  if (/\b(forward deployed|deployed|deployment engineer|fde|field engineer)\b/.test(text)) {
    return "Forward deployed";
  }
  if (/\b(solution|solutions|architect|sales engineer|customer engineer)\b/.test(text)) {
    return "Solutions";
  }
  if (/\b(product manager|product lead|product)\b/.test(text) && /\b(ai|agent|ml)\b/.test(text)) {
    return "AI product";
  }
  if (
    /\b(devex|developer experience|mcp|connector|connectors|platform|automation|tools?)\b/.test(
      text
    ) &&
    /\b(ai|agent|ml|saas|software|engineer|developer)\b/.test(text)
  ) {
    return "AI platform";
  }
  if (
    /\b(applied ai|artificial intelligence|ai engineer|ai developer|ai workflows?|agent|agents|llm|genai|generative ai|ml engineer|machine learning)\b/.test(
      text
    )
  ) {
    return "Applied AI";
  }
  if (/\b(identity|iam|security|trust)\b/.test(text)) {
    return "IAM/security";
  }
  if (/\b(director|head|it services|workplace|business technology)\b/.test(text)) {
    return "IT leadership";
  }
  if (/\b(operations?|operator|ops|growth)\b/.test(text)) {
    return "Operations";
  }
  return "Other";
}

function strategyFitBand(fitScore) {
  const fit = normalizeFit(fitScore);
  if (fit >= 80) return { id: "high", label: "High fit", order: 0 };
  if (fit >= 65) return { id: "medium", label: "Medium fit", order: 1 };
  return { id: "stretch", label: "Stretch", order: 2 };
}

function addStrategyGroup(groups, key, label, app, extra = {}) {
  if (!groups.has(key)) {
    groups.set(key, {
      key,
      label,
      total: 0,
      advanced: 0,
      terminal: 0,
      fitTotal: 0,
      order: extra.order ?? 999,
    });
  }
  const row = groups.get(key);
  const stage = classifyStage(app.status);
  row.total += 1;
  row.fitTotal += normalizeFit(app.fitScore);
  if (isAdvanced(app)) row.advanced += 1;
  if (TERMINAL_STAGES.has(stage)) row.terminal += 1;
}

function finalizeStrategyRows(groups, { fixedOrder = false } = {}) {
  const maxTotal = Math.max(1, ...[...groups.values()].map((row) => row.total));
  return [...groups.values()]
    .map((row) => {
      const heardBack = row.advanced + row.terminal;
      const avgFit = row.total ? Math.round(row.fitTotal / row.total) : 0;
      const responseValue = row.total ? Math.round((heardBack / row.total) * 100) : 0;
      const advancedValue = row.total ? Math.round((row.advanced / row.total) * 100) : 0;
      return {
        ...row,
        avgFit,
        responseValue,
        advancedValue,
        rate: `${responseValue}%`,
        advanceRate: `${advancedValue}%`,
        bar: Math.max(8, Math.round((row.total / maxTotal) * 100)),
        meta: `${row.advanced}/${row.total} advanced · ${responseValue}% response`,
      };
    })
    .sort((a, b) => {
      if (fixedOrder && a.order !== b.order) return a.order - b.order;
      return (
        b.advanced - a.advanced ||
        b.responseValue - a.responseValue ||
        b.total - a.total ||
        a.order - b.order ||
        a.label.localeCompare(b.label)
      );
    });
}

function latestApplicationTouch(app, communications = []) {
  return latestIso(
    app.updatedAt,
    app.statusUpdatedAt,
    app.appliedAt,
    app.followUp?.generatedAt,
    ...(app.conversations || []).flatMap((conversation) => [conversation.at, conversation.date]),
    communications.flatMap((comm) => [
      comm.updatedAt,
      comm.lastInboundAt,
      comm.lastOutboundAt,
      ...(comm.messages || []).flatMap((message) => [message.at, message.date]),
    ])
  );
}

function buildStrategyStaleRows(applications, communications, now) {
  return applications
    .map((app, index) => {
      const stage = classifyStage(app.status);
      const appComms = communicationsForApplication(app, communications);
      const latest = latestApplicationTouch(app, appComms);
      if (
        TERMINAL_STAGES.has(stage) ||
        (STAGE_ORDER[stage] ?? 0) >= STAGE_ORDER.screen ||
        !latest
      ) {
        return null;
      }
      const daysQuiet = daysBetween(new Date(latest), now);
      if (daysQuiet <= STRATEGY_STALE_AFTER_DAYS) return null;
      return {
        id: app.id || `stale-${index + 1}`,
        title: app.company || "Unknown company",
        meta: `${daysQuiet}d quiet · ${app.role || "Open role"}`,
        detailId: app.id || "",
        daysQuiet,
        stage: stageGroupLabel(stage),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.daysQuiet - a.daysQuiet || a.title.localeCompare(b.title))
    .slice(0, 4);
}

function strategyStageStartedAt(app) {
  return app.statusUpdatedAt || app.stageUpdatedAt || app.appliedAt || app.updatedAt || "";
}

function daysSince(rawDate, now) {
  if (!rawDate) return null;
  const date = new Date(rawDate);
  if (Number.isNaN(date.valueOf())) return null;
  return Math.max(0, daysBetween(date, now));
}

function withStrategyBars(rows, key) {
  const max = Math.max(1, ...rows.map((row) => Number(row[key] || 0)));
  return rows.map((row) => ({
    ...row,
    bar: Math.max(8, Math.round((Number(row[key] || 0) / max) * 100)),
  }));
}

function buildStrategyStageRows(applications, now) {
  const rows = applications
    .map((app, index) => {
      const stage = classifyStage(app.status);
      if (TERMINAL_STAGES.has(stage)) return null;
      const daysInStage = daysSince(strategyStageStartedAt(app), now);
      if (daysInStage == null) return null;
      const stageLabelValue = stageGroupLabel(stage);
      return {
        id: app.id || `stage-age-${index + 1}`,
        title: app.company || "Unknown company",
        meta: `${daysInStage}d in ${stageLabelValue} · ${app.role || "Open role"}`,
        detailId: app.id || "",
        daysInStage,
        stage: stageLabelValue,
        rate: `${daysInStage}d`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.daysInStage - a.daysInStage || a.title.localeCompare(b.title))
    .slice(0, 4);
  return withStrategyBars(rows, "daysInStage");
}

function cadenceDueAt(app, communications = []) {
  return earliestIso(
    app.followUp?.dueAt,
    app.followUp?.nextActionDue,
    communications.map((comm) => comm.nextActionDue)
  );
}

function buildCadenceRow(app, index, communications, now) {
  const stage = classifyStage(app.status);
  if (TERMINAL_STAGES.has(stage)) return null;

  const stageLabelValue = stageGroupLabel(stage);
  const dueAt = cadenceDueAt(app, communications);
  if (dueAt) {
    const daysDue = daysBetween(new Date(dueAt), now);
    if (daysDue > 0) {
      return {
        id: app.id || `cadence-${index + 1}`,
        title: `Follow up with ${app.company || "Unknown company"}`,
        meta: `${daysDue}d overdue · ${stageLabelValue}`,
        detailId: app.id || "",
        tone: "overdue",
        priority: 0,
        daysQuiet: daysDue,
        badge: "Due",
      };
    }
    if (daysDue === 0) {
      return {
        id: app.id || `cadence-${index + 1}`,
        title: `Follow up with ${app.company || "Unknown company"}`,
        meta: `due today · ${stageLabelValue}`,
        detailId: app.id || "",
        tone: "due",
        priority: 1,
        daysQuiet: 0,
        badge: "Today",
      };
    }
    if (daysDue >= -7) {
      return {
        id: app.id || `cadence-${index + 1}`,
        title: `Hold until ${formatDateShort(dueAt.slice(0, 10), "scheduled")}`,
        meta: `${app.company || "Unknown company"} · ${Math.abs(daysDue)}d out · ${stageLabelValue}`,
        detailId: app.id || "",
        tone: "scheduled",
        priority: 4,
        daysQuiet: Math.abs(daysDue),
        badge: "Set",
      };
    }
  }

  const latest = latestApplicationTouch(app, communications);
  const daysQuiet = daysSince(latest, now);
  if (daysQuiet == null) return null;
  if ((STAGE_ORDER[stage] ?? 0) >= STAGE_ORDER.screen && daysQuiet > 5) {
    // No next round is booked here (we already passed the cadenceDueAt branch). At 2+
    // weeks of silence an interview/screen loop has gone cold — escalate from "watch" to
    // "stale" so a no-response interview reads as needing a decision, not a perpetual
    // live loop. This applies the same 2-week staleness rule advanced stages were exempt
    // from in buildStrategyStaleRows.
    const isStale = daysQuiet > STRATEGY_STALE_AFTER_DAYS;
    return {
      id: app.id || `cadence-${index + 1}`,
      title: isStale
        ? `Revisit stale ${stageLabelValue} at ${app.company || "Unknown company"}`
        : `Protect ${stageLabelValue} loop at ${app.company || "Unknown company"}`,
      meta: isStale ? `${daysQuiet}d quiet · no response` : `${daysQuiet}d quiet · active loop`,
      detailId: app.id || "",
      tone: isStale ? "quiet" : "watch",
      priority: isStale ? 2 : 3,
      daysQuiet,
      badge: isStale ? "Stale" : "Watch",
    };
  }
  if (daysQuiet > STRATEGY_STALE_AFTER_DAYS && hasContactPath(app, communications)) {
    return {
      id: app.id || `cadence-${index + 1}`,
      title: `Set next touch for ${app.company || "Unknown company"}`,
      meta: `${daysQuiet}d quiet · no next touch`,
      detailId: app.id || "",
      tone: "quiet",
      priority: 2,
      daysQuiet,
      badge: "Plan",
    };
  }
  return null;
}

function buildStrategyCadenceRows(applications, communications, now) {
  return applications
    .map((app, index) =>
      buildCadenceRow(app, index, communicationsForApplication(app, communications), now)
    )
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.priority - b.priority || b.daysQuiet - a.daysQuiet || a.title.localeCompare(b.title)
    )
    .slice(0, 5);
}

function strategyLearningBuckets(applications, now) {
  const buckets = [
    { label: "Last 30d", min: 0, max: 30 },
    { label: "31-60d", min: 31, max: 60 },
    { label: "61-90d", min: 61, max: 90 },
  ].map((bucket) => ({
    ...bucket,
    applied: 0,
    advanced: 0,
    interviews: 0,
    rejected: 0,
    responseRate: 0,
  }));

  for (const app of applications) {
    const age = daysSince(app.appliedAt || app.submittedDate || app.createdAt, now);
    if (age == null || age > 90) continue;
    const bucket = buckets.find((candidate) => age >= candidate.min && age <= candidate.max);
    if (!bucket) continue;
    const stage = classifyStage(app.status);
    bucket.applied += 1;
    if (isAdvanced(app)) bucket.advanced += 1;
    if (!TERMINAL_STAGES.has(stage) && (STAGE_ORDER[stage] || 0) >= STAGE_ORDER.interview) {
      bucket.interviews += 1;
    }
    if (stage === "rejected") bucket.rejected += 1;
  }

  return buckets.map((bucket) => ({
    ...bucket,
    responseRate: bucket.applied
      ? Math.round(((bucket.advanced + bucket.rejected) / bucket.applied) * 100)
      : 0,
  }));
}

function strategyPercent(numerator, denominator) {
  if (!denominator) return "0%";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function buildStrategyLearningTrends(bucket) {
  const applied = bucket?.applied || 0;
  const advanced = bucket?.advanced || 0;
  const interviews = bucket?.interviews || 0;
  const rejected = bucket?.rejected || 0;
  return [
    {
      id: "applied",
      label: "Applied",
      value: applied,
      deltaLabel: `${applied} roles`,
      meta: "Tracker rows entering the funnel.",
      tone: "neutral",
    },
    {
      id: "advanced",
      label: "Advanced",
      value: advanced,
      deltaLabel: strategyPercent(advanced, applied),
      meta: `${advanced}/${applied} moved past applied.`,
      tone: advanced ? "positive" : "neutral",
    },
    {
      id: "interviews",
      label: "Interviews",
      value: interviews,
      deltaLabel: strategyPercent(interviews, applied),
      meta: `${interviews}/${applied} reached interview stage.`,
      tone: interviews ? "positive" : "neutral",
    },
    {
      id: "rejected",
      label: "Rejected",
      value: rejected,
      deltaLabel: strategyPercent(rejected, applied),
      meta: `${rejected}/${applied} closed rejected.`,
      tone: rejected >= 2 ? "warning" : "neutral",
    },
  ];
}

function buildStrategyLearningSignals(applications, now) {
  const sourceGroups = new Map();
  const roleGroups = new Map();
  for (const app of applications) {
    const age = daysSince(app.appliedAt || app.submittedDate || app.createdAt, now);
    if (age == null || age > 30) continue;
    addStrategyGroup(
      sourceGroups,
      `source:${normalizeName(strategySourceLabel(app))}`,
      strategySourceLabel(app),
      app
    );
    const lane = strategyRoleLane(app.role);
    addStrategyGroup(roleGroups, `role:${normalizeName(lane)}`, lane, app);
  }

  const sourceRows = finalizeStrategyRows(sourceGroups).map((row) => ({
    ...row,
    kindOrder: 0,
  }));
  const roleRows = finalizeStrategyRows(roleGroups).map((row) => ({
    ...row,
    kindOrder: 1,
  }));

  return [...sourceRows, ...roleRows]
    .filter((row) => row.total > 0)
    .sort(
      (a, b) =>
        b.advanced - a.advanced ||
        b.responseValue - a.responseValue ||
        b.total - a.total ||
        a.kindOrder - b.kindOrder ||
        a.label.localeCompare(b.label)
    )
    .slice(0, 4)
    .map((row) => ({
      id: row.key,
      label: row.label,
      meta: `${row.advanced} advanced · ${row.rate} response · ${row.total} tracked`,
      value: row.advanced,
      tone: row.advanced ? "positive" : "neutral",
    }));
}

// After a strategy review is recorded (reevaluate-strategy stamps tracker.json#
// strategyReview), the "review ready" nudge stays quiet until the funnel has produced
// enough NEW resolved outcomes (advances + rejections) to be worth another look — or a
// slow drip of new signal ages past the cooldown ceiling. A pure time gap with zero new
// outcomes never re-fires: there is nothing new to retune on. Without this gate the
// banner re-fired on every render forever, since the rolling 30-day counts stay above
// threshold regardless of whether a review just ran. See the Reevaluation Contract.
const STRATEGY_REVIEW_NEW_SIGNAL = 5;
const STRATEGY_REVIEW_COOLDOWN_DAYS = 21;

// All-time count of resolved learning outcomes (advances + rejections) — the monotonic
// signal a strategy review consumes. Mirrors exactly what buildStrategyReviewTrigger
// reacts to, so the snapshot the skill stores and the live count are measured the same.
function strategyOutcomeTotal(applications) {
  return applications.reduce(
    (n, app) => n + (isAdvanced(app) || classifyStage(app.status) === "rejected" ? 1 : 0),
    0
  );
}

// Reconcile the live outcome count against the last recorded review snapshot.
function strategyReviewSignal(applications, reviewState, now) {
  const outcomes = strategyOutcomeTotal(applications);
  const lastReviewedAt = reviewState?.lastReviewedAt || null;
  if (!lastReviewedAt) {
    return { reviewed: false, outcomes, newOutcomes: outcomes, daysSince: null };
  }
  const snap = reviewState.snapshot || {};
  const reviewedOutcomes =
    snap.outcomes != null
      ? Number(snap.outcomes) || 0
      : Number(snap.advanced || 0) + Number(snap.rejected || 0);
  return {
    reviewed: true,
    outcomes,
    newOutcomes: Math.max(0, outcomes - reviewedOutcomes),
    daysSince: daysSince(lastReviewedAt, now),
  };
}

function reviewAgeLabel(days) {
  if (days == null) return "recently";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function buildStrategyReviewTrigger(bucket, reviewSignal = {}) {
  const applied = bucket?.applied || 0;
  const advanced = bucket?.advanced || 0;
  const rejected = bucket?.rejected || 0;
  const meetsThreshold = applied >= 3 && (advanced >= 2 || rejected >= 2);

  const { reviewed = false, newOutcomes = 0, daysSince: daysSinceReview = null } = reviewSignal;
  const freshSignal =
    newOutcomes >= STRATEGY_REVIEW_NEW_SIGNAL ||
    (newOutcomes >= 1 && (daysSinceReview ?? 0) >= STRATEGY_REVIEW_COOLDOWN_DAYS);
  const ready = meetsThreshold && (!reviewed || freshSignal);

  if (ready) {
    return {
      ready: true,
      title: "Enough signal to review strategy",
      summary: `Last 30d: ${applied} applications, ${advanced} advanced, ${rejected} rejected. Run reevaluate-strategy before changing volume or channel mix.`,
      ctaLabel: "Run strategy review",
      ctaAction: "strategy-review",
    };
  }

  // Reviewed recently; thresholds are still high but no fresh signal worth re-tuning on.
  // Acknowledge the review instead of pretending signal is "still forming".
  if (reviewed && meetsThreshold) {
    const waitNote =
      newOutcomes > 0
        ? `${newOutcomes} new outcome${newOutcomes === 1 ? "" : "s"} since — re-review at ${STRATEGY_REVIEW_NEW_SIGNAL}.`
        : "No new outcomes since — nothing new to retune on yet.";
    return {
      ready: false,
      title: "Strategy reviewed — watching for new signal",
      summary: `Reviewed ${reviewAgeLabel(daysSinceReview)}. ${waitNote}`,
      ctaLabel: "Review details",
      ctaAction: "jobs",
    };
  }

  return {
    ready: false,
    title: "Learning signal still forming",
    summary: `Last 30d: ${applied} applications, ${advanced} advanced, ${rejected} rejected. Keep collecting comparable outcomes before retuning gates.`,
    ctaLabel: "Review details",
    ctaAction: "jobs",
  };
}

// Builds a compact view-model from tracker.json#analytics.reevaluation (the
// persisted block written by `rolester analytics --write`). Fully defensive:
// returns null when the block is absent, incomplete, or has no usable threshold,
// so callers can short-circuit rendering safely on older trackers.
function buildReevaluationProgress(reevaluationData) {
  if (!reevaluationData || typeof reevaluationData !== "object") return null;
  const { thresholds, sinceLastReview, due } = reevaluationData;
  if (!thresholds || !sinceLastReview) return null;
  const totalCurrent = Number(sinceLastReview.rejectionTotal) || 0;
  const totalThreshold = Number(thresholds.rejectionTotal) || 0;
  if (!totalThreshold) return null;
  const familyThreshold = Number(thresholds.rejectionPerFamily) || 0;
  const byFamily =
    sinceLastReview.rejectionByFamily && typeof sinceLastReview.rejectionByFamily === "object"
      ? sinceLastReview.rejectionByFamily
      : {};
  const familyLines = [];
  if (familyThreshold > 0) {
    for (const [family, rawCount] of Object.entries(byFamily)) {
      const n = Number(rawCount) || 0;
      if (n >= Math.ceil(familyThreshold / 2)) {
        familyLines.push({
          family,
          count: n,
          threshold: familyThreshold,
          over: n >= familyThreshold,
        });
      }
    }
    familyLines.sort((a, b) => b.count - a.count);
  }
  const isDue = Boolean(due);
  const label = isDue
    ? `${totalCurrent}/${totalThreshold} rejections — review due`
    : `${totalCurrent}/${totalThreshold} rejections since last review`;
  return { totalCurrent, totalThreshold, due: isDue, familyLines, label };
}

function buildStrategyLearning(applications, now, reviewState, reevaluationData) {
  const history = strategyLearningBuckets(applications, now);
  const current = history[0] || { applied: 0, advanced: 0, interviews: 0, rejected: 0 };
  const reviewSignal = strategyReviewSignal(applications, reviewState, now);
  return {
    windowLabel: "Last 30d",
    trends: buildStrategyLearningTrends(current),
    history,
    signals: buildStrategyLearningSignals(applications, now),
    reviewTrigger: buildStrategyReviewTrigger(current, reviewSignal),
    reevaluation: buildReevaluationProgress(reevaluationData),
  };
}

// Local role-family classifier — mirrors classifyRoleFamily in outcome-analysis.mjs
// but lives here so dashboard-data.js stays self-contained (no imports; it runs in
// the browser after being copied verbatim to workspace/dashboard-data.js).
function classifyRoleFamilyLocal(role, targeting) {
  const lower = String(role || "").toLowerCase();
  let families = null;
  if (targeting && Array.isArray(targeting.role_families) && targeting.role_families.length > 0) {
    families = targeting.role_families;
  } else if (
    targeting &&
    Array.isArray(targeting.role_buckets) &&
    targeting.role_buckets.length > 0
  ) {
    families = targeting.role_buckets.map((bucket) => ({
      name: (bucket.name || "other").toLowerCase().replace(/\s+/g, "-"),
      patterns: Array.isArray(bucket.titles) ? bucket.titles.map((t) => t.toLowerCase()) : [],
    }));
  }
  if (families !== null) {
    for (const family of families) {
      const patterns = Array.isArray(family.patterns) ? family.patterns : [];
      if (patterns.some((p) => lower.includes(p.toLowerCase()))) return family.name;
    }
    return "other";
  }
  const trimmed = String(role || "").trim();
  if (!trimmed) return "uncategorized";
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// The tracker.json#strategyReview stamp the reevaluate-strategy skill writes on
// completion to silence the "review ready" nudge until new signal accrues. Computes
// the all-time outcome snapshot with the SAME predicate the render gate reads, so the
// snapshot and the live count never diverge. The caller supplies the ISO timestamp
// (scripts can't call Date.now()/new Date() in some runtimes — pass it in explicitly).
//
// targeting (optional) — when provided, the snapshot also records per-family rejected
// baselines (rejectedByFamily) so the analytics CLI can compute "since last review"
// per-family deltas after the next review stamps.
export function buildStrategyReviewStamp(trackerData, reviewedAtIso, targeting) {
  const applications = trackerData?.applications || [];
  let applied = 0;
  let advanced = 0;
  let rejected = 0;
  const rejectedByFamily = {};
  for (const app of applications) {
    applied += 1;
    if (isAdvanced(app)) advanced += 1;
    if (classifyStage(app.status) === "rejected") {
      rejected += 1;
      const family = classifyRoleFamilyLocal(app.role, targeting);
      rejectedByFamily[family] = (rejectedByFamily[family] || 0) + 1;
    }
  }
  return {
    lastReviewedAt: reviewedAtIso,
    snapshot: {
      applied,
      advanced,
      rejected,
      outcomes: advanced + rejected,
      rejectedByFamily: Object.keys(rejectedByFamily).length > 0 ? rejectedByFamily : null,
    },
  };
}

function buildStrategyRecommendation({ topSource, bestLane, staleCount, cadence = [] }) {
  const urgentCadence = cadence.filter((row) => row.tone === "overdue" || row.tone === "due");
  if (urgentCadence.length > 0) {
    const count = urgentCadence.length;
    return {
      title: "Handle the top items in Next Steps",
      summary: `${count} follow-up${count === 1 ? "" : "s"} due or overdue. Open the queue first; Strategy details explain why the pipeline is behaving this way.`,
      ctaLabel: "Open Next Steps",
      ctaAction: "actions",
    };
  }
  if (staleCount >= 3) {
    return {
      title: "Clean up quiet applications before adding more",
      summary: `${staleCount} active application${staleCount === 1 ? "" : "s"} have gone quiet. Open Jobs to decide what to nudge, downgrade, or close before adding more top-of-funnel work.`,
      ctaLabel: "Open Jobs",
      ctaAction: "jobs",
    };
  }
  if (topSource?.total) {
    return {
      title: `Double down on ${topSource.label}`,
      summary: `${topSource.label} is producing ${topSource.rate} response across ${topSource.total} tracked role${topSource.total === 1 ? "" : "s"}. Keep adding roles that resemble ${bestLane?.label || "the best-progressing lane"}.`,
      ctaLabel: "Open Jobs",
      ctaAction: "jobs",
    };
  }
  return {
    title: "Build a measurable loop",
    summary:
      "No applied outcomes are available yet. Source, evaluate, and track a few comparable roles before tuning the strategy.",
    ctaLabel: "Open Jobs",
    ctaAction: "jobs",
  };
}

function buildStrategyInsights(trackerData, { now = new Date() } = {}) {
  const applications = trackerData?.applications || [];
  const communications = trackerData?.communications || [];
  const sourceGroups = new Map();
  const roleGroups = new Map();
  const fitGroups = new Map();

  for (const app of applications) {
    const sourceLabel = strategySourceLabel(app);
    addStrategyGroup(sourceGroups, normalizeName(sourceLabel), sourceLabel, app);

    const lane = strategyRoleLane(app.role);
    addStrategyGroup(roleGroups, normalizeName(lane), lane, app);

    const fitBand = strategyFitBand(app.fitScore);
    addStrategyGroup(fitGroups, fitBand.id, fitBand.label, app, { order: fitBand.order });
  }

  const sources = finalizeStrategyRows(sourceGroups).slice(0, 4);
  const roles = finalizeStrategyRows(roleGroups).slice(0, 4);
  const fitBands = finalizeStrategyRows(fitGroups, { fixedOrder: true });
  const stale = buildStrategyStaleRows(applications, communications, now);
  const stageAges = buildStrategyStageRows(applications, now);
  const cadence = buildStrategyCadenceRows(applications, communications, now);
  const learning = buildStrategyLearning(
    applications,
    now,
    trackerData?.strategyReview,
    trackerData?.analytics?.reevaluation
  );
  const topSource = sources[0] || {
    label: "No source yet",
    rate: "0%",
    total: 0,
    advanced: 0,
  };
  const bestLane = roles[0] || {
    label: "No lane yet",
    rate: "0%",
    total: 0,
    advanced: 0,
  };

  return {
    metrics: {
      topSource: {
        label: topSource.label,
        rate: topSource.rate,
        value: topSource.label,
      },
      bestLane: {
        label: bestLane.label,
        rate: bestLane.rate,
        value: bestLane.label,
      },
      staleCount: {
        label: "Quiet",
        value: stale.length,
        rate: stale.length ? `${stale.length} quiet` : "Clear",
      },
    },
    sources,
    roles,
    fitBands,
    stale,
    stageAges,
    cadence,
    learning,
    recommendation: buildStrategyRecommendation({
      topSource,
      bestLane,
      staleCount: stale.length,
      cadence,
    }),
  };
}

const AVATAR_CLASSES = [
  "bg-primary-container text-white",
  "bg-secondary-container text-white",
  "bg-surface-container-highest text-primary",
  "bg-primary-fixed-dim text-primary",
  "bg-secondary-fixed text-secondary",
  "bg-surface-container-highest text-on-surface-variant",
];

// The candidate's own name, normalized, so contact extraction can drop the
// candidate themselves out of the network (a thread "from" them isn't a contact).
// Derived from profile config, never hardcoded — see code-must-be-domain-neutral.
// Set during buildDashboardViewModel.
let activeCandidateName = "";

function titleCase(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d/.test(part)) return part.charAt(0) + part.slice(1).toLowerCase();
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

function initials(value) {
  const words = String(value || "")
    .replace(/&/g, " ")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  if (!words.length) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function formatDateShort(rawDate, fallback = "Sourced") {
  if (!rawDate) return fallback;
  const date = new Date(`${rawDate}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) return String(rawDate);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function normalizeFit(value) {
  const fit = Number(value || 0);
  if (!Number.isFinite(fit)) return 0;
  return Math.max(0, Math.min(100, Math.round(fit)));
}

function baseAskK(value) {
  if (!value) return 0;
  const matches = [...String(value).matchAll(/([\d,]+(?:\.\d+)?)\s*([MmKk]?)/g)];
  return matches.reduce((best, match) => {
    const raw = Number.parseFloat(match[1].replace(/,/g, ""));
    if (!Number.isFinite(raw)) return best;
    const unit = match[2].toLowerCase();
    const normalized =
      unit === "m" ? raw * 1000 : unit === "k" ? raw : raw >= 10000 ? raw / 1000 : raw;
    return Math.max(best, Math.round(normalized));
  }, 0);
}

function moneyKValues(value) {
  if (!value) return [];
  return [...String(value).matchAll(/([\d,]+(?:\.\d+)?)\s*([MmKk]?)/g)]
    .map((match) => {
      const raw = Number.parseFloat(match[1].replace(/,/g, ""));
      if (!Number.isFinite(raw)) return null;
      const unit = match[2].toLowerCase();
      return unit === "m" ? raw * 1000 : unit === "k" ? raw : raw >= 10000 ? raw / 1000 : raw;
    })
    .filter((value) => Number.isFinite(value));
}

function medianMoneyK(value) {
  const values = moneyKValues(value).sort((a, b) => a - b);
  if (!values.length) return 0;
  const mid = values.length / 2;
  return values.length % 2 ? values[Math.floor(mid)] : (values[mid - 1] + values[mid]) / 2;
}

function formatMoneyK(value) {
  if (!value || !Number.isFinite(value)) return "TBD";
  if (value >= 1000) {
    const millions = value / 1000;
    return `$${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(2).replace(/0$/, "")}M`;
  }
  return `$${Math.round(value)}K`;
}

function stageLabel(status, source) {
  if (source === "sourced") {
    const stage = classifyStage(status);
    return stage === "sourced" ? "Sourced" : titleCase(status || stage);
  }
  return titleCase(status || "applied");
}

function normalizeMode(mode, location) {
  const raw = String(mode || "")
    .toLowerCase()
    .replace(/[-_\s]+/g, "");
  if (raw.includes("remote")) return "remote";
  if (raw.includes("hybrid")) return "hybrid";
  if (raw.includes("onsite") || raw.includes("office")) return "onsite";
  if (raw.includes("relo")) return "relo";

  const loc = String(location || "").toLowerCase();
  if (loc.includes("remote")) return "remote";
  if (loc.includes("hybrid")) return "hybrid";
  if (loc.includes("onsite") || loc.includes("on-site") || loc.includes("on site")) return "onsite";
  return "";
}

function modeInfo(mode, location) {
  const id = normalizeMode(mode, location);
  return {
    id,
    label: MODE_META[id]?.label || (mode ? titleCase(mode) : "TBD"),
    icon: MODE_META[id]?.icon || "navigation",
  };
}

function sourceInfo(source, channel) {
  const key = source === "sourced" ? "sourced" : String(channel || "board").toLowerCase();
  return SOURCE_META[key] || { label: titleCase(key || "Tracked"), icon: "list" };
}

function isTriageFit(row) {
  return String(row.fitBasis || "").toLowerCase() === "triage";
}

function fitLabel(row) {
  return `${isTriageFit(row) ? "~" : ""}${row.fit}`;
}

function compactComp(base, tc) {
  const baseDisplay = base || "TBD";
  const tcDisplay = tc || "";
  const midpoint = medianMoneyK(baseDisplay) || medianMoneyK(tcDisplay);
  return {
    base: baseDisplay,
    tc: tcDisplay,
    midpoint,
    compact: formatMoneyK(midpoint),
    summary: tcDisplay ? `${baseDisplay} base · ${tcDisplay} TC` : baseDisplay,
  };
}

function stageGroupLabel(stage) {
  const configured = JOB_FUNNEL_STAGES.find((item) => item.id === stage);
  return configured?.label || titleCase(stage);
}

function stageColor(stage) {
  return JOB_FUNNEL_STAGES.find((item) => item.id === stage)?.color || "#8d7f73";
}

function stageIcon(row) {
  if (row?.terminal) return "x";
  const stage = typeof row === "string" ? row : row?.stage;
  return JOB_FUNNEL_STAGES.find((item) => item.id === stage)?.icon || "list";
}

function firstMessageSummary(comm = {}) {
  return (
    comm.summary ||
    (comm.messages || [])
      .map((message) => message.summary || message.body || "")
      .find((summary) => String(summary || "").trim()) ||
    ""
  );
}

function communicationAction(comm = {}, app = {}, now = new Date()) {
  if (comm.status === "closed") return null;
  // Waiting-on-them threads aren't the candidate's action until a follow-up timer fires.
  if (!commIsActionable(comm, now, app)) return null;
  const title = String(comm.nextAction || "").trim();
  if (!title && comm.status !== "needs-reply") return null;
  const dueAt = comm.nextActionDue || comm.lastInboundAt || comm.updatedAt || "";
  const label =
    comm.status === "needs-reply"
      ? "Reply"
      : nextStepActionLabel({ title, source: "communication", app, comm });
  const due = dueAt ? dueText(dueAt, now) : "Review";
  return {
    state: "needs-action",
    label,
    title: title || `Reply to ${comm.company || app.company || "the thread"}`,
    summary: firstMessageSummary(comm) || comm.subject || "Thread has a tracked next action.",
    meta: `${comm.company || app.company || "Tracked thread"} · ${due}`,
    dueAt,
    dueText: due,
    tone: dueTone(dueAt, now),
    workstream: "respond",
    cta: label === "Reply" ? "Open thread" : "Open item",
  };
}

function followUpAction(app = {}, now = new Date()) {
  const followUp = app.followUp;
  if (!followUp) return null;
  const dueAt =
    followUp.dueAt || followUp.nextActionDue || followUp.generatedAt || app.appliedAt || "";
  const label = nextStepActionLabel({
    title: followUpTitle(app),
    detail: followUp.note || followUp.title || "",
    source: "follow-up",
    app,
  });
  return {
    state: dueAt && daysBetween(new Date(dueAt), now) >= 0 ? "needs-action" : "follow-up",
    label,
    title: followUp.title || followUpTitle(app),
    summary: followUp.note || `${app.company || "This role"} has a tracked follow-up.`,
    meta: `${app.company || "Tracked role"} · ${dueAt ? dueText(dueAt, now) : "Review"}`,
    dueAt,
    dueText: dueAt ? dueText(dueAt, now) : "Review",
    tone: dueTone(dueAt, now),
    workstream: "respond",
    cta: "Open follow-up",
  };
}

function explicitApplicationAction(app = {}, row = {}, now = new Date()) {
  const title = String(app.nextAction || "").trim();
  if (!hasRealActionText(title)) return null;
  const dueAt = app.nextActionDue || app.updatedAt || app.appliedAt || "";
  const label = nextStepActionLabel({
    title,
    detail: `${app.statusNote || ""} ${app.note || ""}`,
    source: "application",
    app,
  });
  const due = dueText(dueAt, now);
  return {
    state: "needs-action",
    label,
    title,
    summary:
      app.statusNote ||
      firstSentence(app.note) ||
      `${app.company || row.company || "This application"} needs a manual step.`,
    meta: `${app.company || row.company || "Tracked role"} · ${due}`,
    dueAt,
    dueText: due,
    tone: dueTone(dueAt, now),
    workstream: "review",
    cta: label === "Manual apply" ? "Finish applying" : "Open details",
  };
}

function interviewDateForApp(app = {}) {
  return earliestIso(
    app.nextInterviewAt,
    app.interviewAt,
    app.interviewDate,
    (app.conversations || [])
      .filter((conversation) =>
        /\b(interview|screen|loop|panel|onsite|on-site|final)\b/i.test(
          `${conversation.kind || ""} ${conversation.title || ""} ${conversation.notes || ""}`
        )
      )
      .map((conversation) => conversation.date || conversation.at)
  );
}

function interviewAction(row, app = {}, now = new Date()) {
  const interviewAt = interviewDateForApp(app);
  return {
    state: "interview",
    label: "Prep",
    title: `Prep for ${row.company} ${row.stageGroupLabel.toLowerCase()}`,
    summary: interviewAt
      ? `Upcoming interview work is due ${dueText(interviewAt, now)}.`
      : "Keep this loop protected ahead of new application work.",
    meta: interviewAt
      ? `${formatDateShort(interviewAt.slice(0, 10), "scheduled")} · ${row.role}`
      : `${row.stageGroupLabel} · ${row.role}`,
    dueAt: interviewAt,
    dueText: interviewAt ? dueText(interviewAt, now) : "Prep",
    tone: interviewAt ? dueTone(interviewAt, now) : "secondary",
    workstream: "prepare",
    cta: "Open prep",
  };
}

// Is there an actual human to reach out to for this role? A real reply thread, a
// logged conversation with a named person, or a tracked recruiter/participant. A
// portal-only or cold application with none of these has no contact path — there is
// literally no one to nudge — so the "follow up / set next touch" actions don't apply.
function hasContactPath(sourceRecord = {}, communications = []) {
  const repliableThread = communications.some(
    (comm) =>
      comm &&
      ((comm.channel && comm.channel !== "portal") ||
        (Array.isArray(comm.messages) && comm.messages.length > 0) ||
        (Array.isArray(comm.participants) && comm.participants.length > 0))
  );
  if (repliableThread) return true;
  const conversations = Array.isArray(sourceRecord.conversations) ? sourceRecord.conversations : [];
  return conversations.some((conv) => conv && String(conv.who || "").trim());
}

function staleAction(row, sourceRecord = {}, communications = [], now = new Date()) {
  // No contact path → nothing to nudge. A quiet portal/cold application with no
  // recruiter thread or logged conversation isn't a "set next touch" task; it falls
  // through to the passive watch state (blank action cell). See the actionable-only
  // contact-path rule in AGENTS.md.
  if (!hasContactPath(sourceRecord, communications)) return null;
  const latest = latestApplicationTouch(sourceRecord, communications);
  const daysQuiet = daysSince(latest, now);
  if (daysQuiet == null || daysQuiet <= STRATEGY_STALE_AFTER_DAYS) return null;
  if (daysQuiet > STRATEGY_GHOSTED_AFTER_DAYS) {
    return {
      state: "ghosted",
      label: "Ghosted",
      title: `Close the loop on ${row.company}`,
      summary: `${row.company} has been silent for ${daysQuiet} days — past the ${STRATEGY_GHOSTED_AFTER_DAYS}-day ghosted line. Send a final nudge or archive it.`,
      meta: `${daysQuiet}d silent · ${row.stageGroupLabel}`,
      dueAt: latest,
      dueText: `${daysQuiet}d silent`,
      tone: "warning",
      workstream: "plan",
      cta: "Open details",
    };
  }
  return {
    state: "stale",
    label: "Plan",
    title: `Set next touch for ${row.company}`,
    summary: `${row.company} has been quiet for ${daysQuiet} days. Decide whether to nudge, downgrade, or archive it.`,
    meta: `${daysQuiet}d quiet · ${row.stageGroupLabel}`,
    dueAt: latest,
    dueText: `${daysQuiet}d quiet`,
    tone: "warning",
    workstream: "plan",
    cta: "Open details",
  };
}

// Min..max + median of every dollar figure in a comp string, in $K. Returns null
// when the string carries no parseable figure (e.g. "not posted", "TBD").
function moneyBandK(value) {
  const values = moneyKValues(value).sort((a, b) => a - b);
  if (!values.length) return null;
  return {
    loK: Math.round(values[0]),
    hiK: Math.round(values[values.length - 1]),
    midK: Math.round(medianMoneyK(value)),
  };
}

// Provenance-aware comp model for the drawer's Compensation Range card. Codifies
// where the market figures come from so the UI can say so instead of showing a
// guess as fact:
//   posted     — the JD posted a band; market = that band
//   built      — no posted band; estimated from tracker comparables (compEstimate)
//   needs-info — no posted band and no comparable data yet
// floor + ask come from the persisted compEstimate (resolved arrangement floor +
// target anchor) when a skill has written one for this application; otherwise
// they fall back to the candidate's own compensation config (profile.yml's
// minimum_base / target_base / expected_base, passed in as profileComp) so the
// pins are always a real number the candidate set, never a fabricated
// placeholder. null when neither source has a value.
function compRangeView(row, sourceRecord = {}, profileComp = {}) {
  const est =
    sourceRecord && typeof sourceRecord.compEstimate === "object"
      ? sourceRecord.compEstimate
      : null;
  // profileComp.floorK/askK are already `number | null` (see
  // profileCompFromSettings) — check for null explicitly before Number()
  // coercion, since Number(null) is 0 (finite), not NaN.
  const profileFloorK = profileComp.floorK != null ? Number(profileComp.floorK) : null;
  const profileAskK = profileComp.askK != null ? Number(profileComp.askK) : null;
  const floorK =
    est && Number.isFinite(Number(est.floorK))
      ? Math.round(Number(est.floorK))
      : Number.isFinite(profileFloorK)
        ? Math.round(profileFloorK)
        : null;
  const askK =
    est && Number.isFinite(Number(est.askK))
      ? Math.round(Number(est.askK))
      : Number.isFinite(profileAskK)
        ? Math.round(profileAskK)
        : null;

  const postedBand = moneyBandK(row.comp);
  if (postedBand) {
    return {
      state: "posted",
      stateLabel: "Posted band",
      hasMarket: true,
      floorK,
      askK,
      marketLo: postedBand.loK,
      marketP50: postedBand.midK || row.compMidpointK || postedBand.loK,
      marketHi: postedBand.hiK,
      basis: "Compensation posted in the job description.",
      confidence: "",
      sampleSize: 0,
    };
  }

  if (est && est.source === "comparables" && Number.isFinite(Number(est.midpointK))) {
    return {
      state: "built",
      stateLabel: "Built from data",
      hasMarket: true,
      floorK,
      askK,
      marketLo: Math.round(Number(est.lowK)),
      marketP50: Math.round(Number(est.midpointK)),
      marketHi: Math.round(Number(est.highK)),
      basis: est.basis || "Estimated from comparable roles in your tracker.",
      confidence: est.confidence || "low",
      sampleSize: Number(est.sampleSize) || 0,
      asOf: est.asOf || "",
    };
  }

  return {
    state: "needs-info",
    stateLabel: "Needs more info",
    hasMarket: false,
    floorK,
    askK,
    marketLo: null,
    marketP50: null,
    marketHi: null,
    basis: "No posted comp and no comparable roles yet — gather a number before deciding.",
    confidence: "",
    sampleSize: 0,
  };
}

function missingCompAction(row, estimate) {
  const hasEstimate =
    estimate && estimate.source === "comparables" && Number.isFinite(Number(estimate.midpointK));
  return {
    state: "missing-comp",
    label: "Comp",
    title: hasEstimate ? `Confirm comp for ${row.company}` : `Resolve comp for ${row.company}`,
    summary: hasEstimate
      ? `No posted band. Best guess $${estimate.lowK}K–$${estimate.highK}K (mid $${estimate.midpointK}K) from ${estimate.sampleSize} comparable${estimate.sampleSize === 1 ? "" : "s"} — confirm before promoting.`
      : "No posted comp and no comparable roles yet — gather a number before deciding.",
    meta: `${row.sourceLabel} · ${row.role}`,
    dueAt: "",
    dueText: hasEstimate ? "Confirm" : "Review",
    tone: "warning",
    workstream: "review",
    cta: "Open details",
  };
}

function manualReviewAction(row) {
  return {
    state: "review",
    label: "Review",
    title: `Review ${row.company}`,
    summary:
      row.source === "sourced"
        ? "Gate this sourced role before promoting it into the active pipeline."
        : "Check fit, comp, and next touch before doing more work here.",
    meta: `${row.sourceLabel} · ${row.stageGroupLabel}`,
    dueAt: "",
    dueText: "Review",
    tone: "secondary",
    workstream: "review",
    cta: "Open details",
  };
}

function defaultJobAction(row) {
  if (row.terminal) {
    return {
      state: "archived",
      label: "Archive",
      title: `${row.company} is closed`,
      summary: "This row is kept for history and outcome learning.",
      meta: `${row.stageGroupLabel} · ${row.appliedLabel}`,
      dueAt: "",
      dueText: "Closed",
      tone: "secondary",
      workstream: "archive",
      cta: "Open history",
    };
  }
  if (row.source === "application") {
    return {
      state: "watch",
      label: "Wait",
      title: `Wait on ${row.company}`,
      summary:
        "Application is submitted and no recruiter thread, follow-up date, or contact path is tracked yet.",
      meta: `${row.fit} · ${row.stageGroupLabel}`,
      dueAt: "",
      dueText: "Waiting",
      tone: "secondary",
      workstream: "watch",
      cta: "Open details",
    };
  }
  if (row.fit >= 80) {
    return {
      state: "high-fit",
      label: "Prioritize",
      title: `Prioritize ${row.company}`,
      summary: "High-fit active role. Keep the next touch and artifacts current.",
      meta: `${row.fit} · ${row.stageGroupLabel}`,
      dueAt: "",
      dueText: "Active",
      tone: "success",
      workstream: "prioritize",
      cta: "Open details",
    };
  }
  const undecided = row.stage === "sourced";
  return {
    state: "active",
    label: undecided ? "Gate" : "Watch",
    title: undecided ? `Gate ${row.company}` : `Monitor ${row.company}`,
    summary: undecided
      ? "Review the posting body before tailoring or applying."
      : "No urgent action is due right now.",
    meta: `${row.sourceLabel} · ${row.stageGroupLabel}`,
    dueAt: "",
    dueText: "Active",
    tone: "secondary",
    workstream: undecided ? "review" : "watch",
    cta: "Open details",
  };
}

function buildJobAction(row, sourceRecord = {}, communications = [], now = new Date()) {
  const commAction = communications
    .map((comm) => communicationAction(comm, sourceRecord, now))
    .filter(Boolean)
    .sort((a, b) => new Date(a.dueAt || 0) - new Date(b.dueAt || 0))[0];
  if (commAction) return commAction;

  const explicitAction =
    row.source === "application" ? explicitApplicationAction(sourceRecord, row, now) : null;
  if (explicitAction) return explicitAction;

  const followAction = followUpAction(sourceRecord, now);
  if (followAction && followAction.state === "needs-action") return followAction;

  if (
    !row.terminal &&
    row.source === "application" &&
    (STAGE_ORDER[row.stage] ?? 0) >= STAGE_ORDER.screen
  ) {
    return interviewAction(row, sourceRecord, now);
  }

  // Comp resolution is part of the pre-application promote/hold call. An already
  // applied role with thin comp is a recruiter-call follow-up, not a triage gate,
  // so only surface this on still-undecided (sourced-stage) rows.
  if (
    !row.terminal &&
    (STAGE_ORDER[row.stage] ?? 0) < STAGE_ORDER.applied &&
    !row.compMidpointK &&
    !row.baseK
  ) {
    return missingCompAction(row, sourceRecord?.compEstimate);
  }

  const stale =
    row.source === "application" ? staleAction(row, sourceRecord, communications, now) : null;
  if (stale) return stale;

  // Only surface a follow-up when it is overdue (state === 'needs-action'). A
  // follow-up due next week is not yet an action — let it fall through to watch/default.
  if (followAction?.state === "needs-action") return followAction;
  if (needsManualReview(row)) return manualReviewAction(row);
  return defaultJobAction(row);
}

// Decay is an add-on state that can attach to ANY non-terminal stage, not just
// "awaiting" — a screen- or interview-stage app that goes quiet is going stale too.
// It's pure time-since-last-touch: 14d+ silent = stale, 30d+ silent = ghosted.
// Unlike staleAction (the nudge task, which needs a contact path to act on), the
// decay STATE applies to silent portal-only applications too — "no response after 2
// weeks" is exactly the going-stale signal whether or not there's anyone to chase.
function rowDecayState(row, sourceRecord = {}, communications = [], now = new Date()) {
  if (row.terminal) return "none";
  const daysQuiet = daysSince(latestApplicationTouch(sourceRecord, communications), now);
  if (daysQuiet == null) return "none";
  if (daysQuiet > STRATEGY_GHOSTED_AFTER_DAYS) return "ghosted";
  if (daysQuiet > STRATEGY_STALE_AFTER_DAYS) return "stale";
  return "none";
}

function applyJobAction(row, sourceRecord = {}, communications = [], now = new Date()) {
  const action = buildJobAction(row, sourceRecord, communications, now);
  row.action = action;
  row.actionState = action.state;
  row.workstream = action.workstream;
  row.needsAction = action.state === "needs-action";
  // Decay is stage-independent (see rowDecayState); the pill, filters, and funnel
  // all key off these so a quiet screen/interview row reads as stale/ghosted too.
  row.decayState = rowDecayState(row, sourceRecord, communications, now);
  row.stale = row.decayState === "stale";
  row.ghosted = row.decayState === "ghosted";
  row.missingComp = action.state === "missing-comp";
  row.highFit = row.fit >= 80 && !row.terminal;
  row.interviewPath = !row.terminal && (STAGE_ORDER[row.stage] ?? 0) >= STAGE_ORDER.screen;
  row.archived = row.terminal;
  return row;
}

// Drawer "Interview" section view model: a one-line logistics summary (the typed
// interviewNote) plus structured chips pulled from the most recent interview-like
// conversation. Returns null when there's nothing interview-specific to show so the
// section hides for non-interview rows.
function buildInterviewBlock(record = {}) {
  const convos = Array.isArray(record.conversations) ? record.conversations : [];
  const interviewConvo =
    [...convos]
      .reverse()
      .find((c) =>
        /\b(interview|screen|panel|onsite|on-site|loop|final|hiring|hm)\b/i.test(
          `${c?.kind || ""} ${c?.title || ""}`
        )
      ) ||
    convos[convos.length - 1] ||
    null;
  const line = String(record.interviewNote || "").trim();
  const round = interviewConvo?.kind || "";
  const who = interviewConvo?.who || "";
  const when = interviewConvo?.date || record.nextInterviewAt || record.interviewAt || "";
  const chips = [
    round ? { label: "Round", value: round } : null,
    when ? { label: "When", value: formatDateShort(when, "") } : null,
    who ? { label: "With", value: who } : null,
  ].filter(Boolean);
  const detail = firstSentence(interviewConvo?.notes || "");
  if (!line && !chips.length && !detail) return null;
  return { line, chips, detail };
}

// Company-health view-model. Reads the persisted `companyHealth` object the
// company-health skill wrote to the tracker row (never recomputed client-side —
// persist-then-render, like compEstimate/benefits). Returns null when absent so the
// drawer section + card pill collapse cleanly.
const HEALTH_RATING_LABEL = { healthy: "Healthy", watch: "Watch", risky: "Risky" };
const HEALTH_PROV_LABEL = {
  "built-from-data": "Built from data",
  "needs-more-info": "Needs more info",
  stale: "Stale",
};
const HEALTH_DIM_ORDER = [
  ["layoffRisk", "Layoffs"],
  ["hiringMomentum", "Hiring"],
  ["financial", "Financial"],
  ["sentiment", "Sentiment"],
  ["leadership", "Leadership"],
];

function buildHealthBlock(ch) {
  if (!ch || typeof ch !== "object" || !ch.rating) return null;
  const dims = HEALTH_DIM_ORDER.map(([key, label]) => {
    const dim = ch.dimensions?.[key];
    if (!dim?.level) return null;
    return {
      label,
      level: dim.level,
      note: dim.note || "",
      functionHit: !!dim.functionHit,
      trend: dim.trend || "",
    };
  }).filter(Boolean);
  const signals = (ch.signals || [])
    .filter((sig) => sig && (sig.summary || sig.source))
    .map((sig) => ({
      source: sig.source || "",
      date: sig.date || "",
      summary: sig.summary || "",
      url: sig.url || "",
    }));
  const ratingLabel = ch.forFunction
    ? `${HEALTH_RATING_LABEL[ch.rating] || ch.rating} for ${ch.forFunction}`
    : HEALTH_RATING_LABEL[ch.rating] || ch.rating;
  return {
    rating: ch.rating,
    ratingLabel,
    forFunction: ch.forFunction || "",
    asOf: ch.asOf || "",
    provenance: ch.provenance || "",
    provenanceLabel: HEALTH_PROV_LABEL[ch.provenance] || "",
    rationale: ch.rationale || "",
    crossCut: Array.isArray(ch.crossCut) ? ch.crossCut : [],
    dimensions: dims,
    signals,
  };
}

// Card pill — only the actionable states (watch/risky) badge the glanceable card;
// healthy isn't badged there (it shows in the drawer). The visible label stays short
// ("Risky"/"Watch") so the dense card reads at a glance; the role-scoped detail rides
// in the title tooltip (and in full in the drawer).
function buildHealthBadge(ch) {
  if (!ch?.rating || ch.rating === "healthy") return null;
  const word = ch.rating === "risky" ? "Risky" : "Watch";
  const scope = ch.forFunction ? `${word} for ${ch.forFunction}` : word;
  return { rating: ch.rating, label: word, title: `Company health: ${scope} — internal signal` };
}

function jobDetailFromRow(
  row,
  sourceRecord = {},
  communications = [],
  now = new Date(),
  profileComp = {}
) {
  const compView = compRangeView(row, sourceRecord, profileComp);
  const artifacts = sourceRecord.artifacts || {};
  const artifactList = [
    artifacts.jd || artifacts.jobDescription
      ? { kind: "Job description", note: artifacts.jd || artifacts.jobDescription }
      : null,
    !artifacts.jd &&
    !artifacts.jobDescription &&
    (row.link || sourceRecord.link || sourceRecord.url)
      ? { kind: "Job description", note: "Source link is available from the drawer header." }
      : null,
    artifacts.resume ? { kind: "Resume", note: artifacts.resumeNote || artifacts.resume } : null,
    artifacts.coverLetter ? { kind: "Cover letter", note: artifacts.coverLetter } : null,
  ].filter(Boolean);
  const messages = communications.flatMap((comm) => comm.messages || []);
  const emailList = messages
    .map((message) => ({
      dir: String(message.direction || "").includes("outbound") ? "out" : "in",
      at: formatDateShort(message.at || message.date, "Recent"),
      subject:
        message.subject ||
        communications.find((comm) => (comm.messages || []).includes(message))?.subject ||
        "Message",
      summary: message.summary || message.body || "",
    }))
    .filter((message) => message.summary || message.subject);

  // Baked drafts the agent has prepared but not yet sent — surfaced in the drawer
  // so the user can copy them straight from the job. Sourced from `comm.draft`
  // (email-comms / follow-up write-back) and `app.followUp.draft`.
  const drafts = [];
  for (const comm of communications) {
    const draft = comm.draft;
    // A baked draft is only "ready to send" while the thread is still open. Once the
    // send advances status to waiting/closed the invariant nulls comm.draft, but gate
    // here too so a stale draft left on a sent thread never shows a ghost panel.
    const draftActive = !["waiting", "closed"].includes(comm.status);
    if (draftActive && draft && (draft.subject || draft.body)) {
      const recipient = (comm.participants || []).find((p) => p?.name);
      drafts.push({
        subject: draft.subject || comm.subject || "Draft reply",
        body: draft.body || "",
        to: recipient ? recipient.name : comm.company || "",
      });
    }
  }
  // Gate the follow-up draft symmetrically with the comm.draft gate above (spec step 5b).
  // A stale follow-up draft left after a send must never show a ghost "Ready to send" panel.
  // If a linked comm exists, reuse its status gate ({waiting, closed} = inactive).
  // If no linked comm, block when the application itself is in a terminal/done stage.
  const FOLLOWUP_DONE_STAGES = new Set(["rejected", "withdrawn", "offer", "accepted"]);
  const linkedComm = communications.find((c) => c.applicationId === sourceRecord.id);
  const followUpDraftActive = linkedComm
    ? !["waiting", "closed"].includes(linkedComm.status)
    : !FOLLOWUP_DONE_STAGES.has(row.stage);
  if (
    followUpDraftActive &&
    sourceRecord.followUp?.draft &&
    (sourceRecord.followUp.draft.subject || sourceRecord.followUp.draft.body)
  ) {
    drafts.push({
      subject: sourceRecord.followUp.draft.subject || "Follow-up",
      body: sourceRecord.followUp.draft.body || "",
      to: sourceRecord.company || "",
    });
  }

  const timeline = [
    sourceRecord.appliedAt || row.appliedAt
      ? {
          at: formatDateShort(sourceRecord.appliedAt || row.appliedAt, row.appliedLabel),
          icon: row.source === "sourced" ? "search" : "send",
          title: row.source === "sourced" ? "Role sourced" : "Application tracked",
          desc:
            firstSentence(row.note) ||
            `${row.company} is in the ${row.stageLabel.toLowerCase()} stage.`,
        }
      : null,
    ...(sourceRecord.conversations || []).map((conversation) => ({
      at: formatDateShort(conversation.at || conversation.date, "Recent"),
      icon: "phone",
      title: conversation.title || conversation.kind || "Conversation",
      desc: firstSentence(conversation.summary || conversation.notes || ""),
    })),
    ...communications.flatMap((comm) =>
      (comm.messages || []).map((message) => ({
        at: formatDateShort(message.at || message.date, "Recent"),
        icon: String(message.direction || "").includes("outbound") ? "send" : "mail",
        title: message.subject || comm.subject || "Message",
        desc: firstSentence(message.summary || comm.summary || ""),
      }))
    ),
    sourceRecord.followUp
      ? {
          at: formatDateShort(
            sourceRecord.followUp.dueAt || sourceRecord.followUp.generatedAt,
            "Due"
          ),
          icon: "mail",
          title: sourceRecord.followUp.kind || "Follow-up",
          desc:
            firstSentence(sourceRecord.followUp.note) || "Follow-up action tracked by Rolester.",
        }
      : null,
  ].filter((item) => item && (item.title || item.desc));
  const actionWarnings = communications
    .filter((comm) => comm.status === "needs-reply" || comm.nextAction)
    .map((comm) => {
      const due = formatDateShort(comm.nextActionDue || comm.lastInboundAt, "now");
      return `${comm.nextAction || "Reply needed"} · ${due}`;
    });

  return {
    id: row.id,
    company: row.company,
    role: row.role,
    stage: row.stageLabel,
    fit: row.fit,
    fitBasis: row.fitBasis || "",
    fitBucket: row.fitBucket || "",
    initials: row.initials,
    base: row.comp,
    tc: row.tc,
    link: row.link || sourceRecord.link || sourceRecord.url || "",
    warn: row.warn || sourceRecord.warn || "",
    // Re-derive action live from canonical tracker.json fields so the drawer
    // always reflects current state, not a stale build-time snapshot in row.action.
    nextAction: buildJobAction(row, sourceRecord, communications, now),
    // null when neither a persisted compEstimate nor the candidate's own
    // compensation config has a value — never a fabricated placeholder number
    // (see compRangeView). The drawer renders that as a "Needs info" pin.
    floor: compView.floorK,
    ask: compView.askK,
    marketLo: compView.marketLo,
    marketP50: compView.marketP50,
    marketHi: compView.marketHi,
    compState: compView.state,
    compStateLabel: compView.stateLabel,
    compBasis: compView.basis,
    compConfidence: compView.confidence,
    compHasMarket: compView.hasMarket,
    compSampleSize: compView.sampleSize,
    compAsOf: compView.asOf || "",
    matched: [
      row.source === "sourced" ? "New sourced role" : `${row.stageLabel} stage`,
      row.location,
      row.modeLabel,
      row.sourceLabel,
    ].filter(Boolean),
    gaps: [row.warn, ...actionWarnings].filter(Boolean),
    timeline,
    drafts,
    emails: emailList,
    artifacts: artifactList,
    benefits: (sourceRecord.benefits || []).map((key) => BENEFIT_EMOJI[key]).filter(Boolean),
    // Role-scoped company-health rating (internal signal). Null when the row carries
    // no companyHealth, so the drawer section hides.
    companyHealth: buildHealthBlock(sourceRecord.companyHealth),
    // Typed topic blocks (drawer sections). Each is null/empty for rows that don't
    // carry that topic so the section hides; nothing here ever lands on a card.
    interview: buildInterviewBlock(sourceRecord),
    compNote: String(sourceRecord.compNote || "").trim(),
    roleFit:
      sourceRecord.roleFit &&
      (sourceRecord.roleFit.why?.length || sourceRecord.roleFit.risks?.length)
        ? {
            why: (sourceRecord.roleFit.why || []).filter(Boolean).slice(0, 3),
            risks: (sourceRecord.roleFit.risks || []).filter(Boolean).slice(0, 3),
          }
        : null,
    learnings: (sourceRecord.conversations || [])
      .flatMap((c) => (Array.isArray(c.learnings) ? c.learnings : []))
      .filter((l) => l && (l.label || l.note))
      .slice(-5),
  };
}

function applicationJobRow(app, index, communications = [], now = new Date(), profileComp = {}) {
  const statusStage = classifyStage(app.status);
  const {
    stage,
    order: furthestOrder,
    rounds: interviewRounds,
  } = furthestStageForApp(app, statusStage);
  // The history advanced this row past where its status string alone would land
  // (e.g. multiple completed interview rounds → "final"). Label the badge with the
  // reached stage so the row, the funnel bucket, and the Sankey node all agree.
  const advancedByHistory = furthestOrder > (STAGE_ORDER[statusStage] ?? 0);
  const terminal = TERMINAL_STAGES.has(stage);
  const location = app.loc || app.location || app.mode || "";
  const mode = modeInfo(app.mode || "", location);
  const source = sourceInfo("application", app.channel || "");
  const comp = compactComp(app.base || app.comp?.base || "", app.tc || app.comp?.tc || "");
  const row = {
    id: app.id || `application-${index + 1}`,
    drawerId: app.id || `application-${index + 1}`,
    source: "application",
    company: app.company || "Unknown company",
    role: app.role || "Open role",
    location,
    channel: app.channel || "",
    sourceBucket: sourceBucketId(app.channel),
    status: app.status || stage,
    stage,
    interviewRounds,
    stageLabel: advancedByHistory
      ? stageGroupLabel(stage)
      : stageLabel(app.status || stage, "application"),
    stageGroupLabel: stageGroupLabel(stage),
    comp: comp.base,
    tc: comp.tc,
    compCompact: comp.compact,
    compMidpointK: comp.midpoint,
    compSummary: comp.summary,
    fit: normalizeFit(app.fitScore),
    fitBasis: app.fitBasis || "",
    fitBucket: app.fitBucket || "",
    baseK: baseAskK(app.base || app.comp?.base),
    mode: mode.id,
    modeLabel: mode.label,
    modeIcon: mode.icon,
    sourceLabel: source.label,
    sourceIcon: source.icon,
    appliedAt: app.appliedAt || "",
    appliedLabel: formatDateShort(app.appliedAt, "Tracked"),
    initials: initials(app.company),
    domain: app.domain || app.companyDomain || "",
    logo: app.logo || "",
    link: app.link || app.url || "",
    warn: app.warn || "",
    healthBadge: buildHealthBadge(app.companyHealth),
    avatarClass: AVATAR_CLASSES[index % AVATAR_CLASSES.length],
    terminal,
    // For a rejected/withdrawn app that advanced before dying, the stage it reached
    // (screen / interview / hiring-manager / …) so the funnel can count it as a role the
    // candidate actually interviewed for and lost, not a pre-response form-rejection.
    // null when the app was rejected before any round.
    terminalExitStage: terminal ? deepestRoundStage(app)?.stage || null : null,
    // Real interview rounds completed (see roundCount) — the Jobs funnel's honest
    // ordinal axis. Works for terminal rows, so a role lost after its 1st round
    // counts at round 1 (not whatever deep type its last conversation classified as).
    roundsReached: roundCount(app),
    note: app.note || "",
    statusNote: app.statusNote || "",
  };
  applyJobAction(row, app, communications, now);
  row.searchText = [
    row.company,
    row.role,
    row.location,
    row.modeLabel,
    row.channel,
    row.sourceLabel,
    row.status,
    row.compSummary,
    row.action?.label,
    row.action?.title,
    row.action?.summary,
    row.actionState,
    row.workstream,
    row.note,
  ]
    .join(" ")
    .toLowerCase();
  row.tooltip = jobTooltip(row);
  return { ...row, drawer: jobDetailFromRow(row, app, communications, now, profileComp) };
}

function sourcedJobRow(role, index, now = new Date(), profileComp = {}) {
  const status = role.status || "sourced";
  const stage = classifyStage(
    status === "prospect" || status === "saved" || status === "gated" ? "" : status
  );
  const terminal = TERMINAL_STAGES.has(stage);
  const location = role.loc || role.location || role.mode || "";
  const mode = modeInfo(role.mode || "", location);
  const source = sourceInfo("sourced", role.fitBasis || "sourced");
  const comp = compactComp(role.base || role.comp?.base || "", role.tc || role.comp?.tc || "");
  const row = {
    id: role.id || `sourced-${index + 1}`,
    drawerId: role.id || `sourced-${index + 1}`,
    source: "sourced",
    company: role.company || "Unknown company",
    role: role.role || "Open role",
    location,
    channel: role.fitBasis || "sourced",
    sourceBucket: "sourced",
    status,
    stage,
    stageLabel: stageLabel(status, "sourced"),
    stageGroupLabel: stageGroupLabel(stage),
    comp: comp.base,
    tc: comp.tc,
    compCompact: comp.compact,
    compMidpointK: comp.midpoint,
    compSummary: comp.summary,
    fit: normalizeFit(role.fitScore),
    fitBasis: role.fitBasis || "",
    fitBucket: role.fitBucket || "",
    baseK: baseAskK(role.base || role.comp?.base),
    mode: mode.id,
    modeLabel: mode.label,
    modeIcon: mode.icon,
    sourceLabel: source.label,
    sourceIcon: source.icon,
    appliedAt: "",
    appliedLabel: "Sourced",
    initials: initials(role.company),
    domain: role.domain || role.companyDomain || "",
    logo: role.logo || "",
    link: role.link || role.url || "",
    warn: role.warn || "",
    healthBadge: buildHealthBadge(role.companyHealth),
    avatarClass: AVATAR_CLASSES[(index + 3) % AVATAR_CLASSES.length],
    terminal,
    note: role.note || role.fitBucket || "",
  };
  applyJobAction(row, role, [], now);
  row.searchText = [
    row.company,
    row.role,
    row.location,
    row.modeLabel,
    row.channel,
    row.status,
    row.compSummary,
    row.action?.label,
    row.action?.title,
    row.action?.summary,
    row.actionState,
    row.workstream,
    row.note,
  ]
    .join(" ")
    .toLowerCase();
  row.tooltip = jobTooltip(row);
  return { ...row, drawer: jobDetailFromRow(row, role, [], now, profileComp) };
}

function communicationsForApplication(app, communications = []) {
  const appCompany = String(app.company || "").toLowerCase();
  const appRole = String(app.role || "").toLowerCase();
  return communications.filter((comm) => {
    const commCompany = String(comm.company || "").toLowerCase();
    const commRole = String(comm.role || "").toLowerCase();
    if (
      comm.applicationId &&
      comm.applicationId === app.id &&
      (!commCompany || commCompany === appCompany)
    )
      return true;
    return commCompany === appCompany && (!commRole || commRole === appRole);
  });
}

function sourceBucketId(channel) {
  const normalized = String(channel || "").toLowerCase();
  if (normalized === "referral") return "src-referral";
  if (normalized === "recruiter") return "src-recruiter";
  return "src-cold";
}

function jobTooltip(row) {
  return {
    company: row.company,
    role: row.role,
    status: row.status,
    stage: row.stageGroupLabel,
    fit: fitLabel(row).replace("%", ""),
    fitBasis: row.fitBasis || "",
    base: row.comp,
    tc: row.tc,
    comp: row.compSummary,
    location: row.location,
    mode: row.modeLabel,
    channel: row.channel,
    source: row.sourceLabel,
    updated: row.appliedLabel,
    action: row.action?.title || "",
    workstream: row.workstream || "",
    note: row.note,
  };
}

function buildJobsFunnel(rows) {
  const activeRows = rows.filter((row) => !row.terminal);
  const buckets = JOB_FUNNEL_STAGES.map((stage) => ({
    ...stage,
    count: activeRows.filter((row) => row.stage === stage.id).length,
  })).filter((stage) => stage.count > 0);
  const max = Math.max(1, ...buckets.map((stage) => stage.count));

  return [
    {
      id: "all",
      label: "All Active",
      count: activeRows.length,
      pct: 100,
      color: "#2b2724",
    },
    ...buckets.map((stage) => ({
      ...stage,
      pct: Math.max(8, Math.round((stage.count / max) * 100)),
    })),
  ];
}

// The Jobs funnel chain is numbered rounds ("1st round", "2nd round", …) rather
// than semantic stage types. Round depth is the honest funnel axis (see
// roundCount): a job sits at the column matching how many rounds it actually
// completed, so nothing passes through a stage it skipped. The greens deepen with
// depth to echo the old chain's light→dark gradient.
const ROUND_ORDINALS = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"];
const ROUND_GREENS = ["#7FCBA6", "#5BC4A0", "#34B488", "#1D9E75", "#179069", "#14795A", "#12664D"];
function roundLabel(n) {
  return `${ROUND_ORDINALS[n] || `${n}th`} round`;
}
function roundColor(n) {
  return ROUND_GREENS[Math.min(n - 1, ROUND_GREENS.length - 1)] || "#1D9E75";
}
function sankeyRoundMeta(n, col, count) {
  return {
    id: `round-${n}`,
    label: roundLabel(n),
    color: roundColor(n),
    count,
    col,
    order: n,
    filter: `round-${n}`,
  };
}

// Stale/ghosted are an add-on DECAY state for a quiet PRE-interview (0-round) app:
// applied, no response, gone silent. They render as decay "sink" nodes between
// Awaiting and the round chain, fed forward by awaiting→stale / awaiting→ghosted.
// An app that already reached a round and went quiet stays counted at its round node
// (flagged stale on its card) rather than rolling a band backward into the sinks.
// They can be hidden so dead applications don't inflate the live funnel — ghosted
// (30d+ silent) is hidden by default, stale (14d+ silent) shows unless opted out.
function buildJobsSankey(rows, { showGhosted = false, hideStale = false } = {}) {
  const visibleRows = rows.filter((row) => {
    if (row.ghosted) return showGhosted;
    if (row.stale) return !hideStale;
    return true;
  });

  const nodeMap = new Map();
  const linkMap = new Map();
  const sourceRows = new Map(Object.keys(SANKEY_SOURCE_META).map((key) => [key, []]));
  const furthestOrders = [];
  // Decay band: only pre-interview (0-round) apps that went quiet drain forward as a
  // progression — Awaiting → Going stale, then the fully-ghosted subset continues
  // Going stale → Ghosted. A ghosted app was stale first, so it passes THROUGH the
  // stale node rather than branching straight off Awaiting.
  const decayStaleRows = []; // quiet 14–30d, still merely stale — terminates at the stale node
  const decayGhostedRows = []; // quiet 30d+, fully ghosted — continues stale → ghosted
  // Rejections that happened AFTER >= 1 real round, keyed `round-${n}`, so a role lost
  // after its 1st round drops round-1 → Rejected. These drop forward into the single
  // bottom-right Rejected sink, alongside the bulk of pre-response form-rejections.
  const advancedRejectGroups = new Map();
  // Withdrawals that happened AFTER >= 1 real round — same structure as advancedRejectGroups
  // but route to the Withdrawn sink (muted, not red).
  const advancedWithdrawGroups = new Map();
  // Accepted offers — the happy terminus, keyed by the round depth the accepted role
  // reached so it flows round-N → Accepted 🎉 (a green celebratory sink, not a sink for losses).
  const acceptedGroups = new Map();
  let awaiting = 0;
  let stale = 0;
  let ghosted = 0;
  let terminal = 0;
  let terminalPreScreen = 0;
  let withdrawnTerminal = 0;
  let withdrawnTerminalPreScreen = 0;

  function ensureNode(meta) {
    if (!nodeMap.has(meta.id)) nodeMap.set(meta.id, { ...meta, count: meta.count ?? 0 });
    return nodeMap.get(meta.id);
  }

  function addLink(from, to, count, color, filter, examples = []) {
    if (count <= 0) return;
    const key = `${from}->${to}`;
    if (!linkMap.has(key)) {
      linkMap.set(key, {
        from,
        to,
        count: 0,
        color,
        filter,
        examples: [],
      });
    }
    const link = linkMap.get(key);
    link.count += count;
    for (const example of examples) {
      if (link.examples.length >= 3) break;
      link.examples.push(example);
    }
  }

  const examplesOf = (items) =>
    items.slice(0, 3).map((row) => `${row.company} · ${row.stageLabel}`);

  // furthestOrders holds ROUND NUMBERS (1, 2, 3 …), not stage orders — the funnel
  // chain is numbered rounds (see roundCount / sankeyRoundMeta). reachedFor(n) counts
  // apps that did >= n rounds, which is genuinely cumulative, so the chain never
  // implies a round the candidate skipped.
  for (const row of visibleRows) {
    const bucket = row.sourceBucket || sourceBucketId(row.channel);
    sourceRows.get(bucket)?.push(row);
    const rounds = row.roundsReached || 0;
    if (row.terminal) {
      const isWithdrawn = row.stage === "withdrawn";
      if (isWithdrawn) {
        // Candidate-initiated exit — tracked separately from market rejections.
        withdrawnTerminal += 1;
        if (rounds >= 1) {
          furthestOrders.push(rounds);
          const key = `round-${rounds}`;
          if (!advancedWithdrawGroups.has(key)) {
            advancedWithdrawGroups.set(key, { round: rounds, rows: [] });
          }
          advancedWithdrawGroups.get(key).rows.push(row);
        } else {
          withdrawnTerminalPreScreen += 1;
        }
      } else {
        terminal += 1;
        // A rejection that landed after >= 1 real round is counted at that round AND drops
        // into Rejected from there (round-N → rejected). A pre-response rejection did 0
        // rounds and flows into Rejected straight from Heard back.
        if (rounds >= 1) {
          furthestOrders.push(rounds);
          const key = `round-${rounds}`;
          if (!advancedRejectGroups.has(key)) {
            advancedRejectGroups.set(key, { round: rounds, rows: [] });
          }
          advancedRejectGroups.get(key).rows.push(row);
        } else {
          terminalPreScreen += 1;
        }
      }
      continue;
    }
    if (rounds >= 1) {
      furthestOrders.push(rounds);
      if (row.stage === "accepted") {
        if (!acceptedGroups.has(rounds)) acceptedGroups.set(rounds, []);
        acceptedGroups.get(rounds).push(row);
      }
    } else {
      awaiting += 1;
    }
    // Decay overlay: a quiet PRE-interview app (0 rounds, still Awaiting) drains forward
    // through Going stale, and on to Ghosted if it has fully ghosted. An app that already
    // reached a round and went quiet stays counted at its round node (its card carries the
    // stale flag) — routing it back into the col-1.5 decay sink would draw an ugly backward
    // band, so we don't.
    if ((row.ghosted || row.stale) && rounds < 1) {
      if (row.ghosted) {
        ghosted += 1;
        decayGhostedRows.push(row);
      } else {
        stale += 1;
        decayStaleRows.push(row);
      }
    }
  }

  for (const [bucket, bucketRows] of sourceRows) {
    if (!bucketRows.length) continue;
    const node = ensureNode(SANKEY_SOURCE_META[bucket]);
    node.count = bucketRows.length;
  }

  const advanced = furthestOrders.length;
  // Advanced now includes rejected-after-advancing apps (pushed above), so Heard back
  // = everyone who advanced + the pre-screen rejections + pre-screen withdrawals. Same
  // total as the old `advanced + terminal`, just without double-counting.
  const heardBack = advanced + terminalPreScreen + withdrawnTerminalPreScreen;
  if (awaiting > 0) ensureNode({ ...SANKEY_RESPONSE_META.awaiting, count: awaiting });
  if (heardBack > 0) ensureNode({ ...SANKEY_RESPONSE_META.heard, count: heardBack });

  const reachedFor = (round) => furthestOrders.filter((value) => value >= round).length;
  // Numbered-round chain: one node per round depth actually reached, 1 … maxRound.
  // reachedFor(n) is monotonic, so the chain only ever thins out left-to-right.
  const maxRound = furthestOrders.reduce((max, value) => Math.max(max, value), 0);
  for (let n = 1; n <= maxRound; n += 1) {
    ensureNode(sankeyRoundMeta(n, 2 + (n - 1), reachedFor(n)));
  }
  // Accepted 🎉 — the celebratory terminus. An accepted offer flows out of the last round
  // it reached into a single green sink, set just past the deepest accepted round so the
  // win reads instantly and apart from the live chain. Green (not the red loss sink).
  const acceptedCount = [...acceptedGroups.values()].reduce((sum, rows) => sum + rows.length, 0);
  if (acceptedCount > 0) {
    let acceptedRound = 0;
    for (const round of acceptedGroups.keys()) acceptedRound = Math.max(acceptedRound, round);
    ensureNode({
      id: "accepted",
      label: "Accepted 🎉",
      color: "#2F9E55",
      count: acceptedCount,
      col: 2 + (acceptedRound - 1) + 0.7,
      order: 98,
      filter: "accepted",
    });
    for (const [round, rows] of acceptedGroups) {
      addLink(`round-${round}`, "accepted", rows.length, "#2F9E55", "accepted", examplesOf(rows));
    }
  }
  // Rejected is a single terminal sink, bottom-pinned (see the layout pass). It sits
  // HALF a column past the furthest point any rejected app actually reached — NOT way
  // out at the end of the live chain. A pre-response rejection's furthest point is Heard
  // back (col 1); a round-N rejection's is round-N (col N+1). So with rejections only at
  // round 1, Rejected lands at col 2.5 (between 1st and 2nd round) while the green chain
  // — still-alive jobs that went deeper — runs on past it. Every drop converges here:
  // pre-response rejections from Heard back, per-round cuts from the round they died at.
  if (terminal > 0) {
    let furthestRejectCol = terminalPreScreen > 0 ? 1 : 0;
    for (const group of advancedRejectGroups.values()) {
      furthestRejectCol = Math.max(furthestRejectCol, 2 + (group.round - 1));
    }
    ensureNode({
      id: "rejected",
      label: "Rejected",
      color: "#CB5340",
      count: terminal,
      col: furthestRejectCol + 0.5,
      order: 99,
      filter: "terminal",
    });
  }
  // Withdrawn — candidate-initiated exit. Muted grey (not red) to distinguish from
  // a market rejection. Sits at the same depth as the rejection sink for its furthest
  // round, but rendered with a neutral color.
  if (withdrawnTerminal > 0) {
    let furthestWithdrawCol = withdrawnTerminalPreScreen > 0 ? 1 : 0;
    for (const group of advancedWithdrawGroups.values()) {
      furthestWithdrawCol = Math.max(furthestWithdrawCol, 2 + (group.round - 1));
    }
    ensureNode({
      id: "withdrawn",
      label: "Withdrawn",
      color: "#6f7479",
      count: withdrawnTerminal,
      col: furthestWithdrawCol + 0.5,
      order: 100,
      filter: "terminal",
    });
  }

  // Decay is rendered as a fading grey, not a colour — a quiet app is signal
  // draining away, so it desaturates and goes translucent as it decays. Going
  // stale sits halfway between Awaiting (col 1) and the first round (col 2) at a
  // visible grey; Ghosted is a labelled dead-exit pinned to the TOP of its own
  // column (2.25), so the faded band peels UP off Going stale and leaks away —
  // the mirror of Rejected, which sinks to the bottom.
  // "Going stale" is the cumulative quiet state: every ghosted app was stale on the way,
  // so the node counts ALL pre-response quiet apps (stale + ghosted). The merely-stale
  // ones terminate here; the ghosted subset flows one hop further to Ghosted.
  const quiet = stale + ghosted;
  if (quiet > 0)
    ensureNode({
      id: "stale",
      label: "Going stale",
      color: DECAY_STALE_COLOR,
      count: quiet,
      col: 1.5,
      order: 1.5,
      filter: "stale",
    });
  if (ghosted > 0)
    ensureNode({
      id: "ghosted",
      label: "Ghosted",
      color: DECAY_GHOSTED_COLOR,
      count: ghosted,
      col: 2.25,
      order: 0,
      filter: "ghosted",
    });

  for (const [bucket, bucketRows] of sourceRows) {
    if (!bucketRows.length) continue;
    const source = SANKEY_SOURCE_META[bucket];
    const awaitingRows = bucketRows.filter((row) => !row.terminal && (row.roundsReached || 0) < 1);
    const heardRows = bucketRows.filter((row) => row.terminal || (row.roundsReached || 0) >= 1);
    addLink(
      source.id,
      "awaiting",
      awaitingRows.length,
      source.color,
      "awaiting",
      examplesOf(awaitingRows)
    );
    addLink(
      source.id,
      "heardback",
      heardRows.length,
      source.color,
      "heardback",
      examplesOf(heardRows)
    );
  }

  if (maxRound >= 1) {
    addLink("heardback", "round-1", reachedFor(1), roundColor(1), "round-1");
  }
  addLink("heardback", "rejected", terminalPreScreen, "#CB5340", "terminal");
  addLink("heardback", "withdrawn", withdrawnTerminalPreScreen, "#6f7479", "terminal");

  for (let n = 1; n < maxRound; n += 1) {
    addLink(`round-${n}`, `round-${n + 1}`, reachedFor(n + 1), roundColor(n + 1), `round-${n + 1}`);
  }

  // Per-round rejection threads — each round drops the roles lost there down into the
  // single Rejected sink (round-1 → rejected, round-2 → rejected …).
  for (const group of advancedRejectGroups.values()) {
    addLink(
      `round-${group.round}`,
      "rejected",
      group.rows.length,
      "#CB5340",
      "terminal",
      examplesOf(group.rows)
    );
  }
  // Per-round withdrawal threads — mirrors rejection threads but routes to Withdrawn.
  for (const group of advancedWithdrawGroups.values()) {
    addLink(
      `round-${group.round}`,
      "withdrawn",
      group.rows.length,
      "#6f7479",
      "terminal",
      examplesOf(group.rows)
    );
  }

  // Decay overlay links — the quiet band flows FORWARD as a progression: Awaiting →
  // Going stale carries every pre-response quiet app, then the fully-ghosted subset
  // continues Going stale → Ghosted. (addLink no-ops on count <= 0, so an all-stale or
  // all-ghosted pipeline just drops the empty hop.)
  const decayAllRows = decayStaleRows.concat(decayGhostedRows);
  addLink(
    "awaiting",
    "stale",
    decayAllRows.length,
    DECAY_STALE_COLOR,
    "stale",
    examplesOf(decayAllRows)
  );
  addLink(
    "stale",
    "ghosted",
    decayGhostedRows.length,
    DECAY_GHOSTED_COLOR,
    "ghosted",
    examplesOf(decayGhostedRows)
  );

  const nodes = [...nodeMap.values()].sort((a, b) => a.col - b.col || a.order - b.order);
  const links = [...linkMap.values()].sort((a, b) => {
    const aFrom = nodeMap.get(a.from);
    const bFrom = nodeMap.get(b.from);
    const aTo = nodeMap.get(a.to);
    const bTo = nodeMap.get(b.to);
    return (aFrom?.order ?? 0) - (bFrom?.order ?? 0) || (aTo?.order ?? 0) - (bTo?.order ?? 0);
  });

  return { nodes, links, total: visibleRows.length };
}

function needsManualReview(row) {
  if (row.terminal) return false;
  // Triage is a pre-application decision: an un-promoted sourced role still
  // awaiting a promote-or-cut call. Once a role has been applied to (or advanced
  // further) the call is made — it's pipeline, not triage backlog, and must not
  // re-enter the review queue just for still living in the sourced[] array.
  return row.stage === "sourced";
}

function buildJobsRail(rows) {
  const activeRows = rows.filter((row) => !row.terminal);
  const screenPlus = activeRows.filter(
    (row) => row.source === "application" && (STAGE_ORDER[row.stage] ?? 0) >= STAGE_ORDER.screen
  ).length;
  const fresh = activeRows.filter((row) => row.stage === "sourced").length;
  const highFit = activeRows.filter((row) => row.fit >= 80).length;
  const manualReview = activeRows.filter(needsManualReview).length;
  const terminal = rows.filter((row) => row.terminal).length;

  let nextDecision = {
    title: "Queue is clear",
    summary: "No high-priority job board decision is waiting right now.",
    action: "",
    hasWork: false,
  };
  if (manualReview > 0) {
    nextDecision = {
      title: `Review ${manualReview} role${manualReview === 1 ? "" : "s"}`,
      summary: "Triage sourced, missing-comp, or medium-fit roles before promoting more work.",
      action: "manual-review",
      hasWork: true,
    };
  } else if (fresh > 0) {
    nextDecision = {
      title: `Promote or hold ${fresh} fresh role${fresh === 1 ? "" : "s"}`,
      summary: "Use fit, comp visibility, and apply mode before starting application work.",
      action: "manual-review",
      hasWork: true,
    };
  } else if (screenPlus > 0) {
    nextDecision = {
      title: "Protect interview path",
      summary: "Keep screen, interview, and final-loop roles ahead of new applications.",
      action: "interview-path",
      hasWork: true,
    };
  }

  return {
    screenPlus,
    fresh,
    highFit,
    manualReview,
    terminal,
    nextDecision,
  };
}

function buildJobs(trackerData, { now = new Date(), activityEvents = [], profileComp = {} } = {}) {
  const communications = trackerData?.communications || [];
  const applicationRows = (trackerData?.applications || []).map((app, index) =>
    applicationJobRow(
      app,
      index,
      communicationsForApplication(app, communications),
      now,
      profileComp
    )
  );
  const sourcedRows = (trackerData?.sourced || trackerData?.prospects || []).map((role, index) =>
    sourcedJobRow(role, index, now, profileComp)
  );
  const activeRows = applicationRows.filter((row) => !row.terminal);
  const activeSourcedRows = sourcedRows.filter((row) => !row.terminal);
  const terminalRows = [...applicationRows, ...sourcedRows].filter((row) => row.terminal);
  const rows = [...activeRows, ...activeSourcedRows, ...terminalRows];
  for (const row of rows) {
    row.needsReview = needsManualReview(row);
  }

  // Attach each row's slice of the activity feed to its drawer (the per-job timeline,
  // filtered by refs.applicationId). The drawer prefers this over the comms-derived
  // timeline when the job has logged activity.
  const byApp = new Map();
  for (const e of activityEvents) {
    const appId = e?.refs?.applicationId;
    if (!appId) continue;
    if (!byApp.has(appId)) byApp.set(appId, []);
    byApp.get(appId).push(e);
  }
  for (const row of rows) {
    row.drawer.activityTimeline = buildJobActivityTimeline(byApp.get(row.drawerId) || [], now);
  }
  const details = Object.fromEntries(rows.map((row) => [row.drawerId, row.drawer]));

  return {
    rows,
    details,
    funnel: buildJobsFunnel(rows),
    // The funnel is a complete-picture view: it always shows every decay state
    // (stale + ghosted). Hiding ghosted/stale is a table-only preference now.
    sankey: buildJobsSankey(applicationRows, { showGhosted: true }),
    rail: buildJobsRail(rows),
    visibleCount: rows.filter((row) => !row.terminal).length,
    terminalCount: terminalRows.length,
    totalCount: rows.length,
  };
}

function buildReviewHoldRoles(trackerData) {
  const sourced = trackerData?.sourced || trackerData?.prospects || [];
  return sourced
    .filter((role) => String(role.status || "").toLowerCase() === "reviewed-hold")
    .sort((a, b) => Number(b.fitScore || 0) - Number(a.fitScore || 0))
    .map((role) => ({
      detailId: role.id || "",
      company: role.company || "Unknown company",
      role: role.role || "Open role",
      fit: Number(role.fitScore || 0),
      status: role.fitBucket || role.fitBasis || "reviewed-hold",
      link: role.link || role.url || "",
      location: role.loc || role.location || role.mode || "",
    }));
}

function buildSourcedRoles(trackerData) {
  const sourced = trackerData?.sourced || trackerData?.prospects || [];
  return [...sourced]
    .sort((a, b) => Number(b.fitScore || 0) - Number(a.fitScore || 0))
    .map((role, index) => ({
      id: role.id || `sourced-${index + 1}`,
      company: role.company || "Unknown company",
      role: role.role || "Open role",
      location: role.loc || role.location || role.mode || "",
      fit: normalizeFit(role.fitScore),
      fitBucket: role.fitBucket || "",
      link: role.link || role.url || "",
    }));
}

export function buildDashboardViewModel(
  trackerData,
  {
    now = new Date(),
    activityEvents = [],
    modes = null,
    settings = null,
    library = null,
    agentGuidance = null,
  } = {}
) {
  activeCandidateName = normalizeName(settings?.profile?.candidate || "");
  const allNextSteps = buildNextSteps(trackerData, now, { limit: null });
  const timeNextSteps = allNextSteps.slice(0, 3);
  // Story-enrichment prompts ("give me more context") append AFTER the 3 time-based
  // steps so they always render regardless of the cap. The focus card is built from
  // the time-based steps only — an enrichment ask should never become the headline.
  const enrichmentSteps = buildStoryEnrichmentSteps(trackerData);
  const nextSteps = [...timeNextSteps, ...enrichmentSteps];
  const latestRoles = buildLatestRoles(trackerData);
  return {
    recency: {
      updatedAt: durableUpdatedAt(trackerData),
    },
    agentGuidance: buildAgentGuidanceStatus(agentGuidance || modes?.agentGuidance || null),
    modes: buildModeStatus(modes),
    settings: buildSettingsStatus(settings),
    library: buildLibraryStatus(library),
    stats: buildStats(trackerData),
    focus: buildFocusCard(trackerData, { now, nextSteps: timeNextSteps, latestRoles }),
    nextSteps,
    allNextSteps,
    latestRoles,
    sourcedRoles: buildSourcedRoles(trackerData),
    reviewHoldRoles: buildReviewHoldRoles(trackerData),
    calendar: buildCalendar(trackerData, { now }),
    strategy: buildStrategyInsights(trackerData, { now }),
    jobs: buildJobs(trackerData, {
      now,
      activityEvents,
      profileComp: profileCompFromSettings(settings),
    }),
    network: buildNetwork(trackerData, { now }),
    // No limit: keep the full history so the "View all" drawer is complete; the
    // dock view-model slices to DASHBOARD_ACTIVITY_LIMIT at render time.
    activity: buildActivityPulse(activityEvents, { now, limit: null }),
  };
}

// ---------------------------------------------------------------------------
// Activity Pulse — the live agent-activity feed (workspace/activity.jsonl).
// Skills are the only writers (src/core/tracker/activity-log.mjs); here we only
// shape + render the events into the existing pulse timeline. See SPEC.md §2.
// ---------------------------------------------------------------------------

// Per-type Lucide glyph for the timeline dot (paths match the dashboard-shell markup).
const ACTIVITY_ICON_PATHS = {
  sourced: '<path d="m8 11 2 2 4-4"/><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  evaluated:
    '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  tailored:
    '<path d="M14.364 13.634a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506l4.013-4.009a1 1 0 0 0-3.004-3.004z"/><path d="M14.487 7.858A1 1 0 0 1 14 7V2"/><path d="M20 19.645V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l2.516 2.516"/><path d="M8 18h1"/>',
  drafted:
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  applied:
    '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  status_change:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  message:
    '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/>',
  interview:
    '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>',
  offer:
    '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
  research:
    '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  negotiation:
    '<line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  failure:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  system:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
};

// Dot background + icon color per type: agent work on the secondary container,
// world/system on the neutral surface, offer on the success (tertiary) tint,
// failure on the error tint.
const ACTIVITY_TYPE_STYLE = {
  sourced: { dot: "bg-secondary-container", icon: "text-on-secondary-container" },
  evaluated: { dot: "bg-secondary-container", icon: "text-on-secondary-container" },
  tailored: { dot: "bg-secondary-container", icon: "text-on-secondary-container" },
  drafted: { dot: "bg-secondary-container", icon: "text-on-secondary-container" },
  applied: { dot: "bg-secondary-container", icon: "text-on-secondary-container" },
  research: { dot: "bg-secondary-container", icon: "text-on-secondary-container" },
  negotiation: { dot: "bg-secondary-container", icon: "text-on-secondary-container" },
  status_change: { dot: "bg-surface-container-high", icon: "text-on-surface-variant" },
  message: { dot: "bg-surface-container-high", icon: "text-on-surface-variant" },
  interview: { dot: "bg-surface-container-high", icon: "text-on-surface-variant" },
  system: { dot: "bg-surface-container-high", icon: "text-on-surface-variant" },
  offer: { dot: "bg-tertiary-container", icon: "text-on-tertiary-container" },
  failure: { dot: "bg-error-container", icon: "text-error" },
};

const ACTIVITY_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function activityClock(d) {
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

// ISO → "Today, 9:12 AM" / "Yesterday, 4:30 PM" / "Jun 12" / "Jun 12, 2025".
function activityRelTime(at, now) {
  const d = new Date(at);
  if (Number.isNaN(d.valueOf())) return "";
  const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const nDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((nDay - dDay) / 86_400_000);
  if (diff === 0) return `Today, ${activityClock(d)}`;
  if (diff === 1) return `Yesterday, ${activityClock(d)}`;
  if (d.getFullYear() === now.getFullYear())
    return `${ACTIVITY_MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${ACTIVITY_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// A small inline-SVG glyph for the drawer's per-job timeline dot — same Lucide paths
// as the main pulse, sized for the 6×6 dot. Inline SVG (not a material-symbols
// ligature, which renders as mono text in this dashboard) so it's a real icon.
function activityDrawerIcon(iconPath, iconClass) {
  return `<svg class="${esc(iconClass)}" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPath}</svg>`;
}

// The per-job slice of the activity feed (events already filtered to one application),
// shaped for the drawer's timeline section. Oldest-first — the job's story top to
// bottom — with a color-coded dot per event type.
function buildJobActivityTimeline(events, now) {
  return [...events]
    .filter((e) => e?.title && e?.at)
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .map((e) => {
      const type = ACTIVITY_TYPE_STYLE[e.type] ? e.type : "system";
      const style = ACTIVITY_TYPE_STYLE[type];
      return {
        at: activityRelTime(e.at, now),
        title: e.title,
        desc: firstSentence(e.summary || ""),
        iconSvg: activityDrawerIcon(
          ACTIVITY_ICON_PATHS[type] || ACTIVITY_ICON_PATHS.system,
          style.icon
        ),
        dotClass: style.dot,
      };
    });
}

export function buildActivityPulse(events = [], { now = new Date(), limit = 12 } = {}) {
  // limit == null means "no cap" — the View-all drawer needs the full history,
  // not the top 12. The dock still slices to DASHBOARD_ACTIVITY_LIMIT at render.
  const cap = limit == null ? Number.POSITIVE_INFINITY : limit;
  return [...events]
    .filter((e) => e?.title && e?.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, cap)
    .map((e) => {
      const type = ACTIVITY_TYPE_STYLE[e.type] ? e.type : "system";
      const style = ACTIVITY_TYPE_STYLE[type];
      // No needsUser tint: the pulse feed is read-only history. Urgency tint stays
      // tone-driven only (warning/failure), never "this needs an action" — those are
      // derived from tracker.json, not frozen onto an event.
      const tint = e.tone === "warning" || type === "failure" ? "bg-error-container/10" : "";
      return {
        id: e.id,
        relTime: activityRelTime(e.at, now),
        type,
        iconPath: ACTIVITY_ICON_PATHS[type] || ACTIVITY_ICON_PATHS.system,
        dotClass: style.dot,
        iconClass: style.icon,
        titleClass: type === "failure" ? "text-error" : "text-on-surface",
        tintClass: tint,
        actor: e.actor === "world" ? "world" : "agent",
        title: e.title,
        summary: compactUiText(e.summary || "", 120),
        tags: Array.isArray(e.tags) ? e.tags : [],
        appId: e.refs?.applicationId || "",
      };
    });
}
