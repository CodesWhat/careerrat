import { createHash } from "node:crypto";
import { runSourcedScan } from "../../../scripts/scan-sourced.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import { companyBoardResolutionGet } from "../db/verbs/company-discovery.mjs";
import { companyAtsUpsert, sourceConfigGet, sourceConfigPut } from "../db/verbs/source-config.mjs";
import {
  assertSourcingRunActiveInDb,
  sourcingRunAssertActive,
  sourcingRunComplete,
  sourcingRunFail,
  sourcingRunLatest,
  sourcingRunProgress,
  sourcingRunStart,
} from "../db/verbs/sourcing-runs.mjs";
import { normalizeCompanyKey, resolveCompanyBoard } from "../discovery/company-board-resolver.mjs";
import { fillManualDomainHints } from "../discovery/company-seeds.mjs";
import { buildSearchSources } from "../profile/generate-search-sources.mjs";
import { buildSourceUrl } from "../providers/source-url.mjs";
import {
  inferProvider,
  isBoardProviderSupported,
  isCompanyProviderSupported,
} from "../scoring/sourced-scanner.mjs";
import { pendingSourceLoginRequests } from "../search/source-login-preflight.mjs";
import { createSearchExecutionId } from "../search/unified-job-search.mjs";

// Bounded backfill for automatic company-board resolution ahead of the first
// search: on a fresh install, targeting.tracked_companies is just a list of
// bare names (config/targeting.schema.json), so countDeterministicSources
// below can't count them until they land in the sourced-scan config with a
// supported careers_url. discover-companies/company-proposals may have
// already resolved a board for one of these names earlier in onboarding
// (cached in company_board_resolutions) without the confirm-first gate ever
// promoting it into sourced-scan. This backfill promotes only those already-
// resolved, high-confidence boards — it never invents a domain from a bare
// name by itself (no slugify(name)+".com" guessing). A name with no prior
// resolution is normally just left for the user/discover-companies to
// resolve — UNLESS this run would otherwise attempt zero companies, in which
// case the bounded AI rescue below (LAYER 3) makes one batched domain-hint
// attempt before giving up; see aiRescueHintlessCompanies's own comment.
const COMPANY_BOARD_BACKFILL_BUDGET_MS = 5000;
const COMPANY_BOARD_BACKFILL_CONCURRENCY = 4;
const COMPANY_BOARD_BACKFILL_TIMEOUT_MS = 3000;
// Separate budget for the AI domain-hint rescue call itself, which runs
// outside (before) the resolution budget above — a bare-name company list
// has no cached hint to resolve against yet, so there is nothing for the
// resolution budget to bound until the AI call returns one.
const COMPANY_BOARD_AI_HINT_TIMEOUT_MS = 8000;
const COMPANY_BOARD_AI_HINT_MAX_NAMES = 20;

const STATUS_LABELS = Object.freeze({
  not_started: "Not started",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
});

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value, { sourceConfig = false } = {}) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableValue(entry, { sourceConfig }));
  }
  if (!value || typeof value !== "object") return value;
  const entries = [];
  for (const key of Object.keys(value).sort()) {
    if (sourceConfig && key === "lastRunAt") continue;
    const normalized = stableValue(value[key], { sourceConfig });
    if (
      sourceConfig &&
      key === "recency" &&
      normalized &&
      typeof normalized === "object" &&
      !Array.isArray(normalized) &&
      Object.keys(normalized).length === 0
    ) {
      continue;
    }
    entries.push([key, normalized]);
  }
  return Object.fromEntries(entries);
}

function searchProfileInputs(profile = {}) {
  return {
    authorization: clone(profile.authorization || {}),
    candidate: { domain: String(profile.candidate?.domain || "") },
    compensation: clone(profile.compensation || {}),
    location: clone(profile.location || {}),
  };
}

function searchTargetingInputs(targeting = {}) {
  const searchPreferences = clone(targeting.search_preferences || {});
  delete searchPreferences.ai_prompts;
  delete searchPreferences.ai_prompts_input_fingerprint;
  delete searchPreferences.cadence;
  return {
    ...clone(targeting),
    search_preferences: searchPreferences,
  };
}

