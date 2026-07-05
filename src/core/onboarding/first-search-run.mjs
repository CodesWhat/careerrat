import { runSourcedScan } from "../../../scripts/scan-sourced.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import { sourceConfigGet, sourceConfigPut } from "../db/verbs/source-config.mjs";
import {
  sourcingRunComplete,
  sourcingRunFail,
  sourcingRunLatest,
  sourcingRunStart,
} from "../db/verbs/sourcing-runs.mjs";
import { buildSearchSources } from "../profile/generate-search-sources.mjs";
import { inferProvider } from "../scoring/sourced-scanner.mjs";

const NO_DETERMINISTIC_SOURCES = Object.freeze({
  code: "NO_DETERMINISTIC_SOURCES",
  message:
    "No deterministic first-search sources are ready. Add an RSS source or supported public ATS company before starting local sourcing.",
  action: "Add an RSS source or supported public ATS company, then retry first search.",
});

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

function makeError(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
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
    merged[key] = compactArrayValues([...asArray(existing?.[key]), ...asArray(generated?.[key])]);
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

function mergeSearchSources(existing = {}, generated = {}) {
  return {
    ...generated,
    ...existing,
    title_filter: mergeFilterObject(existing.title_filter, generated.title_filter),
    location_filter: mergeFilterObject(existing.location_filter, generated.location_filter),
    searches: mergeEntries(existing.searches, generated.searches, sourceEntryKey),
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

function supportedAtsCompanies(sourcedScan = {}) {
  return asArray(sourcedScan.tracked_companies).filter(
    (entry) => entry && entry.enabled !== false && Boolean(inferProvider(entry))
  );
}

function sourceSetupError() {
  return { ...NO_DETERMINISTIC_SOURCES };
}

function currentSourceConfigs(pathCtx) {
  return {
    searchSources: sourceConfigGet({ ...pathCtx, name: "search-sources" }).data,
    sourcedScan: sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data,
  };
}

function normalizeRunSummary(summary = {}, deterministicSources) {
  const errors = Array.isArray(summary.errors) ? summary.errors : [];
  return {
    attemptedSources: deterministicSources.attempted,
    scanned: Number(summary.scanned || 0),
    new: Number(summary.new || 0),
    errorCount: errors.length,
    offerCount: Array.isArray(summary.offers) ? summary.offers.length : 0,
    zeroResults: Number(summary.new || 0) === 0,
    deterministicSources: clone(deterministicSources),
  };
}

function ensureSearchReady(pathCtx) {
  const config = candidateConfigGet(pathCtx);
  const setup = config.setup || {};
  if (setup.readiness?.search_ready !== true) {
    throw makeError("Candidate setup is not search-ready", "NOT_SEARCH_READY", {
      readiness: setup.readiness || {},
      missing: setup.missing || {},
    });
  }
  return config;
}

function startSearchRun({ repoRoot, env, purpose, retryFailed = false, trigger } = {}) {
  const pathCtx = { repoRoot, env };
  const config = ensureSearchReady(pathCtx);
  const prepared = prepareFirstSearchSources({ repoRoot, env, config });
  const deterministicSources = prepared.deterministicSources;
  const start = sourcingRunStart({
    ...pathCtx,
    purpose,
    retryFailed,
    trigger,
    metadata: { deterministicSources },
  });

  let run = start.run;
  if (start.reused !== true && deterministicSources.attempted < 1) {
    run = sourcingRunFail({ ...pathCtx, id: start.run.id, error: sourceSetupError() }).run;
  }

  return {
    ok: true,
    reused: start.reused === true,
    run: mapSourcingRunForUi(run),
    sources: {
      searches: Array.isArray(prepared.searchSources?.searches)
        ? prepared.searchSources.searches.length
        : 0,
      trackedCompanies: Array.isArray(prepared.sourcedScan?.tracked_companies)
        ? prepared.sourcedScan.tracked_companies.length
        : 0,
      deterministicSources,
    },
    readiness: config.setup?.readiness || {},
    missing: config.setup?.missing || {},
  };
}

export function countDeterministicSources({ searchSources, sourcedScan } = {}) {
  const enabledSearches = searchList(searchSources).filter(isEnabled);
  const rss = enabledSearches.filter(isFetchableRss).length;
  const supportedAts = supportedAtsCompanies(sourcedScan).length;
  const skipped = enabledSearches.length - rss;
  return {
    attempted: rss + supportedAts,
    rss,
    supportedAtsCompanies: supportedAts,
    skipped,
  };
}

export function prepareFirstSearchSources({ repoRoot, env = process.env, config = null } = {}) {
  const pathCtx = { repoRoot, env };
  const candidateConfig = config || candidateConfigGet(pathCtx);
  const generated = buildSearchSources(candidateConfig.targeting, candidateConfig.profile);
  const current = sourceConfigGet({ ...pathCtx, name: "search-sources" });
  const next = current.stored === true ? mergeSearchSources(current.data, generated) : generated;
  const sources = sourceConfigPut({ ...pathCtx, name: "search-sources", data: next });
  const sourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
  const deterministicSources = countDeterministicSources({
    searchSources: sources.data,
    sourcedScan,
  });

  return {
    ok: true,
    sources,
    searchSources: sources.data,
    sourcedScan,
    deterministicSources,
    readiness: candidateConfig.setup?.readiness || {},
    missing: candidateConfig.setup?.missing || {},
  };
}

export function startFirstSearchRun({ repoRoot, env = process.env, retryFailed = false } = {}) {
  return startSearchRun({
    repoRoot,
    env,
    purpose: "first-search",
    retryFailed,
    trigger: retryFailed ? "first-search-retry" : "search-ready",
  });
}

export function startManualSearchRun({ repoRoot, env = process.env } = {}) {
  return startSearchRun({
    repoRoot,
    env,
    purpose: "manual-search",
    retryFailed: false,
    trigger: "manual-search",
  });
}

export async function runFirstSearchInBackground({
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  runId,
} = {}) {
  const pathCtx = { repoRoot, env };
  try {
    const { searchSources, sourcedScan } = currentSourceConfigs(pathCtx);
    const deterministicSources = countDeterministicSources({ searchSources, sourcedScan });
    if (deterministicSources.attempted < 1) {
      return sourcingRunFail({ ...pathCtx, id: runId, error: sourceSetupError() }).run;
    }

    const summary = await runSourcedScan({ repoRoot, env, fetchImpl, write: true });
    return sourcingRunComplete({
      ...pathCtx,
      id: runId,
      summary: normalizeRunSummary(summary, deterministicSources),
    }).run;
  } catch (error) {
    try {
      return sourcingRunFail({
        ...pathCtx,
        id: runId,
        error: {
          code: error?.code || "SOURCING_SCAN_FAILED",
          message: error?.message || "Sourcing scan failed.",
        },
      }).run;
    } catch {
      throw error;
    }
  }
}

export function mapSourcingRunForUi(run) {
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
  return {
    ...latest,
    run: latest.run ? mapSourcingRunForUi(latest.run) : null,
  };
}
