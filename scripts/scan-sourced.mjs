#!/usr/bin/env node
// scripts/scan-sourced.mjs — the deterministic (non-AI) company-watchlist +
// RSS-source sweep: scans every enabled tracked_companies entry in
// config/sourced-scan.json (via each ATS's public postings API) plus every
// enabled RSS-bearing source in config/search-sources.yml, rule-scores each
// offer against candidate/targeting.yml + candidate/profile.yml
// (scoreSourcedOffer, cold-family down-weighted via computeFamilyOutcomes),
// dedupes against tracker.json + workspace/jobs (buildSeenSets), and reports
// a summary — optionally capturing kept JDs and persisting Jobs-visible sourced
// rows in DB workspaces. No AI model is ever called.
//
// src/cli/search-route.mjs calls the exported runSourcedScan() in-process for
// POST /api/search/scan. CLI flag parsing and output formatting remain behind
// the import.meta.url entry guard, so imports never touch process.argv.
//
// Usage (unchanged):
//   npm run scan:sourced -- --write --summary --verify
//   npm run scan:sourced -- --company "<Company>" --write --summary --verify
//   npm run scan:sourced -- --config <path> --limit 10
//
// Flags:
//   --config <path>    Override config/sourced-scan.json's default path
//   --company <name>   Scan only tracked_companies whose name includes this (case-insensitive)
//   --write            Capture kept JDs and persist Jobs-visible sourced rows
//   --verify           Liveness-check every kept offer's URL, drop expired ones
//   --summary          Print a human-readable summary instead of raw JSON
//   --limit <n>        Cap offers.length (0 = no cap)
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dbExists } from "../src/core/db/connection.mjs";
import { buildDbSeenSets } from "../src/core/db/scan-context.mjs";
import { companyBoardResolutionRecordScan } from "../src/core/db/verbs/company-discovery.mjs";
import {
  deepIngestConfirmedForGeneration,
  postingSightingsLoad,
  postingSightingsRecord,
} from "../src/core/db/verbs/index.mjs";
import { sourceConfigGet, sourceConfigMutate } from "../src/core/db/verbs/source-config.mjs";
import { normalizeCompanyKey } from "../src/core/discovery/company-board-resolver.mjs";
import { hydrateJobOffer } from "../src/core/intake/resolve.mjs";
import { checkUrlLiveness } from "../src/core/liveness/job-link-checker.mjs";
import { createHostThrottle } from "../src/core/net/host-throttle.mjs";
import { resolvePublicFetch } from "../src/core/net/public-http-fetch.mjs";
import {
  loadLegacyCandidateConfig,
  loadCandidateConfig as loadStoredCandidateConfig,
} from "../src/core/profile/config-store.mjs";
import { adjacencyNote } from "../src/core/profile/targeting-adjacency.mjs";
import { buildSourceUrl } from "../src/core/providers/source-url.mjs";
import {
  captureAndPersistOffersIfDb,
  offersWithCapturedJobs,
  revalidatePersistedSourcedRows,
  sourcedPolicyDigest,
  sourcedRowsFromScanOffers,
} from "../src/core/scoring/sourced-persistence.mjs";
import {
  applyPresentationCaps,
  buildLocationFilter,
  buildTitleFilter,
  computeFamilyOutcomes,
  filterAndDedupeOffers,
  isBoardProviderSupported,
  loadScannerConfig,
  requalifyCanonicalOffers,
  scanBoards,
  scanCompanies,
  scanSearchSources,
  scoreSourcedOffer,
} from "../src/core/scoring/sourced-scanner.mjs";
import { annotateTopResults } from "../src/core/search/ai-rerank.mjs";
import { loadSweepSlugs, planSweep, resolveSweepSetting } from "../src/core/search/ats-sweep.mjs";
import { planDeadBoardSkips, recordDeadBoardOutcome } from "../src/core/search/dead-boards.mjs";
import {
  SEARCH_NOT_SEARCHABLE_BROWSER_REASON,
  SEARCH_NOT_SEARCHABLE_LOGIN_REASON,
  summarizeDeadSources,
  summarizeSearchHealth,
} from "../src/core/search/search-health.mjs";
import { crossMatchNewPostings, openRunCache } from "../src/core/search/shared-postings-cache.mjs";
import { pendingSourceLoginRequests } from "../src/core/search/source-login-preflight.mjs";
import { normalizeCompanyRoleKey } from "../src/core/tracker/tracker-data.mjs";

const _scriptRoot = join(fileURLToPath(import.meta.url), "../..");

// ---------------------------------------------------------------------------
// Shared helper — reads a candidate's DB-first targeting/profile docs for the
// sweep's scoring context (keep/cut signals, comp floor, cold-family
// down-weight, location bonus — see sourced-scanner.mjs's
// scoreSourcedOfferFromConfig). Pure per-call (no module-level caching) so
// it's safe to call once per runSourcedScan() invocation against any
// repoRoot, including a fresh tempdir per test/request.
// ---------------------------------------------------------------------------

function loadCandidateConfig(pathCtx, { standaloneConfigMode = false } = {}) {
  try {
    const config = standaloneConfigMode
      ? loadLegacyCandidateConfig(pathCtx)
      : loadStoredCandidateConfig(pathCtx);
    const targeting = config?.targeting || null;
    const profile = config?.profile || null;
    if (targeting == null && profile == null) return {};
    const result = { targeting, profile };

    // DB mode only: fold confirmed role-signal rows into the scoring config so
    // scoreSourcedOffer's per-offer overlay has something to resolve against.
    // Standalone --config mode and legacy/non-DB workspaces stay unchanged —
    // no rows, byte-identical scoring.
    if (!standaloneConfigMode && dbExists(pathCtx)) {
      try {
        result.roleSignals = deepIngestConfirmedForGeneration(pathCtx).roleSignals;
      } catch {
        // best-effort — scoring falls back to no role-signal rows
      }
    }

    return result;
  } catch {
    return {};
  }
}

function toOutputOffer(offer) {
  const { bodyText, ...rest } = offer;
  const [row] = sourcedRowsFromScanOffers([offer]);
  return {
    ...rest,
    id: row?.id || rest.id || null,
    fitScore: row?.fitScore ?? null,
    fitBucket: row?.fitBucket || "",
    ratingReason: String(rest.ratingReason || ""),
    ruleFlags: Array.isArray(rest.ruleFlags) ? rest.ruleFlags : [],
    bodyChars: String(bodyText || "").length,
  };
}

function loadScannerConfigForRun({ pathCtx, configPath }) {
  if (configPath) return loadScannerConfig(configPath);
  if (dbExists(pathCtx)) return sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
  return {
    title_filter: { positive: [], negative: [] },
    location_filter: null,
    tracked_companies: [],
  };
}

