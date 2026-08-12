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

const ICON_PATHS = {
  mapPin:
    '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  hybrid: '<circle cx="9" cy="9" r="7"/><circle cx="15" cy="15" r="7"/>',
  building:
    '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
  // building-2: cleaner office tower used for onsite
  "building-2":
    '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4M10 10h4M10 14h4M10 18h4"/>',
  // moving truck for relo (plane kept as commented alt)
  truck:
    '<path d="M5 18H3c-.6 0-1-.4-1-1V7c0-.6.4-1 1-1h10c.6 0 1 .4 1 1v11"/><path d="M14 9h4l4 4v4c0 .6-.4 1-1 1h-2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  // plane alt: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>'
  navigation: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  alert:
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
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
    if (/\b(?:reject|declin|withdraw)\w*/i.test(text)) continue;
    const scheduling = SCHEDULING_CONV_RE.test(text);
    if (!scheduling && INTERVIEW_ROUND_RE.test(text)) rounds += 1;
    if (scheduling) continue; // a pending touchpoint never advances the stage
    const convStage = classifyStage(text);
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
    if (/\b(?:reject|declin|withdraw)\w*/i.test(text)) continue;
    if (SCHEDULING_CONV_RE.test(text)) continue;
    const stage = classifyStage(text);
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
    if (/\b(?:reject|declin|withdraw)\w*/i.test(text)) continue;
    if (SCHEDULING_CONV_RE.test(text)) continue;
    if (NON_ROUND_CONV_RE.test(text)) continue; // referral/offer/negotiation/debrief ≠ a round
    rounds += 1;
  }
  return rounds;
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
      title: "Mode config is invalid. Run careerrat modes status.",
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
    "Run careerrat doctor, then ask the agent to follow the Agent guidance block.";
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
  if (
    /@/.test(text) ||
    /\b(no reply|noreply|notification|candidate portal|portal|workday|ashby|greenhouse)\b/i.test(
      text
    )
  ) {
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

function addNetworkContact(record, rawName, { company, type, context = "", note = "" } = {}) {
  const name = cleanContactName(rawName, company || record.company);
  if (!name) return;
  const contactType = type || contactTypeFromText(`${rawName} ${context} ${note}`);
  if (contactType === "Portal") return;
  const key = `${normalizeName(contactType)}:${normalizeName(name)}`;
  const existing = record.contactMap.get(key);
  const summary = firstSentence(note || context, "Relationship context captured in tracker.");
  if (existing) {
    existing.note = existing.note || summary;
    return;
  }
  record.contactMap.set(key, { type: contactType, name, note: compactUiText(summary, 96) });
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
      });
    }
    if (message.direction === "outbound-sent" || message.direction === "outbound-draft") {
      for (const to of message.to || []) {
        addNetworkContact(record, to, {
          company: record.company,
          type: contactTypeFromText(`${to} ${message.summary}`, "Recruiter"),
          context: message.subject,
          note: message.summary,
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
  if (record.contactMap.size > 0) return true;
  return record.comms.some(
    (comm) => comm.channel && comm.channel !== "portal" && comm.status !== "closed"
  );
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

// Whether a comm thread is the candidate's to act on right now. Passive (waiting-on-them)
// statuses surface only when their follow-up timer has fired; everything else open does.
function commIsActionable(comm = {}, now = new Date()) {
  if (comm.status === "closed") return false;
  if (PASSIVE_COMM_STATUSES.has(comm.status)) return commActionDue(comm, now);
  return true;
}

function buildNextSteps(trackerData, now, { limit = 3 } = {}) {
  const applications = trackerData?.applications || [];
  const communications = trackerData?.communications || [];
  const appById = new Map(applications.map((app) => [app.id, app]));
  const openCommStatuses = new Set(["needs-reply", "drafted", "blocked"]);

  const commSteps = communications
    .filter(
      (comm) =>
        commIsActionable(comm, now) &&
        (openCommStatuses.has(comm.status) || hasRealActionText(comm.nextAction))
    )
    .map((comm) => {
      const app = appById.get(comm.applicationId);
      const dueAt = comm.nextActionDue || comm.lastInboundAt;
      const company = comm.company || app?.company || "Unknown company";
      const stepDueText = dueText(dueAt, now);
      const tone = dueTone(dueAt, now);
      const title = comm.nextAction || "Reply needed";
      const detail = comm.summary || comm.subject || app?.role || "";
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
      const detail = app.role || app.statusNote || firstSentence(app.note) || "";
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
      const detail = app.statusNote || firstSentence(app.note) || app.role || "";
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

  const ordered = [...commSteps, ...applicationSteps, ...followUpSteps].sort(sortByQueuePriority);
  return limit == null ? ordered : ordered.slice(0, limit);
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
  const role = app.role || "Open role";
  const company = app.company || "Unknown company";
  // Structured logistics facts so the dossier card reads full and scannable.
  // Logistics only — comp/fit stay in the drawer (Tracker Content Register).
  const facts = [
    app.mode ? { label: "Format", value: titleCase(app.mode) } : null,
    app.loc ? { label: "Location", value: app.loc } : null,
  ].filter(Boolean);
  // The featured interview's prep document. interview-prep writes this artifact when an
  // upcoming interview becomes the Focus item; "Open dossier" previews it full-page. When
  // no dossier exists yet, the card prompts to build one instead of opening an empty modal.
  const rawDossier = app.artifacts?.interviewDossier || null;
  const hasDossier = Boolean(rawDossier?.markdown);
  const dossier = {
    title: rawDossier?.title || `${company} — ${role}`,
    subtitle: app.interviewNote || `${company} · ${role}`,
    round: rawDossier?.round || "",
    generatedAt: rawDossier?.generatedAt || "",
    markdown: rawDossier?.markdown || "",
  };
  return {
    kind: "interview",
    label: hasDossier ? "Interview dossier" : "Upcoming interview",
    title: hasDossier ? "Interview dossier" : "Upcoming interview",
    company,
    role,
    facts,
    dossier,
    hasDossier,
    detail: `${company} · ${role}`,
    // Focus card interview slot reads ONLY the typed interviewNote — logistics, nothing
    // about comp/fit (those route to the drawer). Legacy rows with only app.note fall
    // back to a generic line, not the old mixed-topic blob.
    note:
      app.interviewNote ||
      (hasDossier
        ? "Dossier ready — open to review prep context."
        : "Interview scheduled — generate your prep dossier."),
    dueAt: selected.dueAt,
    dueText: selected.dueAt ? dueText(selected.dueAt, now) : "Prep",
    tone: dueTone(selected.dueAt, now),
    detailId: app.id || "",
    // Only offer "Open dossier" when one actually exists, so the CTA never opens empty.
    cta: hasDossier ? "Open dossier" : "Prep this interview",
  };
}

function buildFocusCard(trackerData, { now, nextSteps, latestRoles } = {}) {
  const interview = buildInterviewFocus(trackerData, now);
  if (interview) return interview;

  const action = nextSteps?.[0];
  if (action) {
    return {
      kind: "action",
      label: "Next action",
      title: action.title,
      company: action.company,
      role: action.detail || "",
      detail: action.detail || `${action.company} · ${action.dueText}`,
      note:
        action.supportingText ||
        firstSentence(action.detail) ||
        "This is the next item waiting on you.",
      dueAt: action.dueAt,
      dueText: action.dueText,
      tone: action.tone,
      detailId: action.detailId || "",
      cta: "Handle next action",
    };
  }

  const role = latestRoles?.[0];
  if (role) {
    return {
      kind: "review",
      label: "Review queue",
      title: "Best new role",
      company: role.company,
      role: role.role,
      detail: `${role.fit} · ${role.status}`,
      note: "No urgent action is ahead of the source queue.",
      dueAt: "",
      dueText: "Review",
      tone: "secondary",
      detailId: role.detailId || "",
      cta: "Review roles",
    };
  }

  return {
    kind: "clear",
    label: "All clear",
    title: "No urgent action",
    company: "Rolester",
    role: "",
    detail: "The dashboard has no interview, reply, or review item to elevate.",
    note: "When new tracker activity arrives, the focus card will promote the next useful item.",
    dueAt: "",
    dueText: "Clear",
    tone: "secondary",
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
  if (!commIsActionable(comm, now)) return null;
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
// persisted block written by `careerrat analytics --write`). Fully defensive:
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

// logo.dev company logos are entirely optional. The publishable token is PRIVATE
// candidate config (never committed — see code-must-be-domain-neutral); absent →
// every avatar stays an initials chip. Set during buildDashboardViewModel.
let activeLogoToken = "";

// The candidate's own name, normalized, so contact extraction can drop the
// candidate themselves out of the network (a thread "from" them isn't a contact).
// Derived from profile config, never hardcoded — see code-must-be-domain-neutral.
// Set during buildDashboardViewModel.
let activeCandidateName = "";

// The stored `domain` is usually the application PORTAL, not the employer. Keying
// logo.dev on these would paint every Ashby/Greenhouse job with the ATS's own
// logo, so they can never be a logo source. (Real fix is upstream: capture the
// company domain when a job is added — see ui-change-queue B9.)
const ATS_LOGO_DOMAINS = new Set([
  "ashbyhq.com",
  "greenhouse.io",
  "lever.co",
  "myworkday.com",
  "myworkdayjobs.com",
  "workday.com",
  "breezy.hr",
  "workable.com",
  "jobvite.com",
  "smartrecruiters.com",
  "icims.com",
  "bamboohr.com",
  "recruitee.com",
  "teamtailor.com",
  "linkedin.com",
  "indeed.com",
  "wellfound.com",
  "linkedin.net",
]);

function companyDomainForLogo(domain) {
  let host = String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
  if (!host) return "";
  // Strip a leading careers/jobs portal subdomain to recover the employer apex
  // (jobs.apple.com → apple.com, careers.datadoghq.com → datadoghq.com).
  host = host.replace(
    /^(careers?|jobs|job-boards|boards|apply|talent|hire|recruiting|work|explore\.jobs|explore)\./,
    ""
  );
  const registrable = host.split(".").slice(-2).join(".");
  if (ATS_LOGO_DOMAINS.has(host) || ATS_LOGO_DOMAINS.has(registrable)) return "";
  return host;
}

// Shared logo.dev query params. fallback=404 makes a miss error out so our own
// initials chip shows (via the img onerror), instead of logo.dev's generic monogram.
const LOGO_QUERY = `&size=64&format=webp&retina=true&fallback=404`;

// Resolve a logo URL with two strategies, in precision order:
//   1. Domain — when we have a CLEAN, real employer domain (apple.com), key on it.
//      Most precise; immune to name collisions.
//   2. Name search — otherwise fall back to logo.dev's /name/ lookup keyed on the
//      company name. The company name is the one field we always have and is always
//      correct, so this covers the ATS-hosted majority (jobs.ashbyhq.com rows whose
//      stored domain is the portal, not the employer) with no manual data upkeep.
// A clean domain auto-overrides name search as we capture real domains upstream.
function buildLogoUrl(domain, name) {
  if (!activeLogoToken) return "";
  const token = encodeURIComponent(activeLogoToken);
  const host = companyDomainForLogo(domain);
  if (host) {
    return `https://img.logo.dev/${encodeURIComponent(host)}?token=${token}${LOGO_QUERY}`;
  }
  const company = String(name || "").trim();
  if (company) {
    return `https://img.logo.dev/name/${encodeURIComponent(company)}?token=${token}${LOGO_QUERY}`;
  }
  return "";
}

// logo.dev serves a dark-optimised variant via &theme=dark — it returns the
// light/knockout version of monochrome marks so a black wordmark stays visible on
// our dark avatar tile. We bake the suffix in at render and re-point every logo on
// theme toggle (see syncLogoTheme in the shell). The base URL is kept on
// data-logo-base so the toggle can rebuild the src either way.
function logoThemeSuffix() {
  try {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "&theme=dark" : "";
  } catch (_e) {
    return "";
  }
}

// One avatar surface: a real logo masking an initials chip, or just the chip.
// `wrapperClass` carries the size/shape/color utilities for the call site.
// `logoSrc` is an OPTIONAL explicit image path (e.g. a bundled demo-corp logo); when
// present it wins over the logo.dev lookup. Real workspaces never set it, so this stays
// domain-neutral — it's just "use the logo the data already carries, else resolve one."
function avatarMarkup(domain, name, initialsText, wrapperClass, logoSrc) {
  const safeInitials = esc(initialsText);
  if (logoSrc) {
    return `<span class="${wrapperClass} avatar-has-logo"><img class="avatar-logo-img" src="${esc(logoSrc)}" alt="" loading="lazy" onerror="this.remove()"><span class="avatar-logo-initials">${safeInitials}</span></span>`;
  }
  const base = buildLogoUrl(domain, name);
  if (!base) {
    return `<span class="${wrapperClass}">${safeInitials}</span>`;
  }
  const src = base + logoThemeSuffix();
  return `<span class="${wrapperClass} avatar-has-logo"><img class="avatar-logo-img" src="${esc(src)}" data-logo-base="${esc(base)}" alt="" loading="lazy" onerror="this.remove()"><span class="avatar-logo-initials">${safeInitials}</span></span>`;
}

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

function inlineIcon(name, className = "jobs-inline-icon") {
  const path = ICON_PATHS[name];
  if (!path) return "";
  return `<svg class="${esc(className)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
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
  if (!commIsActionable(comm, now)) return null;
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
// target anchor) so they are real config values, not UI placeholders.
function compRangeView(row, sourceRecord = {}) {
  const est =
    sourceRecord && typeof sourceRecord.compEstimate === "object"
      ? sourceRecord.compEstimate
      : null;
  const floorK = est && Number.isFinite(Number(est.floorK)) ? Math.round(Number(est.floorK)) : null;
  const askK = est && Number.isFinite(Number(est.askK)) ? Math.round(Number(est.askK)) : null;

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

function jobDetailFromRow(row, sourceRecord = {}, communications = [], now = new Date()) {
  const compView = compRangeView(row, sourceRecord);
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
    floor: compView.floorK ?? 200,
    ask: compView.askK ?? (row.fit >= 85 ? 230 : row.fit >= 75 ? 215 : 200),
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

function applicationJobRow(app, index, communications = [], now = new Date()) {
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
  return { ...row, drawer: jobDetailFromRow(row, app, communications, now) };
}

function sourcedJobRow(role, index, now = new Date()) {
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
  return { ...row, drawer: jobDetailFromRow(row, role, [], now) };
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

function buildJobs(trackerData, { now = new Date(), activityEvents = [] } = {}) {
  const communications = trackerData?.communications || [];
  const applicationRows = (trackerData?.applications || []).map((app, index) =>
    applicationJobRow(app, index, communicationsForApplication(app, communications), now)
  );
  const sourcedRows = (trackerData?.sourced || trackerData?.prospects || []).map((role, index) =>
    sourcedJobRow(role, index, now)
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
  activeLogoToken = settings?.logoToken || "";
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
    jobs: buildJobs(trackerData, { now, activityEvents }),
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

function activitySourceMarker(actor) {
  if (actor === "world") {
    // Inline SVG (not the material-symbols ligature, which renders as mono text in
    // this dashboard) so the world marker is a real icon regardless of icon-font load.
    return '<span class="source-icon source-icon-email" data-tooltip="World event" title="World event" role="img" aria-label="World event"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/></svg></span>';
  }
  return '<span class="source-icon source-icon-rolester" data-tooltip="Rolester" title="Rolester" role="img" aria-label="Rolester"><img src="../../assets/logo.png" alt="" /></span>';
}

function activityDotIcon(row) {
  return `<svg class="pulse-dot-icon ${esc(row.iconClass)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${row.iconPath}</svg>`;
}

function activityTags(tags) {
  if (!tags.length) return "";
  const chips = tags
    .map(
      (t) =>
        `<span class="px-1.5 py-0.5 bg-on-tertiary-container/10 text-on-tertiary-container rounded text-[10px] font-bold">${esc(t)}</span>`
    )
    .join("");
  return `<div class="flex gap-1.5 flex-wrap mt-1.5">${chips}</div>`;
}

function activityCta() {
  // The pulse feed is read-only history — it never renders a live CTA. A finished
  // action self-clears in the derived action surfaces (Next Steps / Action Queue /
  // drawer), which read tracker.json; an immutable event must never carry a button
  // that outlives the work. See docs/activity-and-action-state.md. The whole row is
  // navigable to its job via data-detail-id on renderActivityRow instead.
  return "";
}

function renderActivityRow(row, isLast) {
  const inner = `
            <div class="flex items-center gap-2 mb-0.5 flex-wrap">
              <span class="font-label-caps text-label-caps text-outline font-data-mono">${esc(row.relTime)}</span>
              ${activitySourceMarker(row.actor)}
            </div>
            <div class="font-bold ${esc(row.titleClass)} text-[13px] leading-tight mb-0.5">${esc(row.title)}</div>
            ${row.summary ? `<div class="text-[12px] text-on-surface-variant leading-snug">${esc(row.summary)}</div>` : ""}
            ${activityTags(row.tags)}
            ${activityCta(row)}`;
  const body = row.tintClass
    ? `<div class="${esc(row.tintClass)} rounded-lg p-3">${inner}</div>`
    : inner;
  // The last row drops the trailing connector line and uses tighter bottom padding.
  // A row tied to an application is navigable to its job drawer (history → context),
  // via the same [data-next-step-item][data-detail-id] delegation the queue uses.
  const nav = row.appId
    ? ` data-next-step-item data-detail-id="${esc(row.appId)}" role="button" tabindex="0"`
    : "";
  return `
        <div class="relative flex gap-3 ${isLast ? "pb-2" : "pb-5"}${row.appId ? " cursor-pointer" : ""}"${nav}>
          ${isLast ? "" : '<div class="pulse-connector"></div>'}
          <div class="pulse-dot ${esc(row.dotClass)}">${activityDotIcon(row)}</div>
          <div class="flex-1 min-w-0">${body}</div>
        </div>`;
}

function renderActivityEmpty() {
  return `
        <div class="py-8 text-center text-[12px] text-on-surface-variant">
          No activity yet. As Rolester sources, evaluates, tailors, and tracks roles, each action shows up here.
        </div>`;
}

export function renderActivityPulse(rows) {
  if (!rows || rows.length === 0) return renderActivityEmpty();
  return rows.map((row, i) => renderActivityRow(row, i === rows.length - 1)).join("");
}

function focusToneClass(tone) {
  if (tone === "error") return "text-error";
  if (tone === "warning") return "text-[#e0a93b]";
  return "text-on-tertiary-container";
}

function renderFocusCard(focus) {
  if (!focus) return "";
  // Interview focus: the CTA opens the full-page dossier preview (NOT the generic job
  // drawer). Any other focus kind keeps the drawer-delegation behaviour.
  const buttonAttrs =
    focus.kind === "interview" && focus.detailId && focus.hasDossier
      ? ` data-open-dossier="${esc(focus.detailId)}"`
      : focus.detailId
        ? ` data-next-step-item data-detail-id="${esc(focus.detailId)}"`
        : "";
  const facts = Array.isArray(focus.facts) ? focus.facts : [];
  const factsHtml = facts.length
    ? `<dl class="focus-card-facts">${facts
        .map((fact) => `<div><dt>${esc(fact.label)}</dt><dd>${esc(fact.value)}</dd></div>`)
        .join("")}</dl>`
    : "";
  return `
        <div class="focus-card-copy">
          <h3 class="focus-card-title">${esc(focus.title)}</h3>
          <p class="focus-card-meta">${esc(focus.company)}${focus.role ? ` · ${esc(focus.role)}` : ""}</p>
          <p class="focus-card-note">${esc(focus.note)}</p>
          ${factsHtml}
        </div>
        <div class="focus-card-actions">
          <span class="focus-card-due ${esc(focusToneClass(focus.tone))}">${esc(focus.dueText)}</span>
          <button type="button" class="focus-card-cta"${buttonAttrs}>${esc(focus.cta)}</button>
        </div>`;
}

export function renderNextSteps(steps) {
  return steps
    .map((step) => {
      const content = `
          <div class="min-w-0">
            <div class="font-bold text-primary text-[14px] leading-tight">${esc(step.title)}</div>
            <p class="mt-1 text-[12px] text-on-surface-variant">${esc(step.supportingText || `${step.company} · ${step.dueText}`)}</p>
          </div>
          <span class="font-label-caps text-label-caps ${esc(step.actionToneClass || "text-secondary")} uppercase font-data-mono">${esc(step.actionLabel || "Review")}</span>`;
      if (step.detailId) {
        return `
        <button type="button" class="grid w-full cursor-pointer grid-cols-[1fr_auto] items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-surface-container-low" data-next-step-item data-detail-id="${esc(step.detailId)}">
          ${content}
        </button>`;
      }
      return `
        <div class="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-4">
          ${content}
        </div>`;
    })
    .join("");
}

function fitToneClass(fit) {
  if (fit >= 80) return "text-on-tertiary-container";
  if (fit >= 70) return "text-[#e0a93b]";
  return "text-outline";
}

function renderLatestRoles(roles) {
  if (!roles.length) return "";
  return roles
    .map((role) => {
      // Every role row opens its job drawer (same delegation the queue/jobs cards use).
      const nav = role.detailId
        ? ` data-next-step-item data-detail-id="${esc(role.detailId)}"`
        : "";
      return `
        <button type="button" class="grid w-full cursor-pointer grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 text-left transition-colors"${nav}>
          <div class="min-w-0">
            <div class="font-bold text-primary text-[14px] leading-tight">${esc(role.company)}</div>
            <div class="mt-1 text-[12px] text-on-surface-variant">${esc(role.role)} · ${esc(role.status)}</div>
          </div>
          <span class="jobs-fit" style="--jobs-fit-color:${esc(fitToneColor(role.fit))}" title="Triage fit score">
            <span>${esc(role.fit)}</span>
          </span>
        </button>`;
    })
    .join("");
}

function sourcedRoleGateClass(fitBucket) {
  const b = String(fitBucket || "").toLowerCase();
  if (b === "keep") return "text-on-tertiary-container";
  if (b === "review") return "text-[#e0791f]";
  return "text-outline";
}

function renderSourcedRoles(roles) {
  if (!roles.length) {
    return `<div class="px-5 py-8 text-center text-[13px] text-on-surface-variant">No sourced roles yet.</div>`;
  }
  return roles
    .map((role) => {
      const fitColor = fitToneColor(role.fit);
      const gateLabel = role.fitBucket ? titleCase(role.fitBucket) : "—";
      const gateClass = sourcedRoleGateClass(role.fitBucket);
      const locationText = role.location ? ` · ${role.location}` : "";
      const actionHtml = role.link
        ? `<div class="text-right font-label-caps text-label-caps text-secondary uppercase"><a href="${esc(role.link)}" target="_blank" rel="noopener noreferrer" class="hover:underline">Open</a></div>`
        : `<div class="text-right font-label-caps text-label-caps text-outline uppercase">—</div>`;
      return `
        <div class="grid w-full grid-cols-[1fr_120px_120px_120px] items-center gap-4 px-5 py-4">
          <div class="min-w-0">
            <div class="font-bold text-primary text-[14px]">${esc(role.company)}</div>
            <div class="mt-1 text-[12px] text-on-surface-variant">${esc(role.role)}${esc(locationText)}</div>
          </div>
          <div class="font-data-mono text-[13px]" style="color:${esc(fitColor)}">${esc(role.fit)}</div>
          <div class="font-label-caps text-label-caps uppercase ${esc(gateClass)}">${esc(gateLabel)}</div>
          ${actionHtml}
        </div>`;
    })
    .join("");
}

function renderReviewHoldRoles(roles) {
  if (!roles.length) return "";
  return roles
    .map((role) => {
      const fitColor = fitToneColor(role.fit);
      const locationText = role.location ? ` · ${esc(role.location)}` : "";
      const actionHtml = role.link
        ? `<div class="text-right font-label-caps text-label-caps text-secondary uppercase"><a href="${esc(role.link)}" target="_blank" rel="noopener noreferrer" class="hover:underline">Open</a></div>`
        : `<div class="text-right font-label-caps text-label-caps text-outline uppercase">—</div>`;
      return `
        <div class="grid w-full grid-cols-[1fr_100px_100px] items-center gap-4 px-5 py-3">
          <div class="min-w-0">
            <div class="font-bold text-primary text-[14px]">${esc(role.company)}</div>
            <div class="mt-1 text-[12px] text-on-surface-variant">${esc(role.role)}${locationText}</div>
          </div>
          <div class="font-data-mono text-[13px]" style="color:${esc(fitColor)}">${esc(String(role.fit))}</div>
          ${actionHtml}
        </div>`;
    })
    .join("");
}

function stageBadgeClass(row) {
  if (row.terminal) return "bg-surface-container-highest text-outline";
  if (row.stage === "sourced") return "bg-secondary-fixed/40 text-secondary";
  if (row.stage === "accepted" || row.stage === "offer")
    return "bg-tertiary-container/10 text-on-tertiary-container";
  if ((STAGE_ORDER[row.stage] ?? 0) >= STAGE_ORDER.screen)
    return "bg-surface-container-highest text-primary";
  return "bg-surface-container-highest text-on-surface-variant";
}

function jsArg(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, " ");
}

function renderJobRow(row) {
  const muted = row.terminal;
  return `
    <tr class="${row.terminal ? "rejected-row " : ""}hover:bg-surface-container-low transition-colors group cursor-pointer" onclick="openDrawer('${esc(jsArg(row.drawerId))}')">
      <td class="px-6 py-4">
        <div class="flex items-center gap-3">
          ${avatarMarkup(row.domain, row.company, row.initials, `w-8 h-8 rounded ${esc(row.avatarClass)} flex items-center justify-center font-black text-[10px]`, row.logo)}
          <div>
            <div class="font-bold ${muted ? "text-outline" : "text-primary"}">${esc(row.company)}</div>
            <div class="text-[11px] text-outline">${esc(row.location || "Location TBD")}</div>
          </div>
        </div>
      </td>
      <td class="px-6 py-4 text-body-md ${muted ? "text-on-surface-variant" : "text-on-surface"}">${esc(row.role)}</td>
      <td class="px-6 py-4 font-data-mono text-data-mono ${muted ? "text-outline" : "text-on-surface"}">${esc(row.comp)}</td>
      <td class="px-6 py-4">
        <div class="flex items-center gap-2">
          <span class="${fitToneClass(row.fit)} font-bold text-[12px] font-data-mono">${esc(fitLabel(row))}</span>
        </div>
      </td>
      <td class="px-6 py-4"><span class="px-2 py-0.5 ${stageBadgeClass(row)} rounded text-[10px] font-bold uppercase tracking-wider">${esc(row.stageLabel)}</span></td>
      <td class="px-6 py-4 font-data-mono text-data-mono ${muted ? "text-outline" : "text-on-surface-variant"}">${esc(row.appliedLabel)}</td>
      <td class="px-6 py-4 text-right"><button class="material-symbols-outlined text-outline opacity-0 group-hover:opacity-100 transition-opacity" aria-label="More options">more_vert</button></td>
    </tr>`;
}

function renderJobsRows(rows) {
  return rows.map(renderJobRow).join("");
}

function renderJobsFunnel(buckets) {
  return buckets
    .map(
      (bucket) => `
        <button type="button" class="jobs-funnel-step" data-jobs-stage-filter="${esc(bucket.id)}" style="--jobs-stage-color:${esc(bucket.color)}">
          <span class="jobs-funnel-step-main">
            <span class="jobs-funnel-label">${esc(bucket.label)}</span>
            <span class="jobs-funnel-count">${esc(bucket.count)}</span>
          </span>
          <span class="jobs-funnel-bar" aria-hidden="true"><span style="width:${esc(bucket.pct)}%"></span></span>
        </button>`
    )
    .join("");
}

function sankeyTipPayload(title, count, examples) {
  return esc(
    JSON.stringify({
      title,
      count,
      examples: examples || [],
    })
  );
}

function renderJobsSankey(sankey) {
  const W = 1800;
  const H = 520;
  const top = 48;
  const columnHeight = 400;
  const nodeW = 5;
  const columns = [...new Set(sankey.nodes.map((node) => node.col))].sort((a, b) => a - b);
  const maxCol = Math.max(1, ...columns);
  const leftPad = 220;
  const usableWidth = W - leftPad - 320;
  const xForCol = (col) => leftPad + (usableWidth * col) / maxCol;
  const gapAfterNode = (node, next) =>
    node?.id === "screen" && (next?.id === "rejected" || next?.id === "ghosted") ? 36 : 16;
  const columnNodes = (col) => sankey.nodes.filter((node) => node.col === col);
  const columnGapTotal = (nodes) =>
    nodes
      .slice(0, -1)
      .reduce((total, node, index) => total + gapAfterNode(node, nodes[index + 1]), 0);
  const columnUnitCaps = columns
    .map((col) => {
      const nodes = columnNodes(col);
      const count = nodes.reduce((total, node) => total + node.count, 0);
      return count > 0 ? (columnHeight - columnGapTotal(nodes)) / count : 11;
    })
    .filter((value) => Number.isFinite(value) && value > 0);
  // The per-column cap is what makes a column fit inside columnHeight. A high unit
  // floor (was 4) overrode that for a heavy column — e.g. 113 "Direct apply" rows ×
  // 4 = 452px overflowed the 400px column and pushed "Recruiter sourced" (and its
  // stacked count) off the bottom of the viewBox. The 6px node / 4px link minimums
  // already keep thin nodes visible, so let the caps govern the fit.
  const unit = Math.max(1, Math.min(11, ...columnUnitCaps));
  const layout = new Map();

  for (const col of columns) {
    const nodes = columnNodes(col);
    const usedHeight =
      nodes.reduce((total, node) => total + Math.max(6, node.count * unit), 0) +
      columnGapTotal(nodes);
    let y = top + Math.max(0, (columnHeight - usedHeight) / 2);
    // (Columns lay out left→right: Awaiting is placed before the stale column, and the
    // stale node before the exits column, so both are in `layout` when we need them.)
    const awaitingLaid = layout.get("awaiting");
    const staleLaid = layout.get("stale");
    if (nodes.some((node) => node.id === "stale") && awaitingLaid) {
      // Going stale is a thick band (≈half the active pipeline) crossing a very short
      // hop (Awaiting → col 1.5). At that thickness ANY vertical offset bends the band
      // into a crease, because the stroke is wider than the curve's radius — it reads as
      // folding back on itself. So top-align the stale sink with Awaiting and let the
      // band run dead straight: a clean horizontal drain, no fold. Clamp only so a stale
      // pool taller than the column can't spill past the bottom.
      const maxTop = top + columnHeight - usedHeight;
      y = Math.min(awaitingLaid.y, maxTop);
    } else if (nodes.some((node) => node.id === "screen") && staleLaid) {
      // Exits column. Centre the winning Screen lane vertically so it has room, with the
      // Going stale bend above. Keep a floor so Heard back → Screen still clears the
      // stale node (the band crosses the stale column at ~(heardback.y + colStart + screenH)/2).
      const heardLaid = layout.get("heardback");
      const screenNode = nodes.find((node) => node.id === "screen");
      const screenH = screenNode ? Math.max(6, screenNode.count * unit) : 0;
      const maxStart = top + columnHeight - usedHeight;
      const centreScreen = top + columnHeight / 2 - screenH / 2;
      const clearFloor = heardLaid
        ? 2 * (staleLaid.y + staleLaid.h + 8) - heardLaid.y - screenH
        : y;
      y = Math.min(maxStart, Math.max(centreScreen, clearFloor));
    } else if (nodes.some((node) => node.id === "rejected")) {
      // Rejected is the terminal "lost" sink, pinned to the bottom-right corner. Every
      // drop converges here along the bottom lane: pre-response rejections run nearly
      // flat from Heard back (which also sits low), the per-round cuts drop in from the
      // chain above. Bottom-anchoring keeps that heavy band out of the live chain.
      y = top + columnHeight - usedHeight;
    } else if (nodes.some((node) => node.id === "ghosted")) {
      // Ghosted is the decay dead-exit, pinned to the TOP of its own column so the faded
      // band peels UP off Going stale and leaks away — the mirror of Rejected sinking to
      // the bottom. Top-anchoring guarantees the band always reads as a rising exit,
      // whatever height Going stale lands at.
      y = top;
    }
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const h = Math.max(6, node.count * unit);
      layout.set(node.id, { ...node, x: xForCol(col), y, h });
      y += h + gapAfterNode(node, nodes[index + 1]);
    }
  }

  const outOffsets = new Map();
  const inOffsets = new Map();
  // The Rejected sink stacks its incoming bands deliberately: the per-round cuts
  // (which fall from the chain above) seat into the TOP of the node, and the heavy
  // pre-response band (from low-sitting Heard back) runs into the BOTTOM. Default
  // draw order would invert that — Heard back on top, thin cuts crammed into the
  // bottom tip — so pre-seat rejected's in-offsets source-high-to-low, Heard back last.
  const rejInOffset = new Map();
  {
    const incoming = sankey.links.filter((link) => link.to === "rejected" && layout.get(link.from));
    incoming.sort((a, b) => {
      if (a.from === "heardback") return 1;
      if (b.from === "heardback") return -1;
      return layout.get(a.from).y - layout.get(b.from).y;
    });
    let acc = 0;
    for (const link of incoming) {
      rejInOffset.set(link, acc);
      acc += Math.max(4, link.count * unit);
    }
  }
  const paths = sankey.links
    .map((link) => {
      const from = layout.get(link.from);
      const to = layout.get(link.to);
      if (!from || !to) return "";
      const h = Math.max(4, link.count * unit);
      const out = outOffsets.get(link.from) || 0;
      const incoming =
        link.to === "rejected" ? rejInOffset.get(link) || 0 : inOffsets.get(link.to) || 0;
      outOffsets.set(link.from, out + h);
      if (link.to !== "rejected") inOffsets.set(link.to, incoming + h);
      const x1 = from.x + nodeW;
      const x2 = to.x;
      const y1 = from.y + out + h / 2;
      const y2 = to.y + incoming + h / 2;
      // Cap the control-point reach at half the span: a 120px floor on a short hop
      // (e.g. Awaiting → Going stale) would push the two control points past each
      // other and balloon the band into a blob. Half-span keeps every band a clean,
      // gentle S that exits each node horizontally.
      const span = Math.abs(x2 - x1);
      const curve = Math.min(Math.max(120, span * 0.52), span * 0.5);
      const tip = sankeyTipPayload(`${from.label} → ${to.label}`, link.count, link.examples);
      return `<path class="jobs-sankey-link jobs-sankey-filter" d="M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}" fill="none" stroke="${esc(link.color)}" stroke-width="${esc(h)}" stroke-linecap="butt" data-jobs-stage-filter="${esc(link.filter || "all")}" data-sankey-from="${esc(link.from)}" data-sankey-to="${esc(link.to)}" data-sankey-tip="${tip}" />`;
    })
    .join("");

  const nodeMarkup = [...layout.values()]
    .map((node) => {
      const isFirst = node.col === 0;
      const isLast = node.col === maxCol;
      const isRound = typeof node.id === "string" && node.id.startsWith("round-");
      const isRejected = node.id === "rejected";
      const isAccepted = node.id === "accepted";
      // Round nodes (1st → 4th round) always label ABOVE the line so the red rejection
      // threads dropping below the chain never tangle with the names. Rejected and the
      // Accepted 🎉 terminus label to their RIGHT like sinks even when they sit mid-chart
      // — they're pinned off the live chain, so an above/below label would crash into it.
      const sideRight = (isLast || isRejected || isAccepted) && !isRound;
      const labelAbove =
        node.id === "awaiting" || node.id === "stale" || node.id === "ghosted" || isRound;
      const labelX = isFirst ? node.x - 8 : sideRight ? node.x + nodeW + 14 : node.x + nodeW / 2;
      const anchor = isFirst ? "end" : sideRight ? "start" : "middle";
      // Two-line label: name on top, (count) stacked underneath. Offset the block
      // so both lines clear the node bar (the count drops ~1.2em below the name).
      const labelY = labelAbove
        ? node.y - 26
        : isFirst || sideRight
          ? node.y + node.h / 2 - 4
          : node.y + node.h + 16;
      const labelClass = `jobs-sankey-node-label${isFirst ? " jobs-sankey-node-label--source" : ""}`;
      // Always center the (count) under the title, whatever the title's anchor is.
      // The first column right-aligns (anchor=end) and the last left-aligns
      // (anchor=start), so the count must be re-centered on the title's midpoint —
      // estimate the title width from its glyph count (source labels render at 13px).
      const approxCharW = isFirst ? 7.0 : 7.6;
      const titleW = String(node.label).length * approxCharW;
      const countX =
        anchor === "end" ? labelX - titleW / 2 : anchor === "start" ? labelX + titleW / 2 : labelX;
      const header = node.col === 0 ? "Source" : node.col === 1 ? "Heard back?" : "Furthest stage";
      const tip = sankeyTipPayload(`${node.label}: ${node.count}`, node.count);
      // Decay nodes (stale/ghosted) carry no inline label — the response column is
      // too tight to stack four labels — so they render as a bare colour segment
      // identified by the legend and hover tooltip.
      const labelMarkup = node.hideLabel
        ? ""
        : `<text class="${labelClass}" x="${esc(labelX)}" y="${esc(labelY)}" text-anchor="${anchor}">${esc(node.label)}<tspan x="${esc(countX)}" dy="1.2em" text-anchor="middle">(${esc(node.count)})</tspan></text>`;
      return `
        <g class="jobs-sankey-node jobs-sankey-filter" data-jobs-stage-filter="${esc(node.filter || "all")}" data-sankey-node-id="${esc(node.id)}" data-sankey-tip="${tip}">
          <rect x="${esc(node.x)}" y="${esc(node.y)}" width="${nodeW}" height="${esc(node.h)}" rx="2" fill="${esc(node.color)}" />
          ${labelMarkup}
          <title>${esc(header)} · ${esc(node.label)} ${esc(node.count)}</title>
        </g>`;
    })
    .join("");

  const legend = sankey.nodes
    // Response column stays out of the legend (it has inline labels), but the
    // unlabelled decay exits need a swatch to be identifiable.
    .filter((node) => node.col !== 1 || node.id === "stale" || node.id === "ghosted")
    .map(
      (node) =>
        `<span class="jobs-sankey-legend-item" data-sankey-legend-id="${esc(node.id)}"><i style="background:${esc(node.color)}"></i>${esc(node.label)}</span>`
    )
    .join("");
  // The funnel SVG always scales to fit the frame (preserveAspectRatio meet), so it
  // never overflows — no horizontal scroll affordance is needed even at full depth.
  return `
    <div class="jobs-sankey-wrap">
      <div class="jobs-sankey-frame">
        <svg class="jobs-sankey" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Jobs Sankey funnel">
          <g class="jobs-sankey-links">${paths}</g>
          <g class="jobs-sankey-nodes">${nodeMarkup}</g>
        </svg>
      </div>
      <div class="jobs-sankey-legend">${legend}</div>
    </div>`;
}

function tooltipPayload(row) {
  return esc(JSON.stringify(row.tooltip));
}

// Per-icon tooltip: hovering a compact icon cell swaps the shared tooltip to
// explain what that icon means (the row's company/role tip shows everywhere else).
function iconTipPayload(label, meaning) {
  return esc(JSON.stringify({ icon: label, meaning: meaning || "" }));
}

// A quiet application that's drifted past the stale/ghosted line reads its decay in
// the status pill, not just the action column — so the pill says "Going stale" /
// "Ghosted" instead of a plain "Applied". staleAction only ever fires on awaiting
// (pre-screen) applications, so this never masks a real pipeline stage.
function statusDisplayLabel(row) {
  if (row.ghosted) return "Ghosted";
  if (row.stale) return "Going stale";
  return row.stageGroupLabel || row.stageLabel;
}

// Decay reads as draining signal, not alarm colour: a neutral grey that lightens
// as the app rots — medium grey going stale, lighter grey once ghosted. Otherwise
// fall back to the normal stage colour (muted warm-grey for terminal rows).
function statusPillTone(row) {
  if (row.ghosted) return "#878d93";
  if (row.stale) return "#6f7479";
  return row.terminal ? "#8d7f73" : stageColor(row.stage);
}

function statusPillIcon(row) {
  if (row.ghosted) return "alert";
  if (row.stale) return "flag";
  return stageIcon(row);
}

function statusTitle(row) {
  const visible = statusDisplayLabel(row);
  return row.stageLabel && row.stageLabel !== visible ? `${visible} · ${row.stageLabel}` : visible;
}

function jobActionToneClass(action = {}) {
  if (action.tone === "error") return "jobs-action-label--error";
  if (action.tone === "warning") return "jobs-action-label--warning";
  if (action.tone === "success") return "jobs-action-label--success";
  return "jobs-action-label--neutral";
}

function jobActionIcon(action = {}) {
  if (action.state === "archived") return "check";
  if (action.state === "interview" || action.workstream === "prepare") return "calendar";
  if (action.state === "missing-comp") return "search";
  if (action.state === "ghosted") return "alert";
  if (action.state === "stale" || action.workstream === "plan") return "flag";
  if (action.state === "needs-action" || action.workstream === "respond") return "chat";
  if (action.state === "watch" || action.workstream === "watch") return "clock";
  if (action.state === "high-fit") return "flag";
  return "list";
}

function jobActionAttrs(row) {
  return [
    `data-action-state="${esc(row.actionState || "active")}"`,
    `data-workstream="${esc(row.workstream || "watch")}"`,
    `data-needs-action="${row.needsAction ? "1" : "0"}"`,
    `data-stale="${row.stale ? "1" : "0"}"`,
    `data-ghosted="${row.ghosted ? "1" : "0"}"`,
    `data-missing-comp="${row.missingComp ? "1" : "0"}"`,
    `data-high-fit="${row.highFit ? "1" : "0"}"`,
    `data-interview-path="${row.interviewPath ? "1" : "0"}"`,
  ].join(" ");
}

// The action column only earns ink when there's something to actually DO. Passive
// states — waiting on a reply, monitoring a quiet role, or an archived/closed row —
// are status, not a task, so they render an empty cell. ("Awaiting isn't an action.")
const PASSIVE_ACTION_STATES = new Set(["watch", "active", "archived", "high-fit"]);
function jobActionIsActionable(action = {}) {
  if (!action?.state) return false;
  if (action.workstream === "watch" || action.workstream === "archive") return false;
  return !PASSIVE_ACTION_STATES.has(action.state);
}

function renderJobsActionCell(row) {
  const action = row.action || defaultJobAction(row);
  if (!jobActionIsActionable(action)) return "";
  const label = action.label || "Review";
  const title = action.title || "Review role";
  const meta = action.meta || action.dueText || "Active";
  return `
        <div class="jobs-action-cell jobs-action-cell--icon" data-tip="${iconTipPayload(label, `${title} · ${meta}`)}" aria-label="${esc(`${label}: ${title}. ${meta}`)}">
          <span class="jobs-action-icon ${esc(jobActionToneClass(action))}" aria-hidden="true">
            ${inlineIcon(jobActionIcon(action), "jobs-action-icon-svg")}
          </span>
        </div>`;
}

function renderJobsExplorerRow(row) {
  const muted = row.terminal;
  const stageTone = statusPillTone(row);
  const sourceLabel = row.sourceLabel || titleCase(row.channel || row.source);
  const modeLabel = row.modeLabel || "TBD";
  const locationLabel = row.location || "Location TBD";
  const statusLabel = statusDisplayLabel(row);
  return `
    <tr data-jobs-row data-detail-id="${esc(row.drawerId)}" data-stage="${esc(row.stage)}" data-source-kind="${esc(row.source)}" data-source-bucket="${esc(row.sourceBucket)}" data-channel="${esc(String(row.channel || "").toLowerCase())}" data-source-label="${esc(sourceLabel.toLowerCase())}" data-terminal="${row.terminal ? "1" : "0"}" data-rounds-reached="${row.roundsReached || 0}" data-needs-review="${row.needsReview ? "1" : "0"}" ${jobActionAttrs(row)} data-search="${esc(row.searchText)}" data-company="${esc(row.company.toLowerCase())}" data-role="${esc(row.role.toLowerCase())}" data-location="${esc(locationLabel.toLowerCase())}" data-mode="${esc(row.mode || modeLabel.toLowerCase())}" data-fit="${esc(row.fit)}" data-base="${esc(row.compMidpointK || row.baseK)}" data-applied="${esc(row.appliedAt || row.appliedLabel)}" data-tip="${tooltipPayload(row)}">
      <td>
        <div class="jobs-company-cell">
          ${avatarMarkup(row.domain, row.company, row.initials, `jobs-avatar ${esc(row.avatarClass)}`, row.logo)}
          <span class="jobs-company-copy">
            <strong class="${muted ? "is-muted" : ""}">${esc(row.company)}</strong>
            <small>${esc(sourceLabel)}</small>
          </span>
        </div>
      </td>
      <td>
        <div class="jobs-role-cell">
          <strong>${esc(row.role)}</strong>
        </div>
      </td>
      <td class="jobs-cell-comp" data-tip="${iconTipPayload("Compensation", row.compSummary)}">
        <span class="jobs-comp-cell" aria-label="${esc(row.compSummary)}">
          <strong>${esc(row.compCompact || row.comp)}</strong>
        </span>
      </td>
      <td class="jobs-cell-mode" data-tip="${iconTipPayload("Work mode", modeLabel)}">
        <span class="jobs-mode-chip jobs-mode-icon-only" aria-label="${esc(modeLabel)}">
          ${inlineIcon(row.modeIcon || "navigation")}
        </span>
      </td>
      <td class="jobs-cell-fit" data-tip="${iconTipPayload(`Fit · ${fitLabel(row)}`, isTriageFit(row) ? "Triage estimate — not yet fully evaluated" : "Evaluated fit score")}">
        <span class="jobs-fit ${isTriageFit(row) ? "is-triage" : ""}" style="--jobs-fit-color:${esc(fitToneColor(row.fit))}" aria-label="${isTriageFit(row) ? "Triage estimate - not yet fully evaluated" : "Evaluated fit score"}">
          <span>${esc(fitLabel(row))}</span>
        </span>
      </td>
      <td class="jobs-cell-status" data-tip="${iconTipPayload("Status", statusTitle(row))}"><span class="jobs-stage-pill jobs-stage-icon-only" style="--jobs-stage-color:${esc(stageTone)}" aria-label="${esc(statusLabel)}">${inlineIcon(statusPillIcon(row), "jobs-stage-icon-svg")}</span></td>
      <td class="jobs-cell-action">
        ${renderJobsActionCell(row)}
      </td>
    </tr>`;
}

function renderJobsExplorerRows(rows) {
  return rows.map(renderJobsExplorerRow).join("");
}

function fitToneColor(fit) {
  if (fit >= 80) return "#2f9e8f";
  if (fit >= 70) return "#e0a93b";
  return "#8d7f73";
}

function renderJobsCards(rows) {
  return rows
    .map((row) => {
      const stageTone = statusPillTone(row);
      const modeLabel = row.modeLabel || "TBD";
      const locationLabel = row.location || "Location TBD";
      const sourceLabel = row.sourceLabel || titleCase(row.channel || row.source);
      const statusLabel = statusDisplayLabel(row);
      const statusHint = statusTitle(row);
      const action = row.action || defaultJobAction(row);
      return `
        <article class="jobs-card" data-jobs-card data-detail-id="${esc(row.drawerId)}" data-stage="${esc(row.stage)}" data-source-kind="${esc(row.source)}" data-source-bucket="${esc(row.sourceBucket)}" data-channel="${esc(String(row.channel || "").toLowerCase())}" data-source-label="${esc(sourceLabel.toLowerCase())}" data-terminal="${row.terminal ? "1" : "0"}" data-rounds-reached="${row.roundsReached || 0}" data-needs-review="${row.needsReview ? "1" : "0"}" ${jobActionAttrs(row)} data-search="${esc(row.searchText)}" data-company="${esc(row.company.toLowerCase())}" data-role="${esc(row.role.toLowerCase())}" data-mode="${esc(row.mode || modeLabel.toLowerCase())}" data-fit="${esc(row.fit)}" data-base="${esc(row.compMidpointK || row.baseK)}" data-applied="${esc(row.appliedAt || row.appliedLabel)}" data-tip="${tooltipPayload(row)}">
          ${
            jobActionIsActionable(action)
              ? `<div class="jobs-card-action">
            <span class="jobs-action-label ${esc(jobActionToneClass(action))}">${esc(action.label || "Review")}</span>
            <span>${esc(action.title || "Review role")}</span>
          </div>`
              : ""
          }
          <div class="jobs-card-top">
            ${avatarMarkup(row.domain, row.company, row.initials, `jobs-avatar ${esc(row.avatarClass)}`, row.logo)}
            <span class="jobs-stage-pill jobs-stage-has-icon" style="--jobs-stage-color:${esc(stageTone)}" aria-label="${esc(statusHint)}">${inlineIcon(statusPillIcon(row), "jobs-stage-icon-svg")}<span>${esc(statusLabel)}</span></span>
          </div>
          <div class="jobs-card-copy">
            <h3>${esc(row.role)}</h3>
            <p>${esc(row.company)}</p>
          </div>
          <div class="jobs-card-facts">
            <span><b>${esc(row.comp)}</b> <small>${row.tc ? `TC ${esc(row.tc)}` : "Comp"}</small></span>
            <span><b>${esc(locationLabel)}</b> <small>Location</small></span>
            <span><b>${esc(modeLabel)}</b> <small>Mode</small></span>
            <span class="jobs-card-fit-block">
              <span class="jobs-fit ${isTriageFit(row) ? "is-triage" : ""}" style="--jobs-fit-color:${esc(fitToneColor(row.fit))}" aria-label="${isTriageFit(row) ? "Triage estimate - not yet fully evaluated" : "Evaluated fit score"}"><span>${esc(fitLabel(row))}</span></span>
              <small>Fit</small>
            </span>
          </div>
          ${
            row.healthBadge
              ? `<div class="jobs-card-health"><span class="jobs-health-pill" data-health="${esc(row.healthBadge.rating)}" title="${esc(row.healthBadge.title)}">${inlineIcon("alert", "jobs-health-icon-svg")}<span>${esc(row.healthBadge.label)}</span></span></div>`
              : ""
          }
          ${
            row.statusNote || row.note
              ? `<p class="jobs-card-note">${esc(row.statusNote || firstSentence(row.note))}</p>`
              : ""
          }
          <div class="jobs-card-meta">
            <span class="jobs-source-chip">${inlineIcon(row.sourceIcon || "list")}<span>${esc(sourceLabel)}</span></span>
            <span class="jobs-card-date">${esc(row.appliedLabel)}</span>
          </div>
        </article>`;
    })
    .join("");
}

function registerJobDetails(rows) {
  if (typeof globalThis === "undefined") return;
  globalThis.rolesterJobDetails = Object.fromEntries(rows.map((row) => [row.drawerId, row.drawer]));
}

function setText(root, selector, value) {
  const el = root.querySelector(selector);
  if (el) el.textContent = String(value);
}

function setAllText(root, selector, value) {
  if (typeof root.querySelectorAll === "function") {
    for (const el of root.querySelectorAll(selector)) {
      el.textContent = String(value);
    }
    return;
  }
  setText(root, selector, value);
}

function renderModeStatus(root, modes) {
  const queryAll = (selector) => {
    if (typeof root.querySelectorAll === "function") {
      return Array.from(root.querySelectorAll(selector));
    }
    const el = root.querySelector(selector);
    return el ? [el] : [];
  };

  for (const [key, item] of [
    ["usage", modes.usage],
    ["application", modes.application],
  ]) {
    const displayKey = key === "application" ? "apply" : key;
    const chips = queryAll(`[data-mode-chip="${key}"]`);
    const values = queryAll(`[data-mode-value="${key}"]`);
    for (const value of values) {
      value.textContent = item.label;
    }
    for (const chip of chips) {
      chip.dataset.modeTone = item.tone;
      chip.title = item.title;
      chip.setAttribute("aria-label", `${displayKey} mode: ${item.label}. ${item.title}`);
    }
  }
}

function renderAgentGuidance(root, guidance) {
  const card = root.querySelector("[data-agent-guidance]");
  if (card) {
    card.hidden = false;
    card.dataset.nextSkill = guidance.nextSkill || "";
    card.dataset.command = guidance.command || "";
  }
  setText(root, "[data-agent-guidance-title]", guidance.title);
  setText(root, "[data-agent-guidance-message]", guidance.message);
  setText(root, "[data-agent-guidance-reason]", guidance.reason);
  const cta = root.querySelector("[data-agent-guidance-cta]");
  if (cta) {
    cta.textContent = guidance.ctaLabel;
    cta.dataset.agentGuidanceAction = guidance.nextSkill || guidance.command || "doctor";
    cta.title = guidance.nextSkill
      ? `Ask your agent to run ${guidance.nextSkill}.`
      : guidance.command || "Run careerrat doctor.";
  }
}

function renderSettingsList(items, emptyLabel = "Not set") {
  const values = listOrEmpty(items);
  if (values.length === 0) {
    return `<li class="settings-list-empty">${esc(emptyLabel)}</li>`;
  }
  return values.map((item) => `<li>${esc(item)}</li>`).join("");
}

function renderSettingsStatus(root, settings) {
  const values = {
    candidate: settings.profile.candidate,
    headline: settings.profile.headline,
    location: settings.profile.location,
    minimumBase: settings.profile.minimumBase,
    targetBase: settings.profile.targetBase,
    expectedBase: settings.profile.expectedBase,
    workAuthorization: settings.profile.workAuthorization,
    sessionProvider: settings.automation.sessionProvider,
  };

  for (const [key, value] of Object.entries(values)) {
    setText(root, `[data-settings-value="${key}"]`, value);
  }

  const roles = root.querySelector("[data-settings-roles]");
  if (roles)
    roles.innerHTML = renderSettingsList(
      settings.targeting.primaryRoles,
      "No primary roles configured"
    );

  const excluded = root.querySelector("[data-settings-excluded]");
  if (excluded) {
    excluded.innerHTML = renderSettingsList(
      settings.targeting.excludedCompanies,
      "No company exclusions configured"
    );
  }

  const boundaries = root.querySelector("[data-settings-boundaries]");
  if (boundaries) {
    boundaries.innerHTML = renderSettingsList(
      settings.honesty.boundaries,
      "No extra honesty boundaries configured"
    );
  }

  const capabilities = root.querySelector("[data-settings-capabilities]");
  if (capabilities) {
    capabilities.innerHTML = renderSettingsList(
      settings.automation.enabledCapabilities,
      "No automation capabilities enabled"
    );
  }

  const files = root.querySelector("[data-settings-files]");
  if (files)
    files.innerHTML = renderSettingsList(settings.files, "No candidate config files found");
}

function renderNetworkContacts(contacts) {
  const values = objectList(contacts);
  if (!values.length) {
    return `
      <div class="network-contact-node">
        <span class="network-contact-pill">Signal</span>
        <div><b>No named contact</b><span>Relationship details will appear after a human thread is captured.</span></div>
      </div>`;
  }
  return values
    .map(
      (contact) => `
        <div class="network-contact-node">
          <span class="network-contact-pill">${esc(contact.type || "Contact")}</span>
          <div><b>${esc(contact.name || "Contact")}</b><span>${esc(contact.note || "Relationship context captured.")}</span></div>
        </div>`
    )
    .join("");
}

function renderNetworkCompanies(companies) {
  const values = objectList(companies);
  if (!values.length) {
    return `
      <article class="network-company-card">
        <div class="network-company-head">
          <div class="network-company-copy">
            <b>No warm paths yet</b>
            <span>Human recruiter and hiring-team threads will appear here once captured.</span>
          </div>
        </div>
        <div class="network-reuse-panel" data-reuse-state="closed">
          <b>Relationship map empty</b>
          <span>Portal-only applications are intentionally excluded from warm-path reuse.</span>
        </div>
      </article>`;
  }
  return values
    .map((company) => {
      // The card reads as a clean header by default (logo + name); the contacts and
      // safe-reuse panel — the dense blue chrome — live in a collapsed body the user
      // expands on demand (see "so much blue" cleanup).
      return `
        <article class="network-company-card" data-reuse-state="${esc(company.reuseState)}">
          <button type="button" class="network-company-head" data-network-toggle aria-expanded="false">
            ${avatarMarkup(company.domain, company.company, company.initials, "network-company-logo")}
            <div class="network-company-copy">
              <b>${esc(company.company)}</b>
              <span>${esc(company.role)} · ${esc(company.status)}</span>
            </div>
            <span class="network-state-pill" data-reuse-state="${esc(company.reuseState)}" style="--network-tone:${esc(company.progressTone)}">${esc(company.stateLabel)}</span>
            <svg class="network-company-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          <div class="network-company-body" data-network-body hidden>
            <div class="network-contact-stack">
              ${renderNetworkContacts(company.contacts)}
            </div>
            <div class="network-reuse-panel" data-reuse-state="${esc(company.reuseState)}">
              <b>${esc(company.reuseTitle)}</b>
              <span>${esc(company.reuseBody)}</span>
              <div class="network-reuse-meta">
                <span>${esc(company.reuseScope)}</span>
                <span>Next safe touch</span>
                <span>${esc(company.nextTouch)}</span>
              </div>
            </div>
          </div>
        </article>`;
    })
    .join("");
}

function renderNetworkCoverage(coverage) {
  return `
    <div class="network-mini-stat"><strong>${esc(coverage.recruiters || 0)}</strong><span>Recruiters</span></div>
    <div class="network-mini-stat"><strong>${esc(coverage.hiringManagers || 0)}</strong><span>HM</span></div>
    <div class="network-mini-stat"><strong>${esc(coverage.signals || 0)}</strong><span>Signals</span></div>`;
}

function renderNetworkList(items, tones = ["var(--coral)", "var(--sky)", "var(--mustard)"]) {
  return listOrEmpty(items)
    .map(
      (item, index) =>
        `<li style="--network-tone:${tones[index % tones.length]}"><i></i><span>${esc(item)}</span></li>`
    )
    .join("");
}

function renderNetworkLeadReview(leads = []) {
  const rows = objectList(leads);
  if (!rows.length) {
    return '<div class="network-empty-row">No relationship leads waiting for review.</div>';
  }
  return rows
    .map(
      (lead) => `
        <div class="network-sourcing-row">
          <span class="network-signal-pill" data-state="signal">${esc(lead.label || "Review lead")}</span>
          <div class="network-signal-copy">
            <b>${esc(lead.name)}</b>
            <span>${esc(lead.company)} · ${esc(lead.title || lead.type || "Contact")}</span>
          </div>
          <div class="network-signal-meta">
            <span>${esc(lead.platform || "linkedin")}</span>
            <span>${esc(lead.note || "Review before outreach.")}</span>
          </div>
        </div>`
    )
    .join("");
}

function renderNetworkSourcingTargets(targets = []) {
  const rows = objectList(targets);
  if (!rows.length) {
    return '<div class="network-empty-row">No unconnected active rows need relationship sourcing.</div>';
  }
  return rows
    .map(
      (target) => `
        <div class="network-sourcing-row">
          <span class="network-signal-pill" data-state="ask">${esc(target.label || "Search contact path")}</span>
          <div class="network-signal-copy">
            <b>${esc(target.company)}</b>
            <span>${esc(target.role)} · ${esc(target.fit)} fit</span>
          </div>
          <div class="network-signal-meta">
            <span>${esc(target.capability || "relationship_sourcing")}</span>
            <span>${esc(target.summary || "Find a reviewed relationship path first.")}</span>
          </div>
        </div>`
    )
    .join("");
}

function renderLibraryFilters(items) {
  const values = objectList(items);
  if (!values.length)
    return `<button type="button" class="library-chip" disabled><span>No tags</span><b>0</b></button>`;
  return values
    .map(
      (item) =>
        `<button type="button" class="library-chip" data-library-tag="${esc(item.label)}"><span>${esc(item.label)}</span><b>${esc(item.count)}</b></button>`
    )
    .join("");
}

function renderLibraryTags(tags) {
  return objectList(tags)
    .map((tagItem) => {
      const tone =
        tagItem.tone && tagItem.tone !== "teal" ? ` data-tone="${esc(tagItem.tone)}"` : "";
      return `<span class="library-tag"${tone}>${esc(tagItem.label)}</span>`;
    })
    .join("");
}

function renderLibraryClaimCard(card) {
  const kind = card.kind || "evidence";
  const label = card.label || "Evidence Library";
  const title = card.title || "Reusable material";
  const summary = card.summary || "";
  const note = card.note || "Use with the confirmed evidence boundary.";
  const tagLabels = objectList(card.tags)
    .map((tagItem) => tagItem.label)
    .filter(Boolean)
    .join(", ");
  return `
        <article class="library-card" data-library-card="${esc(kind)}" data-library-claim data-claim-type="${esc(kind)}" data-claim-title="${esc(title)}" data-claim-label="${esc(label)}" data-claim-summary="${esc(summary)}" data-claim-note="${esc(note)}" data-claim-tags="${esc(tagLabels)}" role="button" tabindex="0" aria-label="Open ${esc(title)}">
          <div class="library-card-top">
            <div class="library-card-copy">
              <span class="library-card-label">${esc(label)}</span>
              <b>${esc(title)}</b>
              <span>${esc(summary)}</span>
            </div>
          </div>
          <div class="library-tag-row">
            ${renderLibraryTags(card.tags)}
          </div>
          <p class="library-card-note">${esc(note)}</p>
        </article>`;
}

function renderLibraryGapCallouts(items) {
  return objectList(items)
    .map((item) => {
      const tone = item.tone ? `var(--${esc(item.tone)})` : "var(--coral)";
      const title = item.title || "Claim gap";
      const body = item.body || "";
      return `
        <div class="library-callout-row" style="--library-tone:${tone}"><i></i><span><b>${esc(title)}</b> — ${esc(body)}</span></div>`;
    })
    .join("");
}

function renderLibraryCards(cards) {
  const values = objectList(cards);
  if (!values.length) {
    return `
      <article class="library-card" data-library-card="empty">
        <div class="library-card-top">
          <div class="library-card-copy">
            <span class="library-card-label">Evidence Library</span>
            <b>No reusable material yet</b>
            <span>Add evidence, stories, or writing style to populate this surface.</span>
          </div>
        </div>
      </article>`;
  }
  return values.map((card) => renderLibraryClaimCard(card)).join("");
}

function renderStrategyRows(rows, emptyLabel) {
  const values = objectList(rows);
  if (!values.length) {
    return `<div class="strategy-empty-row">${esc(emptyLabel)}</div>`;
  }
  return values
    .map(
      (row) => `
        <div class="strategy-row" style="--strategy-width:${esc(row.bar || 8)}%">
          <div class="strategy-row-copy">
            <b>${esc(row.label)}</b>
            <span>${esc(row.meta || `${row.total || 0} tracked`)}</span>
          </div>
          <span class="strategy-row-rate">${esc(row.rate || "0%")}</span>
          <i aria-hidden="true"><b></b></i>
        </div>`
    )
    .join("");
}

function renderStrategyStaleRows(rows) {
  const values = objectList(rows);
  if (!values.length) {
    return `<div class="strategy-empty-row">No quiet active applications.</div>`;
  }
  return values
    .map(
      (row) => `
        <button type="button" class="strategy-stale-row" data-detail-id="${esc(row.detailId || "")}" data-next-step-item>
          <span>
            <b>${esc(row.title)}</b>
            <small>${esc(row.meta)}</small>
          </span>
          <em>${esc(row.stage || "Applied")}</em>
        </button>`
    )
    .join("");
}

function renderStrategyStageRows(rows) {
  const values = objectList(rows);
  if (!values.length) {
    return `<div class="strategy-empty-row">No active stage age yet.</div>`;
  }
  return values
    .map(
      (row) => `
        <button type="button" class="strategy-stage-row" style="--strategy-width:${esc(row.bar || 8)}%" data-detail-id="${esc(row.detailId || "")}" data-next-step-item>
          <span>
            <b>${esc(row.title)}</b>
            <small>${esc(row.meta)}</small>
          </span>
          <em>${esc(row.rate || `${row.daysInStage || 0}d`)}</em>
          <i aria-hidden="true"><b></b></i>
        </button>`
    )
    .join("");
}

function renderStrategyCadenceRows(rows) {
  const values = objectList(rows);
  if (!values.length) {
    return `<div class="strategy-empty-row">No cadence nudges right now.</div>`;
  }
  return values
    .map(
      (row) => `
        <button type="button" class="strategy-cadence-row" data-tone="${esc(row.tone || "quiet")}" data-detail-id="${esc(row.detailId || "")}" data-next-step-item>
          <span>
            <b>${esc(row.title)}</b>
            <small>${esc(row.meta)}</small>
          </span>
          <em>${esc(row.badge || "Plan")}</em>
        </button>`
    )
    .join("");
}

const STRATEGY_TONE_FILLS = {
  neutral: "bg-secondary",
  positive: "bg-on-tertiary-container",
  warning: "bg-outline",
};

function renderStrategyTrendRows(rows) {
  const values = objectList(rows);
  if (!values.length) {
    return `<div class="strategy-empty-row">No outcome trend yet.</div>`;
  }
  // Applied → Advanced → Interviews → Rejected is a natural funnel. Render it as
  // horizontal bars scaled to the largest bucket (Applied), so the drop-off and
  // attrition read at a glance instead of four equal-weight number cards.
  const peak = Math.max(1, ...values.map((row) => Number(row.value) || 0));
  return values
    .map((row) => {
      const count = Number(row.value) || 0;
      const pct = Math.round((count / peak) * 100);
      const fill = STRATEGY_TONE_FILLS[row.tone] || STRATEGY_TONE_FILLS.neutral;
      // Applied's deltaLabel is "N roles" (redundant with the count); only show the
      // delta when it's a conversion/attrition percentage.
      const showDelta = /%/.test(row.deltaLabel || "");
      return `
        <div class="grid grid-cols-[88px_minmax(0,1fr)_auto] items-center gap-3" title="${esc(row.meta || "")}">
          <span class="font-label-caps text-label-caps text-outline uppercase">${esc(row.label)}</span>
          <div class="h-2.5 overflow-hidden rounded-full bg-surface-container-high">
            <div class="h-full rounded-full ${fill}" style="width:${pct}%"></div>
          </div>
          <span class="flex items-baseline justify-end gap-1.5 tabular-nums">
            <b class="font-data-mono text-[18px] leading-none font-[300] text-primary">${esc(count)}</b>
            ${showDelta ? `<em class="text-[11px] not-italic text-on-surface-variant">${esc(row.deltaLabel)}</em>` : ""}
          </span>
        </div>`;
    })
    .join("");
}

function renderStrategyHistoryRows(rows) {
  const values = objectList(rows);
  if (!values.length) {
    return `<div class="strategy-empty-row">No dated outcomes yet.</div>`;
  }
  return values
    .map(
      (row) => `
        <div class="strategy-history-row">
          <span>
            <b>${esc(row.label)}</b>
            <small>${esc(row.applied || 0)} applied · ${esc(row.advanced || 0)} advanced · ${esc(row.rejected || 0)} rejected</small>
          </span>
          <em>${esc(row.responseRate || 0)}%</em>
        </div>`
    )
    .join("");
}

function renderStrategyLearningSignals(rows) {
  const values = objectList(rows);
  if (!values.length) {
    return `<div class="strategy-empty-row">No winning source or role-family signal yet.</div>`;
  }
  return values
    .map(
      (row) => `
        <div class="strategy-signal-row" data-tone="${esc(row.tone || "neutral")}">
          <span>
            <b>${esc(row.label)}</b>
            <small>${esc(row.meta)}</small>
          </span>
          <em>${esc(row.value || 0)}</em>
        </div>`
    )
    .join("");
}

// Renders a compact one-line reevaluation progress footer inside the review
// panel. Uses inline styles that match the shell's existing CSS token set
// (--rgb-line, --ink-soft, #e0a93b warning amber) so no new CSS is needed.
// Returns "" when reevaluation is null/absent — callers can safely concat it.
function renderReevaluationProgress(reevaluation) {
  if (!reevaluation) return "";
  const { label, due, familyLines = [] } = reevaluation;
  const labelColor = due ? "#e0a93b" : "var(--ink-soft)";
  const chips = familyLines
    .slice(0, 3)
    .map(
      (f) =>
        `<span style="font-size:11px;font-weight:750;color:${f.over ? "#e0a93b" : "var(--ink-soft)"};white-space:nowrap">${esc(f.family)} ${esc(String(f.count))}/${esc(String(f.threshold))}</span>`
    )
    .join("");
  return `<div style="grid-column:1/-1;border-top:1px solid rgba(var(--rgb-line),0.08);padding-top:8px;display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px"><span style="font-size:12px;font-weight:650;color:${labelColor}">${esc(label)}</span>${chips}</div>`;
}

function renderStrategyReviewTrigger(trigger = {}, reevaluation) {
  const action = trigger.ctaAction || "jobs";
  const ctaLabel = trigger.ctaLabel || "Review details";
  return `
    <div class="strategy-review-panel" data-ready="${trigger.ready ? "true" : "false"}">
      <span>${esc(trigger.ready ? "Review ready" : "Collecting signal")}</span>
      <div>
        <b>${esc(trigger.title || "Learning signal still forming")}</b>
        <p>${esc(trigger.summary || "Keep collecting comparable outcomes before retuning gates.")}</p>
      </div>
      <a class="strategy-review-cta" href="#${esc(action)}">${esc(ctaLabel)}</a>${renderReevaluationProgress(reevaluation)}
    </div>`;
}

function renderStrategyRecommendation(recommendation = {}) {
  const action = recommendation.ctaAction || "";
  const ctaLabel = recommendation.ctaLabel || "";
  const cta =
    ctaLabel && action === "actions"
      ? `<button type="button" class="strategy-recommendation-cta" data-strategy-recommendation-cta onclick="openActionsDrawer()">${esc(ctaLabel)}</button>`
      : ctaLabel
        ? `<a class="strategy-recommendation-cta" data-strategy-recommendation-cta href="#${esc(action || "jobs")}">${esc(ctaLabel)}</a>`
        : "";
  return `
    <div class="strategy-recommendation-copy">
      <div class="strategy-recommendation-title">${esc(recommendation.title || "Build a measurable loop")}</div>
      <p>${esc(
        recommendation.summary ||
          "No applied outcomes are available yet. Source and track a few comparable roles first."
      )}</p>
    </div>
    ${cta}`;
}

function renderStrategyInsights(root, strategy) {
  if (!strategy) return;
  setText(root, '[data-strategy-metric="topSource"]', strategy.metrics.topSource.label);
  setText(root, '[data-strategy-metric="bestLane"]', strategy.metrics.bestLane.label);
  setText(root, '[data-strategy-metric="staleCount"]', strategy.metrics.staleCount.value);
  setText(root, '[data-strategy-metric-detail="topSource"]', strategy.metrics.topSource.rate);
  setText(root, '[data-strategy-metric-detail="bestLane"]', strategy.metrics.bestLane.rate);
  setText(root, '[data-strategy-metric-detail="staleCount"]', strategy.metrics.staleCount.rate);

  const sources = root.querySelector("[data-strategy-source-list]");
  if (sources) sources.innerHTML = renderStrategyRows(strategy.sources, "No source outcomes yet.");
  const roles = root.querySelector("[data-strategy-role-list]");
  if (roles) roles.innerHTML = renderStrategyRows(strategy.roles, "No role-lane outcomes yet.");
  const fits = root.querySelector("[data-strategy-fit-list]");
  if (fits) fits.innerHTML = renderStrategyRows(strategy.fitBands, "No fit-band outcomes yet.");
  const stale = root.querySelector("[data-strategy-stale-list]");
  if (stale) stale.innerHTML = renderStrategyStaleRows(strategy.stale);
  const stages = root.querySelector("[data-strategy-stage-list]");
  if (stages) stages.innerHTML = renderStrategyStageRows(strategy.stageAges);
  const cadence = root.querySelector("[data-strategy-cadence-list]");
  if (cadence) cadence.innerHTML = renderStrategyCadenceRows(strategy.cadence);
  const trends = root.querySelector("[data-strategy-trend-list]");
  if (trends) trends.innerHTML = renderStrategyTrendRows(strategy.learning?.trends);
  const history = root.querySelector("[data-strategy-history-list]");
  if (history) history.innerHTML = renderStrategyHistoryRows(strategy.learning?.history);
  const signals = root.querySelector("[data-strategy-learning-signals]");
  if (signals) signals.innerHTML = renderStrategyLearningSignals(strategy.learning?.signals);
  const trigger = root.querySelector("[data-strategy-review-trigger]");
  if (trigger)
    trigger.innerHTML = renderStrategyReviewTrigger(
      strategy.learning?.reviewTrigger,
      strategy.learning?.reevaluation
    );
  const recommendation = root.querySelector("[data-strategy-recommendation]");
  if (recommendation)
    recommendation.innerHTML = renderStrategyRecommendation(strategy.recommendation);
}

function renderCalendarExportControls(event, { compact = false } = {}) {
  if (!event?.export) return "";
  const compactClass = compact ? " calendar-export-row--compact" : "";
  return `
    <div class="calendar-export-row${compactClass}" aria-label="Calendar export options">
      <button type="button" class="calendar-export-link" data-calendar-download-event data-calendar-export-id="${esc(event.id || "")}">.ics</button>
      <a class="calendar-export-link" href="${esc(event.export.googleUrl)}" target="_blank" rel="noreferrer" data-calendar-google-link>Google</a>
      <a class="calendar-export-link" href="${esc(event.export.outlookUrl)}" target="_blank" rel="noreferrer" data-calendar-outlook-link>Outlook</a>
    </div>`;
}

function renderCalendarEvent(event) {
  // Opaque busy blocks are non-interactive context — no detail link, no export.
  if (event.kind === "busy") {
    return `
    <div class="calendar-event calendar-event--busy" data-kind="busy">
      <b>${esc(event.title || "Busy")}</b>
      <small>${esc(event.meta || "")}</small>
    </div>`;
  }
  const detailAttrs = event.detailId
    ? ` data-next-step-item data-detail-id="${esc(event.detailId)}"`
    : "";
  return `
    <article class="calendar-event${event.done ? " calendar-event--done" : ""}" data-kind="${esc(event.kind || "deadline")}"${event.done ? ' data-done="true"' : ""} data-calendar-export-id="${esc(event.id || "")}">
      <button type="button" class="calendar-event-main"${detailAttrs}>
        <b>${esc(event.title)}</b>
        <small>${esc(event.meta)}</small>
      </button>
      ${renderCalendarExportControls(event)}
    </article>`;
}

function renderCalendarDay(day) {
  const state = day.state ? ` data-calendar-day-state="${esc(day.state)}"` : "";
  const events = day.events?.length
    ? day.events.map(renderCalendarEvent).join("")
    : '<div class="calendar-event calendar-event-empty"><b>Open block</b><small>No tracked item</small></div>';
  return `
    <article class="calendar-day-card" data-calendar-date="${esc(day.iso)}"${state}>
      <div class="calendar-day-head"><span>${esc(day.dow)}</span><strong>${esc(day.date)}</strong></div>
      ${events}
    </article>`;
}

function renderCalendarNextUp(item = {}) {
  const detailAttrs = item.detailId
    ? ` data-next-step-item data-detail-id="${esc(item.detailId)}"`
    : "";
  return `
    <div class="calendar-rail-head">
      <strong>Next up</strong>
      <span>${esc(item.label || calendarKindLabel(item.kind))}</span>
    </div>
    <div>
      <div class="calendar-dossier-title">${esc(item.title || "No dated action")}</div>
      <p class="calendar-dossier-note mt-3">${esc(item.note || "No dated item is waiting in this week.")}</p>
    </div>
    <div class="calendar-action-row">
      <span>${esc(item.meta || "Calendar clear")}</span>
      <button type="button" class="focus-card-cta w-fit"${detailAttrs}>${esc(item.cta || "Review jobs")}</button>
    </div>
    ${renderCalendarExportControls(item, { compact: true })}`;
}

function renderCalendarLoops(loops = []) {
  const rows = objectList(loops);
  const body = rows.length
    ? rows
        .map((item) => {
          const when = [formatDateShort(item.iso, ""), item.time].filter(Boolean).join(" · ");
          return `
    <button type="button" class="grid grid-cols-[1fr_auto] gap-3 px-3 py-3 text-left" data-next-step-item data-detail-id="${esc(item.detailId || "")}">
      <span class="flex flex-col leading-tight">
        <span class="font-bold text-primary text-[13px]">${esc(item.title)}</span>
        ${when ? `<span class="font-bold text-on-surface-variant text-[11px] tabular-nums">${esc(when)}</span>` : ""}
      </span>
      <span class="calendar-kind-pill" data-kind="${esc(item.kind)}">${esc(item.label || calendarKindLabel(item.kind))}</span>
    </button>`;
        })
        .join("")
    : '<div class="px-3 py-3 text-[12px] font-bold text-on-surface-variant">No dated open loops this week.</div>';
  return `
    <div class="calendar-rail-head">
      <strong>Open loops</strong>
      <span>${esc(rows.length)} due</span>
    </div>
    <div class="dashboard-zebra">${body}</div>`;
}

function renderCalendarMonthGrid(month = {}) {
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    .map((label) => `<div class="calendar-month-label">${label}</div>`)
    .join("");
  const cells = objectList(month.days)
    .map((day, index) => {
      const classes = ["calendar-month-cell"];
      // Render-applied checkerboard band (was nth-child(odd) — child #(8+index),
      // odd when index is odd) so the inline week-expansion row can't shift it.
      if (index % 2 === 1) classes.push("is-band");
      if (day.muted) classes.push("is-muted");
      if (day.isToday) classes.push("is-today");
      if (day.monthLabel) classes.push("is-month-start");
      const eventCount = objectList(day.events).length;
      if (eventCount) classes.push("has-events");
      const state = day.state ? ` data-calendar-day-state="${esc(day.state)}"` : "";
      const dots = objectList(day.events)
        .slice(0, 4)
        .map((event) => `<i class="calendar-dot" data-kind="${esc(event.kind)}"></i>`)
        .join("");
      const dateMarkup = day.monthLabel
        ? `<strong><span class="calendar-month-tag">${esc(day.monthLabel)}</span>${esc(day.date)}</strong>`
        : `<strong>${esc(day.date)}</strong>`;
      return `<button type="button" class="${classes.join(" ")}" data-calendar-date="${esc(day.iso)}" data-calendar-month-day${state}>${dateMarkup}${dots ? `<span class="calendar-dot-row">${dots}</span>` : ""}</button>`;
    })
    .join("");
  return labels + cells;
}

function renderCalendarTodayList(today = {}) {
  const rows = objectList(today.events);
  if (!rows.length) {
    return '<div class="px-3 py-3 text-[12px] font-bold text-on-surface-variant">No tracked item due today.</div>';
  }
  return rows
    .map(
      (event) => `
    <button type="button" class="grid grid-cols-[1fr_auto] gap-3 px-3 py-3 text-left" data-next-step-item data-detail-id="${esc(event.detailId || "")}">
      <span class="flex flex-col leading-tight">
        <span class="font-bold text-primary text-[13px]">${esc(event.title)}</span>
        ${event.time ? `<span class="font-bold text-on-surface-variant text-[11px] tabular-nums">${esc(event.time)}</span>` : ""}
      </span>
      <span class="calendar-kind-pill" data-kind="${esc(event.kind)}">${esc(event.label || calendarKindLabel(event.kind))}</span>
    </button>`
    )
    .join("");
}

function renderUpcomingList(upcoming = {}) {
  const rows = objectList(upcoming.events);
  if (!rows.length) {
    return '<div class="px-3 py-3 text-[12px] font-bold text-on-surface-variant">Nothing upcoming.</div>';
  }
  return rows
    .map(
      (event) => `
    <button type="button" class="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3 text-left" data-kind="${esc(event.kind)}" data-next-step-item data-detail-id="${esc(event.detailId || "")}">
      <span class="flex flex-col text-on-surface-variant text-[12px] tabular-nums leading-tight">
        <span class="font-bold">${esc(formatDateShort(event.iso, ""))}</span>
        ${event.time ? `<span class="text-[11px] opacity-80">${esc(event.time)}</span>` : ""}
      </span>
      <span class="font-bold text-primary text-[13px]">${esc(event.title)}</span>
      <span class="calendar-kind-pill" data-kind="${esc(event.kind)}">${esc(event.label || calendarKindLabel(event.kind))}</span>
    </button>`
    )
    .join("");
}

function renderCalendarWeekStats(stats = {}) {
  return `
    <div class="calendar-mini-stat"><strong>${esc(stats.interviews || 0)}</strong><span>Interviews</span></div>
    <div class="calendar-mini-stat"><strong>${esc(stats.replies || 0)}</strong><span>Replies</span></div>
    <div class="calendar-mini-stat"><strong>${esc(stats.deadlines || 0)}</strong><span>Due</span></div>`;
}

function renderCalendarProtectedPrep(prep = {}) {
  const detailAttrs = prep.detailId
    ? ` data-next-step-item data-detail-id="${esc(prep.detailId)}"`
    : "";
  return `
    <div class="calendar-rail-head">
      <strong>Protected prep</strong>
      <span>${esc(prep.label || "Next")}</span>
    </div>
    <p class="calendar-dossier-note">${esc(prep.note || "No dated prep item is waiting.")}</p>
    <button type="button" class="focus-card-cta w-fit"${detailAttrs}>${esc(prep.cta || "Review jobs")}</button>`;
}

function renderCalendarSyncProviders(sync = {}) {
  return objectList(sync.providers)
    .map(
      (provider) => `
    <div class="calendar-sync-provider" data-calendar-sync-provider="${esc(provider.key)}">
      <div>
        <b>${esc(provider.label)}</b>
        <small>${esc(provider.channel)} · ${esc(provider.key)}</small>
      </div>
      <span>${esc(provider.status || "Consent gated")}</span>
    </div>`
    )
    .join("");
}

function renderCalendarSyncHistory(sync = {}) {
  const rows = objectList(sync.history);
  if (!rows.length) {
    return '<div class="calendar-sync-empty">No calendar writes yet.</div>';
  }
  return rows
    .map(
      (write) => `
    <div class="calendar-sync-history-row" data-calendar-sync-write="${esc(write.id)}">
      <div>
        <b>${esc(write.title)}</b>
        <small>${esc(write.providerLabel)} · ${esc(write.atLabel)}</small>
      </div>
      <span>${esc(write.statusLabel)}</span>
    </div>`
    )
    .join("");
}

function renderCalendarDom(root, calendar, { weekIndex = calendar.currentWeekIndex || 0 } = {}) {
  if (!root || !calendar) return;
  const weeks = objectList(calendar.weeks);
  const safeWeekIndex = Math.max(0, Math.min(weekIndex, Math.max(0, weeks.length - 1)));
  const week = weeks[safeWeekIndex] || {};

  setText(root, '[data-calendar-stat="thisWeek"]', calendar.metrics?.thisWeek || 0);
  setText(root, '[data-calendar-stat="interviews"]', calendar.metrics?.interviews || 0);
  setText(root, '[data-calendar-stat="dueToday"]', calendar.metrics?.dueToday || 0);
  setAllText(root, "[data-calendar-week-label]", week.label || "No week");
  setText(root, "[data-calendar-month-title]", calendar.month?.title || "Calendar");
  setText(root, "[data-calendar-month-count]", calendar.month?.countLabel || "0 tracked");
  setText(root, "[data-calendar-today-label]", calendar.today?.label || "Today");

  const weekBoard = root.querySelector("[data-calendar-week-board]");
  if (weekBoard) weekBoard.innerHTML = objectList(week.days).map(renderCalendarDay).join("");
  const nextUp = root.querySelector("[data-calendar-next-up]");
  if (nextUp) nextUp.innerHTML = renderCalendarNextUp(week.nextUp);
  const openLoops = root.querySelector("[data-calendar-open-loops]");
  if (openLoops) openLoops.innerHTML = renderCalendarLoops(week.loops);
  const monthGrid = root.querySelector("[data-calendar-month-grid]");
  if (monthGrid) monthGrid.innerHTML = renderCalendarMonthGrid(calendar.month);
  const todayList = root.querySelector("[data-calendar-today-list]");
  if (todayList) todayList.innerHTML = renderCalendarTodayList(calendar.today);
  const weekStats = root.querySelector("[data-calendar-this-week-stats]");
  if (weekStats) weekStats.innerHTML = renderCalendarWeekStats(week.stats);
  const protectedPrep = root.querySelector("[data-calendar-protected-prep]");
  if (protectedPrep) protectedPrep.innerHTML = renderCalendarProtectedPrep(calendar.protectedPrep);
  const syncProviders = root.querySelector("[data-calendar-sync-providers]");
  if (syncProviders) syncProviders.innerHTML = renderCalendarSyncProviders(calendar.sync);
  const syncHistory = root.querySelector("[data-calendar-sync-history]");
  if (syncHistory) syncHistory.innerHTML = renderCalendarSyncHistory(calendar.sync);

  const prev = root.querySelector("[data-calendar-prev-week]");
  if (prev) prev.disabled = safeWeekIndex === 0;
  const next = root.querySelector("[data-calendar-next-week]");
  if (next) next.disabled = safeWeekIndex >= weeks.length - 1;
}

function renderCalendarStatus(root, calendar) {
  renderCalendarDom(root, calendar);
  if (typeof globalThis === "undefined") return;
  globalThis.rolesterCalendarViewModel = calendar;
  globalThis.rolesterCalendarRender = (state = {}) =>
    renderCalendarDom(state.root || globalThis.document, calendar, state);
  if (typeof globalThis.updateCalendarWorkbench === "function") {
    globalThis.updateCalendarWorkbench(calendar);
  }
}

function renderNetworkStatus(root, network) {
  setText(root, '[data-network-stat="warmPaths"]', network.metrics.warmPaths);
  setText(root, '[data-network-stat="companies"]', network.metrics.companies);
  setText(root, '[data-network-stat="dormant"]', network.metrics.dormant);

  const companyGrid = root.querySelector("[data-network-company-grid]");
  if (companyGrid) companyGrid.innerHTML = renderNetworkCompanies(network.companies);
  const coverage = root.querySelector("[data-network-coverage]");
  if (coverage) coverage.innerHTML = renderNetworkCoverage(network.coverage);
  const gaps = root.querySelector("[data-network-gaps]");
  if (gaps) gaps.innerHTML = renderNetworkList(network.gaps);
  const guardrails = root.querySelector("[data-network-guardrails]");
  if (guardrails)
    guardrails.innerHTML = renderNetworkList(network.guardrails, [
      "var(--teal)",
      "var(--sky)",
      "var(--coral)",
    ]);
  const objections = root.querySelector("[data-network-objections]");
  if (objections)
    objections.innerHTML = renderNetworkList(network.objections, [
      "var(--coral)",
      "var(--teal)",
      "var(--plum)",
    ]);
  const leadReview = root.querySelector("[data-network-lead-review]");
  if (leadReview) leadReview.innerHTML = renderNetworkLeadReview(network.sourcing?.reviewLeads);
  const sourcingTargets = root.querySelector("[data-network-sourcing-targets]");
  if (sourcingTargets)
    sourcingTargets.innerHTML = renderNetworkSourcingTargets(network.sourcing?.targets);
}

function renderLibraryStatus(root, library) {
  setText(root, '[data-library-stat="claims"]', library.metrics.claims);
  setText(root, '[data-library-stat="stories"]', library.metrics.stories);
  setText(root, '[data-library-stat="gaps"]', library.metrics.gaps);

  const filters = root.querySelector("[data-library-filters]");
  if (filters) filters.innerHTML = renderLibraryFilters(library.filters);
  const cards = root.querySelector("[data-library-cards]");
  if (cards) cards.innerHTML = renderLibraryCards(library.cards);
  const gaps = root.querySelector("[data-library-gaps]");
  if (gaps) {
    gaps.innerHTML = renderLibraryGapCallouts(library.gaps);
    // metrics.gaps already excludes the "No urgent gaps" placeholder, so the whole
    // Claim guardrails section hides when there's nothing the user must resolve.
    const region = gaps.closest("[data-library-callout]");
    if (region) region.hidden = Number(library.metrics?.gaps || 0) === 0;
  }
}

export function renderDashboardViewModel(viewModel, root = document) {
  const updatedChip = root.querySelector("[data-updated-recency]");
  if (updatedChip && viewModel.recency?.updatedAt) {
    updatedChip.dataset.updatedAt = viewModel.recency.updatedAt;
    delete updatedChip.dataset.updatedAgeSeconds;
    delete updatedChip.dataset.updatedStartedAt;
    if (typeof globalThis !== "undefined" && typeof globalThis.updateRecencyStats === "function") {
      globalThis.updateRecencyStats(root);
    }
  }

  renderModeStatus(root, viewModel.modes);
  renderAgentGuidance(root, viewModel.agentGuidance);
  renderSettingsStatus(root, viewModel.settings);
  renderStrategyInsights(root, viewModel.strategy);
  renderCalendarStatus(root, viewModel.calendar);
  renderNetworkStatus(root, viewModel.network);
  renderLibraryStatus(root, viewModel.library);

  setText(root, '[data-dashboard-stat="inPlay"]', viewModel.stats.inPlay);
  setText(root, '[data-dashboard-stat="responseRate"]', `${viewModel.stats.responseRate}%`);
  setText(root, '[data-dashboard-stat="interviews"]', viewModel.stats.interviews);

  const nextSteps = root.querySelector("#next-steps-list");
  if (nextSteps) nextSteps.innerHTML = renderNextSteps(viewModel.nextSteps);

  const upcomingList = root.querySelector("#upcoming-list");
  if (upcomingList) upcomingList.innerHTML = renderUpcomingList(viewModel.calendar?.upcoming);

  const latestRoles = root.querySelector("#latest-roles-list");
  if (latestRoles) latestRoles.innerHTML = renderLatestRoles(viewModel.latestRoles);

  const sourcedRolesList = root.querySelector("#sourced-roles-list");
  if (sourcedRolesList) sourcedRolesList.innerHTML = renderSourcedRoles(viewModel.sourcedRoles);

  const reviewHoldList = root.querySelector("#review-hold-list");
  if (reviewHoldList) reviewHoldList.innerHTML = renderReviewHoldRoles(viewModel.reviewHoldRoles);
  const reviewHoldCount = root.querySelector("[data-review-hold-count]");
  if (reviewHoldCount) reviewHoldCount.textContent = viewModel.reviewHoldRoles.length;
  const reviewHoldLane = root.querySelector("[data-review-hold-lane]");
  if (reviewHoldLane) reviewHoldLane.hidden = viewModel.reviewHoldRoles.length === 0;

  const focusCard = root.querySelector("#focus-card-body");
  if (focusCard && viewModel.focus) {
    focusCard.dataset.focusKind = viewModel.focus.kind;
    focusCard.dataset.detailId = viewModel.focus.detailId || "";
    focusCard.setAttribute("data-focus-kind", viewModel.focus.kind);
    focusCard.setAttribute("data-detail-id", viewModel.focus.detailId || "");
    focusCard.innerHTML = renderFocusCard(viewModel.focus);
    // Expose the featured dossier so the "Open dossier" CTA can preview it full-page
    // (keyed by detailId; the modal handler reads from here).
    if (typeof globalThis !== "undefined") {
      globalThis.rolesterDossiers =
        viewModel.focus.kind === "interview" &&
        viewModel.focus.detailId &&
        viewModel.focus.hasDossier
          ? { [viewModel.focus.detailId]: viewModel.focus.dossier || null }
          : {};
    }
  }

  if (viewModel.activity) {
    const pulseFeeds = new Set();
    const pulseFeed = root.querySelector("#pulse-feed");
    if (pulseFeed) pulseFeeds.add(pulseFeed);
    if (typeof root.querySelectorAll === "function") {
      root.querySelectorAll("[data-pulse-feed]").forEach((feed) => {
        pulseFeeds.add(feed);
      });
    }
    for (const feed of pulseFeeds) {
      // Both the header popover (#pulse-feed) and the full drawer show the complete
      // log — the popover is a fixed-height card that scrolls internally, so it no
      // longer needs the old "latest few" cap. "View all" opens the same feed
      // full-screen in the drawer.
      feed.innerHTML = renderActivityPulse(viewModel.activity);
    }
  }

  const jobsTable = root.querySelector("#jobs-tbody");
  if (jobsTable) jobsTable.innerHTML = renderJobsRows(viewModel.jobs.rows);

  const jobsFunnel = root.querySelector("#jobs-funnel-list");
  if (jobsFunnel) jobsFunnel.innerHTML = renderJobsFunnel(viewModel.jobs.funnel);

  const jobsSankey = root.querySelector("#jobs-sankey-slot");
  // The funnel is static: it always renders the full population (every stage +
  // both decay states). Filtering/hiding is a table-only concern, driven by the
  // explorer toggles and by clicking funnel nodes — neither rebuilds this SVG.
  if (jobsSankey) jobsSankey.innerHTML = renderJobsSankey(viewModel.jobs.sankey);

  const jobsExplorerBody = root.querySelector("#jobs-explorer-tbody");
  if (jobsExplorerBody) jobsExplorerBody.innerHTML = renderJobsExplorerRows(viewModel.jobs.rows);

  const jobsCardGrid = root.querySelector("#jobs-card-grid");
  if (jobsCardGrid) jobsCardGrid.innerHTML = renderJobsCards(viewModel.jobs.rows);

  setText(root, '[data-jobs-count="active"]', viewModel.jobs.visibleCount);
  setText(root, '[data-jobs-count="screenplus"]', viewModel.jobs.rail.screenPlus);
  setText(root, '[data-jobs-count="review"]', viewModel.jobs.rail.manualReview);
  setAllText(root, '[data-jobs-rail-value="screenPlus"]', viewModel.jobs.rail.screenPlus);
  setAllText(root, '[data-jobs-rail-value="fresh"]', viewModel.jobs.rail.fresh);
  setAllText(root, '[data-jobs-rail-value="highFit"]', viewModel.jobs.rail.highFit);
  setAllText(root, '[data-jobs-rail-value="manualReview"]', viewModel.jobs.rail.manualReview);
  setAllText(root, '[data-jobs-rail-value="terminal"]', viewModel.jobs.rail.terminal);
  setAllText(root, "[data-jobs-rail-next-title]", viewModel.jobs.rail.nextDecision.title);
  setAllText(root, "[data-jobs-rail-next-summary]", viewModel.jobs.rail.nextDecision.summary);

  const showingLabel = root.querySelector("#showing-label");
  if (showingLabel) {
    showingLabel.dataset.visibleCount = String(viewModel.jobs.visibleCount);
    showingLabel.dataset.totalCount = String(viewModel.jobs.totalCount);
    showingLabel.dataset.terminalCount = String(viewModel.jobs.terminalCount);
    showingLabel.textContent = `Showing ${viewModel.jobs.visibleCount} of ${viewModel.jobs.totalCount} jobs`;
  }

  const rejectedButton = root.querySelector("#show-rejected-btn");
  if (rejectedButton) rejectedButton.textContent = "Show rejected";
  registerJobDetails(viewModel.jobs.rows);
  globalThis.setupJobsExplorer?.(viewModel.jobs);

  const nextDecisionCard = root.querySelector("[data-jobs-next-decision]");
  if (nextDecisionCard) {
    const next = viewModel.jobs.rail.nextDecision;
    nextDecisionCard.dataset.hasWork = next.hasWork ? "1" : "0";
    const nextDecisionCta = nextDecisionCard.querySelector("[data-jobs-rail-next]");
    if (nextDecisionCta && next.action) {
      nextDecisionCta.dataset.jobsRailAction = next.action;
    }
  }
}

// Parse the activity feed (JSONL — one event per line). Tolerant: a malformed or
// partial trailing line (crash mid-append) is skipped, never thrown.
function parseActivityJsonl(text) {
  const events = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip malformed/partial line
    }
  }
  return events;
}

// Fetch the Activity Pulse feed alongside the tracker. The feed is optional —
// absence or any error degrades to an empty feed (the renderer shows the
// empty-state), never breaking the rest of the dashboard.
async function fetchActivityEvents(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    return parseActivityJsonl(await res.text());
  } catch {
    return [];
  }
}

async function fetchModeStatus(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchSettingsStatus(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchLibraryStatus(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function hydrateDashboardFromTracker({
  root = document,
  source = "../../workspace/tracker.json",
  now = new Date(),
} = {}) {
  const activitySource = source.replace(/tracker\.json(\?|$)/, "activity.jsonl$1");
  const modesSource = source.replace(/tracker\.json(\?|$)/, "modes.json$1");
  const settingsSource = source.replace(/tracker\.json(\?|$)/, "settings.json$1");
  const librarySource = source.replace(/tracker\.json(\?|$)/, "library.json$1");
  const [trackerData, activityEvents, modes, settings, library] = await Promise.all([
    fetch(source, { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error(`Could not load tracker JSON: ${response.status}`);
      return response.json();
    }),
    fetchActivityEvents(activitySource),
    fetchModeStatus(modesSource),
    fetchSettingsStatus(settingsSource),
    fetchLibraryStatus(librarySource),
  ]);
  const effectiveSettings = settings || modes?.settings || null;
  const viewModel = buildDashboardViewModel(trackerData, {
    now,
    activityEvents,
    modes,
    settings: effectiveSettings,
    library,
    agentGuidance: modes?.agentGuidance || null,
  });
  renderDashboardViewModel(viewModel, root);
  return viewModel;
}
