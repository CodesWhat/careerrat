/**
 * Tracker dashboard: summary computation and HTML/text rendering.
 */

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

// ── Status classification helpers ─────────────────────────────────────────────

// classifyApp is the COARSE 3-bucket view (awaiting / advanced / rejected) used by
// buildStats. It derives from the fine classifyStage ladder below so labels stay
// consistent with the Active Pipeline (a verbose label like "2nd
// phone interview" counts as advanced in both): screen-and-beyond = "advanced"
// (heard back), sourced/applied = "awaiting", terminal = "rejected". classifyStage
// is a hoisted declaration; TERMINAL_STAGES is read at call time.
function classifyApp(app) {
  const stage = classifyStage(app.status);
  if (stage.id === "withdrawn") return "withdrawn";
  if (TERMINAL_STAGES.has(stage.id)) return "rejected";
  if (stage.order < 1) return "pre-application";
  if (stage.order >= 2) return "advanced";
  return "awaiting";
}

// ── Stage ladder (fine-grained pipeline classification) ───────────────────────
// classifyApp above is the COARSE 3-bucket classifier (awaiting/advanced/rejected)
// that buildStats depends on. classifyStage is the FINE pipeline
// ladder: it preserves the candidate's raw status label and maps it to a
// canonical rung for colour + ordering. Because a user's process can differ,
// callers may pass customStages (from trackerData.stages) to override a canonical
// rung (same id) or mint a brand-new one.

const STAGE_LADDER = [
  { id: "sourced", label: "Sourced", order: 0, colorVar: "--text-muted" },
  { id: "reviewed-hold", label: "Reviewed: hold", order: 0.5, colorVar: "--orange" },
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
  let applied = 0;

  for (const app of applications) {
    const cls = classifyApp(app);
    if (cls === "pre-application") continue;
    applied++;
    if (cls === "awaiting") awaiting++;
    else if (cls === "advanced") advanced++;
    else if (cls === "rejected") rejected++;
    else if (cls === "withdrawn") withdrawn++;
  }

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
    "=== CareerRat Tracker Summary ===",
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
