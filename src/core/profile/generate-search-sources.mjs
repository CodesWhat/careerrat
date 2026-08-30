import { CAREER_OPS_PUBLIC_PROVIDER_IDS } from "../providers/provider-parity.mjs";
import { buildWellfoundUrl } from "../providers/wellfound.mjs";
import { titlesBelowTarget } from "./seniority.mjs";

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
// aggregators only, including the zero-auth Arbeitnow feed used as the
// deterministic first-search floor.
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

const MAX_HOSPITALITY_QUERY_TITLES = 4;
const HOSPITALITY_RESULTS_PER_QUERY = 8;
const HOSPITALITY_DOMAIN_RE =
  /\b(hospitality|food service|food and beverage|restaurant|hotel|lodging|catering|nightlife|bar operations|event operations|venue operations)\b/i;
const HOSPITALITY_TITLE_RE =
  /\b(bartender|barback|bar manager|cocktail server|restaurant server|banquet server|waiter|waitress|hostess?|cook|chef|kitchen|restaurant|hospitality|hotel|guest service|front desk|food and beverage|banquet|catering|event operations|venue operations|sommelier|concierge|housekeeping|reservations?|beverage)\b/i;

// General geo vocabulary used only to interpret the candidate's own location
// strings. This is deliberately data-driven: no candidate locale is a default,
// and adding recognition means adding a country/region row rather than branching
// on a particular person's city.
const COUNTRY_DEFINITIONS = [
  {
    name: "United States",
    aliases: ["USA", "U.S.", "U.S.A.", "US"],
    regions: ["North America", "Americas"],
  },
  { name: "Canada", aliases: [], regions: ["North America", "Americas"] },
  { name: "Mexico", aliases: [], regions: ["North America", "Latin America", "Americas"] },
  { name: "Brazil", aliases: [], regions: ["Latin America", "Americas"] },
  { name: "Argentina", aliases: [], regions: ["Latin America", "Americas"] },
  { name: "Chile", aliases: [], regions: ["Latin America", "Americas"] },
  { name: "Colombia", aliases: [], regions: ["Latin America", "Americas"] },
  {
    name: "United Kingdom",
    aliases: ["UK", "U.K.", "England", "Scotland", "Wales", "Northern Ireland"],
    regions: ["Europe", "EMEA"],
  },
  { name: "Ireland", aliases: [], regions: ["Europe", "EMEA"] },
  { name: "France", aliases: [], regions: ["Europe", "EMEA"] },
  { name: "Germany", aliases: [], regions: ["Europe", "EMEA"] },
  { name: "Spain", aliases: [], regions: ["Europe", "EMEA"] },
  { name: "Italy", aliases: [], regions: ["Europe", "EMEA"] },
  { name: "Netherlands", aliases: ["Holland"], regions: ["Europe", "EMEA"] },
  { name: "Poland", aliases: [], regions: ["Europe", "EMEA"] },
  { name: "Portugal", aliases: [], regions: ["Europe", "EMEA"] },
  { name: "Sweden", aliases: [], regions: ["Europe", "EMEA"] },
  { name: "Norway", aliases: [], regions: ["Europe", "EMEA"] },
  { name: "Denmark", aliases: [], regions: ["Europe", "EMEA"] },
  { name: "Switzerland", aliases: [], regions: ["Europe", "EMEA"] },
  { name: "India", aliases: [], regions: ["Asia-Pacific"] },
  { name: "China", aliases: [], regions: ["Asia-Pacific"] },
  { name: "Japan", aliases: [], regions: ["Asia-Pacific"] },
  { name: "South Korea", aliases: ["Korea"], regions: ["Asia-Pacific"] },
  { name: "Singapore", aliases: [], regions: ["Asia-Pacific"] },
  { name: "Taiwan", aliases: [], regions: ["Asia-Pacific"] },
  { name: "Philippines", aliases: ["The Philippines"], regions: ["Asia-Pacific"] },
  { name: "Indonesia", aliases: [], regions: ["Asia-Pacific"] },
  { name: "Vietnam", aliases: [], regions: ["Asia-Pacific"] },
  { name: "Australia", aliases: [], regions: ["Asia-Pacific"] },
  { name: "New Zealand", aliases: [], regions: ["Asia-Pacific"] },
  { name: "Israel", aliases: [], regions: ["Middle East", "EMEA"] },
  { name: "United Arab Emirates", aliases: ["UAE", "U.A.E."], regions: ["Middle East", "EMEA"] },
  { name: "Saudi Arabia", aliases: [], regions: ["Middle East", "EMEA"] },
  { name: "South Africa", aliases: [], regions: ["Africa", "EMEA"] },
  { name: "Nigeria", aliases: [], regions: ["Africa", "EMEA"] },
  { name: "Kenya", aliases: [], regions: ["Africa", "EMEA"] },
];