function loadSearchSourcesForRun(pathCtx) {
  if (dbExists(pathCtx)) {
    return sourceConfigGet({ ...pathCtx, name: "search-sources" }).data;
  }
  return null;
}

function searchListKey(config) {
  if (Array.isArray(config?.searches)) return "searches";
  if (Array.isArray(config?.sources)) return "sources";
  return null;
}

function materializeBrowserSearchSource(source) {
  if (!source || source.enabled === false) return null;
  if (source.url) return source;
  if (!["url-query", "browser", "aggregator"].includes(source.source_type)) return null;
  try {
    const built = buildSourceUrl(source);
    return {
      ...source,
      url: built.url,
      searchState: built.searchState || source.searchState || {},
    };
  } catch {
    return null;
  }
}

function isFetchableSearchSource(source) {
  if (!source || source.enabled === false) return false;
  if (source.source_type === "rss" || source.rssUrl) return true;
  if (["ats", "board"].includes(source.source_type)) {
    return isBoardProviderSupported(source.provider) || Boolean(source.url);
  }
  return Boolean(materializeBrowserSearchSource(source));
}

function normalizedIdentityValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function searchSourceFetchIdentity(source) {
  return JSON.stringify({
    sourceType: normalizedIdentityValue(source?.source_type),
    provider: normalizedIdentityValue(source?.provider),
    rssUrl: String(source?.rssUrl || "").trim(),
    url: String(source?.url || "").trim(),
    searchUrl: String(source?.searchUrl || "").trim(),
  });
}

function persistSearchSourceWatermark({ pathCtx, source, savedAt, guard }) {
  if (!source || !dbExists(pathCtx)) return null;
  return sourceConfigMutate({
    ...pathCtx,
    name: "search-sources",
    guard,
    mutate(current) {
      const key = searchListKey(current);
      if (!key) return current;
      return {
        ...current,
        [key]: current[key].map((entry) =>
          searchSourceFetchIdentity(entry) === searchSourceFetchIdentity(source) &&
          isFetchableSearchSource(entry)
            ? {
                ...entry,
                recency: {
                  ...(entry.recency || {}),
                  lastRunAt: savedAt.toISOString(),
                },
              }
            : entry
        ),
      };
    },
  });
}

function companySourceFetchIdentity(company) {
  return JSON.stringify({
    provider: normalizedIdentityValue(company?.provider || company?.ats),
    careersUrl: String(company?.careers_url || company?.careersUrl || "").trim(),
  });
}

function persistCompanySourceWatermark({ pathCtx, companySource, savedAt, guard }) {
  if (!dbExists(pathCtx)) return null;
  return sourceConfigMutate({
    ...pathCtx,
    name: "sourced-scan",
    guard,
    mutate(current) {
      return {
        ...current,
        tracked_companies: (current.tracked_companies || []).map((company) =>
          companySourceFetchIdentity(company) === companySourceFetchIdentity(companySource) &&
          company?.enabled !== false
            ? { ...company, lastRunAt: savedAt.toISOString() }
            : company
        ),
      };
    },
  });
}

function enabledCompanies(config, companyFilter) {
  return (config.tracked_companies || [])
    .filter((entry) => entry && entry.enabled !== false)
    .filter(
      (entry) => !companyFilter || entry.name.toLowerCase().includes(companyFilter.toLowerCase())
    );
}

function searchSourceTasks(searchSources) {
  const key = searchListKey(searchSources);
  if (!key) return [];
  const entries = searchSources[key];
  const rss = [];
  const boards = [];
  const browsers = [];
  entries.forEach((source, sourceIndex) => {
    if (!source || source.enabled === false) return;
    if (source.source_type === "rss" || source.rssUrl) {
      rss.push({ kind: "rss", source, sourceIndex });
    }
    if (
      ["ats", "board"].includes(source.source_type) &&
      isBoardProviderSupported(source.provider)
    ) {
      boards.push({ kind: "board", source, sourceIndex });
    }
    const supportedBoard =
      ["ats", "board"].includes(source.source_type) && isBoardProviderSupported(source.provider);
    if (!source.rssUrl && !supportedBoard) {
      const browserSource = materializeBrowserSearchSource(source);
      if (browserSource?.url) {
        browsers.push({
          kind: "browser",
          source,
          captureSource: browserSource,
          sourceIndex,
        });
      }
    }
  });
  // The whole-scan path concatenated RSS results before board results. Keeping
  // that order makes cross-source dedup choose the exact same winner.
  return [...rss, ...boards, ...browsers];
}

function singleSearchSourceConfig(searchSources, source) {
  const key = searchListKey(searchSources);
  return { ...searchSources, [key]: [source] };
}