function buildSourcingRunFingerprint({ purpose, mode, config, searchSources, sourcedScan } = {}) {
  const input = stableValue({
    version: 1,
    purpose: String(purpose || ""),
    mode: String(mode || purpose || ""),
    targeting: searchTargetingInputs(config?.targeting),
    profile: searchProfileInputs(config?.profile),
    searchSources: stableValue(searchSources || {}, { sourceConfig: true }),
    sourcedScan: stableValue(sourcedScan || {}, { sourceConfig: true }),
  });
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasConfiguredTargetTitles(config = {}) {
  return asArray(config?.targeting?.role_buckets).some((bucket) =>
    asArray(bucket?.titles).some((title) => String(title || "").trim().length > 0)
  );
}

function compactArrayValues(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const key = String(value || "")
      .trim()
      .toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function mergeFilterObject(existing = {}, generated = {}) {
  const keys = new Set([...Object.keys(generated || {}), ...Object.keys(existing || {})]);
  const merged = {};
  for (const key of keys) {
    const existingValue = existing?.[key];
    const generatedValue = generated?.[key];
    if (Array.isArray(existingValue) || Array.isArray(generatedValue)) {
      merged[key] = compactArrayValues([...asArray(existingValue), ...asArray(generatedValue)]);
    } else if (key === "needs_location" && generatedValue !== undefined) {
      merged[key] = generatedValue;
    } else {
      merged[key] = existingValue ?? generatedValue;
    }
  }
  return merged;
}

function mergeTitleFilter(existing = {}, generated = {}) {
  const reconciledExisting =
    generated?.seniority_basis === "candidate-ladder"
      ? {
          ...existing,
          negative: asArray(existing?.negative).filter(
            (value) =>
              !["intern", "junior"].includes(
                String(value || "")
                  .trim()
                  .toLowerCase()
              )
          ),
        }
      : existing;
  const merged = mergeFilterObject(reconciledExisting, generated);
  merged.below_target = compactArrayValues(asArray(generated?.below_target));
  if (generated?.seniority_basis) merged.seniority_basis = generated.seniority_basis;
  return merged;
}

function mergeLocationFilter(existing = {}, generated = {}) {
  const merged = mergeFilterObject(existing, generated);
  for (const key of ["allow", "block"]) {
    if (Array.isArray(generated?.[key])) merged[key] = compactArrayValues(generated[key]);
  }
  if (generated?.needs_location !== undefined) {
    merged.needs_location = generated.needs_location;
  }
  return merged;
}

function sourceEntryKey(entry = {}) {
  const provider = String(entry.provider || entry.platform || "")
    .trim()
    .toLowerCase();
  const url = String(entry.url || "")
    .trim()
    .toLowerCase();
  if (url) return `url:${url}`;
  const rssUrl = String(entry.rssUrl || entry.rss_url || "")
    .trim()
    .toLowerCase();
  if (rssUrl) return `rss:${rssUrl}`;
  const query = String(entry.query || "")
    .trim()
    .toLowerCase();
  if (query) return `query:${provider}:${query}`;
  const label = String(entry.label || "")
    .trim()
    .toLowerCase();
  return label ? `label:${provider}:${label}` : "";
}

function companyEntryKey(entry = {}) {
  const name = String(entry.name || entry)
    .trim()
    .toLowerCase();
  const careersUrl = String(entry.careers_url || entry.url || "")
    .trim()
    .toLowerCase();
  return careersUrl ? `url:${careersUrl}` : name ? `name:${name}` : "";
}

function mergeEntries(existingEntries, generatedEntries, keyForEntry) {
  const out = [];
  const seen = new Set();
  for (const entry of [
    ...(Array.isArray(existingEntries) ? existingEntries : []),
    ...(Array.isArray(generatedEntries) ? generatedEntries : []),
  ]) {
    const key = keyForEntry(entry);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(entry);
  }
  return out;
}

function mergeSourceCatalog(existing = {}, generated = {}) {
  const keys = new Set([...Object.keys(generated || {}), ...Object.keys(existing || {})]);
  const merged = {};
  for (const key of keys) {
    merged[key] = compactArrayValues([...asArray(existing?.[key]), ...asArray(generated?.[key])]);
  }
  return merged;
}

// Before generated sources carried enabled_reason, one release wrote this
// complete disabled trio. A single unmarked row is ambiguous and stays
// user-owned. The exact three-row cohort is the provenance signal: remove all
// untouched copies only when every historical row is still present, then let
// the current generator add one enabled canonical copy of each board.
const LEGACY_UNMARKED_REMOTE_BOARD_BUNDLE = Object.freeze([
  Object.freeze({
    provider: "remoteok",
    label: "Remote OK",
    source_type: "board",
    url: "https://remoteok.com/api",
    enabled: false,
  }),
  Object.freeze({
    provider: "remotive",
    label: "Remotive",
    source_type: "board",
    url: "https://remotive.com/api/remote-jobs",
    enabled: false,
  }),
  Object.freeze({
    provider: "workingnomads",
    label: "Working Nomads",
    source_type: "board",
    url: "https://www.workingnomads.com/jobsapi/job/_search",
    enabled: false,
  }),
]);

function isExactLegacyRemoteBoard(entry, expected) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const entryKeys = Object.keys(entry);
  const expectedKeys = Object.keys(expected);
  return (
    entryKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(entry, key) && Object.is(entry[key], expected[key]))
  );
}

function hasCompleteLegacyRemoteBoardBundle(existingEntries) {
  const entries = asArray(existingEntries);
  return LEGACY_UNMARKED_REMOTE_BOARD_BUNDLE.every((expected) =>
    entries.some((entry) => isExactLegacyRemoteBoard(entry, expected))
  );
}

const GENERATED_SOURCE_REASONS = new Set([
  "targeting",
  "domain-gate",
  "hospitality-domain",
  "baseline",
]);

function hasGeneratedBaselineOwnership(searchSources = {}) {
  const entries = asArray(searchSources.searches);
  return (
    Number(searchSources.generator_revision) >= 1 ||
    entries.some((entry) => GENERATED_SOURCE_REASONS.has(entry?.enabled_reason)) ||
    hasCompleteLegacyRemoteBoardBundle(entries)
  );
}

