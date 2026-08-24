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
import { sourceConfigGet, sourceConfigPut } from "../src/core/db/verbs/source-config.mjs";
import { resolveJobUrl } from "../src/core/intake/resolve.mjs";
import { checkUrlLiveness } from "../src/core/liveness/job-link-checker.mjs";
import {
  loadLegacyCandidateConfig,
  loadCandidateConfig as loadStoredCandidateConfig,
} from "../src/core/profile/config-store.mjs";
import {
  captureAndPersistOffersIfDb,
  offersWithCapturedJobs,
  sourcedRowsFromScanOffers,
} from "../src/core/scoring/sourced-persistence.mjs";
import {
  buildLocationFilter,
  buildTitleFilter,
  computeFamilyOutcomes,
  filterAndDedupeOffers,
  isBoardProviderSupported,
  loadScannerConfig,
  scanBoards,
  scanCompanies,
  scanSearchSources,
  scoreSourcedOffer,
} from "../src/core/scoring/sourced-scanner.mjs";

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

function isFetchableSearchSource(source) {
  if (!source || source.enabled === false) return false;
  if (source.source_type === "rss" || source.rssUrl) return true;
  return ["ats", "board"].includes(source.source_type) && isBoardProviderSupported(source.provider);
}

function stampSearchSourceWatermark(config, sourceIndex, savedAt) {
  const key = searchListKey(config);
  if (!key || !isFetchableSearchSource(config[key]?.[sourceIndex])) {
    return { config, stamped: false };
  }
  const lastRunAt = savedAt.toISOString();
  const searches = config[key].map((source, index) =>
    index === sourceIndex
      ? { ...source, recency: { ...(source.recency || {}), lastRunAt } }
      : source
  );
  return { config: { ...config, [key]: searches }, stamped: true };
}

function persistSearchSourceWatermark({ pathCtx, searchSources, sourceIndex, savedAt }) {
  if (!searchSources) return null;
  const { config, stamped } = stampSearchSourceWatermark(searchSources, sourceIndex, savedAt);
  if (!stamped) return null;
  if (dbExists(pathCtx)) {
    return sourceConfigPut({ ...pathCtx, name: "search-sources", data: config });
  }
  return null;
}

function persistCompanySourceWatermark({ pathCtx, companyName, savedAt }) {
  if (!dbExists(pathCtx)) return null;
  const current = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
  const target = String(companyName || "")
    .trim()
    .toLowerCase();
  const companies = (current.tracked_companies || []).map((company) =>
    String(company?.name || "")
      .trim()
      .toLowerCase() === target
      ? { ...company, lastRunAt: savedAt.toISOString() }
      : company
  );
  return sourceConfigPut({
    ...pathCtx,
    name: "sourced-scan",
    data: { ...current, tracked_companies: companies },
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
  });
  // The whole-scan path concatenated RSS results before board results. Keeping
  // that order makes cross-source dedup choose the exact same winner.
  return [...rss, ...boards];
}

function singleSearchSourceConfig(searchSources, source) {
  const key = searchListKey(searchSources);
  return { ...searchSources, [key]: [source] };
}

function emptyFilteredResult() {
  return {
    kept: [],
    filteredTitle: [],
    filteredSeniority: [],
    filteredLocation: [],
    filteredAge: [],
    filteredSalary: [],
    filteredEligibility: [],
    duplicates: [],
    possibleDuplicates: [],
    invalid: [],
    expired: [],
    overflow: [],
  };
}

function appendFilteredResult(target, result) {
  for (const key of Object.keys(target)) {
    if (Array.isArray(result[key])) target[key].push(...result[key]);
  }
}

function captureOffersForOutput({ repoRoot, env, offers, savedAt }) {
  if (dbExists({ repoRoot, env })) {
    return (
      captureAndPersistOffersIfDb({
        repoRoot,
        env,
        offers,
        savedAt,
      })?.offers || []
    );
  }
  return offersWithCapturedJobs({ repoRoot, env, offers, savedAt });
}

