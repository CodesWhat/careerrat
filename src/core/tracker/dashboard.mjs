/**
 * Tracker dashboard: summary computation and HTML/text rendering.
 */

import { BRAND_LOGO_SRC } from "./brand-logo.mjs";
import { computeFollowUps } from "./cadence.mjs";
import { DASHBOARD_SCRIPT } from "./client-script.mjs";
import { DASHBOARD_CSS } from "./styles.mjs";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * HTML-escape a value for safe interpolation.
 * @param {unknown} v
 * @returns {string}
 */
function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

/** Build a local cached logo route for a company domain/name. */
function logoUrl(domain, name) {
  const cleanedDomain = String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
  const company = String(name || "").trim();
  const params = [];
  if (cleanedDomain) params.push(`domain=${encodeURIComponent(cleanedDomain)}`);
  if (company) params.push(`name=${encodeURIComponent(company)}`);
  return params.length ? `/api/logos/img?${params.join("&")}` : "";
}

/**
 * Render the avatar span for a company. Defaults to a deterministic, offline
 * monogram. A real logo image is layered on top via the local cache route, with
 * the monogram initials underneath as the automatic fallback (the <img> removes
 * itself on error → initials show through).
 *
 * @param {string} name
 * @param {string} [domain]  Company domain, e.g. "stripe.com"
 * @param {unknown} [_logo]  Legacy logo.dev option, ignored now that the route caches.
 * @returns {string}
 */
function avatarHtml(name, domain, _logo, logoSrc) {
  const { initials, slot } = companyMonogram(name);
  if (!initials) return "";
  const open = `<span class="avatar" style="--avatar: var(--c-${slot})">`;
  // Priority: an explicit bundled logo (e.g. the demo corps) → opt-in logo.dev
  // image → deterministic monogram. The monogram initials always sit underneath
  // as the automatic fallback (each <img> removes itself on error).
  // Bundled or opt-in logos sit on a white "chip": the monogram initials stay in
  // the markup (hidden via `.has-logo`) so that if the image 404s, `onerror`
  // drops the chip and the deterministic monogram shows through unchanged.
  const chipOpen = `<span class="avatar has-logo" style="--avatar: var(--c-${slot})">`;
  const onErr = "this.remove();this.parentNode.classList.remove('has-logo')";
  if (logoSrc?.src) {
    return `${chipOpen}<img class="logo-img" src="${esc(logoSrc.src)}" alt="" loading="lazy" onerror="${onErr}">${esc(initials)}</span>`;
  }
  const url = esc(logoUrl(domain, name));
  if (url) {
    return `${chipOpen}<img class="logo-img" src="${url}" alt="" loading="lazy" onerror="${onErr}">${esc(initials)}</span>`;
  }
  return `${open}${esc(initials)}</span>`;
}

/** Render a company cell: avatar (logo or monogram) + company name, with an
 *  optional muted subtitle line (e.g. location) beneath the name. */
function companyCell(name, domain, logo, logoSrc, sub) {
  const label = esc(name || "");
  const avatar = avatarHtml(name, domain, logo, logoSrc);
  const subLine = sub ? `<span class="co-sub">${esc(sub)}</span>` : "";
  return `<span class="co">${avatar}<span class="co-text"><span class="co-name">${label}</span>${subLine}</span></span>`;
}

// ── Work-mode + fit-score cell helpers ────────────────────────────────────────
// Lucide-style inline glyph set (stroked, currentColor). Used for stat cards
// and section headers so the dashboard stays self-contained — no icon font or
// external sprite. Each entry is the inner markup of a 24×24 viewBox.
const ICON_PATHS = {
  flame:
    '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3a2.5 2.5 0 0 0 2.5 2.5Z"/>',
  reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  target:
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  funnel: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  bars: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
  briefcase:
    '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  phone:
    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.7 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.34 1.53.57 2.34.7A2 2 0 0 1 22 16.92z"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  "x-circle": '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
};