function normalizedTargetTitles(searchSources = {}) {
  return new Set(
    asArray(searchSources?.title_filter?.positive)
      .map((title) =>
        String(title || "")
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );
}

function targetTitleSlug(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isLegacyGeneratedTargetSource(entry, searchSources) {
  if (entry?.enabled_reason != null) return false;
  if (Number(searchSources.generator_revision) >= 1) return false;
  const titles = normalizedTargetTitles(searchSources);
  if (titles.size === 0) return false;
  const query = String(entry?.query || "")
    .trim()
    .toLowerCase();

  if (entry?.provider === "HiringCafe") {
    return (
      entry.source_type === "url-query" &&
      titles.has(query) &&
      String(entry.label || "")
        .trim()
        .toLowerCase() === query &&
      entry.searchState?.sortBy === "date" &&
      !entry.url
    );
  }
  if (entry?.provider === "RemoteVibeCodingJobs") {
    return titles.has(query) && entry.rssUrl === "https://remotevibecodingjobs.com/feed.xml";
  }
  if (entry?.provider === "Wellfound" && entry.source_type === "browser" && !entry.platform) {
    const path = (() => {
      try {
        return new URL(entry.url).pathname.toLowerCase();
      } catch {
        return "";
      }
    })();
    return [...titles].some((title) => {
      const slug = targetTitleSlug(title);
      return slug && path.split("/").includes(slug);
    });
  }
  return false;
}

function generatedTitleFilterState(searchSources = {}) {
  const stored = searchSources?.generator_state?.title_filter;
  if (stored) return stored;
  if (!hasGeneratedBaselineOwnership(searchSources)) return null;

  const positive = compactArrayValues(
    asArray(searchSources.searches)
      .filter((entry) => isLegacyGeneratedTargetSource(entry, searchSources))
      .map((entry) => entry.query)
  );
  const titleFilter = searchSources.title_filter || {};
  return {
    ...titleFilter,
    positive: positive.length > 0 ? positive : asArray(titleFilter.positive),
  };
}

function disableGeneratedBaselineWithoutTargets(searchSources = {}) {
  if (!hasGeneratedBaselineOwnership(searchSources)) return searchSources;
  let changed = false;
  const searches = asArray(searchSources.searches).map((entry) => {
    const generated =
      GENERATED_SOURCE_REASONS.has(entry?.enabled_reason) ||
      isLegacyGeneratedTargetSource(entry, searchSources);
    if (!generated || entry.enabled === false) return entry;
    changed = true;
    return { ...entry, enabled: false };
  });
  const titleFilter = clearGeneratedTitleFilter(
    searchSources.title_filter,
    generatedTitleFilterState(searchSources)
  );
  if (!changed && titleFilter === searchSources.title_filter) return searchSources;
  return {
    ...searchSources,
    generator_revision: 1,
    title_filter: titleFilter,
    searches,
  };
}

function withoutGeneratedValues(values, generatedValues) {
  const generated = new Set(
    asArray(generatedValues).map((value) =>
      String(value || "")
        .trim()
        .toLowerCase()
    )
  );
  return asArray(values).filter(
    (value) =>
      !generated.has(
        String(value || "")
          .trim()
          .toLowerCase()
      )
  );
}

function replaceGeneratedTitleFilter(existingConfig = {}, generatedConfig = {}) {
  const previousGenerated = generatedTitleFilterState(existingConfig);
  if (!previousGenerated) {
    return mergeTitleFilter(existingConfig.title_filter, generatedConfig.title_filter);
  }
  const existing = existingConfig.title_filter || {};
  const generated = generatedConfig.title_filter || {};
  const next = { ...existing };
  for (const key of ["positive", "negative", "below_target"]) {
    next[key] = compactArrayValues([
      ...withoutGeneratedValues(existing[key], previousGenerated[key]),
      ...asArray(generated[key]),
    ]);
  }
  if (generated.seniority_basis) next.seniority_basis = generated.seniority_basis;
  return next;
}

function clearGeneratedTitleFilter(titleFilter = {}, generatedTitleFilter = null) {
  if (!generatedTitleFilter) {
    if (
      asArray(titleFilter.positive).length === 0 &&
      asArray(titleFilter.below_target).length === 0
    ) {
      return titleFilter;
    }
    return { ...titleFilter, positive: [], below_target: [] };
  }
  const next = { ...titleFilter };
  let changed = false;
  for (const key of ["positive", "negative", "below_target"]) {
    const retained = withoutGeneratedValues(titleFilter[key], generatedTitleFilter[key]);
    if (retained.length !== asArray(titleFilter[key]).length) changed = true;
    next[key] = retained;
  }
  if (titleFilter.seniority_basis === generatedTitleFilter.seniority_basis) {
    delete next.seniority_basis;
    changed = true;
  }
  return changed ? next : titleFilter;
}

function reconcileLegacyUnmarkedRemoteBoards(existingEntries) {
  const entries = asArray(existingEntries);
  if (!hasCompleteLegacyRemoteBoardBundle(entries)) return entries;
  return entries.filter(
    (entry) =>
      !LEGACY_UNMARKED_REMOTE_BOARD_BUNDLE.some((expected) =>
        isExactLegacyRemoteBoard(entry, expected)
      )
  );
}

// Pre-6de6fa6b installs can carry stored RemoteVibeCodingJobs/Wellfound
// entries generated by the old hardcoded "AI engineer" fallback in
// generate-search-sources.mjs (fixed to derive the query from the
// candidate's own titles instead — see that file's buildSearchSources).
// Neither entry carries a marker like the domain-gate boards' `enabled_reason`
// (that's set only on the remoteok/remotive/workingnomads trio), so a legacy
// entry is identified by provider + the literal stale query. Without this,
// mergeEntries above keeps shadowing the freshly generated entry forever:
// RemoteVibeCodingJobs collides on its fixed rssUrl key (so the stale query
// entry wins the merge outright) and Wellfound's url-derived key differs
// from the new one (so the stale entry survives alongside a duplicate) —
// either way, the "AI engineer" entry never gets replaced on its own. This
// drops exactly those legacy machine-generated entries from the stored side
// before merging so the freshly generated, domain-neutral entry can take
// their place; any entry the user has since edited (a different query, or a
// query that happens to be pointed at some other provider) is left untouched.
//
// RemoteVibeCodingJobs stores its literal query verbatim, but Wellfound only
// ever stores the derived URL (buildWellfoundUrl never round-trips the
// source title back onto the entry) — so the Wellfound side is identified by
// matching the URL's role slug against the slugified literal instead.
const LEGACY_HARDCODED_AGGREGATOR_QUERY = "AI engineer";
// Mirrors wellfound.mjs's own private slug() exactly (lowercase, non-alnum runs
// collapsed to single hyphens, trimmed) — kept local rather than exported
// there solely for this stale-entry comparison.
const LEGACY_HARDCODED_QUERY_SLUG = LEGACY_HARDCODED_AGGREGATOR_QUERY.toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");
const LEGACY_WELLFOUND_URL_RE = new RegExp(
  `/role/(?:r/|l/[^/]+/)?${LEGACY_HARDCODED_QUERY_SLUG}(?:/|$)`
);

function isLegacyHardcodedAggregatorEntry(entry = {}, generatedEntries = []) {
  if (entry.provider === "RemoteVibeCodingJobs") {
    if (String(entry.query || "").trim() !== LEGACY_HARDCODED_AGGREGATOR_QUERY) return false;
    const generated = generatedEntries.find(
      (candidate) => candidate?.provider === "RemoteVibeCodingJobs"
    );
    return String(generated?.query || "").trim() !== LEGACY_HARDCODED_AGGREGATOR_QUERY;
  }
  if (entry.provider === "Wellfound") {
    const url = String(entry.url || "");
    if (!LEGACY_WELLFOUND_URL_RE.test(url)) return false;
    return !generatedEntries.some(
      (candidate) => candidate?.provider === "Wellfound" && String(candidate.url || "") === url
    );
  }
  return false;
}

function reconcileGeneratedSearches(existingConfig = {}, generatedEntries = []) {
  const generatedByKey = new Map();
  for (const entry of asArray(generatedEntries)) {
    const key = sourceEntryKey(entry);
    if (key) generatedByKey.set(key, entry);
  }
  const reconciledLegacy = reconcileLegacyUnmarkedRemoteBoards(existingConfig.searches).filter(
    (entry) => !isLegacyHardcodedAggregatorEntry(entry, generatedEntries)
  );
  const retained = [];
  for (const entry of reconciledLegacy) {
    const markerOwned = GENERATED_SOURCE_REASONS.has(entry?.enabled_reason);
    const legacyOwned = isLegacyGeneratedTargetSource(entry, existingConfig);
    const generated = generatedByKey.get(sourceEntryKey(entry));
    const retiresWithTarget =
      ["targeting", "hospitality-domain", "baseline"].includes(entry?.enabled_reason) ||
      legacyOwned;
    if (!generated && retiresWithTarget) continue;
    if (generated && (markerOwned || legacyOwned)) {
      if (entry.enabled_reason === "domain-gate") {
        retained.push({ ...entry, enabled: generated.enabled });
      } else {
        retained.push({
          ...entry,
          ...generated,
          ...(entry.recency || generated.recency
            ? { recency: { ...generated.recency, ...entry.recency } }
            : {}),
        });
      }
      continue;
    }
    retained.push(entry);
  }
  return mergeEntries(retained, generatedEntries, sourceEntryKey);
}

function mergeSearchSources(existing = {}, generated = {}) {
  return {
    ...generated,
    ...existing,
    generator_revision: generated.generator_revision,
    generator_state: generated.generator_state,
    title_filter: replaceGeneratedTitleFilter(existing, generated),
    location_filter: mergeLocationFilter(existing.location_filter, generated.location_filter),
    searches: reconcileGeneratedSearches(existing, generated.searches),
    tracked_companies: mergeEntries(
      existing.tracked_companies,
      generated.tracked_companies,
      companyEntryKey
    ),
    source_catalog: mergeSourceCatalog(existing.source_catalog, generated.source_catalog),
  };
}

function searchList(searchSources = {}) {
  if (Array.isArray(searchSources.searches)) return searchSources.searches;
  if (Array.isArray(searchSources.sources)) return searchSources.sources;
  return [];
}

function isEnabled(entry = {}) {
  return entry && entry.enabled !== false;
}

function isFetchableRss(entry = {}) {
  return isEnabled(entry) && (entry.source_type === "rss" || Boolean(entry.rssUrl));
}

function isFetchableBoard(entry = {}) {
  return (
    isEnabled(entry) &&
    ["ats", "board"].includes(entry.source_type) &&
    isBoardProviderSupported(entry.provider)
  );
}

function isBrowserSearchSource(entry = {}) {
  if (!isEnabled(entry) || isFetchableRss(entry) || isFetchableBoard(entry)) {
    return false;
  }
  if (entry.url) return true;
  if (!["url-query", "browser", "aggregator"].includes(entry.source_type)) return false;
  try {
    return Boolean(buildSourceUrl(entry).url);
  } catch {
    return false;
  }
}

function supportedAtsCompanies(sourcedScan = {}) {
  return asArray(sourcedScan.tracked_companies).filter((entry) => {
    if (!entry || entry.enabled === false) return false;
    const provider = inferProvider(entry);
    return Boolean(provider && isCompanyProviderSupported(provider));
  });
}

function trackedCompanyNames(candidateConfig) {
  const seen = new Set();
  const names = [];
  for (const raw of asArray(candidateConfig?.targeting?.tracked_companies)) {
    const name = String(raw || "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function knownCompanyNames(sourcedScan) {
  return new Set(
    asArray(sourcedScan?.tracked_companies)
      .map((entry) =>
        String(entry?.name || "")
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );
}

// A bare tracked-company name only gets a resolver attempt when it already
// has a real, previously-resolved board cached under its company key — that
// cache entry is the only hint source allowed here.
function cachedBoardHint({ repoRoot, env, name }) {
  const companyKey = normalizeCompanyKey(name);
  if (!companyKey) return "";
  const cached = companyBoardResolutionGet({
    repoRoot,
    env,
    companyKey,
  }).resolution;
  return String(cached?.job_board_url || cached?.careers_url || "").trim();
}

// Shared by both the cache-hinted pass and the AI-rescue pass below: resolve
// one company name against a URL/domain hint and, on a supported ATS match,
// promote it into sourced-scan exactly the same way either path found it.
async function resolveAndPromoteCompanyBoard({ repoRoot, env, fetchImpl, name, hint, timeoutMs }) {
  try {
    const result = await resolveCompanyBoard({
      repoRoot,
      env,
      seed: { name, job_board_url: hint },
      fetchImpl,
      timeoutMs,
    });
    if (result?.status !== "supported_ats") return { resolved: false, promoted: false };
    let promoted = false;
    if (result.promotable && result.careersUrl) {
      companyAtsUpsert({
        repoRoot,
        env,
        entry: {
          name: result.companyName || name,
          careers_url: result.careersUrl,
        },
      });
      promoted = true;
    }
    return { resolved: true, promoted };
  } catch {
    // One company's resolution failure/timeout never sinks the batch — it
    // just stays unresolved until a later first/manual search retries it.
    return { resolved: false, promoted: false };
  }
}

// LAYER 3 rescue: without this, a tracked company with no cached board
// resolution (the common case for a fresh/legacy install whose companies are
// just typed/extracted names — see this file's header comment) can never be
// promoted, so an install with tech titles but no resolvable companies and
// no enabled RSS/board searches stays permanently stuck on
// NO_DETERMINISTIC_SOURCES. This makes ONE batched runBoundedAI call (via
// company-seeds.mjs's fillManualDomainHints — same call discover-companies'
// manual-seed domain fill already makes; reused here rather than duplicated)
// to guess a domain for up to COMPANY_BOARD_AI_HINT_MAX_NAMES hintless
// names, then resolves+promotes whatever came back exactly like the
// cache-hinted pass above. Gated on the caller only invoking this when the
// cache-hinted pass attempted nothing AND there is a hintless set to try
// (backfillCompanyBoards' "otherwise doomed" precondition) — no gating is
// invented beyond that plus fillManualDomainHints' own resolveAIRoute
// availability check (it returns { ai: { used: false } } untouched when no
// AI route is configured, so this degrades to a no-op automatically). The
// call itself only ever runs inside a user-initiated search run:
// prepareFirstSearchSources is reached from startSearchRun's
// search-ready/manual-search/first-search-retry triggers, each starting
// from an explicit user action (finishing onboarding or clicking search),
// never a background poll — see AGENTS.md's "no AI spend without intent"
// rule.
async function aiRescueHintlessCompanies({ repoRoot, env, call, fetchImpl, names }) {
  const requested = Math.min(names.length, COMPANY_BOARD_AI_HINT_MAX_NAMES);
  const seeds = names.slice(0, requested).map((name) => ({ name, domain_hint: "" }));

  let timer;
  const timedOut = Symbol("ai-hint-timeout");
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timedOut), COMPANY_BOARD_AI_HINT_TIMEOUT_MS);
  });
  let filled;
  try {
    const outcome = await Promise.race([
      fillManualDomainHints({ repoRoot, env, seeds, call }),
      timeout,
    ]);
    filled = outcome === timedOut ? null : outcome;
  } catch {
    filled = null;
  } finally {
    clearTimeout(timer);
  }

  const hintedSeeds = filled ? filled.seeds.filter((seed) => seed.domain_hint) : [];
  const outcome = {
    requested,
    hinted: hintedSeeds.length,
    attempted: 0,
    resolved: 0,
    promoted: 0,
  };
  if (!hintedSeeds.length) return outcome;

  const deadline = Date.now() + COMPANY_BOARD_BACKFILL_BUDGET_MS;
  let cursor = 0;
  async function worker() {
    while (cursor < hintedSeeds.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const seed = hintedSeeds[cursor++];
      outcome.attempted += 1;
      const result = await resolveAndPromoteCompanyBoard({
        repoRoot,
        env,
        fetchImpl,
        name: seed.name,
        hint: seed.domain_hint,
        timeoutMs: Math.min(COMPANY_BOARD_BACKFILL_TIMEOUT_MS, remaining),
      });
      if (result.resolved) outcome.resolved += 1;
      if (result.promoted) outcome.promoted += 1;
    }
  }
  await Promise.all(
    Array.from(
      {
        length: Math.min(COMPANY_BOARD_BACKFILL_CONCURRENCY, hintedSeeds.length),
      },
      worker
    )
  );
  return outcome;
}

async function backfillCompanyBoards({
  repoRoot,
  env,
  fetchImpl,
  call,
  candidateConfig,
  sourcedScan,
}) {
  const summary = { attempted: 0, resolved: 0, promoted: 0 };
  const known = knownCompanyNames(sourcedScan);
  const pending = trackedCompanyNames(candidateConfig).filter(
    (name) => !known.has(name.toLowerCase())
  );
  if (!pending.length) return summary;

  const hintless = [];
  const deadline = Date.now() + COMPANY_BOARD_BACKFILL_BUDGET_MS;
  let cursor = 0;

  async function worker() {
    while (cursor < pending.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const name = pending[cursor++];
      const hint = cachedBoardHint({ repoRoot, env, name });
      if (!hint) {
        hintless.push(name);
        continue;
      }
      summary.attempted += 1;
      const result = await resolveAndPromoteCompanyBoard({
        repoRoot,
        env,
        fetchImpl,
        name,
        hint,
        timeoutMs: Math.min(COMPANY_BOARD_BACKFILL_TIMEOUT_MS, remaining),
      });
      if (result.resolved) summary.resolved += 1;
      if (result.promoted) summary.promoted += 1;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(COMPANY_BOARD_BACKFILL_CONCURRENCY, pending.length) }, worker)
  );

  // This run is "otherwise doomed" on the company-board axis: the
  // cache-hinted pass above attempted nothing, but there are hintless names
  // it never got to try. One bounded AI rescue attempt before giving up.
  if (summary.attempted === 0 && hintless.length > 0) {
    const rescue = await aiRescueHintlessCompanies({
      repoRoot,
      env,
      call,
      fetchImpl,
      names: hintless,
    });
    summary.attempted += rescue.attempted;
    summary.resolved += rescue.resolved;
    summary.promoted += rescue.promoted;
    summary.aiHintFill = {
      requested: rescue.requested,
      hinted: rescue.hinted,
      resolved: rescue.resolved,
    };
  }

  return summary;
}