const REGION_DEFINITIONS = [
  { name: "North America", aliases: [] },
  { name: "Latin America", aliases: ["LATAM"] },
  { name: "Americas", aliases: [] },
  { name: "Europe", aliases: ["European Union"] },
  { name: "Asia-Pacific", aliases: ["Asia Pacific", "APAC"] },
  { name: "Middle East", aliases: [] },
  { name: "Africa", aliases: [] },
  { name: "EMEA", aliases: [] },
];

// Common locality abbreviations that do not carry a state/country marker.
// Recognizing one only establishes its country/region for the broad source
// filter. The scanner's commute-area check still decides whether a specific
// non-remote offer is local enough.
const LOCALITY_COUNTRY_ALIASES = [
  {
    country: "United States",
    aliases: [
      "NYC",
      "New York City",
      "New York Metropolitan Area",
      "New York Metro Area",
      "NY Metro",
    ],
  },
];

const US_STATES = [
  ["Alabama", "AL"],
  ["Alaska", "AK"],
  ["Arizona", "AZ"],
  ["Arkansas", "AR"],
  ["California", "CA"],
  ["Colorado", "CO"],
  ["Connecticut", "CT"],
  ["Delaware", "DE"],
  ["Florida", "FL"],
  ["Georgia", "GA"],
  ["Hawaii", "HI"],
  ["Idaho", "ID"],
  ["Illinois", "IL"],
  ["Indiana", "IN"],
  ["Iowa", "IA"],
  ["Kansas", "KS"],
  ["Kentucky", "KY"],
  ["Louisiana", "LA"],
  ["Maine", "ME"],
  ["Maryland", "MD"],
  ["Massachusetts", "MA"],
  ["Michigan", "MI"],
  ["Minnesota", "MN"],
  ["Mississippi", "MS"],
  ["Missouri", "MO"],
  ["Montana", "MT"],
  ["Nebraska", "NE"],
  ["Nevada", "NV"],
  ["New Hampshire", "NH"],
  ["New Jersey", "NJ"],
  ["New Mexico", "NM"],
  ["New York", "NY"],
  ["North Carolina", "NC"],
  ["North Dakota", "ND"],
  ["Ohio", "OH"],
  ["Oklahoma", "OK"],
  ["Oregon", "OR"],
  ["Pennsylvania", "PA"],
  ["Rhode Island", "RI"],
  ["South Carolina", "SC"],
  ["South Dakota", "SD"],
  ["Tennessee", "TN"],
  ["Texas", "TX"],
  ["Utah", "UT"],
  ["Vermont", "VT"],
  ["Virginia", "VA"],
  ["Washington", "WA"],
  ["West Virginia", "WV"],
  ["Wisconsin", "WI"],
  ["Wyoming", "WY"],
  ["District of Columbia", "DC"],
];

