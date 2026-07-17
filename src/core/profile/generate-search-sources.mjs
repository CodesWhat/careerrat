import { buildWellfoundUrl } from "../providers/wellfound.mjs";

// Generate a search-sources configuration object from targeting + profile.
// Validates against config/search-sources.schema.json.

// ---------------------------------------------------------------------------
// Domain board registry
// Tech boards (RemoteVibeCodingJobs) are included when the candidate's domain
// is explicitly configured as a tech domain. An explicit NON-tech domain is
// authoritative and is never overridden by title inference below. Only when
// candidate.domain is absent or empty (resume extraction commonly leaves it
// blank — see .agents/skills/resume-extract/SKILL.md) do we fall back to
// inferTechFromTargeting(): a keyword heuristic over the candidate's OWN
// configured targeting titles (never a hardcoded personal/tech default —
// see the repo's domain-neutrality rule). Only when NEITHER an explicit
// tech domain NOR tech-shaped titles are present do we generate general
// aggregators only (HiringCafe / LinkedIn / Google Jobs).
// ---------------------------------------------------------------------------

const TECH_DOMAINS = new Set([
  "software engineering",
  "software",
  "engineering",
  "tech",
  "technology",
]);

// Keyword heuristic for role_buckets[].titles — deliberately broad (covers
// engineering, data, ML/AI, and infra-adjacent titles) since it only decides
// whether to seed tech-only boards as enabled-by-default, never whether to
// omit/include general aggregators.
const TECH_TITLE_RE =
  /\b(engineer(ing)?|developer|software|devops|sre|data|machine learning|ml|ai|cloud|platform|infrastructure|systems?|architect)\b/i;

function isTechDomain(domain = "") {
  const lower = String(domain || "")
    .toLowerCase()
    .trim();
  // Absent/empty domain → not tech; caller gets only general aggregators.
  if (!lower) return false;
  // Exact match or starts-with for compound domains like "software engineering / data"
  return TECH_DOMAINS.has(lower) || lower.startsWith("software") || lower.startsWith("tech");
}

// Fallback used only when candidate.domain is absent/empty: collect every
// title across every role bucket (duplicates count — a title repeated across
// buckets is a stronger signal, not noise) and require a strict MAJORITY
// (more than half, and at least one title total) to look tech-shaped before
// defaulting tech-only boards on. Zero titles configured → false, same as
// the empty-domain case this replaces.
function inferTechFromTargeting(targeting) {
  const titles = [];
  for (const bucket of targeting?.role_buckets ?? []) {
    for (const title of bucket?.titles ?? []) {
      if (typeof title === "string" && title) titles.push(title);
    }
  }
  if (titles.length === 0) return false;
  const techMatches = titles.filter((title) => TECH_TITLE_RE.test(title)).length;
  return techMatches > titles.length / 2;
}

function generatedRecency(targeting) {
  const postingAge = targeting?.search_preferences?.posting_age;
  if (postingAge?.mode === "fixed-days") {
    const days = Number(postingAge.days);
    if (Number.isFinite(days) && days > 0) {
      return {
        mode: "fixed-hours",
        hours: Math.round(days * 24 * 100) / 100,
        safetyMinutes: 30,
      };
    }
  }
  return {
    mode: "since-last-run",
    safetyMinutes: 30,
  };
}

/**
 * buildSearchSources(targeting, profile) → plain JS object valid against search-sources.schema.json.
 *
 * @param {object} targeting - Rolester targeting config (role_buckets, keep_signals, cut_signals, …)
 * @param {object} profile   - Rolester candidate profile (candidate, compensation, location, …)
 * @returns {object}
 */