function currentSourceConfigs(pathCtx) {
  return {
    searchSources: sourceConfigGet({ ...pathCtx, name: "search-sources" }).data,
    sourcedScan: sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data,
  };
}

function normalizeRunSummary(summary = {}, deterministicSources) {
  const errors = Array.isArray(summary.errors) ? summary.errors : [];
  const loginRequests = Array.isArray(summary.loginRequests) ? summary.loginRequests : [];
  return {
    attemptedSources: deterministicSources.attempted,
    scanned: Number(summary.scanned || 0),
    new: Number(summary.new || 0),
    qualified: Number(summary.qualified || 0),
    presented: Number(summary.presented ?? summary.new ?? 0),
    filtered: Math.max(
      0,
      Number(summary.scanned || 0) - Number(summary.presented ?? summary.new ?? 0)
    ),
    reconciled: Number(summary.reconciled || 0),
    reasonCounts: clone(summary.reasonCounts || {}),
    rejectionSamples: clone(summary.rejectionSamples || {}),
    errorCount: errors.length,
    errors: clone(errors),
    loginRequests: clone(loginRequests),
    sourceCoverage: clone(Array.isArray(summary.sourceCoverage) ? summary.sourceCoverage : []),
    offerCount: Array.isArray(summary.offers) ? summary.offers.length : 0,
    zeroResults: Number(summary.new || 0) === 0,
    deterministicSources: clone(deterministicSources),
  };
}