function sourceCoverageHost(value) {
  try {
    return new URL(String(value || "")).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function sourceCoverageStatus(result = {}) {
  if (result.needsLogin) return "login-required";
  if (Array.isArray(result.errors) && result.errors.length > 0) return "failed";
  if (Array.isArray(result.warnings) && result.warnings.length > 0) return "partial";
  return Array.isArray(result.offers) && result.offers.length > 0 ? "success" : "zero";
}

const BOARD_NOT_FOUND_NOTE =
  " This company's job board wasn't found, so CareerRat will look it up again next time it checks for companies.";

// Feed each company scan back into its cached board resolution: a board that
// answers 404 or errors is marked for a fresh lookup, and one that keeps coming
// back empty gets flagged too. Network failures say nothing about the board, so
// they are left alone.
function recordBoardHealth({ pathCtx, company, result }) {
  const errors = result.errors || [];
  let outcome;
  if (errors.length > 0) {
    const httpStatus = Number(/\bHTTP (\d{3})\b/.exec(errors[0]?.error || "")?.[1]) || 0;
    outcome = httpStatus ? { kind: "http-error", httpStatus } : { kind: "other-failure" };
    if (httpStatus === 404) {
      for (const error of errors) {
        if (/\bHTTP 404\b/.test(error.error || "")) error.error += BOARD_NOT_FOUND_NOTE;
      }
    }
  } else if (result.needsLogin) {
    return;
  } else {
    outcome = { kind: (result.offers || []).length > 0 ? "success" : "zero" };
  }
  if (!dbExists(pathCtx)) return;
  try {
    companyBoardResolutionRecordScan({
      ...pathCtx,
      companyKey: normalizeCompanyKey(company.name),
      outcome,
    });
  } catch {
    // Feedback is best-effort and must never fail the scan itself.
  }
}

function sourceCoverageReceipt({ kind, label, company, url, result }) {
  const receipt = {
    kind,
    label: String(label || company || kind)
      .trim()
      .slice(0, 160),
    host: sourceCoverageHost(url),
    status: sourceCoverageStatus(result),
    found: Array.isArray(result?.offers) ? result.offers.length : 0,
  };
  const warningCount = Array.isArray(result?.warnings) ? result.warnings.length : 0;
  if (warningCount > 0) receipt.warningCount = warningCount;
  if (result?.cacheHit) receipt.cached = true;
  if (company) receipt.company = String(company).trim().slice(0, 160);
  return receipt;
}

// Returns the persisted offers PLUS whether the batch had any artifact-write
// failures (CR-29 round 5): a failed row is neither "new" nor a genuine
// "duplicate" — sourcedUpsertBatch never wrote it, so folding it into the
// duplicate count (as persistedOffers.length shrinking used to imply) made a
// lost posting look like ordinary dedupe instead of a write that needs a
// retry. Callers gate source-watermark advancement on `failed === 0` so a
// source whose offers hit a write failure gets re-scanned next sweep instead
// of the failed posting silently aging out of retry range.
//
// Also carries `conflicts`/`conflictOffers` (CR-29 round 8): captureAndPersistOffersIfDb
// already reports a bridge offer spanning more than one distinct owner as a
// conflict rather than a duplicate, but this caller used to drop that
// distinction on the floor — a dangerous multi-owner bridge folded straight
// into the ordinary duplicate count, with no durable signal that
// reconciliation actually refused to persist it. Callers gate
// source-watermark advancement on `conflicts === 0` too, the same as
// `failed === 0`.
function captureOffersForOutput({ repoRoot, env, offers, savedAt, guard }) {
  if (dbExists({ repoRoot, env })) {
    const persisted = captureAndPersistOffersIfDb({
      repoRoot,
      env,
      offers,
      savedAt,
      guard,
      dedupeCanonical: true,
    });
    return {
      offers: persisted?.offers || [],
      failed: persisted?.failed || 0,
      failedIds: persisted?.failedIds || [],
      conflicts: persisted?.conflicts || 0,
      conflictOffers: persisted?.conflictOffers || [],
    };
  }
  return {
    offers: offersWithCapturedJobs({ repoRoot, env, offers, savedAt }),
    failed: 0,
    failedIds: [],
    conflicts: 0,
    conflictOffers: [],
  };
}

const REJECTION_SAMPLE_LIMIT = 3;

function boundedDiagnosticText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function rejectionSample(entry, fallbackReason) {
  const sample = {
    company: boundedDiagnosticText(entry?.company, 100),
    title: boundedDiagnosticText(entry?.title, 160),
    location: boundedDiagnosticText(entry?.location, 120),
    reason: boundedDiagnosticText(
      entry?.qualificationReason ||
        entry?.duplicateReason ||
        entry?.reason ||
        entry?.liveness?.reason ||
        fallbackReason,
      80
    ),
  };
  if (entry?.qualificationKind) {
    sample.kind = boundedDiagnosticText(entry.qualificationKind, 24);
  }
  if (typeof entry?.provider === "string" && entry.provider.trim()) {
    sample.provider = boundedDiagnosticText(entry.provider, 60);
  }
  return sample;
}

const CONFLICT_OFFER_SAMPLE_LIMIT = 10;

// Bounded, sanitized sample of the offers captureAndPersistOffersIfDb
// rejected as identity conflicts (CR-29 round 8) — company/title/url only,
// the same shape rejectionSample above uses for the other rejection buckets,
// so a caller can see WHICH postings need manual reconciliation without the
// summary carrying full offer bodies.
function conflictOfferSample(offer = {}) {
  return {
    company: boundedDiagnosticText(offer.company, 160),
    title: boundedDiagnosticText(offer.title || offer.role, 240),
    url: boundedDiagnosticText(offer.url || offer.link, 500),
  };
}

function buildRejectionSamples(filtered) {
  const sample = (rows, fallbackReason) =>
    rows.slice(0, REJECTION_SAMPLE_LIMIT).map((entry) => rejectionSample(entry, fallbackReason));
  return {
    title: sample(filtered.filteredTitle, "title-rejected"),
    seniority: sample(filtered.filteredSeniority, "seniority-rejected"),
    location: sample(filtered.filteredLocation, "location-rejected"),
    age: sample(filtered.filteredAge, "age-rejected"),
    salary: sample(filtered.filteredSalary, "salary-rejected"),
    eligibility: sample(filtered.filteredEligibility, "eligibility-rejected"),
    duplicate: sample(filtered.duplicates, "duplicate"),
    invalid: sample(filtered.invalid, "invalid"),
    expired: sample(filtered.expired || [], "expired"),
    overflow: sample(filtered.overflow, "overflow"),
  };
}

async function hydratePartialOffer(offer, { fetchImpl, resolveHost } = {}) {
  return hydrateJobOffer(offer, { fetchImpl, resolveHost });
}

const PARTIAL_HYDRATION_CONCURRENCY = 4;
const SOURCE_SCAN_CONCURRENCY = 4;
const LIVENESS_VERIFICATION_CONCURRENCY = 6;

async function mapWithConcurrency(items, mapper, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    })
  );
  return results;
}

export function buildSeenSetsForRun(pathCtx) {
  if (dbExists(pathCtx)) return buildDbSeenSets(pathCtx);
  return emptySeenContext();
}

function emptySeenContext() {
  return {
    seenUrls: new Set(),
    seenReqIds: new Set(),
    seenCompanyRoles: new Set(),
    tracker: { apps: [], sourced: [] },
  };
}

// ---------------------------------------------------------------------------
// runSourcedScan — the orchestration, importable. src/cli/search-route.mjs
// calls this in-process for POST /api/search/scan; main() below is just the
// CLI's argument-parsing + output-formatting wrapper around the same call.
//
// Returns the summary object
// ({scanned,new,filteredTitle,filteredLocation,duplicates,invalid,expired,
// errors,offers}) returned as POST /api/search/scan's JSON response.
//
// `env` is accepted (not read yet) to keep this call symmetric with the
// route-mounting functions in src/cli/*.mjs, all of which take env even
// where today's logic doesn't need it — see chat-route.mjs's own note on
// this exact pattern.
// ---------------------------------------------------------------------------

export async function runSourcedScan(options = {}) {
  const state = { sharedRun: null };
  try {
    return await runSourcedScanCore(options, state);
  } finally {
    state.sharedRun?.close();
  }
}

