import { validate } from "../profile/schema-validator.mjs";
import { parseYaml, stringifyYaml } from "../profile/yaml.mjs";
import { inferCareerOpsProvider, isCareerOpsProviderSupported } from "./career-ops-registry.mjs";
import { parseHiringCafeSearchState, resolveRecencyWindow } from "./hiringcafe.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function canonicalSearchSourceUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeLegacySearchSource(source) {
  if (!source || typeof source !== "object" || source.source_type !== "manual-auth") {
    return source;
  }
  return {
    ...source,
    source_type: "browser",
    auth: source.auth !== false,
  };
}

export function normalizeSearchSourceConfig(config) {
  if (!config || typeof config !== "object") return config;
  const key = Array.isArray(config.searches)
    ? "searches"
    : Array.isArray(config.sources)
      ? "sources"
      : null;
  if (!key) return config;
  const normalized = config[key].map(normalizeLegacySearchSource);
  return normalized.some((entry, index) => entry !== config[key][index])
    ? { ...config, [key]: normalized }
    : config;
}

// Map a hostname to the saved browser session used when that source needs login.
// Returns null for hosts that do not have a site-specific session.
export function platformForHost(hostname) {
  const host = String(hostname || "")
    .replace(/^www\./, "")
    .toLowerCase();
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
  if (host === "indeed.com" || host.endsWith(".indeed.com")) return "indeed";
  if (host === "glassdoor.com" || host.endsWith(".glassdoor.com")) return "glassdoor";
  if (host === "wellfound.com" || host.endsWith(".wellfound.com")) return "wellfound";
  return null;
}

const BROWSER_PLATFORM_LABELS = Object.freeze({
  glassdoor: "Glassdoor",
  indeed: "Indeed",
  linkedin: "LinkedIn",
  wellfound: "Wellfound",
});

const BROWSER_PLATFORM_PATTERNS = Object.freeze({
  glassdoor: /\bglassdoor(?:\.com)?\b/i,
  indeed: /\bindeed(?:\.com)?\b/i,
  linkedin: /\blinked[\s-]?in(?:\.com)?\b/i,
  wellfound: /\bwellfound(?:\.com)?\b/i,
});

function browserPlatformClaims(source = {}) {
  const claims = new Set();
  for (const value of [source.platform, source.provider, source.label]) {
    const text = String(value || "").trim();
    if (!text) continue;
    for (const [platform, pattern] of Object.entries(BROWSER_PLATFORM_PATTERNS)) {
      if (pattern.test(text)) claims.add(platform);
    }
  }
  return claims;
}

export function resolveBrowserSourceIdentity(source = {}, value = source.url || source.target) {
  const canonicalUrl = canonicalSearchSourceUrl(value);
  if (!canonicalUrl) return { ok: false, reason: "Browser source URL is invalid." };
  const parsed = new URL(String(value).trim());
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    return { ok: false, reason: "Browser source URL must use HTTP or HTTPS." };
  }
  const hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
  if (!hostname) return { ok: false, reason: "Browser source URL has no hostname." };
  const knownPlatform = platformForHost(hostname);
  const claims = browserPlatformClaims(source);
  if ([...claims].some((claim) => claim !== knownPlatform)) {
    return {
      ok: false,
      reason: "Browser source identity does not match its URL hostname.",
    };
  }
  return {
    ok: true,
    url: parsed.toString(),
    canonicalUrl,
    hostname,
    platform: knownPlatform || hostname,
    label: BROWSER_PLATFORM_LABELS[knownPlatform] || hostname,
    knownPlatform,
  };
}

export function requireBrowserSourceIdentity(source = {}, value = source.url || source.target) {
  const identity = resolveBrowserSourceIdentity(source, value);
  if (identity.ok) return identity;
  const error = new Error(identity.reason);
  error.code = "BAD_REQUEST";
  throw error;
}

function resolveSelector(searches, selector) {
  if (typeof selector === "number") {
    if (selector < 0 || selector >= searches.length) {
      throw new Error(`No search at index ${selector}`);
    }
    return selector;
  }
  const lower = String(selector).toLowerCase();
  const idx = searches.findIndex((s) => String(s.label ?? "").toLowerCase() === lower);
  if (idx === -1) throw new Error(`No search with label "${selector}"`);
  return idx;
}

// ---------------------------------------------------------------------------
// emptyConfig
// ---------------------------------------------------------------------------

export function emptyConfig() {
  return {
    title_filter: { positive: [], negative: [] },
    location_filter: { always_allow: [], allow: [], block: [] },
    searches: [],
    tracked_companies: [],
    source_catalog: {},
  };
}