async function startSearchRun({
  repoRoot,
  env,
  fetchImpl = fetch,
  purpose,
  mode,
  retryFailed = false,
  trigger,
  searchExecutionId,
} = {}) {
  const pathCtx = { repoRoot, env };
  const config = candidateConfigGet(pathCtx);
  const prepared = await prepareFirstSearchSources({
    repoRoot,
    env,
    fetchImpl,
    config,
  });
  const deterministicSources = prepared.deterministicSources;
  const inputFingerprint = buildSourcingRunFingerprint({
    purpose,
    mode,
    config,
    searchSources: prepared.searchSources,
    sourcedScan: prepared.sourcedScan,
  });
  const start = sourcingRunStart({
    ...pathCtx,
    purpose,
    retryFailed,
    trigger,
    inputFingerprint,
    metadata: {
      deterministicSources,
      companyBoardResolution: prepared.companyBoardResolution,
      ...(searchExecutionId ? { searchExecutionId } : {}),
    },
  });

  return {
    ok: true,
    reused: start.reused === true,
    run: mapSourcingRunForUi(start.run),
    sources: {
      searches: Array.isArray(prepared.searchSources?.searches)
        ? prepared.searchSources.searches.length
        : 0,
      enabledSearches: searchList(prepared.searchSources).filter(isEnabled).length,
      trackedCompanies: Array.isArray(prepared.sourcedScan?.tracked_companies)
        ? prepared.sourcedScan.tracked_companies.length
        : 0,
      enabledTrackedCompanies: deterministicSources.supportedAtsCompanies,
      deterministicSources,
    },
    readiness: config.setup?.readiness || {},
    missing: config.setup?.missing || {},
  };
}