export function buildSearchSources(targeting, profile) {
  // --- title_filter ---
  const seenTitles = new Set();
  const positiveTitles = [];
  for (const bucket of targeting.role_buckets ?? []) {
    for (const title of bucket.titles ?? []) {
      if (!seenTitles.has(title)) {
        seenTitles.add(title);
        positiveTitles.push(title);
      }
    }
  }

  // 7.4: derive negatives from targeting.cut_signals when present;
  // Intern/Junior are universal noise filters always included.
  const universalNegatives = ["Intern", "Junior"];
  const cutSignals = targeting.cut_signals ?? [];
  const derivedNegatives =
    cutSignals.length > 0 ? cutSignals.filter((s) => typeof s === "string" && s.length > 0) : [];
  // Merge: universal first, then derived (deduped)
  const negativeSet = new Set([...universalNegatives, ...derivedNegatives]);
  const title_filter = {
    positive: positiveTitles,
    negative: [...negativeSet],
  };

  // --- location_filter ---
  const loc = profile.location ?? {};
  const allowSet = new Set();
  if (loc.remote) allowSet.add("Remote");
  if (loc.home) allowSet.add(loc.home);
  for (const city of loc.relocation ?? []) {
    if (city) allowSet.add(city);
  }

  const location_filter = {
    always_allow: [],
    allow: [...allowSet],
    block: [],
  };

  // --- searches ---
  // 7.2: board selection is domain-keyed.
  // HiringCafe is a general aggregator included for all domains.
  // RemoteVibeCodingJobs is a tech-specific aggregator included only for tech domains.
  const domain = profile.candidate?.domain ?? "";
  const hasExplicitDomain = String(domain || "").trim().length > 0;
  // Explicit domain always decides (including an explicit non-tech domain —
  // never overridden by title inference); only an absent/empty domain falls
  // back to reading the candidate's own configured titles.
  const techDomain = hasExplicitDomain ? isTechDomain(domain) : inferTechFromTargeting(targeting);

  // One HiringCafe entry per deduplicated title (order-preserved across buckets).
  const searches = [];
  const seenSearchTitles = new Set();
  const recency = generatedRecency(targeting);
  for (const bucket of targeting.role_buckets ?? []) {
    for (const title of bucket.titles ?? []) {
      if (!seenSearchTitles.has(title)) {
        seenSearchTitles.add(title);
        searches.push({
          provider: "HiringCafe",
          source_type: "url-query",
          label: title,
          query: title,
          enabled: true,
          recency: { ...recency },
          searchState: {
            sortBy: "date",
          },
        });
      }
    }
  }

  // Tech-only aggregator: RemoteVibeCodingJobs.
  // Omit when domain is explicitly non-tech rather than emitting a nonsensical RSS entry.
  if (techDomain) {
    // Determine query: first primary-bucket title, or first title overall, or tech fallback.
    let aggregatorQuery = "AI engineer";
    for (const bucket of targeting.role_buckets ?? []) {
      if (bucket.priority === "primary" && bucket.titles?.length) {
        aggregatorQuery = bucket.titles[0];
        break;
      }
    }
    if (aggregatorQuery === "AI engineer" && positiveTitles.length > 0) {
      aggregatorQuery = positiveTitles[0];
    }

    searches.push({
      provider: "RemoteVibeCodingJobs",
      source_type: "url-query",
      label: "Remote Vibe Coding Jobs",
      query: aggregatorQuery,
      rssUrl: "https://remotevibecodingjobs.com/feed.xml",
      enabled: true,
    });

    // Tech-only aggregator: Wellfound (startup/tech-leaning marketplace).
    // Respects the candidate's location preference: remote=true → /role/r/{slug},
    // onsite with home city → /role/l/{slug}/{loc}, otherwise /role/{slug}.
    searches.push({
      provider: "Wellfound",
      source_type: "browser",
      label: "Wellfound",
      url: buildWellfoundUrl({
        role: aggregatorQuery,
        remote: !!loc.remote,
        location: !loc.remote && loc.home ? loc.home : undefined,
      }),
      enabled: true,
    });
  }

  // Board-wide aggregator feeds (RemoteOK / Remotive / Working Nomads): unlike
  // RemoteVibeCodingJobs/Wellfound above (tech-only, omitted entirely for other
  // domains), these three are seeded for EVERY domain so a fresh install always
  // has at least one working deterministic source (see AGENTS.md's
  // deterministic-first-search contract) — just enabled by default only for
  // tech domains. Any domain can flip one on in config/search-sources.yml;
  // title_filter/location_filter narrow the broad feed the same way they
  // narrow every other sourced-scan lane. `provider` values are lowercase to
  // match sourced-scanner.mjs's BOARD_PROVIDERS registry keys exactly.
  // `enabled_reason: "domain-gate"` marks these three as machine-set by this
  // domain/title gate (not a user's own toggle) — first-search-run.mjs's
  // mergeSearchSources reads that marker to re-sync `enabled` from a fresh
  // regeneration even when a stored copy already exists on disk, so a stale
  // enabled:false from an earlier run (e.g. before candidate.domain/titles
  // told this gate to turn tech boards on) doesn't shadow it forever.
  const boardAggregators = [
    { provider: "remoteok", label: "RemoteOK", url: "https://remoteok.com/api" },
    { provider: "remotive", label: "Remotive", url: "https://remotive.com/api/remote-jobs" },
    {
      provider: "workingnomads",
      label: "Working Nomads",
      url: "https://www.workingnomads.com/api/exposed_jobs/",
    },
  ];
  for (const board of boardAggregators) {
    searches.push({
      provider: board.provider,
      source_type: "board",
      label: board.label,
      url: board.url,
      enabled: techDomain,
      enabled_reason: "domain-gate",
    });
  }

  // --- source_catalog (fixed reference) ---
  const source_catalog = {
    aggregators: ["HiringCafe", "RemoteVibeCodingJobs", "Wellfound", "LinkedIn", "Google Jobs"],
    ats: ["Ashby", "Greenhouse", "Lever", "Workable", "SmartRecruiters", "Recruitee", "Workday"],
    remote_boards: ["RemoteOK", "Jobicy", "Working Nomads", "We Work Remotely", "Remotive"],
  };

  return {
    title_filter,
    location_filter,
    searches,
    tracked_companies: [],
    source_catalog,
  };
}