async function hydratePartialOffer(offer, { fetchImpl, resolveHost } = {}) {
  if (offer?.bodyPartial !== true || !offer?.url) return offer;
  try {
    const resolved = await resolveJobUrl(offer.url, { fetchImpl, resolveHost });
    const bodyText = String(resolved?.bodyText || "").trim();
    if (resolved?.bodyFetchStatus !== "resolved" || bodyText.length < 40) return offer;
    const canonicalUrl = resolved.url || offer.url;
    return {
      ...offer,
      url: canonicalUrl,
      location: resolved.location || offer.location,
      comp: resolved.comp || offer.comp,
      bodyText,
      bodyPartial: false,
      ...(canonicalUrl !== offer.url ? { capturedUrl: offer.url } : {}),
    };
  } catch {
    return offer;
  }
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
} = {}) {
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

  const scanned = { offers: [], errors: [] };
  const filtered = emptyFilteredResult();
  const outputOffers = [];
  const savedAt = new Date();
  const companyPresentationCounts = new Map();
  const seenRunCompanyRoles = new Set();
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
  let completedSources = 0;
  const remainingTasksBySource = new Map();
  const failedSourceIndexes = new Set();
  for (const task of sourceTasks) {
    remainingTasksBySource.set(
      task.sourceIndex,
      (remainingTasksBySource.get(task.sourceIndex) || 0) + 1
    );
  }

  async function acceptBatch(result, batch) {
    scanned.offers.push(...result.offers);
    scanned.errors.push(...result.errors);

    let batchFiltered = filterAndDedupeOffers(result.offers, {
      seenUrls,
      seenReqIds,
      seenCompanyRoles,
      titleFilter,
      locationFilter,
      config: candidateConfig,
      now: savedAt.getTime(),
      companyPresentationCounts,
      seenRunCompanyRoles,
      perCompanyCap,
    });

    if (batchFiltered.kept.some((offer) => offer?.bodyPartial === true)) {
      batchFiltered = {
        ...batchFiltered,
        kept: await Promise.all(
          batchFiltered.kept.map((offer) => hydratePartialOffer(offer, { fetchImpl, resolveHost }))
        ),
      };
    }

    if (verify && batchFiltered.kept.length > 0) {
      const checked = [];
      const dropped = [];
      for (const offer of batchFiltered.kept) {
        const live = await checkUrlLiveness(offer.url, { fetchImpl });
        if (live.result === "expired") dropped.push({ ...offer, liveness: live });
        else checked.push({ ...offer, liveness: live });
      }
      batchFiltered = { ...batchFiltered, kept: checked, expired: dropped };
    }

    const remainingLimit = limit > 0 ? Math.max(0, limit - outputOffers.length) : Infinity;
    const keptForOutput = batchFiltered.kept.slice(0, remainingLimit);
    const limitedOverflow = batchFiltered.kept.slice(remainingLimit).map((offer) => ({
      ...offer,
      qualificationReason: "run-presentation-limit",
    }));
    batchFiltered = {
      ...batchFiltered,
      kept: keptForOutput,
      overflow: [...batchFiltered.overflow, ...limitedOverflow],
    };
    appendFilteredResult(filtered, batchFiltered);
    const offersForOutput = write
      ? standaloneConfigMode
        ? offersWithCapturedJobs({ repoRoot, env, offers: keptForOutput, savedAt })
        : captureOffersForOutput({ repoRoot, env, offers: keptForOutput, savedAt })
      : keptForOutput;
    outputOffers.push(...offersForOutput.map((offer) => toOutputOffer(offer)));
    completedSources += 1;

    if (typeof onProgress === "function") {
      await onProgress({
        foundCount: filtered.kept.length,
        offerCount: outputOffers.length,
        scannedCount: scanned.offers.length,
        errorCount: scanned.errors.length,
        completedSources,
        totalSources,
        batch,
      });
    }
  }

  for (const company of companies) {
    const result = await scanCompanies(
      { ...config, tracked_companies: [company] },
      { fetchImpl, resolveHost, companyFilter: null }
    );
    await acceptBatch(result, { kind: "company", label: company.name });
    if (write && !standaloneConfigMode && result.errors.length === 0) {
      persistCompanySourceWatermark({ pathCtx, companyName: company.name, savedAt });
    }
  }

  // Also scan RSS-bearing and board-wide sources. Processing singleton configs
  // turns each completed fetch into an independently visible Jobs batch while
  // retaining the former company -> RSS -> board ordering for exact dedup parity.
  for (const task of sourceTasks) {
    const singleton = singleSearchSourceConfig(searchSources, task.source);
    const result =
      task.kind === "rss"
        ? await scanSearchSources(singleton, { fetchImpl, resolveHost })
        : await scanBoards(singleton, { fetchImpl, resolveHost });
    await acceptBatch(result, {
      kind: task.kind,
      label: task.source.label || task.source.provider || task.kind,
    });

    if (result.errors.length > 0) failedSourceIndexes.add(task.sourceIndex);
    const remaining = (remainingTasksBySource.get(task.sourceIndex) || 1) - 1;
    remainingTasksBySource.set(task.sourceIndex, remaining);
    if (
      write &&
      !standaloneConfigMode &&
      remaining === 0 &&
      !failedSourceIndexes.has(task.sourceIndex)
    ) {
      const persisted = persistSearchSourceWatermark({
        pathCtx,
        searchSources,
        sourceIndex: task.sourceIndex,
        savedAt,
      });
      if (persisted?.data) searchSources = persisted.data;
    }
  }

  const summary = {
    scanned: scanned.offers.length,
    new: filtered.kept.length,
    qualified: filtered.kept.length + filtered.overflow.length,
    presented: filtered.kept.length,
    filteredTitle: filtered.filteredTitle.length,
    filteredSeniority: filtered.filteredSeniority.length,
    filteredLocation: filtered.filteredLocation.length,
    filteredAge: filtered.filteredAge.length,
    filteredSalary: filtered.filteredSalary.length,
    filteredEligibility: filtered.filteredEligibility.length,
    duplicates: filtered.duplicates.length,
    invalid: filtered.invalid.length,
    expired: filtered.expired?.length || 0,
    overflow: filtered.overflow.length,
    reasonCounts: {
      title: filtered.filteredTitle.length,
      seniority: filtered.filteredSeniority.length,
      location: filtered.filteredLocation.length,
      age: filtered.filteredAge.length,
      salary: filtered.filteredSalary.length,
      eligibility: filtered.filteredEligibility.length,
      duplicate: filtered.duplicates.length,
      invalid: filtered.invalid.length,
      expired: filtered.expired?.length || 0,
      overflow: filtered.overflow.length,
    },
    reconciled:
      filtered.kept.length +
      filtered.filteredTitle.length +
      filtered.filteredSeniority.length +
      filtered.filteredLocation.length +
      filtered.filteredAge.length +
      filtered.filteredSalary.length +
      filtered.filteredEligibility.length +
      filtered.duplicates.length +
      filtered.invalid.length +
      (filtered.expired?.length || 0) +
      filtered.overflow.length,
    errors: scanned.errors,
    coldFamilies,
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