export function countDeterministicSources({ searchSources, sourcedScan } = {}) {
  const enabledSearches = searchList(searchSources).filter(isEnabled);
  const rss = enabledSearches.filter(isFetchableRss).length;
  const boards = enabledSearches.filter(isFetchableBoard).length;
  const browser = enabledSearches.filter(isBrowserSearchSource).length;
  const supportedAts = supportedAtsCompanies(sourcedScan).length;
  const skipped = enabledSearches.length - rss - boards - browser;
  const pendingLogins = pendingSourceLoginRequests(searchSources).length;
  return {
    attempted: rss + boards + browser + supportedAts,
    rss,
    boards,
    browser,
    supportedAtsCompanies: supportedAts,
    ...(pendingLogins > 0 ? { pendingLogins } : {}),
    skipped,
  };
}

// healSearchSourceConfig — the NO-AI, read-path companion to
// prepareFirstSearchSources below. Readiness (countDeterministicSources
// above) is computed by re-reading the STORED search-sources/sourced-scan
// config, but a pre-6de6fa6b install can have a search-sources doc that was
// seeded with zero deterministic sources (company boards seeded
// `enabled:false`, no tech RSS, no `enabled_reason: "domain-gate"` marker
// yet) — the only thing that ever repaired that doc was
// prepareFirstSearchSources's generate + mergeSearchSources (which reconciles
// the exact legacy cohort and re-syncs marked generated entries) pass, and
// that only ever runs inside an actual search run. That's a deadlock when a
// generated baseline has known provenance and can be migrated safely.
// Callers on the readiness READ path (GET /api/search/sources,
// GET /api/onboard/state) call this whenever the stored count is 0. The heal
// runs only when target titles exist and the stored rows prove generator
// ownership through the current marker or exact legacy cohort. Missing,
// default-only, and user-owned configs stay untouched and cannot become ready
// from a page load. This makes no AI calls and never touches sourced-scan's
// tracked-company board resolution (that stays search-time-only, per
// AGENTS.md's "no AI spend without intent"). Re-running an already-healed doc
// returns `healed: false` without writing.
export function healSearchSourceConfig({ repoRoot, env = process.env, config = null } = {}) {
  const pathCtx = { repoRoot, env };
  const candidateConfig = config || candidateConfigGet(pathCtx);
  const current = sourceConfigGet({ ...pathCtx, name: "search-sources" });
  const sourcedScan = sourceConfigGet({
    ...pathCtx,
    name: "sourced-scan",
  }).data;

  const before = countDeterministicSources({
    searchSources: current.data,
    sourcedScan,
  });
  if (!hasConfiguredTargetTitles(candidateConfig)) {
    const eligible = disableGeneratedBaselineWithoutTargets(current.data);
    if (current.stored !== true || eligible === current.data) {
      return {
        healed: false,
        searchSources: current.data,
        deterministicSources: before,
      };
    }
    const written = sourceConfigPut({
      ...pathCtx,
      name: "search-sources",
      data: eligible,
    });
    return {
      healed: true,
      searchSources: written.data,
      deterministicSources: countDeterministicSources({
        searchSources: written.data,
        sourcedScan,
      }),
    };
  }

  const canHealGeneratedBaseline =
    current.stored === true && hasGeneratedBaselineOwnership(current.data);
  if (!canHealGeneratedBaseline) {
    return {
      healed: false,
      searchSources: current.data,
      deterministicSources: before,
    };
  }

  const generated = buildSearchSources(candidateConfig.targeting, candidateConfig.profile);
  const merged = mergeSearchSources(current.data, generated);
  const after = countDeterministicSources({
    searchSources: merged,
    sourcedScan,
  });
  const changed =
    after.attempted > before.attempted || JSON.stringify(merged) !== JSON.stringify(current.data);

  if (!changed) {
    return {
      healed: false,
      searchSources: current.data,
      deterministicSources: before,
    };
  }

  const written = sourceConfigPut({
    ...pathCtx,
    name: "search-sources",
    data: merged,
  });
  return {
    healed: true,
    searchSources: written.data,
    deterministicSources: after,
  };
}