function compactGeoValues(values) {
  const seen = new Set();
  return values
    .filter((value) => {
      const text = String(value || "").trim();
      const key = text.toLowerCase();
      if (!text || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((value) => String(value).trim());
}

function normalizeGeoText(value) {
  return ` ${String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

function containsGeoTerm(value, term) {
  const needle = normalizeGeoText(term).trim();
  return Boolean(needle) && normalizeGeoText(value).includes(` ${needle} `);
}

function hasUsState(value) {
  const text = String(value || "");
  return US_STATES.some(([name, abbreviation]) => {
    if (containsGeoTerm(text, name)) return true;
    return new RegExp(`(?:^|,\\s*)${abbreviation}(?:$|[,/\\s])`, "i").test(text);
  });
}

function countryTerms(country) {
  const terms = [country.name, ...country.aliases];
  if (country.name === "United States") {
    for (const [state, abbreviation] of US_STATES) terms.push(state, `, ${abbreviation}`);
  }
  return terms;
}

function deriveLocationFilter(profile = {}) {
  const loc = profile.location ?? {};
  const worldwideRemote = loc.remote === true && loc.remote_scope === "worldwide";
  const places = compactGeoValues([loc.home, ...(loc.relocation ?? [])]);
  const allowedCountries = new Set();
  const allowedRegions = new Set();
  const allowedLocalityAliases = new Set();

  for (const place of places) {
    for (const country of COUNTRY_DEFINITIONS) {
      if ([country.name, ...country.aliases].some((term) => containsGeoTerm(place, term))) {
        allowedCountries.add(country.name);
      }
    }
    if (hasUsState(place)) allowedCountries.add("United States");
    for (const locality of LOCALITY_COUNTRY_ALIASES) {
      if (locality.aliases.some((term) => containsGeoTerm(place, term))) {
        allowedCountries.add(locality.country);
        for (const alias of locality.aliases) allowedLocalityAliases.add(alias);
      }
    }
    for (const region of REGION_DEFINITIONS) {
      if ([region.name, ...region.aliases].some((term) => containsGeoTerm(place, term))) {
        allowedRegions.add(region.name);
      }
    }
  }

  for (const country of COUNTRY_DEFINITIONS) {
    if (country.regions.some((region) => allowedRegions.has(region))) {
      allowedCountries.add(country.name);
    }
  }
  for (const country of COUNTRY_DEFINITIONS) {
    if (allowedCountries.has(country.name)) {
      for (const region of country.regions) allowedRegions.add(region);
    }
  }

  const allow = [...places, ...allowedLocalityAliases];
  if (loc.remote) allow.push("Remote", "Worldwide", "Anywhere", "Global");
  for (const country of COUNTRY_DEFINITIONS) {
    if (allowedCountries.has(country.name)) allow.push(...countryTerms(country));
  }
  for (const region of REGION_DEFINITIONS) {
    if (allowedRegions.has(region.name)) allow.push(region.name, ...region.aliases);
  }

  const block = [];
  if (places.length > 0 && !worldwideRemote) {
    for (const country of COUNTRY_DEFINITIONS) {
      if (!allowedCountries.has(country.name)) block.push(...countryTerms(country));
    }
    for (const region of REGION_DEFINITIONS) {
      if (!allowedRegions.has(region.name)) block.push(region.name, ...region.aliases);
    }
  }

  return {
    always_allow: places,
    allow: compactGeoValues(allow),
    block: compactGeoValues(block),
    needs_location: places.length === 0 && !loc.remote,
  };
}

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

function hospitalityTarget(targeting, domain) {
  const explicitDomain = String(domain || "").trim();
  if (explicitDomain) return HOSPITALITY_DOMAIN_RE.test(explicitDomain);
  return (targeting?.role_buckets || []).some((bucket) =>
    (bucket?.titles || []).some((title) => HOSPITALITY_TITLE_RE.test(String(title || "")))
  );
}

function boundedHospitalityTitles(roleBuckets, { inferred } = {}) {
  const queries = [];
  const seen = new Set();
  const buckets = (roleBuckets || []).map((bucket) => bucket?.titles || []);
  const cursors = buckets.map(() => 0);

  while (queries.length < MAX_HOSPITALITY_QUERY_TITLES) {
    let added = false;
    for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex += 1) {
      while (cursors[bucketIndex] < buckets[bucketIndex].length) {
        const value = buckets[bucketIndex][cursors[bucketIndex]];
        cursors[bucketIndex] += 1;
        const title = String(value || "").trim();
        const key = title.toLowerCase();
        if (!title || seen.has(key) || (inferred && !HOSPITALITY_TITLE_RE.test(title))) continue;
        seen.add(key);
        queries.push(title);
        added = true;
        break;
      }
      if (queries.length === MAX_HOSPITALITY_QUERY_TITLES) break;
    }
    if (!added) break;
  }
  return queries;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function usLocationParts(value) {
  let text = String(value || "").trim();
  text = text.replace(/,\s*(?:united states(?: of america)?|u\.?s\.?(?:a\.?)?)$/i, "").trim();
  if (/^(?:nyc|new york city)$/i.test(text)) text = "New York, NY";
  const match = text.match(/^(.*?),\s*([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/);
  if (!match) return null;
  const state = US_STATES.find(([, abbreviation]) => abbreviation === match[2].toUpperCase());
  if (!state) return null;
  const rawCity = match[1].trim();
  const city = /^(?:nyc|new york city)$/i.test(rawCity) ? "New York" : rawCity;
  const citySlug = slugify(city);
  return {
    queryLocation: `${city}, ${state[1]}`,
    citySlug: `${citySlug}-${state[1].toLowerCase()}`,
    stateNameSlug: slugify(state[0]),
  };
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
 * @param {object} targeting - CareerRat targeting config (role_buckets, keep_signals, cut_signals, …)
 * @param {object} profile   - CareerRat candidate profile (candidate, compensation, location, …)
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

  // Existing profiles without an explicit occupation ladder retain the
  // conventional engineering noise filters. Once the candidate defines a
  // ranked ladder, its own below-target vocabulary replaces those defaults.
  const seniority = titlesBelowTarget(targeting);
  const legacyNegatives = seniority.configured ? [] : ["Intern", "Junior"];
  const cutSignals = targeting.cut_signals ?? [];
  const derivedNegatives =
    cutSignals.length > 0 ? cutSignals.filter((s) => typeof s === "string" && s.length > 0) : [];
  const negativeSet = new Set([...legacyNegatives, ...derivedNegatives]);
  const title_filter = {
    positive: positiveTitles,
    negative: [...negativeSet],
    below_target: seniority.titles,
    seniority_basis: seniority.configured ? "candidate-ladder" : "legacy-title-terms",
  };

  // --- location_filter ---
  const loc = profile.location ?? {};
  const location_filter = deriveLocationFilter(profile);

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
  const hospitalityDomain = hospitalityTarget(targeting, domain);

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
          enabled_reason: "targeting",
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
    // Determine query: first primary-bucket title, or first title overall. No
    // tech-flavored literal fallback — a candidate with an explicit tech domain
    // but no titles configured yet gets no aggregator entries at all rather than
    // a hardcoded "AI engineer" query that would misrepresent every other tech
    // role family (domain-neutral rule: no personal/tech defaults hardcoded).
    let aggregatorQuery = "";
    for (const bucket of targeting.role_buckets ?? []) {
      if (bucket.priority === "primary" && bucket.titles?.length) {
        aggregatorQuery = bucket.titles[0];
        break;
      }
    }
    if (!aggregatorQuery && positiveTitles.length > 0) {
      aggregatorQuery = positiveTitles[0];
    }

    if (aggregatorQuery) {
      searches.push({
        provider: "RemoteVibeCodingJobs",
        source_type: "url-query",
        label: "Remote Vibe Coding Jobs",
        query: aggregatorQuery,
        rssUrl: "https://remotevibecodingjobs.com/feed.xml",
        enabled: true,
        enabled_reason: "targeting",
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
        enabled_reason: "targeting",
      });
    }
  }

  const hospitalityLocation = usLocationParts(loc.home);
  const hospitalityQueries = boundedHospitalityTitles(targeting.role_buckets, {
    inferred: !hasExplicitDomain,
  });
  let hasRunnableHospitalitySources = false;
  if (hospitalityDomain && hospitalityLocation && hospitalityQueries.length > 0) {
    for (const hospitalityQuery of hospitalityQueries) {
      const what = new URLSearchParams({
        what: hospitalityQuery,
        where: hospitalityLocation.queryLocation,
      }).toString();
      const culinaryAgentsSearch = new URLSearchParams({
        "search[name]": hospitalityQuery,
        "search[location]": hospitalityLocation.queryLocation,
        "search[country]": "US",
      }).toString();
      searches.push(
        {
          provider: "culinaryagents",
          source_type: "board",
          label: `Culinary Agents · ${hospitalityQuery}`,
          url: `https://culinaryagents.com/search/jobs?${culinaryAgentsSearch}`,
          enabled: true,
          enabled_reason: "hospitality-domain",
          max_results: HOSPITALITY_RESULTS_PER_QUERY,
        },
        {
          provider: "oysterlink",
          source_type: "board",
          label: `OysterLink · ${hospitalityQuery}`,
          url: `https://oysterlink.com/jobs/${slugify(hospitalityQuery)}/${hospitalityLocation.citySlug}/`,
          enabled: true,
          enabled_reason: "hospitality-domain",
          max_results: HOSPITALITY_RESULTS_PER_QUERY,
        },
        {
          provider: "hcareers",
          source_type: "board",
          label: `Hcareers · ${hospitalityQuery}`,
          url: `https://www.hcareers.com/jobs?${what}`,
          enabled: true,
          enabled_reason: "hospitality-domain",
          max_results: HOSPITALITY_RESULTS_PER_QUERY,
        },
        {
          provider: "hospitalityonline",
          source_type: "board",
          label: `Hospitality Online · ${hospitalityQuery}`,
          url: `https://www.hospitalityonline.com/jobs?${what}`,
          enabled: true,
          enabled_reason: "hospitality-domain",
          max_results: HOSPITALITY_RESULTS_PER_QUERY,
        }
      );
    }
    searches.push({
      provider: "ihirehospitality",
      source_type: "board",
      label: "iHireHospitality",
      url: `https://www.ihirehospitality.com/t-hospitality-s-${hospitalityLocation.stateNameSlug}-jobs.html`,
      enabled: true,
      enabled_reason: "hospitality-domain",
      max_results: 25,
    });
    hasRunnableHospitalitySources = true;
  }

  // Board-wide remote aggregator feeds (RemoteOK / Remotive / Working Nomads): unlike
  // RemoteVibeCodingJobs/Wellfound above (tech-only, omitted entirely for other
  // domains), these three are seeded and enabled for EVERY candidate domain.
  // title_filter/location_filter narrow the broad feed the same way they
  // narrow every other sourced-scan lane. `provider` values are lowercase to
  // match sourced-scanner.mjs's BOARD_PROVIDERS registry keys exactly.
  // `enabled_reason: "domain-gate"` is retained as the generator-ownership
  // marker so first-search-run.mjs can migrate an older non-tech candidate's
  // generated enabled:false entries to this baseline. Settings removes the
  // marker when the user explicitly toggles a source, so that choice wins.
  // On regeneration, first-search-run.mjs reads that marker to re-sync
  // `enabled` even when a stored copy already exists on disk.
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
      enabled: true,
      enabled_reason: "domain-gate",
    });
  }

  // Every search-ready candidate needs at least one runnable public source,
  // including non-tech and local-role targets that only produce browser query
  // URLs above. Arbeitnow is a zero-auth, board-wide feed; the scanner's shared
  // title and location gates keep its broad results candidate-specific. One
  // page bounds first-run cost while still giving Paul a real deterministic
  // lane instead of graduating into a zero-source repair screen.
  if (
    positiveTitles.length > 0 &&
    !location_filter.needs_location &&
    !hasRunnableHospitalitySources
  ) {
    searches.push({
      provider: "arbeitnow",
      source_type: "board",
      label: "Arbeitnow",
      url: "https://www.arbeitnow.com/api/job-board-api",
      enabled: true,
      enabled_reason: "baseline",
      max_pages: 1,
    });
  }

  // --- source_catalog (fixed reference) ---
  const source_catalog = {
    aggregators: [
      "HiringCafe",
      "Arbeitnow",
      "RemoteVibeCodingJobs",
      "Wellfound",
      "LinkedIn",
      "Google Jobs",
    ],
    ats: ["Ashby", "Greenhouse", "Lever", "Workable", "SmartRecruiters", "Recruitee", "Workday"],
    remote_boards: ["RemoteOK", "Jobicy", "Working Nomads", "We Work Remotely", "Remotive"],
    deterministic_providers: [...CAREER_OPS_PUBLIC_PROVIDER_IDS],
  };

  return {
    generator_revision: 1,
    generator_state: { title_filter, location_filter },
    title_filter,
    location_filter,
    searches,
    tracked_companies: [],
    source_catalog,
  };
}
