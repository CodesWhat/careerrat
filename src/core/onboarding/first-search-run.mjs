import { runSourcedScan } from "../../../scripts/scan-sourced.mjs";
import { candidateConfigGet, hasSearchLocation } from "../db/verbs/candidate.mjs";
import { companyBoardResolutionGet } from "../db/verbs/company-discovery.mjs";
import { companyAtsUpsert, sourceConfigGet, sourceConfigPut } from "../db/verbs/source-config.mjs";
import {
  sourcingRunComplete,
  sourcingRunFail,
  sourcingRunLatest,
  sourcingRunProgress,
  sourcingRunStart,
} from "../db/verbs/sourcing-runs.mjs";
import { normalizeCompanyKey, resolveCompanyBoard } from "../discovery/company-board-resolver.mjs";
import { fillManualDomainHints } from "../discovery/company-seeds.mjs";
import { buildSearchSources } from "../profile/generate-search-sources.mjs";
import { inferProvider, isBoardProviderSupported } from "../scoring/sourced-scanner.mjs";

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

const NO_DETERMINISTIC_SOURCES = Object.freeze({
  code: "NO_DETERMINISTIC_SOURCES",
  message:
    "No deterministic first-search sources are ready. Add an RSS source or supported public ATS company before starting local sourcing.",
  action: "Add an RSS source or supported public ATS company, then retry first search.",
});