export function prepareDeterministicSearchSources({
  repoRoot,
  env = process.env,
  config = null,
} = {}) {
  const pathCtx = { repoRoot, env };
  const candidateConfig = config || candidateConfigGet(pathCtx);
  const current = sourceConfigGet({ ...pathCtx, name: "search-sources" });
  let sources = current;
  let sourcedScan = sourceConfigGet({
    ...pathCtx,
    name: "sourced-scan",
  }).data;
  const previousGeneratedTitleFilter = generatedTitleFilterState(current.data);
  if (hasConfiguredTargetTitles(candidateConfig)) {
    const generated = buildSearchSources(candidateConfig.targeting, candidateConfig.profile);
    const next = current.stored === true ? mergeSearchSources(current.data, generated) : generated;
    sources = sourceConfigPut({
      ...pathCtx,
      name: "search-sources",
      data: next,
    });
    sourcedScan = sourceConfigPut({
      ...pathCtx,
      name: "sourced-scan",
      data: {
        ...sourcedScan,
        title_filter: replaceGeneratedTitleFilter(
          {
            title_filter: sourcedScan.title_filter,
            ...(previousGeneratedTitleFilter
              ? {
                  generator_state: {
                    title_filter: previousGeneratedTitleFilter,
                  },
                }
              : {}),
          },
          generated
        ),
        location_filter: mergeLocationFilter(sourcedScan.location_filter, next.location_filter),
      },
    }).data;
  } else if (current.stored === true) {
    const eligible = disableGeneratedBaselineWithoutTargets(current.data);
    if (eligible !== current.data) {
      sources = sourceConfigPut({
        ...pathCtx,
        name: "search-sources",
        data: eligible,
      });
    }
    if (hasGeneratedBaselineOwnership(current.data)) {
      const titleFilter = clearGeneratedTitleFilter(
        sourcedScan.title_filter,
        previousGeneratedTitleFilter
      );
      if (titleFilter !== sourcedScan.title_filter) {
        sourcedScan = sourceConfigPut({
          ...pathCtx,
          name: "sourced-scan",
          data: { ...sourcedScan, title_filter: titleFilter },
        }).data;
      }
    }
  }

  return {
    ok: true,
    sources,
    searchSources: sources.data,
    sourcedScan,
    deterministicSources: countDeterministicSources({
      searchSources: sources.data,
      sourcedScan,
    }),
    readiness: candidateConfig.setup?.readiness || {},
    missing: candidateConfig.setup?.missing || {},
  };
}

export async function prepareFirstSearchSources({
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  // Optional AI-call override, threaded down to the LAYER 3 rescue's
  // fillManualDomainHints call — same override shape company-seeds.mjs's own
  // callers (and its tests) already use. Production callers omit it and
  // runBoundedAI falls back to the default callAI.
  call,
  config = null,
} = {}) {
  const pathCtx = { repoRoot, env };
  const candidateConfig = config || candidateConfigGet(pathCtx);
  const prepared = prepareDeterministicSearchSources({
    repoRoot,
    env,
    config: candidateConfig,
  });
  const { sources } = prepared;
  let { sourcedScan } = prepared;

  const companyBoardResolution = await backfillCompanyBoards({
    repoRoot,
    env,
    fetchImpl,
    call,
    candidateConfig,
    sourcedScan,
  });
  if (companyBoardResolution.promoted > 0) {
    sourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
  }

  const deterministicSources = countDeterministicSources({
    searchSources: sources.data,
    sourcedScan,
  });

  return {
    ...prepared,
    sourcedScan,
    deterministicSources,
    companyBoardResolution,
  };
}