// ---------------------------------------------------------------------------
// addSearchFromQuery
// ---------------------------------------------------------------------------

export function addSearchFromQuery(
  config,
  {
    query,
    label,
    provider = "HiringCafe",
    sourceType = "url-query",
    enabled = true,
    searchState = {},
    safetyMinutes = 30,
  } = {}
) {
  if (!query || typeof query !== "string" || query.trim() === "") {
    throw new Error("addSearchFromQuery: query is required and must be a non-empty string");
  }

  const providerLower = String(provider).toLowerCase();
  const duplicate = (config.searches ?? []).some(
    (s) => String(s.provider ?? "").toLowerCase() === providerLower && s.query === query
  );
  if (duplicate) return config;

  const entry = {
    provider,
    source_type: sourceType,
    label: label || query,
    query,
    enabled,
    recency: { mode: "since-last-run", safetyMinutes },
    searchState: { sortBy: "date", ...searchState },
  };

  return { ...config, searches: [...(config.searches ?? []), entry] };
}

// ---------------------------------------------------------------------------
// addProviderSource
// ---------------------------------------------------------------------------

export function addProviderSource(
  config,
  { provider, label, query, url, enabled = true, safetyMinutes = 30 } = {}
) {
  const providerId = String(provider || "")
    .trim()
    .toLowerCase();
  if (!isCareerOpsProviderSupported(providerId)) {
    throw new Error(`addProviderSource: unsupported provider: ${provider || "(missing)"}`);
  }

  const normalizedQuery = typeof query === "string" ? query.trim() : "";
  const normalizedUrl = typeof url === "string" ? url.trim() : "";
  if (!normalizedQuery && !normalizedUrl) {
    throw new Error("addProviderSource: a query or URL is required");
  }
  if (normalizedUrl) {
    try {
      new URL(normalizedUrl);
    } catch {
      throw new Error(`addProviderSource: unparseable URL: ${url}`);
    }
  }

  const duplicate = (config.searches ?? []).some((source) => {
    if (String(source.provider || "").toLowerCase() !== providerId) return false;
    return normalizedUrl
      ? source.url === normalizedUrl
      : String(source.query || "").toLowerCase() === normalizedQuery.toLowerCase();
  });
  if (duplicate) return config;

  const sourceLabel = label || String(provider).trim();
  const entry = {
    provider: providerId,
    source_type: normalizedUrl ? "ats" : "board",
    label: sourceLabel,
    ...(normalizedUrl ? { name: sourceLabel, url: normalizedUrl } : { query: normalizedQuery }),
    enabled,
    recency: { mode: "since-last-run", safetyMinutes },
  };
  if (normalizedUrl && normalizedQuery) entry.query = normalizedQuery;

  return { ...config, searches: [...(config.searches ?? []), entry] };
}

// ---------------------------------------------------------------------------
// addSearchFromUrl
// ---------------------------------------------------------------------------