const SEARCH_LOCATION_REQUIRED = Object.freeze({
  code: "SEARCH_LOCATION_REQUIRED",
  message: "Add your location or turn on Remote to start searching.",
  action: "Add a home location or enable Remote, then retry first search.",
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

// mergeEntries above always keeps the EXISTING stored entry on a key
// collision (never clobbering a user's other edits to that entry) — which
// means an `enabled:false` seeded by an earlier run (e.g. before
// candidate.domain/titles told generate-search-sources.mjs's domain gate
// these tech-only boards should default on) would otherwise shadow a freshly
// generated `enabled:true` forever. Entries generate-search-sources.mjs
// marks `enabled_reason: "domain-gate"` are machine-set by that gate, not a
// user's own toggle, so this post-pass re-syncs ONLY `enabled` (nothing
// else on the entry) from the freshly generated copy whenever the merged
// entry still carries that marker. Nothing clears the marker today; a
// future settings-UI toggle that lets a user pin a board on/off by hand
// would need to delete `enabled_reason` at that point so this re-sync stops
// overriding the user's explicit choice.
function resyncDomainGatedEntries(mergedEntries, generatedEntries, keyForEntry) {
  const generatedByKey = new Map();
  for (const entry of Array.isArray(generatedEntries) ? generatedEntries : []) {
    const key = keyForEntry(entry);
    if (key) generatedByKey.set(key, entry);
  }
  return mergedEntries.map((entry) => {
    if (entry?.enabled_reason !== "domain-gate") return entry;
    const key = keyForEntry(entry);
    const generated = key ? generatedByKey.get(key) : null;
    if (!generated || generated.enabled === entry.enabled) return entry;
    return { ...entry, enabled: generated.enabled };
  });
}

function mergeSearchSources(existing = {}, generated = {}) {
  return {
    ...generated,
    ...existing,
    title_filter: mergeFilterObject(existing.title_filter, generated.title_filter),
    location_filter: mergeFilterObject(existing.location_filter, generated.location_filter),
    searches: resyncDomainGatedEntries(
      mergeEntries(existing.searches, generated.searches, sourceEntryKey),
      generated.searches,
      sourceEntryKey
    ),
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
    isEnabled(entry) && entry.source_type === "board" && isBoardProviderSupported(entry.provider)
  );
}

function supportedAtsCompanies(sourcedScan = {}) {
  return asArray(sourcedScan.tracked_companies).filter(
    (entry) => entry && entry.enabled !== false && Boolean(inferProvider(entry))
  );
}

function sourceSetupError() {
  return { ...NO_DETERMINISTIC_SOURCES };
}

function searchLocationError() {
  return { ...SEARCH_LOCATION_REQUIRED };
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
  const cached = companyBoardResolutionGet({ repoRoot, env, companyKey }).resolution;
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
        entry: { name: result.companyName || name, careers_url: result.careersUrl },
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
  const outcome = { requested, hinted: hintedSeeds.length, attempted: 0, resolved: 0, promoted: 0 };
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
    Array.from({ length: Math.min(COMPANY_BOARD_BACKFILL_CONCURRENCY, hintedSeeds.length) }, worker)
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
  return {
    attemptedSources: deterministicSources.attempted,
    scanned: Number(summary.scanned || 0),
    new: Number(summary.new || 0),
    qualified: Number(summary.qualified || 0),
    presented: Number(summary.presented ?? summary.new ?? 0),
    filtered: Math.max(0, Number(summary.scanned || 0) - Number(summary.presented ?? summary.new ?? 0)),
    reconciled: Number(summary.reconciled || 0),
    reasonCounts: clone(summary.reasonCounts || {}),
    errorCount: errors.length,
    errors: clone(errors),
    offerCount: Array.isArray(summary.offers) ? summary.offers.length : 0,
    zeroResults: Number(summary.new || 0) === 0,
    deterministicSources: clone(deterministicSources),
  };
}

function ensureSearchReady(pathCtx, config = candidateConfigGet(pathCtx)) {
  const setup = config.setup || {};
  if (setup.readiness?.search_ready !== true) {
    throw makeError("Candidate setup is not search-ready", "NOT_SEARCH_READY", {
      readiness: setup.readiness || {},
      missing: setup.missing || {},
    });
  }
  return config;
}

async function startSearchRun({
  repoRoot,
  env,
  fetchImpl = fetch,
  purpose,
  retryFailed = false,
  trigger,
} = {}) {
  const pathCtx = { repoRoot, env };
  const config = candidateConfigGet(pathCtx);
  if (!hasSearchLocation(config.profile)) {
    return {
      ok: true,
      parked: true,
      reused: false,
      run: {
        status: "not_started",
        label: STATUS_LABELS.not_started,
        error: searchLocationError(),
      },
      sources: {
        searches: 0,
        enabledSearches: 0,
        trackedCompanies: 0,
        enabledTrackedCompanies: 0,
        deterministicSources: {
          attempted: 0,
          rss: 0,
          boards: 0,
          supportedAtsCompanies: 0,
          skipped: 0,
        },
      },
      readiness: config.setup?.readiness || {},
      missing: config.setup?.missing || {},
    };
  }
  ensureSearchReady(pathCtx, config);
  const prepared = await prepareFirstSearchSources({ repoRoot, env, fetchImpl, config });
  const deterministicSources = prepared.deterministicSources;
  const start = sourcingRunStart({
    ...pathCtx,
    purpose,
    retryFailed,
    trigger,
    metadata: {
      deterministicSources,
      companyBoardResolution: prepared.companyBoardResolution,
    },
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
  const supportedAts = supportedAtsCompanies(sourcedScan).length;
  const skipped = enabledSearches.length - rss - boards;
  return {
    attempted: rss + boards + supportedAts,
    rss,
    boards,
    supportedAtsCompanies: supportedAts,
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
// prepareFirstSearchSources's generate + mergeSearchSources (which folds in
// resyncDomainGatedEntries) pass, and that only ever runs inside an actual
// search run. That's a deadlock: the config can't heal because a search
// can't run because the config isn't healed. Callers on the readiness READ
// path (GET /api/search/sources, GET /api/onboard/state) call this whenever
// the stored count is 0, so readiness can flip true from a page load alone —
// no search run, and (unlike backfillCompanyBoards' LAYER 3 above) ZERO AI
// calls: this only regenerates+merges the search-sources doc itself, never
// touching sourced-scan's tracked-company board resolution (that stays
// search-time-only, per AGENTS.md's "no AI spend without intent"). Idempotent:
// re-running against an already-healed doc finds nothing left to merge and
// returns `healed: false` without writing.
export function healSearchSourceConfig({ repoRoot, env = process.env, config = null } = {}) {
  const pathCtx = { repoRoot, env };
  const candidateConfig = config || candidateConfigGet(pathCtx);
  const generated = buildSearchSources(candidateConfig.targeting, candidateConfig.profile);
  const current = sourceConfigGet({ ...pathCtx, name: "search-sources" });
  const merged = current.stored === true ? mergeSearchSources(current.data, generated) : generated;
  const sourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;

  const before = countDeterministicSources({ searchSources: current.data, sourcedScan });
  const after = countDeterministicSources({ searchSources: merged, sourcedScan });
  const changed =
    after.attempted > before.attempted || JSON.stringify(merged) !== JSON.stringify(current.data);

  if (!changed) {
    return { healed: false, searchSources: current.data, deterministicSources: before };
  }

  const written = sourceConfigPut({ ...pathCtx, name: "search-sources", data: merged });
  return { healed: true, searchSources: written.data, deterministicSources: after };
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
  const generated = buildSearchSources(candidateConfig.targeting, candidateConfig.profile);
  const current = sourceConfigGet({ ...pathCtx, name: "search-sources" });
  const next = current.stored === true ? mergeSearchSources(current.data, generated) : generated;
  const sources = sourceConfigPut({ ...pathCtx, name: "search-sources", data: next });
  const currentSourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
  let sourcedScan = sourceConfigPut({
    ...pathCtx,
    name: "sourced-scan",
    data: {
      ...currentSourcedScan,
      title_filter: mergeFilterObject(currentSourcedScan.title_filter, next.title_filter),
      location_filter: mergeFilterObject(currentSourcedScan.location_filter, next.location_filter),
    },
  }).data;

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
    ok: true,
    sources,
    searchSources: sources.data,
    sourcedScan,
    deterministicSources,
    companyBoardResolution,
    readiness: candidateConfig.setup?.readiness || {},
    missing: candidateConfig.setup?.missing || {},
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
    retryFailed,
    trigger: retryFailed ? "first-search-retry" : "search-ready",
  });
}

export async function startManualSearchRun({
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return startSearchRun({
    repoRoot,
    env,
    fetchImpl,
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
    const summary = await runSourcedScan({
      repoRoot,
      env,
      fetchImpl,
      write: true,
      verify: true,
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