// `prefetchedOffers` (internal, used for shared-cache cross-matching) replaces
// every fetch: the postings run through this workspace's own filters, dedupe,
// caps and canonical writer, and nothing about sources (watermarks, dead boards,
// sightings, revalidation) is touched, since this workspace never fetched them.
async function runSourcedScanCore(
  {
    repoRoot,
    env = process.env,
    fetchImpl = fetch,
    resolveHost,
    configPath,
    companyFilter = null,
    write = true,
    verify = false,
    limit = 0,
    onProgress,
    assertActive,
    writeGuard,
    hydrateOfferImpl = hydratePartialOffer,
    captureBrowserSourceImpl,
    recheckDead = false,
    hostThrottle,
    rerankImpl = annotateTopResults,
    signal,
    prefetchedOffers = null,
    crossMatch = true,
  } = {},
  state = { sharedRun: null }
) {
  const prefetched = Array.isArray(prefetchedOffers);
  const ensureActive = () => {
    signal?.throwIfAborted();
    if (typeof assertActive === "function") assertActive();
  };
  // Per-host concurrency, spacing and Retry-After backoff for every request of
  // the run. Pass hostThrottle: false to bypass (tests that count raw calls).
  const throttle =
    hostThrottle === false
      ? null
      : createHostThrottle(resolvePublicFetch(fetchImpl), hostThrottle || {});
  const fetchForRun = (url, init = {}) => {
    const requestSignal =
      signal && init.signal ? AbortSignal.any([signal, init.signal]) : signal || init.signal;
    const requestInit = requestSignal ? { ...init, signal: requestSignal } : init;
    return throttle
      ? throttle.fetch(url, requestInit)
      : resolvePublicFetch(fetchImpl)(url, requestInit);
  };
  ensureActive();
  const pathCtx = { repoRoot, env };
  const standaloneConfigMode = Boolean(configPath);
  // Shared public-posting cache: reuse another person's recent fetch of a source
  // and hand newly cached postings to everyone else afterwards. An explicit
  // --company or --recheck-dead still fetches fresh (and refreshes the cache).
  const sharedRun =
    !prefetched && write && !standaloneConfigMode
      ? openRunCache({
          repoRoot,
          env,
          bypassReads: Boolean(companyFilter) || recheckDead,
        })
      : null;
  state.sharedRun = sharedRun;
  const scanCompanyCached = async (company) => {
    const hit = sharedRun?.lookup("company", company);
    if (hit) return hit;
    const result = await scanCompanies(
      { ...config, tracked_companies: [company] },
      { fetchImpl: fetchForRun, resolveHost, companyFilter: null }
    );
    sharedRun?.store("company", company, company.name, result);
    return result;
  };
  const config = loadScannerConfigForRun({ pathCtx, configPath });
  const candidateConfig = loadCandidateConfig(pathCtx, {
    standaloneConfigMode,
  });
  const { seenUrls, seenReqIds, seenCompanyRoles, tracker } = standaloneConfigMode
    ? emptySeenContext()
    : buildSeenSetsForRun(pathCtx);

  // Outcome-aware scoring: down-weight role families the candidate's own
  // results show never convert via cold board apply (see
  // computeFamilyOutcomes). Attaching it to candidateConfig threads it into
  // scoreSourcedOffer via filterAndDedupeOffers.
  const familyOutcomes = computeFamilyOutcomes(tracker?.apps || [], candidateConfig.targeting);
  candidateConfig.familyOutcomes = familyOutcomes;
  const coldFamilies = Object.entries(familyOutcomes)
    .filter(([, s]) => s.cold)
    .map(([fam, s]) => `${fam} (0/${s.total})`);

  const titleFilter = buildTitleFilter(config.title_filter, candidateConfig.targeting);
  const locationFilter = buildLocationFilter(config.location_filter);

  const scanned = {
    offers: [],
    errors: [],
    warnings: [],
    loginRequests: [],
    sourceCoverage: [],
  };
  const savedAt = new Date();
  const configuredCompanyCap = Number(
    candidateConfig?.targeting?.search_preferences?.presentation_cap_per_company
  );
  const perCompanyCap =
    Number.isInteger(configuredCompanyCap) && configuredCompanyCap > 0 ? configuredCompanyCap : 5;
  let companies = enabledCompanies(config, companyFilter);
  let searchSources = null;
  if (prefetched) companies = [];
  if (!companyFilter && !standaloneConfigMode && !prefetched) {
    try {
      searchSources = loadSearchSourcesForRun(pathCtx);
    } catch (error) {
      scanned.errors.push({
        company: "search-sources.yml",
        error: error.message,
      });
    }
  }
  // Browser-backed sources can't run without a capture implementation (the
  // terminal has none). Drop them before the run so the attempted set is the
  // runnable set: no stub results, no per-source error rows.
  const allSourceTasks = searchSourceTasks(searchSources);
  const canCaptureBrowser = typeof captureBrowserSourceImpl === "function";
  let sourceTasks = allSourceTasks.filter((task) => task.kind !== "browser" || canCaptureBrowser);
  // Reverse ATS sweep: boards from an operator-provided slug list, scanned for
  // matching roles. Off without the list file; never counts toward run health,
  // since a guessed slug that 404s says nothing about the search.
  let sweepPlan = null;
  const sweepSetting = resolveSweepSetting(candidateConfig.targeting);
  const sweepInfo = {
    enabled: false,
    boards: 0,
    scanned: 0,
    deadSkipped: 0,
    errors: 0,
    offers: 0,
  };
  if (!companyFilter && !standaloneConfigMode && !prefetched && sweepSetting.enabled) {
    try {
      const loaded = loadSweepSlugs(pathCtx);
      if (!loaded.missing) {
        sweepPlan = planSweep({
          slugs: loaded.slugs,
          tracked: config.tracked_companies || [],
          maxBoards: sweepSetting.maxBoards,
          now: savedAt.getTime(),
        });
        sweepInfo.enabled = true;
        sweepInfo.listed = loaded.slugs.length;
        sweepInfo.droppedEntries = loaded.dropped;
        sweepInfo.skippedTracked = sweepPlan.skippedTracked;
      }
    } catch (error) {
      scanned.errors.push({ company: "ats-sweep-slugs", error: error.message });
    }
  }
  // Boards that answered 404/410 on 2 runs in a row sit out until their 14-day
  // re-check (or until the source is edited). An explicit --company or
  // --recheck-dead probes everything.
  const deadPlan = prefetched
    ? {
        companies,
        tasks: sourceTasks,
        skipped: [],
        keys: new Map(),
        companyKey: () => null,
        taskKey: () => null,
      }
    : planDeadBoardSkips({
        pathCtx,
        companies,
        tasks: sourceTasks,
        allCompanies: [...(config.tracked_companies || []), ...(sweepPlan?.entries || [])],
        allSources: searchSources?.[searchListKey(searchSources)] || [],
        bypass: Boolean(companyFilter) || recheckDead,
        prune: write && !standaloneConfigMode && !companyFilter,
      });
  companies = deadPlan.companies;
  sourceTasks = deadPlan.tasks;
  const notSearchableSources = allSourceTasks
    .filter((task) => task.kind === "browser" && !canCaptureBrowser)
    .map((task) => ({
      label: task.source.label || task.source.provider || "Browser source",
      reason:
        task.source.auth === true
          ? SEARCH_NOT_SEARCHABLE_LOGIN_REASON
          : SEARCH_NOT_SEARCHABLE_BROWSER_REASON,
    }));
  const notSearchable = {
    count: notSearchableSources.length,
    sources: notSearchableSources,
  };
  const totalSources = companies.length + sourceTasks.length;
  scanned.loginRequests.push(...pendingSourceLoginRequests(searchSources));
  let completedSources = 0;
  let progressFoundCount = 0;
  let progressErrorCount = scanned.errors.length;
  let progressQueue = Promise.resolve();
  const successfulCompanySources = [];
  const successfulSearchSources = [];
  const remainingTasksBySource = new Map();
  const failedSourceIndexes = new Set();
  for (const task of sourceTasks) {
    remainingTasksBySource.set(
      task.sourceIndex,
      (remainingTasksBySource.get(task.sourceIndex) || 0) + 1
    );
  }

  function reportBatch(result, batch) {
    progressQueue = progressQueue.then(async () => {
      progressFoundCount += result.offers.length;
      progressErrorCount += result.errors.length;
      completedSources += 1;
      if (typeof onProgress === "function") {
        await onProgress({
          foundCount: progressFoundCount,
          offerCount: progressFoundCount,
          scannedCount: progressFoundCount,
          errorCount: progressErrorCount,
          completedSources,
          totalSources,
          batch,
        });
      }
    });
    return progressQueue;
  }

  function acceptBatch(result) {
    scanned.offers.push(...(result.offers || []));
    scanned.errors.push(...(result.errors || []));
    scanned.warnings.push(...(result.warnings || []));
    if (result.needsLogin) scanned.loginRequests.push(result.needsLogin);
  }

  const companyResults = await mapWithConcurrency(
    companies,
    async (company) => {
      ensureActive();
      const result = await scanCompanyCached(company);
      ensureActive();
      await reportBatch(result, { kind: "company", label: company.name });
      return { company, result };
    },
    SOURCE_SCAN_CONCURRENCY
  );
  for (const { company, result } of companyResults) {
    if (write && !standaloneConfigMode && !result.cacheHit) {
      recordBoardHealth({ pathCtx, company, result });
      recordDeadBoardOutcome({
        pathCtx,
        key: deadPlan.companyKey(company),
        kind: "company",
        label: company.name,
        result,
      });
    }
    acceptBatch(result);
    scanned.sourceCoverage.push(
      sourceCoverageReceipt({
        kind: "company",
        label: company.name,
        company: company.name,
        url: company.careers_url || company.careersUrl || company.url,
        result,
      })
    );
    // A truncated or partial scan hasn't seen everything, so it must not move
    // the source's watermark forward.
    if (
      write &&
      !standaloneConfigMode &&
      result.errors.length === 0 &&
      !(result.warnings || []).length
    ) {
      successfulCompanySources.push(company);
    }
  }

  // Also scan RSS-bearing and board-wide sources. Record successful sources
  // now, then advance their watermarks only after the run result is durable.
  const searchSourceResults = await mapWithConcurrency(
    sourceTasks,
    async (task) => {
      ensureActive();
      const singleton = singleSearchSourceConfig(searchSources, task.source);
      const cacheable = task.kind === "rss" || task.kind === "board";
      const label = task.source.label || task.source.provider || task.kind;
      let result = cacheable ? sharedRun?.lookup(task.kind, task.source) : null;
      if (!result) {
        result =
          task.kind === "rss"
            ? await scanSearchSources(singleton, {
                fetchImpl: fetchForRun,
                resolveHost,
              })
            : task.kind === "board"
              ? await scanBoards(singleton, {
                  fetchImpl: fetchForRun,
                  resolveHost,
                })
              : await captureBrowserSourceImpl(task.captureSource || task.source);
        if (cacheable) sharedRun?.store(task.kind, task.source, label, result);
      }
      ensureActive();
      await reportBatch(result, {
        kind: task.kind,
        label: task.source.label || task.source.provider || task.kind,
      });
      return { task, result };
    },
    SOURCE_SCAN_CONCURRENCY
  );
  for (const { task, result } of searchSourceResults) {
    if (
      write &&
      !standaloneConfigMode &&
      !result.cacheHit &&
      ["rss", "board"].includes(task.kind)
    ) {
      recordDeadBoardOutcome({
        pathCtx,
        key: deadPlan.taskKey(task),
        kind: task.kind,
        label: task.source.label || task.source.provider || task.kind,
        result,
      });
    }
    acceptBatch(result);
    scanned.sourceCoverage.push(
      sourceCoverageReceipt({
        kind: "configured",
        label: task.source.label || task.source.provider || task.kind,
        url:
          task.captureSource?.url || task.source.url || task.source.rssUrl || task.source.searchUrl,
        result,
      })
    );

    if (
      (result.errors || []).length > 0 ||
      (result.warnings || []).length > 0 ||
      result.needsLogin
    ) {
      failedSourceIndexes.add(task.sourceIndex);
    }
    const remaining = (remainingTasksBySource.get(task.sourceIndex) || 1) - 1;
    remainingTasksBySource.set(task.sourceIndex, remaining);
    if (
      write &&
      !standaloneConfigMode &&
      remaining === 0 &&
      !failedSourceIndexes.has(task.sourceIndex)
    ) {
      successfulSearchSources.push(task.source);
    }
  }

  if (sweepPlan?.entries.length) {
    ensureActive();
    const sweepDead = planDeadBoardSkips({
      pathCtx,
      companies: sweepPlan.entries,
      tasks: [],
      allCompanies: sweepPlan.entries,
      bypass: recheckDead,
      prune: false,
      now: savedAt,
    });
    sweepInfo.deadSkipped = sweepDead.skipped.length;
    sweepInfo.boards = sweepDead.companies.length;
    const sweepResults = await mapWithConcurrency(
      sweepDead.companies,
      async (company) => {
        ensureActive();
        const result = await scanCompanyCached(company);
        ensureActive();
        return { company, result };
      },
      SOURCE_SCAN_CONCURRENCY
    );
    for (const { company, result } of sweepResults) {
      if (write && !result.cacheHit) {
        recordDeadBoardOutcome({
          pathCtx,
          key: sweepDead.companyKey(company),
          kind: "sweep",
          label: company.name,
          result,
        });
      }
      sweepInfo.scanned += 1;
      sweepInfo.errors += (result.errors || []).length > 0 ? 1 : 0;
      sweepInfo.offers += (result.offers || []).length;
      scanned.offers.push(...(result.offers || []));
    }
  }

  if (prefetched) scanned.offers.push(...prefetchedOffers);

  // Cross-scan memory for ghost/repost demotion. Best-effort: never fails a scan.
  const sightingKey = (offer) => normalizeCompanyRoleKey(offer.company, offer.title);
  let postingHistory = null;
  if (!standaloneConfigMode && dbExists(pathCtx)) {
    try {
      postingHistory = postingSightingsLoad(pathCtx);
    } catch {
      postingHistory = null;
    }
  }

  let filtered = filterAndDedupeOffers(scanned.offers, {
    postingHistory,
    seenUrls,
    seenReqIds,
    seenCompanyRoles,
    titleFilter,
    locationFilter,
    config: candidateConfig,
    now: savedAt.getTime(),
    seenRunCompanyRoles: new Set(),
    deferPartialCandidatePolicy: true,
  });

  if (write && !standaloneConfigMode && !prefetched && dbExists(pathCtx)) {
    try {
      postingSightingsRecord({
        ...pathCtx,
        entries: scanned.offers
          .filter((offer) => offer?.company && offer?.title)
          .map((offer) => ({ key: sightingKey(offer), url: offer.url })),
        now: savedAt,
      });
    } catch {
      // Memory is an aid, not a gate.
    }
  }

  if (
    filtered.kept.some(
      (offer) => offer?.bodyPartial === true && offer?.bodyCapture !== "session-browser"
    )
  ) {
    filtered = {
      ...filtered,
      kept: await mapWithConcurrency(
        filtered.kept,
        (offer) => {
          ensureActive();
          return offer?.bodyPartial === true && offer?.bodyCapture !== "session-browser"
            ? hydrateOfferImpl(offer, { fetchImpl: fetchForRun, resolveHost })
            : offer;
        },
        PARTIAL_HYDRATION_CONCURRENCY
      ),
    };
    ensureActive();
  }

  const canonicalQualification = requalifyCanonicalOffers(filtered.kept, {
    config: candidateConfig,
    now: savedAt.getTime(),
    locationFilter,
  });
  const presentation = applyPresentationCaps(canonicalQualification.kept, {
    companyPresentationCounts: new Map(),
    perCompanyCap,
    limit: limit > 0 ? limit : Infinity,
  });
  filtered = {
    ...filtered,
    kept: presentation.kept,
    overflow: [...filtered.overflow, ...presentation.overflow],
    filteredSeniority: [...filtered.filteredSeniority, ...canonicalQualification.filteredSeniority],
    filteredLocation: [...filtered.filteredLocation, ...canonicalQualification.filteredLocation],
    filteredAge: [...filtered.filteredAge, ...canonicalQualification.filteredAge],
    filteredSalary: [...filtered.filteredSalary, ...canonicalQualification.filteredSalary],
    filteredEligibility: [
      ...filtered.filteredEligibility,
      ...canonicalQualification.filteredEligibility,
    ],
  };

  if (verify && filtered.kept.length > 0) {
    const checked = [];
    const dropped = [];
    const verificationResults = await mapWithConcurrency(
      filtered.kept,
      async (offer) => {
        ensureActive();
        const live = await checkUrlLiveness(offer.url, {
          fetchImpl: fetchForRun,
        });
        ensureActive();
        return { offer, live };
      },
      LIVENESS_VERIFICATION_CONCURRENCY
    );
    for (const { offer, live } of verificationResults) {
      if (live.result === "expired") dropped.push({ ...offer, liveness: live });
      else checked.push({ ...offer, liveness: live });
    }
    filtered = { ...filtered, kept: checked, expired: dropped };
  }

  // Opt-in AI rerank: annotates the top results, never filters or reorders them.
  let aiRerank = null;
  if (filtered.kept.length > 0) {
    ensureActive();
    const reranked = await rerankImpl({
      kept: filtered.kept,
      config: candidateConfig,
      repoRoot,
      env,
      signal,
    });
    ensureActive();
    if (reranked.aiRerank.status !== "disabled") aiRerank = reranked.aiRerank;
    filtered = { ...filtered, kept: reranked.kept };
  }

  if (write) ensureActive();
  const revalidatedExisting =
    write && !standaloneConfigMode && !prefetched
      ? revalidatePersistedSourcedRows({
          repoRoot,
          env,
          config: candidateConfig,
          now: savedAt,
          locationFilter,
          policyDigest: sourcedPolicyDigest({
            config: candidateConfig,
            locationPolicy: config.location_filter,
          }),
          guard: writeGuard,
        })
      : {
          examined: 0,
          readable: 0,
          unreadable: 0,
          hidden: 0,
          hiddenIds: [],
          skipped: false,
        };
  const persistedResult = write
    ? standaloneConfigMode
      ? {
          offers: offersWithCapturedJobs({
            repoRoot,
            env,
            offers: filtered.kept,
            savedAt,
          }),
          failed: 0,
          failedIds: [],
          conflicts: 0,
          conflictOffers: [],
        }
      : captureOffersForOutput({
          repoRoot,
          env,
          offers: filtered.kept,
          savedAt,
          guard: writeGuard,
        })
    : {
        offers: filtered.kept,
        failed: 0,
        failedIds: [],
        conflicts: 0,
        conflictOffers: [],
      };
  const persistedOffers = persistedResult.offers;

  // A source's watermark only advances when this run's write came back
  // clean (CR-29 round 5, extended round 8 to cover conflicts too): a batch
  // with artifact-write failures OR identity conflicts must not let a lost
  // (or ambiguously-owned) posting fall behind the watermark, since that
  // makes it unlikely to ever appear on retry — the source is re-scanned in
  // full again next sweep instead.
  if (
    write &&
    !standaloneConfigMode &&
    persistedResult.failed === 0 &&
    persistedResult.conflicts === 0
  ) {
    ensureActive();
    for (const companySource of successfulCompanySources) {
      persistCompanySourceWatermark({
        pathCtx,
        companySource,
        savedAt,
        guard: writeGuard,
      });
    }
    for (const source of successfulSearchSources) {
      const persisted = persistSearchSourceWatermark({
        pathCtx,
        source,
        savedAt,
        guard: writeGuard,
      });
      if (persisted?.data) searchSources = persisted.data;
    }
  }

  const outputOffers = persistedOffers.map((offer) => toOutputOffer(offer));
  // Conflicts are neither "new" nor a genuine duplicate either (CR-29 round
  // 8, same reasoning as `failed` above): a bridge offer spanning more than
  // one distinct owner gets rejected outright, not written and not merged
  // onto either owner, so it must be subtracted here too or it silently
  // reads as an ordinary duplicate.
  const persistenceDuplicates = Math.max(
    0,
    filtered.kept.length - outputOffers.length - persistedResult.failed - persistedResult.conflicts
  );
  const duplicateCount = filtered.duplicates.length + persistenceDuplicates;
  const titleBlockerCount = filtered.filteredTitle.filter(
    (offer) => offer.qualificationKind === "blocker"
  ).length;
  const titleRelevanceCount = filtered.filteredTitle.length - titleBlockerCount;

  const deadSources = summarizeDeadSources([
    ...companyResults.map(({ company, result }) => ({
      kind: "company",
      label: company.name,
      url: company.careers_url || company.careersUrl || company.url || "",
      errors: result.errors,
    })),
    ...searchSourceResults.map(({ task, result }) => ({
      kind: "source",
      label: task.source.label || task.source.provider || task.kind,
      url: task.captureSource?.url || task.source.url || task.source.rssUrl || "",
      errors: result.errors,
    })),
  ]);

  const summary = {
    scanned: scanned.offers.length,
    new: outputOffers.length,
    qualified: filtered.kept.length + filtered.overflow.length,
    presented: outputOffers.length,
    filteredTitle: filtered.filteredTitle.length,
    filteredSeniority: filtered.filteredSeniority.length,
    filteredLocation: filtered.filteredLocation.length,
    filteredAge: filtered.filteredAge.length,
    filteredSalary: filtered.filteredSalary.length,
    filteredEligibility: filtered.filteredEligibility.length,
    duplicates: duplicateCount,
    invalid: filtered.invalid.length,
    expired: filtered.expired?.length || 0,
    overflow: filtered.overflow.length,
    reasonCounts: {
      title: filtered.filteredTitle.length,
      titleBlocker: titleBlockerCount,
      titleRelevance: titleRelevanceCount,
      seniority: filtered.filteredSeniority.length,
      location: filtered.filteredLocation.length,
      age: filtered.filteredAge.length,
      salary: filtered.filteredSalary.length,
      eligibility: filtered.filteredEligibility.length,
      duplicate: duplicateCount,
      invalid: filtered.invalid.length,
      expired: filtered.expired?.length || 0,
      overflow: filtered.overflow.length,
    },
    rejectionSamples: buildRejectionSamples(filtered),
    reconciled:
      outputOffers.length +
      filtered.filteredTitle.length +
      filtered.filteredSeniority.length +
      filtered.filteredLocation.length +
      filtered.filteredAge.length +
      filtered.filteredSalary.length +
      filtered.filteredEligibility.length +
      duplicateCount +
      filtered.invalid.length +
      (filtered.expired?.length || 0) +
      filtered.overflow.length +
      persistedResult.failed +
      persistedResult.conflicts,
    // A batch with artifact-write failures marks the run as not fully clean
    // (CR-29 round 5): `failed`/`failedIds` name the offers that never made
    // it into the DB so a caller (and the source-watermark gate above) can
    // tell "written" apart from "silently discarded as a duplicate." Round 8
    // extends the same treatment to identity conflicts: a bridge offer
    // spanning more than one distinct owner is rejected outright, and must
    // mark the run not-clean the same way a write failure does rather than
    // settle silently as an ordinary duplicate.
    ok: persistedResult.failed === 0 && persistedResult.conflicts === 0,
    failed: persistedResult.failed,
    failedIds: persistedResult.failedIds,
    conflicts: persistedResult.conflicts,
    conflictOffers: (persistedResult.conflictOffers || [])
      .slice(0, CONFLICT_OFFER_SAMPLE_LIMIT)
      .map(conflictOfferSample),
    errors: scanned.errors,
    warnings: scanned.warnings,
    attemptedSources: scanned.sourceCoverage?.length,
    // Whether the sources could be read at all. `ok` above only covers saving
    // what was found, so a scan where every fetch failed used to read
    // ok:true with nothing to show for it.
    health: summarizeSearchHealth({
      errors: scanned.errors,
      warnings: scanned.warnings,
      attemptedSources: scanned.sourceCoverage?.length,
      notSearchable,
    }),
    notSearchable,
    deadBoards: { skipped: deadPlan.skipped },
    deadSources,
    adjacencyNote: adjacencyNote(candidateConfig.targeting, candidateConfig.profile),
    loginRequests: scanned.loginRequests,
    sourceCoverage: scanned.sourceCoverage,
    ...(throttle ? { requestStats: throttle.stats() } : {}),
    ...(aiRerank ? { aiRerank } : {}),
    ...(sweepInfo.enabled ? { atsSweep: sweepInfo } : {}),
    coldFamilies,
    revalidatedExisting,
    offers: outputOffers,
  };

  if (sharedRun) {
    const shared = {
      enabled: true,
      freshnessHours: sharedRun.settings.freshnessHours,
      sourcesReused: sharedRun.stats.hits,
      sourcesFetched: sharedRun.stats.fetched,
      newPostings: sharedRun.newPostings.length,
      alsoMatchedFor: [],
      skipped: [],
    };
    // Hand postings no one had cached before to everyone else's own pipeline.
    // Only per-person counts come back; nothing else about them reaches this summary.
    if (crossMatch && summary.ok && sharedRun.newPostings.length > 0) {
      ensureActive();
      const matched = await crossMatchNewPostings({
        repoRoot,
        env,
        postings: sharedRun.newPostings,
        assertActive: ensureActive,
        runScan: ({ env: personEnv, offers }) =>
          runSourcedScan({
            repoRoot,
            env: personEnv,
            fetchImpl,
            resolveHost,
            prefetchedOffers: offers,
            crossMatch: false,
            hostThrottle: false,
            write: true,
            hydrateOfferImpl: async (offer) => offer,
            rerankImpl: async ({ kept }) => ({
              kept,
              aiRerank: { status: "disabled" },
            }),
            assertActive,
            signal,
          }),
      });
      shared.alsoMatchedFor = matched.alsoMatchedFor;
      shared.skipped = matched.skipped;
    }
    summary.sharedCache = shared;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// CLI-only below: argument parsing and output formatting. None of this runs on
// import; see the entry guard at the bottom.
// ---------------------------------------------------------------------------

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

const CLI_OPTIONS = new Set([
  "--config",
  "--company",
  "--write",
  "--verify",
  "--summary",
  "--limit",
  "--recheck-dead",
]);

function assertKnownOptions(args) {
  for (const arg of args) {
    if (arg.startsWith("--") && !CLI_OPTIONS.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
}

// Exported (CR-29 round 7) so tests can exercise the summary-mode failure
// sample directly rather than only through a spawned process — `main()`
// itself, and every process.argv touch, stays behind the import.meta.url
// entry guard below exactly as before; this is a pure formatting function.
export function printSummary(summary, offers, cfg, limit) {
  if (summary.coldFamilies.length > 0) {
    console.log(`Cold-board lanes down-weighted: ${summary.coldFamilies.join(", ")}`);
  }
  if (summary.health && summary.health.status !== "ok") {
    console.log(`Scan health: ${summary.health.status}. ${summary.health.message}.`);
  }
  if (summary.adjacencyNote) console.log(summary.adjacencyNote);
  if (summary.requestStats?.rateLimited > 0) {
    const stats = summary.requestStats;
    console.log(
      `Rate limited: ${stats.rateLimited} of ${stats.attempts} requests (${stats.rateLimitedPct}%), ${stats.retried} retried after backoff`
    );
  }
  if (summary.atsSweep) {
    const sweep = summary.atsSweep;
    console.log(
      `ATS sweep: ${sweep.scanned} extra boards scanned (${sweep.offers} postings), ${sweep.deadSkipped} known-dead skipped, ${sweep.errors} unreachable`
    );
  }
  if (summary.aiRerank) console.log(`AI rerank: ${summary.aiRerank.message}`);
  if (summary.sharedCache) {
    const shared = summary.sharedCache;
    console.log(
      `Shared cache: ${shared.sourcesReused} sources reused, ${shared.sourcesFetched} fetched, ${shared.newPostings} new postings cached`
    );
    const matched = shared.alsoMatchedFor.filter((entry) => entry.count > 0);
    if (matched.length > 0) {
      console.log(
        `Also matched for: ${matched.map((entry) => `${entry.person} (${entry.count})`).join(", ")}`
      );
    }
    for (const entry of shared.skipped) {
      console.log(`Shared cache skipped ${entry.person}: ${entry.reason}`);
    }
  }
  console.log(`Scanned: ${summary.scanned}`);
  console.log(`New after filters/dedupe: ${summary.new}`);
  console.log(`Filtered by title: ${summary.filteredTitle}`);
  console.log(`Filtered by location: ${summary.filteredLocation}`);
  console.log(`Duplicates: ${summary.duplicates}`);
  // Summary mode used to hide a persistence failure entirely — `ok`/
  // `failed`/`failedIds` only ever showed up in the raw JSON output, so a
  // human (or a cron log grepping this mode) had no way to see that offers
  // were silently lost to a JD artifact-write failure. A bounded sample (up
  // to 10 ids) is enough to point someone at what needs a retry without
  // dumping the whole list.
  if (summary.ok === false) {
    const failedIds = Array.isArray(summary.failedIds) ? summary.failedIds : [];
    const sample = failedIds.slice(0, 10);
    const suffix = failedIds.length > sample.length ? ", …" : "";
    console.log(`Failed to persist: ${summary.failed} (ids: ${sample.join(", ")}${suffix})`);
  }
  if (summary.conflicts > 0) {
    const conflictOffers = Array.isArray(summary.conflictOffers) ? summary.conflictOffers : [];
    console.log(
      `Identity conflicts (not persisted): ${summary.conflicts}${
        conflictOffers.length
          ? ` (e.g. ${conflictOffers[0].company}: ${conflictOffers[0].title})`
          : ""
      }`
    );
  }
  if (summary.notSearchable?.count > 0) {
    console.log(`Not searchable from the terminal (${summary.notSearchable.count}):`);
    const byReason = new Map();
    for (const { label, reason } of summary.notSearchable.sources) {
      byReason.set(reason, [...(byReason.get(reason) || []), label]);
    }
    for (const [reason, labels] of byReason) console.log(`- ${reason} ${labels.join(", ")}`);
  }
  if (summary.deadBoards?.skipped?.length > 0) {
    const names = summary.deadBoards.skipped.map((board) => board.label).join(", ");
    console.log(
      `Skipped ${summary.deadBoards.skipped.length} dead board(s) (404 on 2 runs): ${names}. ` +
        "Re-check: edit the source, run with --recheck-dead, or wait for the automatic 14-day re-check."
    );
  }
  if (summary.deadSources?.count > 0) {
    console.log(`Dead sources (${summary.deadSources.count}):`);
    for (const { label, url, action } of summary.deadSources.sources) {
      console.log(`- ${label}${url ? ` (${url})` : ""}: not found (404). ${action}`);
    }
  }
  if (summary.errors.length > 0) {
    console.log("Errors:");
    for (const error of summary.errors) console.log(`- ${error.company}: ${error.error}`);
  }
  if (Array.isArray(summary.warnings) && summary.warnings.length > 0) {
    console.log("Warnings (results may be incomplete):");
    for (const entry of summary.warnings) console.log(`- ${entry.company}: ${entry.warning}`);
  }
  if (summary.health)
    console.log(`Search health: ${summary.health.status}. ${summary.health.message}`);
  console.log("Top scanner output:");
  for (const offer of offers.slice(0, limit || 25)) {
    const dup = offer.possibleDuplicate ? " possible-duplicate" : "";
    const rating = offer.score == null || !offer.fit ? scoreSourcedOffer(offer, cfg) : offer;
    console.log(
      `- ${rating.score}% ${rating.fit} ${rating.gate || "review"} | ${offer.company} | ${offer.title} | ${offer.location || "N/A"} | ${offer.url}${dup}`
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  assertKnownOptions(args);
  const pathCtx = { repoRoot: _scriptRoot };
  const configPath = valueAfter(args, "--config");
  const companyFilter = valueAfter(args, "--company");
  const write = args.includes("--write");
  const verify = args.includes("--verify");
  const summaryOnly = args.includes("--summary");
  const recheckDead = args.includes("--recheck-dead");
  const limit = Number(valueAfter(args, "--limit") || 0);

  const summary = await runSourcedScan({
    repoRoot: _scriptRoot,
    fetchImpl: fetch,
    configPath,
    companyFilter,
    write,
    verify,
    limit,
    recheckDead,
  });

  // A batch with JD artifact-write failures used to exit 0 in both output
  // modes: the CLI only ever printed the result, so scheduled automation
  // (a cron sweep, a CI job) had no process-level signal that offers were
  // silently lost and needed a retry (CR-29 round 7).
  if (summary.ok === false) process.exitCode = 1;
  // A scan that could not read its sources is a failed scan, not an empty one.
  // Exit 3 keeps it apart from a crash (exit 1).
  else if (summary.health?.status === "failed") process.exitCode = 3;

  const candidateConfig = loadCandidateConfig(pathCtx);

  if (summaryOnly) {
    printSummary(summary, summary.offers, candidateConfig, limit);
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