export function addSearchFromUrl(
  config,
  pastedUrl,
  { label, enabled = true, sourceType = null } = {}
) {
  let parsed;
  try {
    parsed = new URL(pastedUrl);
  } catch {
    throw new Error(`addSearchFromUrl: unparseable URL: ${pastedUrl}`);
  }

  const host = parsed.hostname.replace(/^www\./, "");
  const canonicalTarget = canonicalSearchSourceUrl(pastedUrl);
  const duplicate = (config.searches ?? []).some((source) => {
    const existingTarget = source.url || source.rssUrl;
    return existingTarget && canonicalSearchSourceUrl(existingTarget) === canonicalTarget;
  });
  if (duplicate) return config;

  if (sourceType === "rss") {
    const entry = {
      provider: host,
      source_type: "rss",
      label: label || host,
      rssUrl: pastedUrl,
      enabled,
      recency: { mode: "since-last-run", safetyMinutes: 30 },
    };
    return { ...config, searches: [...(config.searches ?? []), entry] };
  }

  // www. is already stripped by the line above, so host is never 'www.wellfound.com' here.
  if (host === "wellfound.com") {
    const identity = requireBrowserSourceIdentity({ provider: "Wellfound", label }, pastedUrl);
    const entry = {
      provider: "Wellfound",
      source_type: "browser",
      platform: identity.platform,
      label: label || "Wellfound import",
      url: pastedUrl,
      enabled,
    };
    return { ...config, searches: [...(config.searches ?? []), entry] };
  }

  if (host === "jobs.lever.co" || host === "api.lever.co") {
    // Derive the company slug from the first non-empty path segment.
    const companySlug = parsed.pathname.split("/").filter(Boolean)[0] || "";
    const entry = {
      provider: "Lever",
      source_type: "ats",
      label: label || (companySlug ? `Lever – ${companySlug}` : "Lever import"),
      url: pastedUrl,
      enabled,
    };
    return { ...config, searches: [...(config.searches ?? []), entry] };
  }

  if (host.includes("hiring.cafe")) {
    const searchState = parseHiringCafeSearchState(pastedUrl);
    const query = searchState.searchQuery ?? undefined;
    const normalizedQuery = String(query || "")
      .trim()
      .toLowerCase();
    const duplicateQuery =
      normalizedQuery &&
      (config.searches ?? []).some(
        (source) =>
          slug(source.provider) === "hiringcafe" &&
          String(source.query || source.searchState?.searchQuery || "")
            .trim()
            .toLowerCase() === normalizedQuery
      );
    if (duplicateQuery) return config;

    const entry = {
      provider: "HiringCafe",
      source_type: "url-query",
      label: label || query || "HiringCafe import",
      ...(query !== undefined ? { query } : {}),
      url: pastedUrl,
      searchState,
      enabled,
      recency: { mode: "since-last-run", safetyMinutes: 30 },
    };

    return { ...config, searches: [...(config.searches ?? []), entry] };
  }

  // Authenticated-search hosts (LinkedIn / Indeed / Glassdoor) use the app's saved
  // browser session. The source starts disabled so its first use can ask one clear,
  // site-specific Yes/No question instead of hiding the choice in Settings.
  const authPlatform = platformForHost(host);
  if (authPlatform) {
    const identity = requireBrowserSourceIdentity({ provider: host, label }, pastedUrl);
    const entry = {
      provider: host,
      source_type: "browser",
      auth: true,
      platform: identity.platform,
      label: label || `${host} (authenticated)`,
      url: pastedUrl,
      enabled: false,
    };
    return { ...config, searches: [...(config.searches ?? []), entry] };
  }

  if (sourceType === "url-query" || sourceType === "browser") {
    const identity =
      sourceType === "browser"
        ? requireBrowserSourceIdentity({ provider: host, label }, pastedUrl)
        : null;
    const entry = {
      provider: host,
      source_type: sourceType,
      ...(identity ? { platform: identity.platform } : {}),
      label: label || host,
      url: pastedUrl,
      enabled,
      recency: { mode: "since-last-run", safetyMinutes: 30 },
    };
    return { ...config, searches: [...(config.searches ?? []), entry] };
  }

  const deterministicProvider = inferCareerOpsProvider({ careers_url: pastedUrl });
  if (deterministicProvider) {
    const sourceLabel = label || parsed.hostname;
    const entry = {
      provider: deterministicProvider,
      source_type: "ats",
      label: sourceLabel,
      name: sourceLabel,
      url: pastedUrl,
      enabled,
    };
    return { ...config, searches: [...(config.searches ?? []), entry] };
  }

  // Generic URL-based source
  const identity = requireBrowserSourceIdentity({ provider: host, label }, pastedUrl);
  const entry = {
    provider: host,
    source_type: "browser",
    platform: identity.platform,
    label: label || host,
    url: pastedUrl,
    enabled,
  };

  return { ...config, searches: [...(config.searches ?? []), entry] };
}

// ---------------------------------------------------------------------------
// setEnabled
// ---------------------------------------------------------------------------

export function setEnabled(config, selector, enabled) {
  const searches = config.searches ?? [];
  const idx = resolveSelector(searches, selector);
  const updated = searches.map((source, index) => {
    if (index !== idx) return source;
    const { enabled_reason: _generatedEnabledReason, ...userOwnedSource } = source;
    return { ...userOwnedSource, enabled };
  });
  return { ...config, searches: updated };
}

// ---------------------------------------------------------------------------
// markRun
// ---------------------------------------------------------------------------

export function markRun(config, selector, now = new Date()) {
  const searches = config.searches ?? [];
  const idx = resolveSelector(searches, selector);
  const updated = searches.map((s, i) => {
    if (i !== idx) return s;
    return {
      ...s,
      recency: { ...(s.recency ?? {}), lastRunAt: now.toISOString() },
    };
  });
  return { ...config, searches: updated };
}

// ---------------------------------------------------------------------------
// recencyCutoff
// ---------------------------------------------------------------------------