export async function startFirstSearchRun({
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  retryFailed = false,
} = {}) {
  return startSearchRun({
    repoRoot,
    env,
    fetchImpl,
    purpose: "first-search",
    mode: "onboarding",
    retryFailed,
    trigger: retryFailed ? "first-search-retry" : "search-ready",
  });
}

export async function startManualSearchRun({
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  searchExecutionId,
} = {}) {
  return startSearchRun({
    repoRoot,
    env,
    fetchImpl,
    purpose: "manual-search",
    mode: "manual",
    retryFailed: false,
    trigger: "manual-search",
    searchExecutionId: createSearchExecutionId({ searchExecutionId }),
  });
}

export async function runFirstSearchInBackground({
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  runId,
  signal,
  heartbeatMs = 30_000,
  settle = true,
  captureBrowserSourceImpl,
} = {}) {
  const pathCtx = { repoRoot, env };
  let heartbeat = null;
  try {
    signal?.throwIfAborted();
    const { searchSources, sourcedScan } = currentSourceConfigs(pathCtx);
    const deterministicSources = countDeterministicSources({
      searchSources,
      sourcedScan,
    });
    // Progress is best-effort telemetry. A failed progress write (e.g. the run
    // was concurrently failed or retried, flipping it out of RUNNING) must never
    // abort the scan or block completion — partial results are already persisted
    // per batch regardless. Same convention as the detached-run .catch() callers.
    const recordProgress = (progress) => {
      try {
        sourcingRunProgress({ ...pathCtx, id: runId, progress });
      } catch {
        /* best-effort: never let progress telemetry fail the scan */
      }
    };

    let lastProgress = null;
    const heartbeatProgress = () =>
      recordProgress({
        foundCount: 0,
        offerCount: 0,
        scannedCount: 0,
        completedSources: 0,
        totalSources: deterministicSources.attempted,
        ...(lastProgress || {}),
      });
    heartbeatProgress();
    heartbeat = setInterval(heartbeatProgress, Math.max(1, Number(heartbeatMs) || 30_000));
    heartbeat.unref?.();
    const summary = await runSourcedScan({
      repoRoot,
      env,
      fetchImpl,
      captureBrowserSourceImpl,
      write: true,
      verify: true,
      assertActive: () => sourcingRunAssertActive({ ...pathCtx, id: runId }),
      writeGuard: (db) => assertSourcingRunActiveInDb(db, runId),
      signal,
      onProgress: ({ batch: _batch, ...progress }) => {
        lastProgress = progress;
        recordProgress(progress);
      },
    });
    recordProgress({
      completedSources: 0,
      totalSources: deterministicSources.attempted,
      ...(lastProgress || {}),
      foundCount: Number(summary.new || 0),
      offerCount: Array.isArray(summary.offers) ? summary.offers.length : 0,
      scannedCount: Number(summary.scanned || 0),
      errorCount: Array.isArray(summary.errors) ? summary.errors.length : 0,
    });
    const normalizedSummary = normalizeRunSummary(summary, deterministicSources);
    if (!settle) {
      return {
        settlement: { status: "completed", summary: normalizedSummary },
        value: summary,
      };
    }
    return sourcingRunComplete({
      ...pathCtx,
      id: runId,
      summary: normalizedSummary,
    }).run;
  } catch (error) {
    const failure = signal?.aborted && signal.reason ? signal.reason : error;
    if (failure?.code === "SOURCING_RUN_SERVER_STOPPED") throw failure;
    if (!settle) {
      return {
        settlement: {
          status: "failed",
          error: {
            code: failure?.code || "SOURCING_SCAN_FAILED",
            message: failure?.message || "Sourcing scan failed.",
          },
        },
        value: null,
      };
    }
    try {
      return sourcingRunFail({
        ...pathCtx,
        id: runId,
        error: {
          code: failure?.code || "SOURCING_SCAN_FAILED",
          message: failure?.message || "Sourcing scan failed.",
        },
      }).run;
    } catch {
      throw error;
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function mapSourcingRunForUi(run) {
  if (!run) {
    return {
      status: "not_started",
      label: STATUS_LABELS.not_started,
      run: null,
    };
  }
  return {
    ...clone(run),
    label: STATUS_LABELS[run.status] || String(run.status || "Unknown"),
  };
}

export function latestSourcingRunForUi({
  repoRoot,
  env = process.env,
  purpose = "first-search",
} = {}) {
  const latest = sourcingRunLatest({ repoRoot, env, purpose });
  let inputsChanged = false;
  if (latest.run) {
    const config = candidateConfigGet({ repoRoot, env });
    const searchSources = sourceConfigGet({ repoRoot, env, name: "search-sources" }).data;
    const sourcedScan = sourceConfigGet({ repoRoot, env, name: "sourced-scan" }).data;
    const currentFingerprint = buildSourcingRunFingerprint({
      purpose,
      mode: purpose === "first-search" ? "onboarding" : "manual",
      config,
      searchSources,
      sourcedScan,
    });
    inputsChanged = latest.run.metadata?.inputFingerprint !== currentFingerprint;
  }
  return {
    ...latest,
    inputsChanged,
    run: latest.run ? mapSourcingRunForUi(latest.run) : null,
  };
}
