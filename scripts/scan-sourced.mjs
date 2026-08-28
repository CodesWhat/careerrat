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
import { deepIngestConfirmedForGeneration } from "../src/core/db/verbs/index.mjs";
import { sourceConfigGet, sourceConfigMutate } from "../src/core/db/verbs/source-config.mjs";
import { hydrateJobOffer } from "../src/core/intake/resolve.mjs";
import { checkUrlLiveness } from "../src/core/liveness/job-link-checker.mjs";
import {
  loadLegacyCandidateConfig,
  loadCandidateConfig as loadStoredCandidateConfig,
} from "../src/core/profile/config-store.mjs";
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
import { pendingSourceLoginRequests } from "../src/core/search/source-login-preflight.mjs";

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
                recency: { ...(entry.recency || {}), lastRunAt: savedAt.toISOString() },
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
        browsers.push({ kind: "browser", source, captureSource: browserSource, sourceIndex });
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

function captureOffersForOutput({ repoRoot, env, offers, savedAt, guard }) {
  if (dbExists({ repoRoot, env })) {
    return (
      captureAndPersistOffersIfDb({
        repoRoot,
        env,
        offers,
        savedAt,
        guard,
        dedupeCanonical: true,
      })?.offers || []
    );
  }
  return offersWithCapturedJobs({ repoRoot, env, offers, savedAt });
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

export async function runSourcedScan({
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
  signal,
} = {}) {
  const ensureActive = () => {
    signal?.throwIfAborted();
    if (typeof assertActive === "function") assertActive();
  };
  const fetchForRun = (url, init = {}) => {
    const requestSignal =
      signal && init.signal ? AbortSignal.any([signal, init.signal]) : signal || init.signal;
    return fetchImpl(url, requestSignal ? { ...init, signal: requestSignal } : init);
  };
  ensureActive();
  const pathCtx = { repoRoot, env };
  const standaloneConfigMode = Boolean(configPath);
  const config = loadScannerConfigForRun({ pathCtx, configPath });
  const candidateConfig = loadCandidateConfig(pathCtx, { standaloneConfigMode });
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

  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);

  const scanned = { offers: [], errors: [], loginRequests: [] };
  const savedAt = new Date();
  const configuredCompanyCap = Number(
    candidateConfig?.targeting?.search_preferences?.presentation_cap_per_company
  );
  const perCompanyCap =
    Number.isInteger(configuredCompanyCap) && configuredCompanyCap > 0 ? configuredCompanyCap : 5;
  const companies = enabledCompanies(config, companyFilter);
  let searchSources = null;
  if (!companyFilter && !standaloneConfigMode) {
    try {
      searchSources = loadSearchSourcesForRun(pathCtx);
    } catch (error) {
      scanned.errors.push({ company: "search-sources.yml", error: error.message });
    }
  }
  const sourceTasks = searchSourceTasks(searchSources);
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
    if (result.needsLogin) scanned.loginRequests.push(result.needsLogin);
  }

  const companyResults = await mapWithConcurrency(
    companies,
    async (company) => {
      ensureActive();
      const result = await scanCompanies(
        { ...config, tracked_companies: [company] },
        { fetchImpl: fetchForRun, resolveHost, companyFilter: null }
      );
      ensureActive();
      await reportBatch(result, { kind: "company", label: company.name });
      return { company, result };
    },
    SOURCE_SCAN_CONCURRENCY
  );
  for (const { company, result } of companyResults) {
    acceptBatch(result);
    if (write && !standaloneConfigMode && result.errors.length === 0) {
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
      const result =
        task.kind === "rss"
          ? await scanSearchSources(singleton, { fetchImpl: fetchForRun, resolveHost })
          : task.kind === "board"
            ? await scanBoards(singleton, { fetchImpl: fetchForRun, resolveHost })
            : typeof captureBrowserSourceImpl === "function"
              ? await captureBrowserSourceImpl(task.captureSource || task.source)
              : {
                  offers: [],
                  errors: [
                    {
                      company: task.source.label || task.source.provider || "Browser source",
                      error: "Open this search in the CareerRat app so its browser can read it.",
                    },
                  ],
                  needsLogin: null,
                };
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
    acceptBatch(result);

    if ((result.errors || []).length > 0 || result.needsLogin) {
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

  let filtered = filterAndDedupeOffers(scanned.offers, {
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
        const live = await checkUrlLiveness(offer.url, { fetchImpl: fetchForRun });
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

  if (write) ensureActive();
  const revalidatedExisting =
    write && !standaloneConfigMode
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
  const persistedOffers = write
    ? standaloneConfigMode
      ? offersWithCapturedJobs({ repoRoot, env, offers: filtered.kept, savedAt })
      : captureOffersForOutput({
          repoRoot,
          env,
          offers: filtered.kept,
          savedAt,
          guard: writeGuard,
        })
    : filtered.kept;

  if (write && !standaloneConfigMode) {
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
  const persistenceDuplicates = Math.max(0, filtered.kept.length - outputOffers.length);
  const duplicateCount = filtered.duplicates.length + persistenceDuplicates;
  const titleBlockerCount = filtered.filteredTitle.filter(
    (offer) => offer.qualificationKind === "blocker"
  ).length;
  const titleRelevanceCount = filtered.filteredTitle.length - titleBlockerCount;

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
      filtered.overflow.length,
    errors: scanned.errors,
    loginRequests: scanned.loginRequests,
    coldFamilies,
    revalidatedExisting,
    offers: outputOffers,
  };

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
]);

function assertKnownOptions(args) {
  for (const arg of args) {
    if (arg.startsWith("--") && !CLI_OPTIONS.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
}

function printSummary(summary, offers, cfg, limit) {
  if (summary.coldFamilies.length > 0) {
    console.log(`Cold-board lanes down-weighted: ${summary.coldFamilies.join(", ")}`);
  }
  console.log(`Scanned: ${summary.scanned}`);
  console.log(`New after filters/dedupe: ${summary.new}`);
  console.log(`Filtered by title: ${summary.filteredTitle}`);
  console.log(`Filtered by location: ${summary.filteredLocation}`);
  console.log(`Duplicates: ${summary.duplicates}`);
  if (summary.errors.length > 0) {
    console.log("Errors:");
    for (const error of summary.errors) console.log(`- ${error.company}: ${error.error}`);
  }
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
  const limit = Number(valueAfter(args, "--limit") || 0);

  const summary = await runSourcedScan({
    repoRoot: _scriptRoot,
    fetchImpl: fetch,
    configPath,
    companyFilter,
    write,
    verify,
    limit,
  });

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