export function recencyCutoff(search, now = new Date()) {
  return resolveRecencyWindow({
    lastRunAt: search?.recency?.lastRunAt ?? null,
    now,
    windowHours: search?.recency?.windowHours ?? search?.recency?.hours ?? null,
    safetyMinutes: search?.recency?.safetyMinutes ?? 30,
  });
}

// ---------------------------------------------------------------------------
// listSearches
// ---------------------------------------------------------------------------

export function listSearches(config) {
  return (config.searches ?? []).map((s, index) => ({
    index,
    provider: s.provider,
    label: s.label,
    target: s.query ?? s.url ?? s.rssUrl ?? "",
    source_type: s.source_type,
    enabled: s.enabled,
    lastRunAt: s.recency?.lastRunAt ?? null,
    ...(s.auth ? { auth: true, platform: s.platform ?? null } : {}),
    ...(s.login_skipped === true ? { login_skipped: true } : {}),
  }));
}

// ---------------------------------------------------------------------------
// toCaptureSource
// ---------------------------------------------------------------------------

export function toCaptureSource(search) {
  const id = slug(`${String(search.provider ?? "")}-${String(search.label ?? "")}`);
  return {
    id,
    provider: String(search.provider ?? "").toLowerCase(),
    label: search.label,
    term: search.query,
    url: search.url,
    searchState: search.searchState || {},
    enabled: search.enabled !== false,
    // Authenticated sources carry their platform so the capture path can pick the
    // logged-in session profile. Omitted entirely for ordinary sources.
    ...(search.auth ? { auth: true, platform: search.platform ?? null } : {}),
  };
}

// ---------------------------------------------------------------------------
// mergeSearchConfigs
// ---------------------------------------------------------------------------

// Merge a freshly generated baseline (from current targeting) into an existing
// config without clobbering manual curation. Derived top-level filters and the
// source_catalog are taken from the baseline (they reflect current targeting),
// while existing searches and tracked_companies are preserved. Generated
// searches are appended only when no existing search already covers them
// (matched by provider + query, provider + rssUrl, or provider + url) — so
// re-running is idempotent and user-added or pasted-URL searches survive.
// Generated recency settings are refreshed from the baseline while preserving
// source watermarks.
export function mergeSearchConfigs(existing, baseline) {
  if (!existing || !Array.isArray(existing.searches)) return baseline;

  const existingSearches = existing.searches;
  const isSameGeneratedSearch = (existingSearch, generated) => {
    if (
      String(existingSearch.provider ?? "").toLowerCase() !==
      String(generated.provider ?? "").toLowerCase()
    ) {
      return false;
    }
    const sameQuery =
      existingSearch.query != null &&
      generated.query != null &&
      String(existingSearch.query).toLowerCase() === String(generated.query).toLowerCase();
    const sameRss = existingSearch.rssUrl != null && existingSearch.rssUrl === generated.rssUrl;
    // URL-only entries (Wellfound, Lever, etc.) are matched by provider + url
    // so that re-running --from-targeting is idempotent for all providers.
    const sameUrl =
      existingSearch.url != null && generated.url != null && existingSearch.url === generated.url;
    return sameQuery || sameRss || sameUrl;
  };
  const covers = (generated) => existingSearches.some((e) => isSameGeneratedSearch(e, generated));

  const refreshGeneratedFields = (existingSearch) => {
    const generated = (baseline.searches ?? []).find((g) =>
      isSameGeneratedSearch(existingSearch, g)
    );
    if (!generated?.recency) return existingSearch;
    return {
      ...existingSearch,
      recency: {
        ...generated.recency,
        ...(existingSearch.recency?.lastRunAt
          ? { lastRunAt: existingSearch.recency.lastRunAt }
          : {}),
      },
    };
  };

  const appended = (baseline.searches ?? []).filter((g) => !covers(g));
  const tracked =
    Array.isArray(existing.tracked_companies) && existing.tracked_companies.length > 0
      ? existing.tracked_companies
      : (baseline.tracked_companies ?? []);

  return {
    ...baseline,
    tracked_companies: tracked,
    searches: [...existingSearches.map(refreshGeneratedFields), ...appended],
  };
}

// ---------------------------------------------------------------------------
// parseConfig / serializeConfig / validateConfig
// ---------------------------------------------------------------------------

export function parseConfig(text) {
  return normalizeSearchSourceConfig(parseYaml(text));
}

export function serializeConfig(config) {
  return stringifyYaml(config);
}

export function validateConfig(config, schema) {
  return validate(config, schema);
}
