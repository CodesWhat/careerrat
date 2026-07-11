/**
 * Tracker dashboard: summary computation and HTML/text rendering.
 */

import { computeFollowUps } from "./cadence.mjs";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Count items in an array by a key function.
 * @param {unknown[]} arr
 * @param {(item: unknown) => string} getKey
 * @returns {Record<string, number>}
 */
function countBy(arr, getKey) {
  return arr.reduce((acc, item) => {
    const key = getKey(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

// Number of palette slots a company monogram can land on (maps to --c-0..--c-5).
const AVATAR_SLOTS = 6;

/**
 * Deterministic company monogram: initials + a stable palette slot derived from
 * the company name. No bundled logos — every company gets a consistent, offline,
 * trademark-free avatar. Same name always yields the same initials + color.
 *
 * @param {string} name
 * @returns {{ initials: string, slot: number }}
 */
export function companyMonogram(name) {
  const clean = String(name == null ? "" : name).trim();
  if (!clean) return { initials: "", slot: 0 };
  // First alphanumeric character of each word, skipping symbol-only tokens
  // (so "Globex & Co" → "GC", "Initech" → "IN").
  const firstAlnum = (w) => {
    const m = w.match(/[a-z0-9]/i);
    return m ? m[0] : "";
  };
  const wordInitials = clean.split(/\s+/).map(firstAlnum).filter(Boolean);
  let initials =
    wordInitials.length >= 2
      ? wordInitials[0] + wordInitials[1]
      : (clean.match(/[a-z0-9]/gi) || []).slice(0, 2).join("");
  initials = initials.toUpperCase();
  if (!initials) return { initials: "", slot: 0 };
  let h = 0;
  for (let i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) >>> 0;
  return { initials, slot: h % AVATAR_SLOTS };
}

// ── Hero identity ─────────────────────────────────────────────────────────────
// The hero subtitle is filled from onboarding (candidate/profile.yml +
// candidate/targeting.yml). Until the candidate is set up, the CLI passes the
// example templates so the demo still reads as a real command center. Nothing
// here fabricates facts: every field is sourced from the candidate's own files.

/** Format a USD figure compactly: 200000 → "$200K", 1250000 → "$1.25M". */
function fmtComp(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return `$${(Math.round(m * 100) / 100).toString().replace(/\.0+$/, "")}M`;
  }
  if (v >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${v}`;
}

/**
 * Distill the candidate's identity for the hero from their parsed profile and
 * targeting files. Returns null when there is nothing real to show.
 *
 *   { name, role, targets: string[], floor }
 *
 * Privacy: `floor` is built only from *target/minimum* comp and stated location
 * preferences — never from current_base or any current-comp figure.
 */
export function buildIdentity(profile, targeting) {
  const cand = profile?.candidate || {};
  const comp = profile?.compensation || {};
  const loc = profile?.location || {};

  const name = String(cand.full_name || cand.preferred_name || "").trim();
  const role = String(cand.headline || cand.current_role || cand.title || "").trim();

  // Primary-bucket target titles (fall back to the first bucket), capped at 3.
  const buckets =
    (targeting && Array.isArray(targeting.role_buckets) && targeting.role_buckets) || [];
  const primary = buckets.find((b) => b && b.priority === "primary") || buckets[0] || {};
  const targets = (Array.isArray(primary.titles) ? primary.titles : [])
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .slice(0, 3);

  // Comp/location floor — targets only, never current comp.
  const base = fmtComp(comp.minimum_base || comp.target_base);
  const tc = fmtComp(comp.target_total_comp);
  const modes = [];
  if (loc.remote) modes.push("remote");
  if (loc.hybrid) modes.push("hybrid");
  if (loc.onsite) modes.push("on-site");
  const home = String(loc.home || cand.location || "").trim();
  const where = home ? (modes.length ? `${modes.join(" / ")} · ${home}` : home) : modes.join(" / ");
  let floor = "";
  if (base || tc) {
    const fig = tc && !base ? `${tc} total comp` : base ? `${base} base` : "";
    floor = `Floor: ${fig}${where ? ` (${where})` : ""}`;
  }

  if (!name && !role && targets.length === 0 && !floor) return null;
  return { name, role, targets, floor };
}

// ── Status classification helpers ─────────────────────────────────────────────

// classifyApp is the COARSE 3-bucket view (awaiting / advanced / rejected) used by
// buildStats + buildFunnel. It derives from the fine classifyStage ladder below so
// the funnel and the Active Pipeline never disagree (a verbose label like "2nd
// phone interview" counts as advanced in both): screen-and-beyond = "advanced"
// (heard back), sourced/applied = "awaiting", terminal = "rejected". classifyStage
// is a hoisted declaration; TERMINAL_STAGES is read at call time.
function classifyApp(app) {
  const stage = classifyStage(app.status);
  if (stage.id === "withdrawn") return "withdrawn";
  if (TERMINAL_STAGES.has(stage.id)) return "rejected";
  if (stage.order >= 2) return "advanced";
  return "awaiting";
}

// ── Stage ladder (fine-grained pipeline classification) ───────────────────────
// classifyApp above is the COARSE 3-bucket classifier (awaiting/advanced/rejected)
// that buildStats + buildFunnel depend on. classifyStage is the FINE pipeline
// ladder: it preserves the candidate's raw status label and maps it to a
// canonical rung for colour + ordering. Because a user's process can differ,
// callers may pass customStages (from trackerData.stages) to override a canonical
// rung (same id) or mint a brand-new one.

const STAGE_LADDER = [
  { id: "sourced", label: "Sourced", order: 0, colorVar: "--text-muted" },
  { id: "reviewed-hold", label: "Reviewed — hold", order: 0.5, colorVar: "--orange" },
  { id: "applied", label: "Applied", order: 1, colorVar: "--accent" },
  { id: "manual-apply", label: "Manual Apply", order: 1.5, colorVar: "--orange" },
  { id: "screen", label: "Screen", order: 2, colorVar: "--purple" },
  { id: "interview", label: "Interview", order: 3, colorVar: "--cyan" },
  { id: "final", label: "Final", order: 4, colorVar: "--orange" },
  { id: "offer", label: "Offer", order: 5, colorVar: "--green" },
  { id: "accepted", label: "Accepted", order: 6, colorVar: "--green" },
  { id: "rejected", label: "Rejected", order: 90, colorVar: "--red" },
  { id: "withdrawn", label: "Withdrawn", order: 91, colorVar: "--text-muted" },
];

// Ordered keyword rules — first match wins. Tuned so a verbose label like
// "2nd phone interview" lands on `interview` (not `screen`) and "recruiter
// screen" lands on `screen`.
const STAGE_RULES = [
  ["accepted", ["accept", "signed", "hired"]],
  ["offer", ["offer"]],
  ["final", ["final", "onsite", "on-site", "on site"]],
  ["interview", ["interview", "panel", "technical", "assessment", "passed", "loop"]],
  ["screen", ["screen", "recruiter", "hiring manager", "hm"]],
  ["rejected", ["reject", "declined", "denied", "closed", "no longer"]],
  [
    "manual-apply",
    ["manual-apply", "manual apply", "manual blocked", "blocked", "needs manual", "manual"],
  ],
  // reviewed-hold MUST precede withdrawn ("hold" substring) and applied ("review"
  // substring) so a parked-but-recoverable role isn't mislabelled as Withdrawn.
  ["reviewed-hold", ["reviewed-hold"]],
  ["withdrawn", ["withdraw", "cut", "hold", "skipped", "app-limit"]],
  [
    "applied",
    ["applied", "submitted", "awaiting", "waiting", "pending", "reviewing", "in review", "review"],
  ],
];

const TERMINAL_STAGES = new Set(["rejected", "withdrawn"]);

/**
 * Merge the canonical STAGE_LADDER with caller-supplied custom stages.
 * A custom stage with an existing id overrides that rung; a new id mints one.
 * @param {Array<{id,label,order,color,colorVar,patterns}>} [customStages]
 * @returns {{ byId: Record<string, object>, list: Array<object> }}
 */
function resolveLadder(customStages) {
  const byId = {};
  for (const s of STAGE_LADDER) byId[s.id] = { ...s };
  if (Array.isArray(customStages)) {
    for (const c of customStages) {
      if (!c?.id) continue;
      const prev = byId[c.id] || {};
      byId[c.id] = {
        id: c.id,
        label: c.label || prev.label || c.id,
        order: c.order != null ? c.order : prev.order != null ? prev.order : 50,
        colorVar: c.colorVar || c.color || prev.colorVar || "--text-muted",
        patterns: Array.isArray(c.patterns)
          ? c.patterns.map((p) => String(p).toLowerCase())
          : prev.patterns,
      };
    }
  }
  return { byId, list: Object.values(byId).sort((a, b) => a.order - b.order) };
}

/**
 * Map a free-form status string to a canonical (or custom) pipeline stage,
 * preserving the caller's raw label for display. Custom stages are checked
 * first (by id or pattern substring), then canonical keyword rules, then a safe
 * `applied` default for unknown non-empty statuses.
 *
 * @param {string} status raw status text (e.g. "2nd phone interview")
 * @param {Array} [customStages] optional custom stage defs (trackerData.stages)
 * @returns {{ id: string, label: string, order: number, colorVar: string }}
 */
export function classifyStage(status, customStages) {
  const { byId } = resolveLadder(customStages);
  const s = String(status == null ? "" : status)
    .toLowerCase()
    .trim();
  if (Array.isArray(customStages)) {
    for (const c of customStages) {
      if (!c?.id) continue;
      const pats = Array.isArray(c.patterns) ? c.patterns : [];
      if (
        s &&
        (s === String(c.id).toLowerCase() || pats.some((p) => s.includes(String(p).toLowerCase())))
      ) {
        return byId[c.id];
      }
    }
  }
  for (const [id, subs] of STAGE_RULES) {
    if (subs.some((sub) => s.includes(sub))) return byId[id];
  }
  return byId.applied; // unknown non-empty → safe in-pipeline default
}

/**
 * True when `status` matches a known stage keyword rule — i.e. classifyStage did
 * NOT fall through to the `applied` default. The integrity validator uses this to
 * warn (not reject) on unrecognized raw labels: the tracker preserves the
 * candidate's raw status text by design, so any non-empty label is renderable, but
 * a label matching no rule is worth surfacing as a likely typo.
 *
 * @param {string} status raw status text
 * @returns {boolean}
 */
export function isKnownStatusLabel(status) {
  const s = String(status == null ? "" : status)
    .toLowerCase()
    .trim();
  if (!s) return false;
  return STAGE_RULES.some(([, subs]) => subs.some((sub) => s.includes(sub)));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Strip demo rows from trackerData once any real (non-demo) pipeline data exists.
 * If no real data exists yet (fresh install), returns data unchanged so the seeded
 * demo funnel shows. Defensive against null/missing arrays.
 *
 * @param {object} trackerData
 * @returns {object}
 */
export function stripDemo(trackerData) {
  const applications = trackerData?.applications || [];
  // Back-compat: legacy tracker files use "prospects"; canonical key is "sourced".
  const sourced = (trackerData && (trackerData.sourced || trackerData.prospects)) || [];
  const communications = trackerData?.communications || [];
  const sources = trackerData?.sources || [];

  // "Real pipeline started" = any non-demo row among apps + sourced + comms
  const hasReal =
    applications.some((r) => !r.demo) ||
    sourced.some((r) => !r.demo) ||
    communications.some((r) => !r.demo);

  if (!hasReal) return trackerData;

  return {
    ...trackerData,
    sourced: sourced.filter((r) => !r.demo),
    prospects: undefined,
    applications: applications.filter((r) => !r.demo),
    communications: communications.filter((r) => !r.demo),
    sources: sources.filter((r) => !r.demo),
  };
}

/**
 * Compute the primary stat card numbers from tracker data.
 *
 * @param {object} trackerData
 * @returns {{
 *   inPlay: number, responseRate: number, interviews: number, sourced: number,
 *   applied: number, awaiting: number, advanced: number, rejected: number
 * }}
 */
export function buildStats(trackerData) {
  const applications = trackerData?.applications || [];
  // Back-compat: legacy tracker files use "prospects"; canonical key is "sourced".
  const sourcedArr = (trackerData && (trackerData.sourced || trackerData.prospects)) || [];

  let awaiting = 0;
  let advanced = 0;
  let rejected = 0;
  let withdrawn = 0;

  for (const app of applications) {
    const cls = classifyApp(app);
    if (cls === "awaiting") awaiting++;
    else if (cls === "advanced") advanced++;
    else if (cls === "rejected") rejected++;
    else if (cls === "withdrawn") withdrawn++;
  }

  const applied = applications.length;
  const inPlay = awaiting + advanced;
  // Candidate withdrawals remove the app from the market-response sample — a withdrawal
  // is not a market signal. Exclude withdrawn from both numerator and denominator so
  // responseRate measures only the market's reply rate on apps that stayed in play.
  const rateBase = applied - withdrawn;
  const responseRate = rateBase > 0 ? Math.round(((advanced + rejected) / rateBase) * 100) : 0;

  return {
    inPlay,
    responseRate,
    interviews: advanced,
    sourced: sourcedArr.length,
    applied,
    awaiting,
    advanced,
    rejected,
    withdrawn,
  };
}

/**
 * Build a pure description of the Sankey funnel from tracker data.
 *
 * @param {object} trackerData
 * @returns {{
 *   nodes: Array<{id: string, label: string, col: number, value: number, colorVar: string}>,
 *   links: Array<{s: string, t: string, value: number, pct: number}>,
 *   counts: {applied: number, awaiting: number, advanced: number, rejected: number},
 *   sourceBuckets: Array<{id: string, label: string, colorVar: string, count: number}>
 * }}
 */
// The progression chain renders at most this many advancing rungs — a generous
// scaffold of ordered "slots" the agent can name/extend/reorder per the candidate's
// real loop (e.g. "1st round → take-home → onsite → panel"). Only rungs actually in
// use ever render, so a short process shows a short chain and a long one extends.
const MAX_FUNNEL_STAGES = 20;

export function buildFunnel(trackerData) {
  const applications = trackerData?.applications || [];
  const customStages = trackerData?.stages || [];
  const { byId } = resolveLadder(customStages);

  const counts = { applied: applications.length, awaiting: 0, rejected: 0, withdrawn: 0 };
  // Heard-back furthest stages keyed by stage id → count. Every rung at order ≥ 2
  // that's actually reached becomes its own "Furthest stage" node, so a custom
  // ladder ("Code review", "Onsite 2", "Offer", …) lights up here automatically
  // and stages nobody reached never render.
  const stageCounts = {};

  // Classify each app and assign to a source bucket
  const bucketDefs = [
    {
      id: "src-referral",
      label: "Referral",
      colorVar: "--orange",
      match: (a) => (a.channel || "").toLowerCase() === "referral",
    },
    {
      id: "src-recruiter",
      label: "Recruiter sourced",
      colorVar: "--purple",
      match: (a) => (a.channel || "").toLowerCase() === "recruiter",
    },
    { id: "src-cold", label: "Direct apply", colorVar: "--accent", match: () => true },
  ];

  const bucketApps = { "src-referral": [], "src-recruiter": [], "src-cold": [] };

  for (const app of applications) {
    const stage = classifyStage(app.status, customStages);
    let cls;
    if (TERMINAL_STAGES.has(stage.id)) {
      if (stage.id === "withdrawn") {
        cls = "withdrawn";
        counts.withdrawn++;
      } else {
        cls = "rejected";
        counts.rejected++;
      }
    } else if (stage.order >= 2) {
      cls = stage.id; // a heard-back rung becomes its own furthest-stage bucket
      stageCounts[stage.id] = (stageCounts[stage.id] || 0) + 1;
    } else {
      cls = "awaiting";
      counts.awaiting++;
    }
    for (const bd of bucketDefs) {
      if (bd.match(app)) {
        bucketApps[bd.id].push({ app, cls });
        break;
      }
    }
  }

  const advancedTotal = Object.values(stageCounts).reduce((a, b) => a + b, 0);
  const heardbackValue = advancedTotal + counts.rejected + counts.withdrawn;

  // Cumulative progression: an app whose furthest rung is "interview" also passed
  // "screen", so each rung's value = everyone who reached it OR BEYOND. That turns
  // the heard-back stages into a left-to-right CHAIN (Screen → Interview → Final →
  // Offer → Accepted) instead of parallel siblings — so Offer is only reachable
  // THROUGH Interview, and the spine thins as candidates drop off. reachedFor(order)
  // counts advanced apps whose furthest rung is at least `order`.
  const advFurthestOrders = [];
  for (const [id, cnt] of Object.entries(stageCounts)) {
    const ord = byId[id] ? byId[id].order : 2;
    for (let k = 0; k < cnt; k++) advFurthestOrders.push(ord);
  }
  const reachedFor = (order) => advFurthestOrders.filter((o) => o >= order).length;

  // In-use advancing rungs (order ≥ 2). Contiguous because reachedFor is cumulative
  // (anyone who reached interview also "reached" screen). Capped for legibility.
  const progStages = Object.values(byId)
    .filter((s) => s.order >= 2 && !TERMINAL_STAGES.has(s.id) && reachedFor(s.order) > 0)
    .sort((a, b) => a.order - b.order)
    .slice(0, MAX_FUNNEL_STAGES);

  // Source buckets — only include if they have ≥1 app
  const sourceBuckets = bucketDefs
    .filter((bd) => bucketApps[bd.id].length > 0)
    .map((bd) => ({
      id: bd.id,
      label: bd.label,
      colorVar: bd.colorVar,
      count: bucketApps[bd.id].length,
    }));

  // Build nodes
  const nodes = [];

  // col 0: source buckets
  for (const sb of sourceBuckets) {
    nodes.push({ id: sb.id, label: sb.label, col: 0, value: sb.count, colorVar: sb.colorVar });
  }

  // col 1: awaiting / heard back (only if value > 0)
  if (counts.awaiting > 0) {
    nodes.push({
      id: "awaiting",
      label: "Awaiting",
      col: 1,
      value: counts.awaiting,
      colorVar: "--text-muted",
    });
  }
  if (heardbackValue > 0) {
    nodes.push({
      id: "heardback",
      label: "Heard back",
      col: 1,
      value: heardbackValue,
      colorVar: "--cyan",
    });
  }

  // cols 2..N: the progression chain — one column per in-use rung, cumulative value.
  progStages.forEach((s, i) => {
    nodes.push({
      id: s.id,
      label: s.label,
      col: 2 + i,
      value: reachedFor(s.order),
      colorVar: s.colorVar || "--green",
    });
  });
  // Rejected sink sits in the first heard-back column, branching off Heard back.
  if (counts.rejected > 0) {
    nodes.push({
      id: "rejected",
      label: "Rejected",
      col: 2,
      value: counts.rejected,
      colorVar: "--red",
    });
  }
  // Withdrawn sink — candidate-initiated exit, muted not red.
  if (counts.withdrawn > 0) {
    nodes.push({
      id: "withdrawn",
      label: "Withdrawn",
      col: 2,
      value: counts.withdrawn,
      colorVar: "--text-muted",
    });
  }

  // Build links
  const links = [];

  // col 0 → col 1: each source bucket splits into awaiting vs heard back.
  for (const sb of sourceBuckets) {
    const apps = bucketApps[sb.id];
    const srcAwaiting = apps.filter((a) => a.cls === "awaiting").length;
    const srcHeardback = apps.length - srcAwaiting;

    if (srcAwaiting > 0 && counts.awaiting > 0) {
      links.push({
        s: sb.id,
        t: "awaiting",
        value: srcAwaiting,
        pct: Math.round((srcAwaiting / sb.count) * 100),
      });
    }
    if (srcHeardback > 0 && heardbackValue > 0) {
      links.push({
        s: sb.id,
        t: "heardback",
        value: srcHeardback,
        pct: Math.round((srcHeardback / sb.count) * 100),
      });
    }
  }

  // Heard back → first rung (advance) + Heard back → Rejected (drop off).
  if (progStages.length > 0) {
    const first = progStages[0];
    const v = reachedFor(first.order);
    links.push({
      s: "heardback",
      t: first.id,
      value: v,
      pct: Math.round((v / heardbackValue) * 100),
    });
  }
  if (counts.rejected > 0 && heardbackValue > 0) {
    links.push({
      s: "heardback",
      t: "rejected",
      value: counts.rejected,
      pct: Math.round((counts.rejected / heardbackValue) * 100),
    });
  }
  if (counts.withdrawn > 0 && heardbackValue > 0) {
    links.push({
      s: "heardback",
      t: "withdrawn",
      value: counts.withdrawn,
      pct: Math.round((counts.withdrawn / heardbackValue) * 100),
    });
  }

  // Chain: each rung advances into the next (everyone who reached the next rung).
  for (let i = 0; i < progStages.length - 1; i++) {
    const a = progStages[i],
      b = progStages[i + 1];
    const v = reachedFor(b.order);
    if (v > 0)
      links.push({
        s: a.id,
        t: b.id,
        value: v,
        pct: Math.round((v / (reachedFor(a.order) || 1)) * 100),
      });
  }

  return { nodes, links, counts, sourceBuckets, stageCounts };
}

/**
 * Produce a summary object from tracker data.
 * Defensive: tolerates missing or null arrays.
 *
 * @param {object} trackerData
 * @returns {{
 *   counts: { applications: number, sourced: number, communications: number, sources: number },
 *   byStatus: Record<string, number>,
 *   commsByStatus: Record<string, number>,
 *   openFollowUps: number
 * }}
 */
export function summarizeTracker(trackerData) {
  const applications = trackerData?.applications || [];
  // Back-compat: legacy tracker files use "prospects"; canonical key is "sourced".
  const sourced = (trackerData && (trackerData.sourced || trackerData.prospects)) || [];
  const communications = trackerData?.communications || [];
  const sources = trackerData?.sources || [];

  const byStatus = countBy(applications, (a) => a.status || "unknown");
  const commsByStatus = countBy(communications, (c) => c.status || "unknown");

  // openFollowUps: comms that need action (needs-reply, drafted, waiting, scheduled, blocked)
  const openStatuses = new Set(["needs-reply", "drafted", "waiting", "scheduled", "blocked"]);
  const openFollowUps = communications.filter((c) => openStatuses.has(c.status)).length;

  return {
    counts: {
      applications: applications.length,
      sourced: sourced.length,
      communications: communications.length,
      sources: sources.length,
    },
    byStatus,
    commsByStatus,
    openFollowUps,
  };
}

// ── Today action bar ──────────────────────────────────────────────────────────

/**
 * Build the ordered "Today" queue: follow-ups due/overdue, interview-prep
 * items, and stale-wait applications. Returns items sorted most-urgent first,
 * capped at MAX_TODAY_ITEMS with an overflow count.
 *
 * @param {object} trackerData
 * @param {Date|string} now
 * @param {object} [followUpRules]  same shape as computeFollowUps `rules`
 * @returns {{ items: Array<TodayItem>, overflow: number }}
 *
 * TodayItem: {
 *   kind:        "follow-up" | "interview-prep" | "stale-wait"
 *   urgency:     "overdue" | "due" | "prep" | "wait"
 *   sortKey:     number   (overdueDays desc, then interview order, then staleness)
 *   company:     string
 *   role:        string
 *   action:      string   (what to do — e.g. "Reply needed", "Prep for interview")
 *   whenText:    string   (e.g. "3d overdue", "due today", "screen in 2d")
 *   hasDraft:    boolean
 *   applicationId: string
 *   link:        string
 *   draftPrompt: string
 * }
 */
export function buildTodayQueue(trackerData, now, followUpRules) {
  if (!now) return { items: [], overflow: 0 };

  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(nowDate.getTime())) return { items: [], overflow: 0 };

  const MAX_TODAY_ITEMS = 6;

  // Re-use computeFollowUps to derive comm-due and needs-reply items.
  // This honours the same followUpRules the notification bell uses — no duplication.
  const followUps = computeFollowUps(trackerData, { now: nowDate, rules: followUpRules });

  const applications = trackerData?.applications || [];
  const items = [];

  // ── 1. Due / overdue follow-ups from computeFollowUps ────────────────────
  // Only surface kinds that represent an actionable comm today:
  //   comm-due, needs-reply (due-today or overdue)
  // We skip app-nudge / post-interview-nudge / waiting-stale here — those map to
  // the "stale wait" bucket below so they don't double-render.
  for (const fu of followUps) {
    if (fu.kind !== "comm-due" && fu.kind !== "needs-reply") continue;
    const urgency = fu.overdueDays > 0 ? "overdue" : "due";
    const whenText = fu.overdueDays > 0 ? `${fu.overdueDays}d overdue` : "due today";
    const hasDraft = !!(fu.draft && (fu.draft.body || fu.draft.subject));
    const draftPrompt = fu.role
      ? `Draft the follow-up email for ${fu.company} — ${fu.role}`
      : `Draft the follow-up email for ${fu.company}`;

    // Resolve link: prefer the application whose id matches AND whose company matches
    // the comm company (demo data sometimes links comm→wrong app). Fall back to
    // the id-matched app, then search by company name.
    const idMatchedApp = fu.applicationId
      ? applications.find((a) => a.id === fu.applicationId)
      : null;
    const companyMatchedApp = fu.company
      ? applications.find(
          (a) => (a.company || a.co || "").toLowerCase() === fu.company.toLowerCase()
        )
      : null;
    const linkedApp =
      idMatchedApp && (idMatchedApp.company || "").toLowerCase() === fu.company.toLowerCase()
        ? idMatchedApp
        : companyMatchedApp || idMatchedApp;
    const link = linkedApp?.link || "";

    items.push({
      kind: "follow-up",
      urgency,
      sortKey: 10000 + fu.overdueDays, // follow-ups sorted first, most overdue highest
      company: fu.company,
      role: fu.role || "",
      action: fu.reason || "Follow-up due",
      whenText,
      hasDraft,
      applicationId: fu.applicationId || "",
      link,
      draftPrompt,
    });
  }

  // ── 2. Interview-prep items: active interview-stage applications ───────────
  // Status patterns matching cadence.mjs's isInterviewStage, plus "screen" variants.
  const INTERVIEW_RE = /interview|onsite|on-site|panel|\bfinal\b|technical|screen/i;
  const TERMINAL_SET = new Set(["rejected", "closed", "withdrawn", "declined", "accepted"]);

  for (const app of applications) {
    const status = (app.status || "").toLowerCase();
    if (!status || TERMINAL_SET.has(status)) continue;
    if (!INTERVIEW_RE.test(status)) continue;

    // Don't double-render: if there's already a follow-up item for this app, skip.
    const alreadyCovered = items.some((it) => it.applicationId === app.id);
    if (alreadyCovered) continue;

    items.push({
      kind: "interview-prep",
      urgency: "prep",
      sortKey: 500, // interview-prep is lower priority than overdue follow-ups
      company: app.company || app.co || "",
      role: app.role || "",
      action: "Prep for this stage",
      whenText: String(app.status || "").trim(),
      hasDraft: false,
      applicationId: app.id || "",
      link: app.link || "",
      draftPrompt: "",
    });
  }

  // ── 3. Stale-wait items: active applications with no recent activity ────────
  // Reuses overdueDays from computeFollowUps for app-nudge and post-interview-nudge.
  for (const fu of followUps) {
    if (
      fu.kind !== "app-nudge" &&
      fu.kind !== "post-interview-nudge" &&
      fu.kind !== "waiting-stale"
    )
      continue;
    // Skip if already covered by interview-prep (same app)
    const alreadyCovered = items.some((it) => it.applicationId === fu.applicationId);
    if (alreadyCovered) continue;

    const whenText = fu.overdueDays > 0 ? `${fu.overdueDays}d quiet` : "no response";
    const linkedApp = fu.applicationId ? applications.find((a) => a.id === fu.applicationId) : null;
    const link = linkedApp?.link || "";
    const hasDraft = !!(fu.draft && (fu.draft.body || fu.draft.subject));
    const draftPrompt = fu.role
      ? `Draft the follow-up email for ${fu.company} — ${fu.role}`
      : `Draft the follow-up email for ${fu.company}`;

    items.push({
      kind: "stale-wait",
      urgency: "wait",
      sortKey: fu.overdueDays, // lowest priority bucket, sorted by staleness
      company: fu.company,
      role: fu.role || "",
      action: fu.reason || "No response — consider following up",
      whenText,
      hasDraft,
      applicationId: fu.applicationId || "",
      link,
      draftPrompt,
    });
  }

  // Sort: highest sortKey first (most urgent / most overdue)
  items.sort((a, b) => b.sortKey - a.sortKey);

  const overflow = Math.max(0, items.length - MAX_TODAY_ITEMS);
  return { items: items.slice(0, MAX_TODAY_ITEMS), overflow };
}

/**
 * Render a short plaintext summary for CLI --summary output.
 *
 * @param {object} trackerData
 * @returns {string}
 */
export function renderTrackerSummaryText(trackerData) {
  const summary = summarizeTracker(trackerData);
  const { counts, commsByStatus, openFollowUps } = summary;
  const applications = trackerData?.applications || [];
  const customStages = trackerData?.stages || [];

  const lines = [
    "=== Rolester Tracker Summary ===",
    "",
    `Applications:   ${counts.applications}`,
    `Sourced:        ${counts.sourced}`,
    `Communications: ${counts.communications}`,
    `Sources:        ${counts.sources}`,
    `Open Follow-ups: ${openFollowUps}`,
  ];

  if (applications.length > 0) {
    // Group by classified stage (so e.g. raw "blocked" → manual-apply, not "blocked").
    const stageTotals = {}; // stage.id → { label, order, count }
    for (const app of applications) {
      const stage = classifyStage(app.status, customStages);
      if (!stageTotals[stage.id]) {
        stageTotals[stage.id] = { label: stage.label, order: stage.order, count: 0 };
      }
      stageTotals[stage.id].count++;
    }
    // Print in canonical stage order (STAGE_LADDER order, ascending).
    const sorted = Object.values(stageTotals).sort((a, b) => a.order - b.order);
    lines.push("", "Applications by Stage:");
    for (const { label, count } of sorted) {
      lines.push(`  ${label}: ${count}`);
    }
  }

  if (Object.keys(commsByStatus).length > 0) {
    lines.push("", "Communications by Status:");
    for (const [status, n] of Object.entries(commsByStatus).sort(([, a], [, b]) => b - a)) {
      lines.push(`  ${status}: ${n}`);
    }
  }

  return lines.join("\n");
}