/** Render an inline icon by name (empty string for an unknown name). */
function icon(name) {
  const path = ICON_PATHS[name];
  if (!path) return "";
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

const MODE_LABEL = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site", relo: "Relo" };
// Generic Lucide-style glyphs: house = remote, overlapping circles = hybrid,
// office block = on-site, navigation arrow = relocation.
const MODE_ICON_PATHS = {
  remote: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  hybrid: '<circle cx="9" cy="9" r="7"/><circle cx="15" cy="15" r="7"/>',
  onsite:
    '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
  relo: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
};

/** Mode cell: a small icon + label (falls back to plain text for unknown modes). */
function _modeCell(mode) {
  if (!mode) return "—";
  const label = MODE_LABEL[mode] || mode;
  const path = MODE_ICON_PATHS[mode];
  if (!path) return esc(label);
  return `<span class="mode-cell"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>${esc(label)}</span>`;
}

/** Fit band → colour token. Green = strong, orange = medium, purple = stretch. */
function fitColor(n) {
  return n >= 80 ? "var(--green)" : n >= 60 ? "var(--orange)" : "var(--purple)";
}

/** Fit cell: the number plus a band-coloured bar filled to the score. */
function _fitCell(val) {
  if (val === "" || val == null) return "—";
  const n = Number(val);
  if (Number.isNaN(n)) return esc(String(val));
  const c = fitColor(n);
  const w = Math.max(0, Math.min(100, n));
  return `<span class="score"><span class="score-n" style="color:${c}">${esc(n)}</span><span class="score-bar"><i style="width:${w}%;background:${c}"></i></span></span>`;
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

/** Render the hero subtitle inner HTML from an identity object — a segmented
 *  metadata strip (identity · targeting · floor) with small mono labels, not a
 *  run-on prose sentence. Segments are whitespace-separated so the strip wraps
 *  gracefully without manual line breaks. */
function identityLineHtml(identity) {
  if (!identity) return "";
  const segs = [];
  const idInner = [
    identity.name ? `<b>${esc(identity.name)}</b>` : "",
    identity.role ? `<span class="hm-role">${esc(identity.role)}</span>` : "",
  ]
    .filter(Boolean)
    .join(` <span class="hm-dot">·</span> `);
  if (idInner) segs.push(`<span class="hm-seg">${idInner}</span>`);
  if (identity.targets?.length) {
    segs.push(
      `<span class="hm-seg"><span class="hm-k">Targeting</span>${esc(identity.targets.join(", "))}</span>`
    );
  }
  if (identity.floor) {
    const m = /^Floor:\s*(.*)$/.exec(identity.floor);
    segs.push(
      `<span class="hm-seg"><span class="hm-k">Floor</span>${esc(m ? m[1] : identity.floor)}</span>`
    );
  }
  return segs.join("");
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

/**
 * Render the Sankey funnel SVG string from buildFunnel output.
 * All colors come from CSS variable references so both themes work.
 *
 * @param {ReturnType<typeof buildFunnel>} funnel
 * @returns {string}
 */
function renderFunnelSvg(funnel) {
  const { nodes, links } = funnel;
  if (nodes.length === 0) {
    return `<p class="muted funnel-empty">No applications yet.</p>`;
  }

  // SVG layout constants (tuned funnel proportions)
  const H = 500,
    padT = 40,
    padB = 48,
    plotH = H - padT - padB,
    gap = 20,
    nodeW = 4;

  // Build a map: id → node descriptor with layout info
  const nodeMap = {};
  for (const n of nodes) {
    nodeMap[n.id] = { ...n };
  }

  // Columns are data-driven (the heard-back stages now form a left-to-right
  // progression chain), so derive the column set and space them evenly across the
  // plot. col 0 sits at the left edge and the last column at the right — matching
  // the old fixed endpoints (140 … 860) when only three columns exist.
  const cols = [...new Set(nodes.map((n) => n.col))].sort((a, b) => a - b);
  const maxCol = cols[cols.length - 1] || 0;
  const colX = (col) => (maxCol === 0 ? 140 : 140 + (720 * col) / maxCol);

  // For each column, the ids it holds (in declared order).
  const colOrder = {};
  for (const c of cols) colOrder[c] = nodes.filter((n) => n.col === c).map((n) => n.id);

  // Compute scale: fit the tallest column with headroom.
  const colFit = (col) => {
    const ids = colOrder[col].filter((id) => nodeMap[id] && nodeMap[id].value > 0);
    const sum = ids.reduce((a, id) => a + nodeMap[id].value, 0) || 1;
    return (plotH - Math.max(ids.length - 1, 0) * gap) / sum;
  };
  const scale = 0.86 * Math.min(...cols.map(colFit));

  // Assign x, y, h to each node, vertically centring each column.
  const N = {};
  for (const col of cols) {
    const ids = colOrder[col].filter((id) => nodeMap[id] && nodeMap[id].value > 0);
    const total =
      ids.reduce((a, id) => a + nodeMap[id].value, 0) * scale + Math.max(ids.length - 1, 0) * gap;
    let y = padT + (plotH - total) / 2;
    for (const id of ids) {
      const d = nodeMap[id];
      const h = Math.max(d.value * scale, 3);
      N[id] = { ...d, id, x: colX(col), y, h, out: y, in: y };
      y += h + gap;
    }
  }

  const mid = padT + plotH / 2;

  // Render paths, nodes, labels
  let gradDefs = "",
    paths = "",
    nodesSvg = "",
    labelsSvg = "";

  links.forEach((lk, i) => {
    const s = N[lk.s],
      t = N[lk.t];
    if (!s || !t) return;
    const h = lk.value * scale;
    const sy0 = s.out,
      sy1 = s.out + h;
    s.out += h;
    const ty0 = t.in,
      ty1 = t.in + h;
    t.in += h;
    const x0 = s.x + nodeW,
      x1 = t.x,
      mx = (x0 + x1) / 2;

    // Awaiting flows use a fade-out tail
    const fade = lk.t === "awaiting";
    const tailX = fade ? x1 + 50 : x1;
    const lineOff = (x1 - x0) / (tailX - x0);

    // Each ribbon is painted with a per-link linearGradient that fades from the
    // source color to the target color. SVG <stop stop-color> can't read a CSS
    // var() in every browser, so the stops carry gs-src-*/gs-tgt-* class hooks
    // and patchGradientStops() (in the page script) resolves the live token color
    // into stop-color at load and on every theme toggle. data-* attributes feed
    // the hover tooltip; data-colorvar names the token for the tooltip swatch.
    const srcColorClass = `rc-${s.colorVar.replace("--", "")}`;
    const tgtColorVar = t.colorVar;

    gradDefs +=
      `<linearGradient id="ftg${i}" x1="0" y1="0" x2="1" y2="0">` +
      (fade
        ? // Awaiting flows fade from the source color into the awaiting grey
          // (--text-muted) and out, so the ribbon reads grey at the node, not
          // tinted by the source bucket's hue.
          `<stop offset="0" class="gs-src-${s.colorVar.replace("--", "")}" stop-opacity="0.40"/>` +
          `<stop offset="${(lineOff * 0.55).toFixed(3)}" class="gs-tgt-text-muted" stop-opacity="0.40"/>` +
          `<stop offset="${lineOff.toFixed(3)}" class="gs-tgt-text-muted" stop-opacity="0.34"/>` +
          `<stop offset="1" class="gs-tgt-text-muted" stop-opacity="0"/>`
        : `<stop offset="0" class="gs-src-${s.colorVar.replace("--", "")}" stop-opacity="0.42"/>` +
          `<stop offset="1" class="gs-tgt-${t.colorVar.replace("--", "")}" stop-opacity="0.55"/>`) +
      `</linearGradient>`;

    const tailSeg = fade ? ` L${tailX},${ty0} L${tailX},${ty1}` : "";
    paths +=
      `<path class="ribbon ${srcColorClass}" fill="url(#ftg${i})" data-s="${esc(lk.s)}" data-t="${esc(lk.t)}"` +
      ` data-from="${esc(s.label)}" data-to="${esc(t.label)}" data-val="${esc(lk.value)}" data-pct="${esc(lk.pct)}"` +
      ` data-colorvar="${esc(tgtColorVar)}"` +
      ` d="M${x0},${sy0} C${mx},${sy0} ${mx},${ty0} ${x1},${ty0}${tailSeg} L${x1},${ty1} C${mx},${ty1} ${mx},${sy1} ${x0},${sy1} Z"/>`;
  });

  for (const id in N) {
    const n = N[id];
    const cy = n.y + n.h / 2;
    const cx = n.x + nodeW / 2;
    const faint = id === "awaiting";
    const colorClass = `nc-${n.colorVar.replace("--", "")}`;

    nodesSvg += `<rect class="node ${colorClass}" data-id="${esc(id)}" x="${n.x}" y="${n.y}" width="${nodeW}" height="${n.h}" rx="1.5"/>`;

    if (n.col === 0) {
      labelsSvg += `<text class="lbl" data-id="${esc(id)}" x="${n.x - 13}" y="${cy + 4}" text-anchor="end">${esc(n.label)} <tspan class="v">${esc(n.value)}</tspan></text>`;
    } else if (n.col === maxCol) {
      labelsSvg += `<text class="lbl" data-id="${esc(id)}" x="${n.x + nodeW + 13}" y="${cy + 4}" text-anchor="start">${esc(n.label)} <tspan class="v">${esc(n.value)}</tspan></text>`;
    } else {
      const above = cy < mid;
      const ly = above ? n.y - 10 : n.y + n.h + 18;
      labelsSvg += `<text class="lbl" data-id="${esc(id)}"${faint ? ' opacity="0.42"' : ""} x="${cx}" y="${ly}" text-anchor="middle">${esc(n.label)} <tspan class="v">${esc(n.value)}</tspan></text>`;
    }
  }

  // Legend — derived from the actual nodes so it always matches what's drawn
  // (source buckets, then the in-use heard-back stages and rejected).
  const legendItems = [
    ...funnel.sourceBuckets.map((b) => ({ label: b.label, colorVar: b.colorVar })),
    ...nodes.filter((n) => n.col >= 1).map((n) => ({ label: n.label, colorVar: n.colorVar })),
  ];
  const legendHtml = legendItems
    .map(
      (item) =>
        `<span><span class="dot" style="background: var(${item.colorVar})"></span>${esc(item.label)}</span>`
    )
    .join("");

  return `<svg id="sankey" viewBox="0 0 1000 ${H}" aria-label="Application funnel">
<defs>${gradDefs}</defs>
${paths}${nodesSvg}${labelsSvg}
</svg>
<div class="funnel-legend" id="funnel-legend">${legendHtml}</div>`;
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
 * Render the Today action bar HTML from a buildTodayQueue result.
 *
 * @param {{ items: Array, overflow: number }} queue
 * @returns {string}  HTML string for the today bar section
 */
function renderTodayBar(queue) {
  const { items, overflow } = queue;

  const URGENCY_ICON = {
    overdue: "reply",
    due: "bell",
    prep: "chat",
    wait: "bell",
  };

  const URGENCY_CSS = {
    overdue: "tq-overdue",
    due: "tq-due",
    prep: "tq-prep",
    wait: "tq-wait",
  };

  const listHtml =
    items.length === 0
      ? `<div class="today-bar-empty">You're all caught up — nothing needs a reply today.</div>`
      : `<div class="today-bar-list">` +
        items
          .map((item) => {
            const cssClass = URGENCY_CSS[item.urgency] || "tq-wait";
            const iconName = URGENCY_ICON[item.urgency] || "bell";
            const whenStr = esc(item.whenText);
            // Company + role are secondary context now — the action leads the row.
            const ctxStr = item.role
              ? `${esc(item.company)} <span class="tq-dot">·</span> ${esc(item.role)}`
              : esc(item.company);

            // Action affordances: Draft button (if hasDraft or follow-up kind) and Open link
            const actionBtns = [];
            if ((item.hasDraft || item.kind === "follow-up") && item.draftPrompt) {
              const draftCls = item.hasDraft ? "tq-btn tq-btn-draft" : "tq-btn";
              actionBtns.push(
                `<button type="button" class="${draftCls} tq-draft-btn" ` +
                  `data-detail-id="${esc(item.applicationId)}" ` +
                  `data-draft-prompt="${esc(item.draftPrompt)}" ` +
                  `aria-label="Draft follow-up for ${esc(item.company)}">Draft</button>`
              );
            }
            if (item.link) {
              actionBtns.push(
                `<a class="tq-btn" href="${esc(item.link)}" target="_blank" rel="noopener noreferrer" ` +
                  `aria-label="Open ${esc(item.company)} job posting">Open</a>`
              );
            }
            const actionsHtml = actionBtns.length
              ? `<div class="tq-actions">${actionBtns.join("")}</div>`
              : "";

            return (
              `<div class="tq-item ${cssClass}">` +
              `<span class="tq-icon">${icon(iconName)}</span>` +
              `<div class="tq-body">` +
              `<span class="tq-action">${esc(item.action)}</span>` +
              `<span class="tq-ctx">${ctxStr}</span>` +
              `</div>` +
              `<span class="tq-when">${whenStr}</span>` +
              actionsHtml +
              `</div>`
            );
          })
          .join("") +
        `</div>`;

  const totalShown = items.length;
  const overflowHtml =
    overflow > 0 ? `<span class="today-bar-overflow">+${overflow} more</span>` : "";

  return (
    `<div class="today-bar" aria-label="Today action queue">` +
    `<div class="today-bar-head">` +
    `${icon("flame")}` +
    `<span class="today-bar-label">Today</span>` +
    (totalShown > 0
      ? `<span class="today-bar-count">${totalShown}${overflow > 0 ? `+` : ""}</span>`
      : "") +
    overflowHtml +
    `</div>` +
    listHtml +
    `</div>`
  );
}

/**
 * Render the full tracker as a standalone static HTML document.
 * INLINE CSS only — no external assets, no JS frameworks, no CDN links.
 *
 * @param {object} trackerData
 * @param {{ now?: Date|string, title?: string, logoToken?: string }} [opts]
 * @returns {string}  Complete HTML document starting with `<!doctype html>`
 */
export function renderTrackerDashboard(
  trackerData,
  { now, title, logoToken: _logoToken, logos, identity, eyebrow, heading, followUpRules } = {}
) {
  // Strip demo rows once real pipeline data exists
  const cleanedData = stripDemo(trackerData || {});

  // Legacy call sites may still pass logoToken, but avatars now go through the
  // local /api/logos/img cache route with its built-in publishable key.
  const logo = null;

  // Explicit bundled logos keyed by lowercased company name (e.g. demo corps).
  const logoFor = (co) => logos?.[String(co == null ? "" : co).toLowerCase()] || null;

  const applications = cleanedData?.applications || [];
  // Back-compat: legacy tracker files use "prospects"; canonical key is "sourced".
  const sourced = (cleanedData && (cleanedData.sourced || cleanedData.prospects)) || [];
  const communications = cleanedData?.communications || [];
  const sources = cleanedData?.sources || [];

  const _summary = summarizeTracker(cleanedData);
  const stats = buildStats(cleanedData);
  const funnel = buildFunnel(cleanedData);
  const followUps = now ? computeFollowUps(cleanedData, { now, rules: followUpRules }) : [];
  const todayQueue = now
    ? buildTodayQueue(cleanedData, now, followUpRules)
    : { items: [], overflow: 0 };
  const todayBarHtml = renderTodayBar(todayQueue);

  const pageTitle = esc(title || "Rolester — Job Tracker Dashboard");

  // Hero: eyebrow kicker, gradient heading, and a subtitle distilled from the
  // candidate's onboarding. Heading defaults to "Application Tracker"; the long
  // document <title> stays separate for the browser tab.
  const heroEyebrow = esc(eyebrow || "Job Search · Command Center");
  const heroHeading = esc(heading || "Application Tracker");
  const subHtml = identityLineHtml(identity);
  const subSection = subHtml ? `<p class="sub">${subHtml}</p>` : "";

  const nowIso = now ? (now instanceof Date ? now.toISOString() : String(now)) : "";
  // "Updated …" with a live relative time computed client-side from data-iso.
  const updatedHtml = nowIso
    ? `<span class="ts" id="updated" data-iso="${esc(nowIso)}">Updated just now</span>`
    : "";

  const isEmpty =
    applications.length === 0 &&
    sourced.length === 0 &&
    communications.length === 0 &&
    sources.length === 0;

  // ── Stat cards (command-center style) ────────────────────────────────────
  const statCardsData = [
    { label: "In Play", value: stats.inPlay, colorVar: "--accent", ico: "flame" },
    {
      label: "Response Rate",
      value: stats.responseRate,
      suffix: "%",
      colorVar: "--cyan",
      ico: "reply",
    },
    { label: "Interviews", value: stats.interviews, colorVar: "--green", ico: "chat" },
    { label: "Sourced", value: stats.sourced, colorVar: "--purple", ico: "target" },
  ];
  const statCards = statCardsData
    .map(
      ({ label, value, suffix, colorVar, big, ico }) =>
        `<div class="stat${big ? " stat-big" : ""}" style="--stat-c: var(${colorVar})">` +
        `<div class="stat-top">` +
        `<div class="stat-n" data-to="${esc(value)}" data-sfx="${esc(suffix || "")}">0${esc(suffix || "")}</div>` +
        `<span class="stat-ico">${icon(ico)}</span>` +
        `</div>` +
        `<div class="stat-l">${esc(label)}</div>` +
        `</div>`
    )
    .join("\n");

  // ── All Jobs table ────────────────────────────────────────────────────────
  // Reduce a posted comp string ("$180–250K", "$1.2M", "OTE $200-250K") to a
  // single numeric $K value: the TOP of the range, which is the target ask. Used
  // for both the displayed single number and the data-* min-filter attribute.
  // Returns 0 (not omitted) so rows are never hidden by an inactive min filter.
  function baseAskK(str) {
    if (!str) return 0;
    const re = /([\d,]+(?:\.\d+)?)\s*([MmKk]?)/g;
    let m,
      best = 0;
    const strVal = String(str);
    m = re.exec(strVal);
    while (m !== null) {
      const n = parseFloat(m[1].replace(/,/g, ""));
      if (Number.isFinite(n)) {
        const unit = m[2].toLowerCase();
        // Normalise every match to thousands of dollars ($K)
        const k = unit === "m" ? n * 1000 : unit === "k" ? n : n >= 10000 ? n / 1000 : n;
        if (k > best) best = k;
      }
      m = re.exec(strVal);
    }
    return Math.round(best);
  }

  // Build All Jobs rows: applications first, then sourced entries (status="sourced").
  const allJobsRows = [
    ...applications.map((a) => ({ ...a, _isSourced: false })),
    ...sourced.map((p) => ({ ...p, status: "sourced", _isSourced: true })),
  ].map((j) => {
    const co = j.company || j.co || "";
    const role = j.role || "";
    const loc = j.loc || "";
    const modeKey = j.mode || "";
    const modeLabel = modeKey ? MODE_LABEL[modeKey] || modeKey : "—";
    const fitVal = j.fitScore != null ? j.fitScore : j.score != null ? j.score : "";
    const fitN = fitVal !== "" ? Number(fitVal) : 0;
    const statusRaw = j.status || (j._isSourced ? "sourced" : "");
    const stage = j._isSourced ? "awaiting" : classifyApp(j);
    // Status badge is coloured by the resolved pipeline stage (same palette as
    // the funnel + cards) so every label — including multi-word ones like
    // "final round" or "phone screen" — renders as a proper pill, never bare text.
    const stageObj = j._isSourced
      ? { colorVar: "--purple", label: "sourced" }
      : classifyStage(statusRaw, cleanedData.stages);
    const badgeLabel = statusRaw || stageObj.label || "—";

    // data-* attributes for client-side filtering/sorting
    const dataSearch = esc([co, role, loc, j.note || ""].join(" ").toLowerCase());
    const dataBase = baseAskK(j.base);
    const baseAskDisplay = dataBase > 0 ? fmtComp(dataBase * 1000) : "—";
    const dataFit = fitVal !== "" ? fitN : 0;

    // Tooltip payload (same shape as the existing tooltip handler expects)
    const tipObj = {
      company: co,
      role,
      status: statusRaw,
      fit: fitVal !== "" ? String(fitVal) : "—",
      applied: j.appliedAt || "",
      base: j.base || "",
      tc: j.tc || "",
      loc,
      mode: modeLabel,
      channel: j.channel || "",
      note: j.note || "",
      warn: j.warn || "",
    };
    const dataTip = esc(JSON.stringify(tipObj));

    // MODE cell: icon only in the jobs table (accessible title attribute)
    const modePath = MODE_ICON_PATHS[modeKey];
    const modeCell =
      modeKey && modePath
        ? `<td class="jt-mode" title="${esc(modeLabel)}"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${modePath}</svg></td>`
        : `<td class="jt-mode">—</td>`;

    // FIT cell: NN% + band-coloured bar. A "triage" fit (coarse estimate from
    // search-jobs, not yet body-read by evaluate-job) is marked with a "~" and a
    // dotted treatment so a guess never reads as a calibrated evaluation.
    const isTriageFit = j.fitBasis === "triage";
    const fitCellHtml = (() => {
      if (fitVal === "" || fitVal == null) return "—";
      const n = Number(fitVal);
      if (Number.isNaN(n)) return esc(String(fitVal));
      const c = fitColor(n);
      const w = Math.max(0, Math.min(100, n));
      const cls = isTriageFit ? "score triage" : "score";
      const pre = isTriageFit ? "~" : "";
      const tit = isTriageFit ? ' title="Triage estimate — not yet evaluated"' : "";
      return `<span class="${cls}"${tit}><span class="score-n" style="color:${c}">${pre}${esc(n)}%</span><span class="score-bar"><i style="width:${w}%;background:${c}"></i></span></span>`;
    })();

    // Terminal (rejected/withdrawn) rows are hidden from the table by default and
    // revealed by the "Show rejected" toolbar toggle (see #jobs-section.show-rejected).
    const isTerminalRow = !j._isSourced && stageObj && TERMINAL_STAGES.has(stageObj.id);

    return `<tr data-stage="${esc(stage)}" data-status="${esc(statusRaw.toLowerCase())}" data-company="${esc(co.toLowerCase())}" data-role="${esc(role.toLowerCase())}" data-loc="${esc(loc.toLowerCase())}" data-mode="${esc(modeKey.toLowerCase())}" data-fit="${dataFit}" data-base="${dataBase}" data-terminal="${isTerminalRow ? "1" : "0"}" data-search="${dataSearch}" data-tip="${dataTip}" data-detail-id="${esc(j.id || "")}">
  <td>${companyCell(co, j.domain || j.companyDomain, logo, logoFor(co), loc)}</td>
  <td class="jt-role">${esc(role)}</td>
  <td class="num jt-base">${esc(baseAskDisplay)}</td>
  ${modeCell}
  <td class="num jt-fit">${fitCellHtml}</td>
  <td class="jt-status"><span class="badge" style="--sc: var(${stageObj.colorVar})">${esc(badgeLabel)}</span></td>
</tr>`;
  });

  const totalJobs = allJobsRows.length;
  const allJobsTableBody = allJobsRows.join("\n");

  // ── Active Pipeline card grid (computed here so stageChips + groupBlocks
  //    are available for the unified Jobs section template below) ────────────
  // Cards group by pipeline stage, furthest-along first. Applications map via
  // classifyStage(status); sourced entries fold in as the Sourced rung. Terminal stages
  // (rejected/withdrawn) render in the Rejected section below. The candidate's raw
  // status label is preserved on each card — the stage only drives colour +
  // ordering. customStages (cleanedData.stages) can override or mint rungs.
  const customStages = cleanedData?.stages || [];
  const ladder = resolveLadder(customStages);
  const sourcedStage = ladder.byId.sourced;
  const SOURCED_CAP = 9;
  const CARD_CHAN = {
    referral: ["flag", "Referral — warm intro"],
    recruiter: ["chat", "Recruiter outreach"],
    board: ["list", "Job board"],
    portal: ["target", "Company portal"],
  };

  const fitOf = (job) => (job.fitScore != null ? job.fitScore : job.score != null ? job.score : -1);

  // Shared card builder for the active + rejected grids.
  function pipelineCard(job, stage, opts = {}) {
    const co = job.company || job.co || "";
    const role = job.role || "";
    const loc = job.loc || "";
    const modeKey = job.mode || "";
    const modeLabel = modeKey ? MODE_LABEL[modeKey] || modeKey : "";
    const score = job.fitScore != null ? job.fitScore : job.score != null ? job.score : null;
    const sub = [loc, modeLabel].filter(Boolean).join(" · ");

    // Stage pill: the verbatim status label (or the stage label when blank),
    // coloured by the resolved stage.
    const rawLabel = (job.status && String(job.status).trim()) || stage.label;
    const pill = `<span class="spill" style="--sc: var(${stage.colorVar})" title="${esc(rawLabel)}"><span class="sdot"></span><span class="spill-t">${esc(rawLabel)}</span></span>`;

    // Fit chip — keeps the number; "~" + dimmed for triage (pre-evaluation) fits.
    const isTriage = job.fitBasis === "triage";
    const fitChip =
      score != null
        ? `<span class="cfit${isTriage ? " triage" : ""}" style="color:${fitColor(score)}"${isTriage ? ' title="Triage estimate — not yet evaluated"' : ""}>${isTriage ? "~" : ""}${esc(score)}%</span>`
        : "";

    // Comp line (raw posted strings — never current_base).
    let compLine = "";
    const baseStr = job.base ? esc(job.base) : "";
    const tcStr = job.tc ? esc(job.tc) : "";
    if (baseStr || tcStr) {
      const parts = [];
      if (baseStr) parts.push(`<b>${baseStr}</b> base ask`);
      if (tcStr) parts.push(`<span class="sep">·</span> TC ${tcStr}`);
      compLine = `<div class="ccomp">${parts.join(" ")}</div>`;
    }

    const noteLine = job.note ? `<div class="cnote">${esc(job.note)}</div>` : "";

    const chanEntry = CARD_CHAN[job.channel];
    const micParts = [];
    if (chanEntry)
      micParts.push(`<span class="mic" title="${esc(chanEntry[1])}">${icon(chanEntry[0])}</span>`);
    if (job.warn)
      micParts.push(`<span class="mic warn" title="${esc(job.warn)}">${icon("flag")}</span>`);

    const dateStr = job.date || job.appliedAt || "";
    const metaInner = `${fitChip}${micParts.join("")}${dateStr ? `<span class="cdate">${esc(dateStr)}</span>` : ""}`;
    const metaLine = metaInner ? `<div class="cmeta">${metaInner}</div>` : "";

    const tipObj = {
      company: co,
      role,
      status: job.status || "",
      fit: score != null ? String(score) : "—",
      applied: job.appliedAt || job.date || "",
      base: job.base || "",
      tc: job.tc || "",
      loc,
      mode: modeLabel,
      channel: job.channel || "",
      note: job.note || "",
      warn: job.warn || "",
    };
    const dataTip = esc(JSON.stringify(tipObj));
    const cls = `card${opts.rejected ? " rejected" : ""}`;
    const cardSearch = esc([co, role, loc, job.note || ""].join(" ").toLowerCase());

    return `<article class="${cls}" style="--sc: var(${stage.colorVar})" data-stage="${esc(stage.id)}" data-fit="${esc(score != null ? score : 0)}" data-tip="${dataTip}" data-detail-id="${esc(job.id || "")}" data-search="${cardSearch}">
  <div class="chead">${avatarHtml(co, job.domain || job.companyDomain, logo, logoFor(co))}<div class="cmain"><div class="crole">${esc(role)}</div><div class="csub">${esc(sub) || "&nbsp;"}</div></div>${pill}</div>
  ${compLine}${noteLine}${metaLine}
</article>`;
  }

  // Resolve a stage for every pipeline item (apps + sourced entries),
  // excluding terminal stages (those render in the Rejected section).
  const pipelineItems = [
    ...applications.map((a) => ({ job: a, stage: classifyStage(a.status, customStages) })),
    ...sourced.map((p) => ({ job: p, stage: sourcedStage })),
  ].filter((it) => !TERMINAL_STAGES.has(it.stage.id));

  // Group by stage, then order groups furthest-along first (highest order on top).
  const stageGroups = {};
  for (const it of pipelineItems) {
    if (!stageGroups[it.stage.id]) {
      stageGroups[it.stage.id] = { stage: it.stage, items: [] };
    }
    stageGroups[it.stage.id].items.push(it);
  }
  const prepared = Object.values(stageGroups)
    .sort((a, b) => b.stage.order - a.stage.order)
    .map((g) => {
      const sorted = g.items.slice().sort((x, y) => fitOf(y.job) - fitOf(x.job));
      let shown = sorted;
      let more = 0;
      if (g.stage.id === "sourced" && sorted.length > SOURCED_CAP) {
        shown = sorted.slice(0, SOURCED_CAP);
        more = sorted.length - SOURCED_CAP;
      }
      return { stage: g.stage, shown, more };
    });

  const renderedCount = prepared.reduce((n, p) => n + p.shown.length, 0);

  // Pills read left→right as a stage progression (earliest first, Accepted
  // furthest right), so reverse the furthest-first `prepared` order. "All" stays
  // leftmost. The card groups below keep furthest-first so best prospects surface.
  const stageChips = [
    `<button type="button" class="stage-btn on" data-stage="all">All<span class="bn">${renderedCount}</span></button>`,
  ]
    .concat(
      prepared
        .slice()
        .reverse()
        .map(
          (p) =>
            `<button type="button" class="stage-btn" data-stage="${esc(p.stage.id)}" style="--sc: var(${p.stage.colorVar})"><span class="sdot"></span>${esc(p.stage.label)}<span class="bn">${p.shown.length}</span></button>`
        )
    )
    .join("");

  const groupBlocks = prepared
    .map((p) => {
      const cards = p.shown.map((it) => pipelineCard(it.job, p.stage)).join("\n");
      const moreFooter = p.more
        ? `<div class="more-sourced">+${p.more} more sourced — switch to Table view</div>`
        : "";
      return `<div class="stage-group" data-stage="${esc(p.stage.id)}">
  <div class="stage-group-h"><span class="sdot" style="background: var(${p.stage.colorVar})"></span><span class="sg-label">${esc(p.stage.label)}</span><span class="sg-count">${p.shown.length}</span></div>
  <div class="pipeline-grid">${cards}</div>
  ${moreFooter}
</div>`;
    })
    .join("\n");

  // ── Terminal (rejected/withdrawn) pipeline pieces ─────────────────────────
  // Rendered natively in BOTH views (terminal table rows + terminal board groups)
  // but hidden by default; the "Show rejected" toggle reveals them via the
  // #jobs-section.show-rejected class. Built here so the toolbar count + board can
  // reference them. Sorted fit desc within each terminal stage.
  const terminalItems = applications
    .map((a) => ({ job: a, stage: classifyStage(a.status, customStages) }))
    .filter((it) => TERMINAL_STAGES.has(it.stage.id));
  const terminalCount = terminalItems.length;

  const terminalByStage = {};
  for (const it of terminalItems) {
    if (!terminalByStage[it.stage.id]) {
      terminalByStage[it.stage.id] = { stage: it.stage, items: [] };
    }
    terminalByStage[it.stage.id].items.push(it);
  }
  const terminalPrepared = Object.values(terminalByStage)
    .sort((a, b) => a.stage.order - b.stage.order)
    .map((g) => ({
      stage: g.stage,
      shown: g.items.slice().sort((x, y) => fitOf(y.job) - fitOf(x.job)),
    }));

  const terminalChips = terminalPrepared
    .map(
      (p) =>
        `<button type="button" class="stage-btn stage-btn--terminal" data-stage="${esc(p.stage.id)}" style="--sc: var(${p.stage.colorVar})"><span class="sdot"></span>${esc(p.stage.label)}<span class="bn">${p.shown.length}</span></button>`
    )
    .join("");

  const terminalGroupBlocks = terminalPrepared
    .map((p) => {
      const cards = p.shown
        .map((it) => pipelineCard(it.job, p.stage, { rejected: true }))
        .join("\n");
      return `<div class="stage-group stage-group--terminal" data-stage="${esc(p.stage.id)}">
  <div class="stage-group-h"><span class="sdot" style="background: var(${p.stage.colorVar})"></span><span class="sg-label">${esc(p.stage.label)}</span><span class="sg-count">${p.shown.length}</span></div>
  <div class="pipeline-grid">${cards}</div>
</div>`;
    })
    .join("\n");

  // ── Calendar view data ────────────────────────────────────────────────────
  // A month-grid calendar built client-side from real tracker dates only — no
  // fabricated events. Two honest event types: when each role was Applied
  // (appliedAt) and when a follow-up came Due (the same computeFollowUps the
  // Today bar + notification bell use). Interview times aren't a tracked field,
  // so none are invented. Emitted as inert JSON the client script reads.
  const todayYmd = nowIso ? nowIso.slice(0, 10) : "";
  const toYmd = (v) => (v ? String(v).slice(0, 10) : "");
  const linkByAppId = {};
  for (const a of applications) {
    if (a?.id && a.link) linkByAppId[a.id] = a.link;
  }
  const FOLLOWUP_LABEL = {
    "comm-due": "Follow-up due",
    "needs-reply": "Reply needed",
    "waiting-stale": "Gone quiet",
    "app-nudge": "No response yet",
    "post-interview-nudge": "Interview follow-up",
    "thank-you": "Thank-you owed",
  };
  const calendarEvents = [];
  for (const a of applications) {
    const d = toYmd(a?.appliedAt);
    if (!d) continue;
    calendarEvents.push({
      d,
      t: "applied",
      label: "Applied",
      co: a.company || "",
      role: a.role || "",
      link: a.link || "",
    });
  }
  for (const f of followUps) {
    const d = toYmd(f?.dueAt);
    if (!d) continue;
    calendarEvents.push({
      d,
      t: "followup",
      urg: todayYmd && d < todayYmd ? "overdue" : "due",
      label: FOLLOWUP_LABEL[f.kind] || "Follow-up",
      co: f.company || "",
      role: f.role || "",
      link: linkByAppId[f.applicationId] || "",
    });
  }
  calendarEvents.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));
  // Safe inside <script type="application/json">: only "<" can break the tag.
  const calendarJson = JSON.stringify(calendarEvents).replace(/</g, "\\u003c");

  // ── Unified Jobs section (Table ⇄ Board ⇄ Calendar toggle) ────────────────
  // All three representations are rendered in the HTML; the active view is shown
  // via a CSS class on the section wrapper (.jobs-view-table / -board /
  // -calendar). Default: table. The toggle is part of the sticky toolbar.

  const allJobsTable = `<section class="jobs-section" id="jobs-section">
<div class="jobs-sticky-toolbar">
  <div class="jobs-toolbar-left">
    <h2 class="jobs-toolbar-h">${icon("list")}Jobs</h2>
    <span class="jobs-count" id="jobcount">${esc(String(totalJobs))} of ${esc(String(totalJobs))} jobs</span>
  </div>
  <div class="jobs-toolbar-center">
    <input class="tbl-search" id="jobsearch" placeholder="🔍 Search company, role, location, notes…" type="search" autocomplete="off" />
    <button class="tbl-reset" id="jobreset" type="button">Reset</button>
  </div>
  <div class="jobs-toolbar-right">
    ${
      terminalCount > 0
        ? `<button class="rej-toggle" id="rej-toggle" type="button" aria-pressed="false" title="Show rejected &amp; withdrawn roles">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ic"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>Rejected / Withdrawn<span class="rej-n">${esc(String(terminalCount))}</span>
    </button>`
        : ""
    }
    <div class="view-toggle" id="view-toggle" role="group" aria-label="View mode">
      <button class="vt-btn" id="vt-table" type="button" title="Table view" aria-pressed="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ic"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>Table
      </button>
      <button class="vt-btn" id="vt-board" type="button" title="Board view" aria-pressed="false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ic"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>Board
      </button>
      <button class="vt-btn" id="vt-cal" type="button" title="Calendar view" aria-pressed="false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ic"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>Calendar
      </button>
    </div>
  </div>
</div>
<div class="active-filters" id="colfilters"></div>
<div class="jobs-view-wrap jobs-view-table" id="jobs-view-wrap">
  <div class="jobs-table-view">
    <div class="tbl-wrap">
    <table class="jobs" id="jobs-table">
    <colgroup>
      <col class="c-co"><col class="c-role"><col class="c-base"><col class="c-mode"><col class="c-fit"><col class="c-state">
    </colgroup>
    <thead id="jobshead"></thead>
    <tbody id="jobsbody">
    ${allJobsTableBody}
    </tbody>
    </table>
    </div>
  </div>
  <div class="jobs-board-view" id="jobs-board">
    <div class="board-head">
      <div class="stagefilter" id="stagefilter">${stageChips}${terminalChips}</div>
      <span class="jobs-count" id="activec">${renderedCount > 0 ? `${renderedCount} of ${renderedCount}` : "0 of 0"}</span>
    </div>
    <div class="pipeline-groups" id="active">${renderedCount > 0 || terminalCount > 0 ? groupBlocks + terminalGroupBlocks : `<p class="empty">No roles in the active pipeline yet.</p>`}</div>
  </div>
  <div class="jobs-calendar-view" id="jobs-calendar" data-today="${esc(todayYmd)}">
    <div class="cal-toolbar">
      <div class="cal-nav">
        <button class="cal-arrow" id="cal-prev" type="button" aria-label="Previous month">‹</button>
        <span class="cal-title" id="cal-title">—</span>
        <button class="cal-arrow" id="cal-next" type="button" aria-label="Next month">›</button>
        <button class="cal-today-btn" id="cal-today" type="button">Today</button>
      </div>
      <div class="cal-legend">
        <span class="cal-lg"><span class="cal-dot cal-dot--applied"></span>Applied</span>
        <span class="cal-lg"><span class="cal-dot cal-dot--due"></span>Due</span>
        <span class="cal-lg"><span class="cal-dot cal-dot--overdue"></span>Overdue</span>
      </div>
    </div>
    <div class="cal-weekdays"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>
    <div class="cal-grid" id="cal-grid"></div>
    <script type="application/json" id="cal-data">${calendarJson}</script>
  </div>
</div>
</section>`;

  // ── No-data message ───────────────────────────────────────────────────────
  const noDataSection = isEmpty
    ? `<div class="no-data"><p>No tracker data yet. Add applications, sourced roles, and communications to get started.</p></div>`
    : "";

  // ── Needs Attention section ───────────────────────────────────────────────
  // Build a lookup from job id → job record so avatars can resolve the domain.
  const jobById = {};
  for (const job of [...applications, ...sourced]) {
    if (job.id) jobById[job.id] = job;
  }

  const KIND_META = {
    "comm-due": { iconName: "bell", label: "Follow-up due" },
    "needs-reply": { iconName: "reply", label: "Reply needed" },
    "waiting-stale": { iconName: "bell", label: "Gone quiet" },
    "app-nudge": { iconName: "flame", label: "No response yet" },
    "post-interview-nudge": { iconName: "chat", label: "Interview gone quiet" },
    "thank-you": { iconName: "mail", label: "Thank-you owed" },
  };

  // ── Notification panel items (replaces inline attention section) ─────────
  const notifCount = followUps.length;
  const notifItems = followUps
    .map((fu) => {
      const urgency = fu.overdueDays > 0 ? "overdue" : "due";
      const whenText = fu.overdueDays > 0 ? `${fu.overdueDays}d overdue` : "due today";
      const meta = KIND_META[fu.kind] || { iconName: "bell", label: fu.kind };

      const linkedJob = fu.applicationId ? jobById[fu.applicationId] : null;
      const jobDomain = linkedJob ? linkedJob.domain || linkedJob.companyDomain || "" : "";
      const avatarSpan = avatarHtml(fu.company, jobDomain, logo, logoFor(fu.company));

      const reasonLine = fu.reason
        ? `<span class="att-reason">${icon(meta.iconName)}${esc(fu.reason)}</span>`
        : "";

      const whenChip = `<span class="att-when" data-due="${esc(fu.dueAt)}" data-overdue="${esc(String(fu.overdueDays))}">${esc(whenText)}</span>`;

      // Draft section
      let draftHtml = "";
      if (fu.draft) {
        const openJobBtn = fu.applicationId
          ? `<button class="notif-act notif-open-job" data-detail-id="${esc(fu.applicationId)}" type="button">Open job</button>`
          : "";
        draftHtml =
          `<div class="notif-draft">` +
          `<div class="notif-subj">${esc(fu.draft.subject)}</div>` +
          `<pre class="notif-body">${esc(fu.draft.body)}</pre>` +
          `<div class="notif-actions">` +
          `<button class="notif-act notif-copy" type="button">Copy</button>` +
          `<button class="notif-act notif-mail" type="button">Open in mail</button>` +
          openJobBtn +
          `</div>` +
          `</div>`;
      } else {
        const openJobBtn = fu.applicationId
          ? `<button class="notif-act notif-open-job" data-detail-id="${esc(fu.applicationId)}" type="button">Open job</button>`
          : "";
        draftHtml =
          `<div class="notif-draft">` +
          `<div class="notif-nodraft">No draft yet — ask the agent to draft a follow-up.</div>` +
          (openJobBtn ? `<div class="notif-actions">${openJobBtn}</div>` : ``) +
          `</div>`;
      }

      // Prompt that the Draft button copies to clipboard.
      const draftPrompt = fu.role
        ? `Draft the follow-up email for ${fu.company} — ${fu.role}`
        : `Draft the follow-up email for ${fu.company}`;

      return (
        `<div class="att-item att-${esc(urgency)} notif-item" data-detail-id="${esc(fu.applicationId || "")}" data-draft-company="${esc(fu.company)}" data-draft-role="${esc(fu.role || "")}" data-draft-prompt="${esc(draftPrompt)}">` +
        `<button type="button" class="notif-item-head">` +
        `${avatarSpan}` +
        `<div class="att-main"><span class="att-co">${esc(fu.company)}</span>` +
        (fu.role ? ` <span class="att-role">${esc(fu.role)}</span>` : ``) +
        (reasonLine ? `<br>${reasonLine}` : ``) +
        `</div>` +
        `${whenChip}` +
        `<span class="notif-chev">›</span>` +
        `</button>` +
        `<div class="notif-item-bar">` +
        `<button type="button" class="att-draft-btn" aria-label="Copy draft prompt for ${esc(fu.company)}">Draft</button>` +
        `</div>` +
        draftHtml +
        `</div>`
      );
    })
    .join("\n");

  const notifPanelBody =
    notifCount > 0
      ? `<div class="notif-list">${notifItems}</div>`
      : `<div class="notif-empty">You’re all caught up.</div>`;

  const notifBadge = notifCount > 0 ? `<span class="notif-badge">${notifCount}</span>` : "";

  const notifControl =
    `<div class="notif-wrap">` +
    `<button id="notif-bell" class="notif-bell" type="button" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">` +
    `${icon("bell")}${notifBadge}` +
    `</button>` +
    `<div id="notif-panel" class="notif-panel" role="dialog" aria-label="Needs Attention">` +
    `<div class="notif-head">` +
    `<h3>${icon("bell")}Needs Attention</h3>` +
    `<span class="jobs-count">${notifCount}</span>` +
    `<button id="notif-close" class="notif-close" type="button" aria-label="Close">\xd7</button>` +
    `</div>` +
    notifPanelBody +
    `</div>` +
    `</div>`;

  // ── Funnel section ────────────────────────────────────────────────────────
  const funnelSvgContent = renderFunnelSvg(funnel);
  const funnelSection = `<section class="funnel-section">
<h2>${icon("funnel")}The Funnel</h2>
${funnelSvgContent}
</section>`;

  // ── Detail map (keyed by job id, for the company-click modal) ───────────
  // Build a lookup from applicationId → array of email messages (sorted by at).
  const commsByAppId = {};
  for (const comm of communications) {
    if (!comm.applicationId) continue;
    const id = comm.applicationId;
    if (!commsByAppId[id]) commsByAppId[id] = [];
    if (comm.messages?.length) {
      for (const msg of comm.messages) {
        commsByAppId[id].push({
          direction: msg.direction || "",
          at: msg.at || "",
          from: msg.from || "",
          to: msg.to || "",
          subject: msg.subject || "",
          summary: msg.summary || "",
        });
      }
    } else {
      // Synthesize a single "note" entry from comm-level fields
      commsByAppId[id].push({
        direction: "note",
        at: comm.nextActionDue || "",
        from: "",
        to: "",
        subject: comm.subject || "",
        summary: comm.summary || "",
      });
    }
  }
  // Sort each email list ascending by `at`
  for (const id in commsByAppId) {
    commsByAppId[id].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  // Build the detail map for all jobs (applications + sourced)
  const detailMap = {};
  for (const job of [...applications, ...sourced]) {
    if (!job.id) continue;
    const arts = job.artifacts || {};
    detailMap[job.id] = {
      id: job.id,
      company: job.company || job.co || "",
      role: job.role || "",
      domain: job.domain || job.companyDomain || "",
      status: job.status || (job.fitBasis === "triage" ? "sourced" : ""),
      fit: job.fitScore != null ? job.fitScore : job.score != null ? job.score : "",
      fitBasis: job.fitBasis || "",
      applied: job.appliedAt || job.date || "",
      base: job.base || "",
      tc: job.tc || "",
      loc: job.loc || "",
      mode: job.mode || "",
      channel: job.channel || "",
      warn: job.warn || "",
      note: job.note || "",
      link: job.link || "",
      artifacts: {
        jd: arts.jd || arts.jobDescription || "",
        coverLetter: arts.coverLetter || "",
        resume: arts.resume || "",
        resumeNote: arts.resumeNote || "",
      },
      emails: commsByAppId[job.id] || [],
      conversations: job.conversations || [],
    };
  }
  const jobDetailsJson = JSON.stringify(detailMap)
    .replace(/</g, "\\u003c")
    .replace(/&/g, "\\u0026");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<link rel="icon" type="image/png" href="${BRAND_LOGO_SRC}">
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="hero">
<img class="brand-logo" src="${BRAND_LOGO_SRC}" alt="Rolester">
<div class="hero-text">
<div class="eyebrow">${heroEyebrow}</div>
<h1>${heroHeading}</h1>
${subSection}
</div>
<div class="hero-actions">
${updatedHtml}
${notifControl}
<select id="theme-select" class="theme-select" aria-label="Dashboard color theme" title="Color theme (use the ☀/☾ button for light/dark)">
<option value="original">Original</option>
<option value="spinel">Spinel</option>
<option value="slate">Slate &amp; Coral</option>
<option value="box">Box (HTB)</option>
<option value="tokyonight">Tokyo Night</option>
<option value="gruvbox">Gruvbox</option>
</select>
<button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle light/dark theme" title="Toggle theme">
<svg class="icon-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
<svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
</button>
</div>
</header>
${noDataSection}
<div class="stats">
${statCards}
</div>
${todayBarHtml}
${funnelSection}
${allJobsTable}
</div>
<script type="application/json" id="job-details">${jobDetailsJson}</script>
<div id="job-modal" role="dialog" aria-modal="true" aria-label="Job detail">
  <div id="job-modal-panel">
    <button id="job-modal-close" type="button" aria-label="Close">&times;</button>
    <div id="job-modal-body"></div>
  </div>
</div>
<div class="fteip" id="funnel-tip"></div>
<div class="jobtip" id="job-tip"></div>
<script>${DASHBOARD_SCRIPT}</script>
</body>
</html>`;
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
