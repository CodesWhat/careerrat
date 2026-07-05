#!/usr/bin/env node
// scripts/scan-sourced.mjs — the deterministic (non-AI) company-watchlist +
// RSS-source sweep: scans every enabled tracked_companies entry in
// config/sourced-scan.json (via each ATS's public postings API) plus every
// enabled RSS-bearing source in config/search-sources.yml, rule-scores each
// offer against candidate/targeting.yml + candidate/profile.yml
// (scoreSourcedOffer, cold-family down-weighted via computeFamilyOutcomes),
// dedupes against tracker.json + workspace/jobs (buildSeenSets), and reports
// a summary — optionally persisting it to workspace/scan-results/ and a
// human-readable workspace/intake/*.md digest. No AI model is ever called.
//
// M3 of the paid-POC journey (the /search surface) promoted the orchestration
// below into an exported, importable runSourcedScan() — src/cli/search-route.mjs
// calls it in-process for POST /api/search/scan — the same promotion pattern
// tracker-dev.mjs used for createDevServer()/main(). The CLI's flag parsing,
// output formatting (--summary/--format=tracker/plain JSON), and the
// --format=tracker relocation-mode inference all still live in main(), gated
// behind the import.meta.url entry guard at the bottom, so importing this
// module (tests, the route) never runs the CLI or touches process.argv.
//
// Usage (unchanged):
//   npm run scan:sourced -- --write --intake --summary --verify
//   npm run scan:sourced -- --company "<Company>" --write --intake --summary --verify
//   npm run scan:sourced -- --config <path> --limit 10 --format=tracker
//
// Flags:
//   --config <path>    Override config/sourced-scan.json's default path
//   --company <name>   Scan only tracked_companies whose name includes this (case-insensitive)
//   --write            Persist the summary to workspace/scan-results/sourced-<date>.json
//   --intake           Also render workspace/intake/sourced-<date>.md
//   --verify           Liveness-check every kept offer's URL, drop expired ones
//   --format=tracker   Print one tracker.html-paste-ready object literal per offer
//   --summary          Print a human-readable summary instead of raw JSON
//   --limit <n>        Cap offers.length (0 = no cap)
//   --timestamped      Use a full timestamp (not just the date) in written filenames
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dbExists } from "../src/core/db/connection.mjs";
import { buildDbSeenSets } from "../src/core/db/scan-context.mjs";
import { sourceConfigGet, sourceConfigPut } from "../src/core/db/verbs/source-config.mjs";
import { checkUrlLiveness } from "../src/core/liveness/job-link-checker.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { loadCandidateConfig as loadStoredCandidateConfig } from "../src/core/profile/config-store.mjs";
import { parseYaml } from "../src/core/profile/yaml.mjs";
import {
  captureAndPersistOffersIfDb,
  offersWithCapturedJobs,
} from "../src/core/scoring/sourced-persistence.mjs";
import {
  buildLocationFilter,
  buildTitleFilter,
  computeFamilyOutcomes,
  filterAndDedupeOffers,
  loadScannerConfig,
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

function loadCandidateConfig(pathCtx) {
  try {
    const config = loadStoredCandidateConfig(pathCtx);
    const targeting = config?.targeting || null;
    const profile = config?.profile || null;
    if (targeting == null && profile == null) return {};
    return { targeting, profile };
  } catch {
    return {};
  }
}

function toOutputOffer(offer) {
  const { bodyText, ...rest } = offer;
  return {
    ...rest,
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
  return source && source.enabled !== false && (source.source_type === "rss" || source.rssUrl);
}

function stampSearchSourceWatermarks(config, savedAt) {
  const key = searchListKey(config);
  if (!key) return { config, stamped: 0 };
  let stamped = 0;
  const lastRunAt = savedAt.toISOString();
  const searches = config[key].map((source) => {
    if (!isFetchableSearchSource(source)) return source;
    stamped += 1;
    return { ...source, recency: { ...(source.recency || {}), lastRunAt } };
  });
  return { config: { ...config, [key]: searches }, stamped };
}

function persistSearchSourceWatermarks({ pathCtx, searchSources, savedAt }) {
  if (!searchSources) return null;
  const { config, stamped } = stampSearchSourceWatermarks(searchSources, savedAt);
  if (stamped === 0) return null;
  if (dbExists(pathCtx)) {
    return sourceConfigPut({ ...pathCtx, name: "search-sources", data: config });
  }
  return null;
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

export function buildSeenSetsForRun(pathCtx) {
  if (dbExists(pathCtx)) return buildDbSeenSets(pathCtx);
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
// errors,offers}) — the exact shape written to workspace/scan-results/*.json
// and returned as POST /api/search/scan's JSON response.
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
  configPath,
  companyFilter = null,
  write = true,
  intake = true,
  verify = false,
  limit = 0,
  timestamped = false,
} = {}) {
  void intake;
  void timestamped;
  const pathCtx = { repoRoot, env };
  const config = loadScannerConfigForRun({ pathCtx, configPath });
  const candidateConfig = loadCandidateConfig(pathCtx);
  const { seenUrls, seenReqIds, seenCompanyRoles, tracker } = buildSeenSetsForRun(pathCtx);

  // Outcome-aware scoring: down-weight role families the candidate's own
  // results show never convert via cold board apply (see
  // computeFamilyOutcomes). Attaching it to candidateConfig threads it into
  // scoreSourcedOffer via filterAndDedupeOffers.
  const familyOutcomes = computeFamilyOutcomes(tracker?.apps || [], candidateConfig.targeting);
  candidateConfig.familyOutcomes = familyOutcomes;
  const coldFamilies = Object.entries(familyOutcomes)
    .filter(([, s]) => s.cold)
    .map(([fam, s]) => `${fam} (0/${s.total})`);
  if (coldFamilies.length > 0) {
    console.log(`Cold-board lanes down-weighted: ${coldFamilies.join(", ")}`);
  }

  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);

  const scanned = await scanCompanies(config, { fetchImpl, companyFilter });

  // Also scan the RSS-bearing sources from config/search-sources.yml (the
  // file setup-searches writes). This wires the search-sources pipeline into
  // the sweep; browser/auth source types (HiringCafe, Wellfound, authenticated
  // LinkedIn/Indeed) are agent-driven per the Browser Automation Contract and
  // not fetched here.
  let sourcedFromSearches = { offers: [], errors: [] };
  let searchSources = null;
  if (!companyFilter) {
    try {
      searchSources = loadSearchSourcesForRun(pathCtx);
      if (searchSources)
        sourcedFromSearches = await scanSearchSources(searchSources, { fetchImpl });
    } catch (error) {
      sourcedFromSearches.errors.push({ company: "search-sources.yml", error: error.message });
    }
  }
  const allOffers = [...scanned.offers, ...sourcedFromSearches.offers];
  scanned.offers = allOffers;
  scanned.errors = [...scanned.errors, ...sourcedFromSearches.errors];

  let filtered = filterAndDedupeOffers(allOffers, {
    seenUrls,
    seenReqIds,
    seenCompanyRoles,
    titleFilter,
    locationFilter,
    config: candidateConfig,
  });

  if (verify && filtered.kept.length > 0) {
    const checked = [];
    const dropped = [];
    for (const offer of filtered.kept) {
      const live = await checkUrlLiveness(offer.url);
      if (live.result === "expired") dropped.push({ ...offer, liveness: live });
      else checked.push({ ...offer, liveness: live });
    }
    filtered = { ...filtered, kept: checked, expired: dropped };
  }

  const savedAt = new Date();
  const keptForOutput = limit > 0 ? filtered.kept.slice(0, limit) : filtered.kept;
  const offersForOutput = write
    ? captureOffersForOutput({ repoRoot, env, offers: keptForOutput, savedAt })
    : keptForOutput;
  const outputOffers = offersForOutput.map((offer) => toOutputOffer(offer));
  const summary = {
    scanned: scanned.offers.length,
    new: filtered.kept.length,
    filteredTitle: filtered.filteredTitle.length,
    filteredLocation: filtered.filteredLocation.length,
    duplicates: filtered.duplicates.length,
    invalid: filtered.invalid.length,
    expired: filtered.expired?.length || 0,
    errors: scanned.errors,
    offers: outputOffers,
  };

  if (write) persistSearchSourceWatermarks({ pathCtx, searchSources, savedAt });

  return summary;
}

// ---------------------------------------------------------------------------
// CLI-only below: argument parsing, output formatting, and the
// --format=tracker relocation-mode inference. None of this runs on import —
// see the entry guard at the bottom.
// ---------------------------------------------------------------------------

const _profilePath = userPath({ repoRoot: _scriptRoot }, "candidate/profile.yml");
let _reloTriggers = null; // null = not loaded yet; [] = loaded but empty or absent

function getReloTriggers() {
  if (_reloTriggers !== null) return _reloTriggers;
  try {
    if (existsSync(_profilePath)) {
      const profile = parseYaml(readFileSync(_profilePath, "utf8"));
      const relocation = profile?.location?.relocation ?? [];
      _reloTriggers = relocation
        .filter((c) => typeof c === "string" && c.trim().length > 0)
        .map((c) => c.toLowerCase().trim());
    } else {
      _reloTriggers = [];
    }
  } catch {
    _reloTriggers = [];
  }
  return _reloTriggers;
}

// 7.3: inferMode reads relo triggers from profile.location.relocation.
// Falls back to "hybrid" when no relo triggers are configured — no hardcoded metros.
function inferMode(location = "") {
  const lower = location.toLowerCase();
  if (lower.includes("remote")) return "remote";

  const triggers = getReloTriggers();
  if (triggers.length > 0 && triggers.some((metro) => lower.includes(metro))) return "relo";

  if (/\b(onsite|on-site|in office|in-office)\b/.test(lower)) return "onsite";

  return "hybrid";
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function printSummary(summary, offers, cfg, limit) {
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

function toTrackerObject(offer, cfg) {
  const safe = (value) => JSON.stringify(value || "");
  const rating = offer.score == null || !offer.fit ? scoreSourcedOffer(offer, cfg) : offer;
  const noteParts = [
    `Found by scanner via ${offer.source}`,
    `scanner fit ${rating.score}% (${rating.fit}, ${rating.gate || "review"})`,
    rating.ratingReason,
    Array.isArray(rating.ruleFlags) && rating.ruleFlags.length > 0
      ? `flags: ${rating.ruleFlags.join(", ")}`
      : "",
    "BODY-READ GATE before tailoring",
  ].filter(Boolean);
  return `{co:${safe(offer.company)}, role:${safe(offer.title)}, base:${safe(offer.comp || "verify")}, tc:${safe("+equity/bonus")}, loc:${safe(offer.location || "verify")}, mode:${safe(inferMode(offer.location))}, fitBucket:${safe(rating.fit)}, fitScore:${rating.score}, fitBasis:"triage", channel:"board", link:${safe(offer.url)}, note:${safe(noteParts.join("; "))}}`;
}

async function main() {
  const args = process.argv.slice(2);
  const pathCtx = { repoRoot: _scriptRoot };
  const configPath = valueAfter(args, "--config");
  const companyFilter = valueAfter(args, "--company");
  const write = args.includes("--write");
  const intake = args.includes("--intake");
  const verify = args.includes("--verify");
  const trackerFormat = args.includes("--format=tracker");
  const summaryOnly = args.includes("--summary");
  const limit = Number(valueAfter(args, "--limit") || 0);
  const timestamped = args.includes("--timestamped");

  const summary = await runSourcedScan({
    repoRoot: _scriptRoot,
    fetchImpl: fetch,
    configPath,
    companyFilter,
    write,
    intake,
    verify,
    limit,
    timestamped,
  });

  const candidateConfig = loadCandidateConfig(pathCtx);

  if (summaryOnly) {
    printSummary(summary, summary.offers, candidateConfig, limit);
  } else if (trackerFormat) {
    for (const offer of summary.offers) {
      console.log(toTrackerObject(offer, candidateConfig));
    }
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
