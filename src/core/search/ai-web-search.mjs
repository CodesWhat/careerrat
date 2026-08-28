// ai-web-search.mjs — server-side driver for the Jobs page's "AI Web Search"
// lane: runs the search-jobs skill's AI Web Search mode (see that SKILL.md's
// own section) via the embedded one-shot runtime (runSkillStream, "chat" tool
// profile — Read/Glob/Grep/WebFetch/WebSearch/Skill, no Bash/Write/Edit/
// browser — see runtime-tools.mjs), buffers the model's single fenced JSON
// reply, validates it against config/ai-web-search.schema.json via the same
// bounded/correction-retry helper POST /api/onboard/resume-ai(-stream) uses
// (bounded-ai.mjs's runBoundedAI, structuredMode: "fallback" — see
// onboard-route.mjs's runResumeExtractBounded), hard-dedupes survivors by
// canonical posting URL or provider-qualified requisition ID against BOTH the
// current batch and existing sourced offers + tracker applications (reusing
// the same sourced-identity.mjs keys as the deterministic scanner and DB
// persistence guard), and persists survivors through the same DB
// write path the deterministic sweep uses
// (sourced-persistence.mjs's captureAndPersistOffersIfDb, which both writes
// the JD-body capture file under workspace/jobs/ and upserts the sourced
// row), tagged `source: "ai-web-search"` instead of "scanner".
//
// Cost-gated via modes.mjs's computeAllows("search:ai-web", modes): the
// op table (modes.mjs) never returns "skip" for this operation, only
// "downshift" (lean) or "run" (standard/full) — lean mode narrows how many
// saved prompts run (PROMPT_CAP_BY_MODE below), it never blocks the feature
// outright.
//
// Prompts are always loaded server-side from the stored
// targeting.search_preferences.ai_prompts (search-prompts.mjs's
// getSearchPrompts) — the client only ever passes `promptIds` (which of the
// already-saved prompts to run), never prompt text itself, so a compromised
// or buggy client can't smuggle arbitrary instructions into the skill run.
//
// Two error codes are thrown (not returned) for pre-condition failures a
// caller invoked incorrectly: NO_DATABASE (no SQLite candidate setup yet)
// and NO_SAVED_PROMPTS (nothing to run after applying promptIds/the mode
// cap). Every other outcome — including the model failing to produce valid
// structured output, or a mid-flight AI-route hiccup — is folded into the
// returned `errors` array rather than thrown, mirroring runSourcedScan()'s
// own summary shape (scan-sourced.mjs): the run completed, just with
// partial/zero results and a diagnostic message, not an exception.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOUNDED_AI_CODES, runBoundedAI } from "../ai/bounded-ai.mjs";
import { candidateSafeRuntimeUsageLimit } from "../ai/installed-runtimes.mjs";
import {
  runSkillStream as defaultRunSkillStream,
  resolveAllowedSkills,
} from "../ai/skill-runtime.mjs";
import { dbExists } from "../db/connection.mjs";
import { buildDbSeenSets } from "../db/scan-context.mjs";
import { candidateConfigGet, sourceConfigGet } from "../db/verbs.mjs";
import { hydrateJobOffer } from "../intake/resolve.mjs";
import { validatePublicHttpUrl } from "../net/public-http-fetch.mjs";
import { computeAllows } from "../profile/modes.mjs";
import { buildSourceUrl } from "../providers/source-url.mjs";
import {
  addPostingIdentity,
  extractReqId,
  postingIdentityIsSeen,
} from "../scoring/sourced-identity.mjs";
import {
  captureAndPersistOffersIfDb,
  revalidatePersistedSourcedRows,
} from "../scoring/sourced-persistence.mjs";
import {
  normalizeCompanyRoleKey,
  requalifyCanonicalOffers,
  resolveCompensationEvidence,
} from "../scoring/sourced-scanner.mjs";
import { buildSearchPromptContext, getSearchPrompts } from "./search-prompts.mjs";
import { normalizedTitleWords, titleMatchesBucket } from "./title-match.mjs";

const AI_WEB_SEARCH_SCHEMA_PATH = "config/ai-web-search.schema.json";

const AI_WEB_SEARCH_LABELS = Object.freeze({
  skill: "search-jobs",
  action: "ai-web-search",
  operation: "search:ai-web",
});

const MANUAL_FALLBACK = Object.freeze({
  available: true,
  reason: "manual-ai-web-search",
  action: "Search job boards yourself and add roles manually.",
});

// Per-mode saved-prompt cap — see modes.mjs's "search:ai-web" USAGE_OPERATIONS
// entry (lean: downshift, standard/full: run). An unrecognized usage_mode
// (shouldn't happen; normalizeModes() already defaults it) falls back to the
// standard cap rather than either extreme.
const PROMPT_CAP_BY_MODE = Object.freeze({ lean: 1, standard: 3, full: 5 });
const HYDRATION_CONCURRENCY = 4;
const AI_WEB_SEARCH_PROMPT_CONCURRENCY = 2;
const AI_WEB_SEARCH_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;
const AI_WEB_SEARCH_HEARTBEAT_MS = 30 * 1000;
const MAX_FRESHNESS_RECOVERY_TURNS = 2;
const MAX_USEFUL_SET_TOP_UP_TURNS = 3;
const MIN_USEFUL_SET_ROLES = 3;
const MIN_USEFUL_SET_BUCKETS = 2;
const MAX_SEARCH_QUERY_LENGTH = 100;
const MAX_CONFIGURED_SOURCE_HINTS = 4;
const MAX_CANONICAL_DISQUALIFICATIONS = 20;
const MAX_FETCHED_POSTING_DECISIONS = 20;
const MAX_CORRECTION_CONTEXT_CHARS = 2 * 1024 * 1024;
const AI_WEB_SEARCH_TURN_LIMITS = Object.freeze({
  scope: "prompt-turn",
  web_search_calls: 4,
  web_fetch_calls: 8,
  hard_stop: true,
});
const COMMON_ATS_SEARCH_HOSTS = Object.freeze([
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com",
  "jobs.smartrecruiters.com",
  "myworkdayjobs.com",
]);
const RESULT_URL_POLICY = Object.freeze([
  "Prefer employer-owned career pages and direct ATS postings.",
  "Use third-party boards to discover employer-and-title pairs, and attempt to resolve a direct posting URL before returning the third-party URL.",
  "Return one exact current posting URL, never a search, category, location, career-hub, or redirect-wrapper URL.",
  "If an exact posting-specific third-party page is browser-blocked after that direct-resolution attempt, return it with body_text null and body_partial true so CareerRat can preserve it as an explicitly unverified partial lead.",
  "Reject generic pages, expired redirects, unsafe or private URLs, and postings whose canonical evidence names a different job.",
]);

function savedFitFloor(config = {}) {
  const raw = config?.targeting?.fit_bands?.fit_floor;
  const configured = raw == null || raw === "" ? Number.NaN : Number(raw);
  const floor = Number.isFinite(configured) ? configured : 70;
  return Math.max(0, Math.min(100, floor));
}

function offerMeetsFitFloor(offer, fitFloor) {
  if (offer?.score == null || offer.score === "") return true;
  const score = Number(offer.score);
  return Number.isFinite(score) && score >= fitFloor;
}

function searchRequiresCanonicalLocation(config) {
  const location = config?.profile?.location || {};
  return (
    Boolean(String(location.home || "").trim()) ||
    (Array.isArray(location.relocation) && location.relocation.some(Boolean))
  );
}

function missingPresentationIdentityFields(offer, { requireLocation = false } = {}) {
  return [
    ["company", offer?.company],
    ["title", offer?.title],
    ...(requireLocation ? [["location", offer?.location]] : []),
    ["source", isPostingEvidenceUrl(offer?.url) ? offer.url : ""],
  ]
    .filter(([, value]) => !String(value || "").trim())
    .map(([field]) => field);
}

function offerHasCompletePresentationIdentity(offer, options) {
  return missingPresentationIdentityFields(offer, options).length === 0;
}

function offerHasReadableCanonicalEvidence(offer) {
  return offer?.bodyFetchStatus !== "deferred";
}

function offerCanBePresented(offer, fitFloor, options) {
  const score = Number(offer?.score);
  return (
    offerHasCompletePresentationIdentity(offer, options) &&
    offerHasReadableCanonicalEvidence(offer) &&
    Number.isFinite(score) &&
    score >= fitFloor
  );
}

function canonicalRecoveryRejectionReason(offer, { config }) {
  const qualification = requalifyCanonicalOffers([offer], { config });
  if (qualification.filteredLocation.length) {
    return "The canonical location violates the saved hard location filter.";
  }
  if (qualification.filteredSalary.length) {
    return "The canonical compensation is below the saved hard salary floor.";
  }
  if (qualification.filteredSeniority.length) {
    return "The canonical role violates the saved seniority filter.";
  }
  if (qualification.filteredAge.length) {
    return "The canonical posting violates the saved freshness filter.";
  }
  if (qualification.filteredEligibility.length) {
    return "The canonical role violates the saved work-eligibility filter.";
  }
  return null;
}

function fitFloorRecoveryRejectionReason(offer, fitFloor) {
  return offerMeetsFitFloor(offer, fitFloor)
    ? null
    : `The canonical fit score is below the saved presentation floor of ${fitFloor}.`;
}

function matchingCanonicalCandidateIndex(candidates, offer) {
  return candidates.findIndex((candidate) => {
    const candidateKeys = new Set();
    addPostingIdentity(candidateKeys, candidate);
    return postingIdentityIsSeen(offer, candidateKeys);
  });
}

// Sourced-row `gate` for an AI-web-search survivor. This mode's `candidate`
// context (buildSearchPromptContext) never carries company-history or
// application-limit data (see the SKILL.md section's own note), so unlike
// the deterministic scanner's gateFromScoreAndFlags() this can only ever
// resolve two ways: a cut-shaped flag from the skill's own STEP 3 triage
// demotes it to "likely-cut"; everything else lands on "review" rather than
// an automatic "likely-keep" — a brand-new, less-verified channel earns a
// human look before promotion, regardless of fit score.
const CUT_GATE_FLAGS = new Set([
  "likely-cut",
  "excluded-company",
  "comp-below-floor",
  "app-limit-blocked",
]);

function deriveGate(ruleFlags = []) {
  return ruleFlags.some((flag) => CUT_GATE_FLAGS.has(flag) || flag.startsWith("cut-risk-"))
    ? "likely-cut"
    : "review";
}

function openWebEvidenceBody(role) {
  const lines = [
    "Unverified open-web search evidence. Evaluate this role before relying on its availability or details.",
    role.source_evidence ? `Source evidence: ${role.source_evidence}` : "",
    role.location ? `Location shown: ${role.location}` : "",
    role.comp_text ? `Compensation shown: ${role.comp_text}` : "",
    role.base_comp_text ? `Base pay shown: ${role.base_comp_text}` : "",
    role.annual_earnings_text ? `Annual earnings shown: ${role.annual_earnings_text}` : "",
    role.posted_at ? `Listed: ${role.posted_at}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

// Map one AI-web-search schema role into the "offer" shape
// sourced-persistence.mjs's sourcedRowsFromScanOffers()/offersWithCapturedJobs()
// expect (the same shape scoreSourcedOffer()'s callers produce) — reusing
// that write path rather than hand-rolling a second one.
function toScanOffer(role, { key, reqId }) {
  const ruleFlags = Array.isArray(role.rule_flags) ? role.rule_flags.filter(Boolean) : [];
  const score = Number(role.fit_score);
  const bodyText = String(role.body_text || "").trim();
  const compensation = resolveCompensationEvidence({
    comp: role.comp_text,
    baseComp: role.base_comp_text,
    annualEarningsComp: role.annual_earnings_text,
  });
  return {
    company: role.company,
    title: role.title,
    url: role.url,
    location: role.location || "",
    comp: role.comp_text || "",
    baseComp: compensation.baseComp,
    annualEarningsComp: compensation.annualEarningsComp,
    postedAt: role.posted_at || null,
    bodyText: bodyText || openWebEvidenceBody(role),
    bodyPartial: !bodyText || role.body_partial === true,
    score: Number.isFinite(score) ? score : 0,
    fit: role.fit_bucket || "",
    gate: deriveGate(ruleFlags),
    ratingReason: role.source_evidence || "",
    ruleFlags,
    source: "ai-web-search",
    sourceLabel: "Open web",
    sourceProvider: sourceHost(role.url),
    reqId,
    key,
  };
}

function loadSchema(repoRoot) {
  return JSON.parse(readFileSync(join(repoRoot, AI_WEB_SEARCH_SCHEMA_PATH), "utf8"));
}

function throwPreconditionError(message, code) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function throwIfSearchAborted(signal) {
  if (!signal?.aborted) return;
  const err = new Error("AI web search was cancelled.");
  err.code = "AI_WEB_SEARCH_ABORTED";
  throw err;
}

function safePromptFailure({ outcome, runtimeFailure }) {
  if (runtimeFailure?.code === "RUNTIME_TIMEOUT") {
    return "AI search took too long to finish. Try it again.";
  }
  if (runtimeFailure?.code === "RUNTIME_USAGE_LIMIT") {
    return (
      candidateSafeRuntimeUsageLimit(runtimeFailure.message)?.message ||
      "The selected AI provider has reached its usage limit. Try again later."
    );
  }
  if (outcome?.body?.code === BOUNDED_AI_CODES.AI_SCHEMA_INVALID) {
    return "AI search returned unusable results. Try it again.";
  }
  if (outcome?.body?.code === BOUNDED_AI_CODES.AI_CAP_EXCEEDED) {
    return outcome.body.error?.message;
  }
  return "AI search couldn't finish. Try it again.";
}

const TRANSIENT_AUTHORIZED_RUNTIME_RESPONSE =
  /^(?:Search response was unavailable in the authorized runtime|No usable assistant response)\.?$/i;

function isTransientAuthorizedRuntimeResponse({ runtimeResult, rawText }) {
  if (runtimeResult?.aborted === true) return false;
  if (runtimeResult?.ok === false) {
    const code = String(runtimeResult.code || "").trim();
    if (
      code === "RUNTIME_USAGE_LIMIT" ||
      code === "RUNTIME_AUTH_REQUIRED" ||
      code === "RUNTIME_CANCELLED"
    ) {
      return false;
    }
    return TRANSIENT_AUTHORIZED_RUNTIME_RESPONSE.test(String(runtimeResult.error || "").trim());
  }
  return !String(rawText || "").trim();
}

function safeToolError(content) {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .filter(Boolean)
      .join(" ");
  } else if (content != null) {
    try {
      text = JSON.stringify(content);
    } catch {
      text = String(content);
    }
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 240) : "The web tool reported a failure.";
}

function sourceHost(url) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function normalizedSourceUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return String(value || "").trim();
  }
}

function fetchedPostingAccountabilityErrors(data, toolTrace) {
  const accountedUrls = new Set(
    [...(Array.isArray(data?.roles) ? data.roles : []), ...(data?.rejected_postings || [])]
      .map((entry) => normalizedSourceUrl(entry?.url))
      .filter(Boolean)
  );
  const missingUrls = [
    ...new Set(
      toolTrace
        .filter(
          (item) =>
            item.kind === "source" && item.status === "completed" && isPostingEvidenceUrl(item.url)
        )
        .map((item) => normalizedSourceUrl(item.url))
        .filter((url) => url && !accountedUrls.has(url))
    ),
  ];
  return missingUrls.map((url) => ({
    path: "rejected_postings",
    message:
      "successfully fetched exact posting must appear in roles[].url or " +
      `rejected_postings[].url with a short factual reason: ${url}`,
  }));
}

const GENERIC_CAREER_HUB_SEGMENTS = new Set([
  "application",
  "applications",
  "apply",
  "career",
  "careers",
  "employment",
  "index",
  "index.html",
  "job",
  "jobs",
  "join-our-team",
  "join-us",
  "openings",
  "open-positions",
  "opportunities",
  "positions",
  "results",
  "search",
  "search-results",
  "work-for-us",
  "work-with-us",
]);

function isGenericCareerHubUrl(url) {
  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  return (
    segments.length === 0 || segments.every((segment) => GENERIC_CAREER_HUB_SEGMENTS.has(segment))
  );
}

export function isPostingEvidenceUrl(rawUrl) {
  const checked = validatePublicHttpUrl(rawUrl);
  if (!checked.ok) return false;
  let url;
  try {
    url = new URL(checked.url);
  } catch {
    return false;
  }
  if (
    !new Set(["http:", "https:"]).has(url.protocol) ||
    url.username ||
    url.password ||
    /expired[_-]?jd[_-]?redirect/i.test(url.href)
  ) {
    return false;
  }

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    return /^\/jobs\/view\/[^/]*\d+\/?$/i.test(path);
  }
  if (host === "ziprecruiter.com" || host.endsWith(".ziprecruiter.com")) {
    return !/^\/jobs(?:\/|$)/i.test(path);
  }
  if (host === "indeed.com" || host.endsWith(".indeed.com")) {
    const hasPostingId = Boolean(url.searchParams.get("jk") || url.searchParams.get("vjk"));
    return hasPostingId || !/^\/(?:jobs(?:\/|$)|q-[^/]+-jobs(?:\.html)?(?:\/|$))/i.test(path);
  }
  if (host === "glassdoor.com" || host.endsWith(".glassdoor.com")) {
    const hasPostingId = Boolean(
      url.searchParams.get("jl") || url.searchParams.get("jobListingId")
    );
    return hasPostingId || !/^\/job(?:\/|$)/i.test(path) || /\/job-listing(?:\/|$)/i.test(path);
  }
  if (host === "wellfound.com" || host.endsWith(".wellfound.com")) {
    return /^\/jobs\/\d+(?:[-/]|$)/i.test(path);
  }
  return !isGenericCareerHubUrl(url);
}

function mergeSourceReceipts(toolTrace, recoveredSources) {
  const byUrl = new Map();
  for (const source of [
    ...toolTrace.filter((item) => item.kind === "source").map(({ kind, ...item }) => item),
    ...recoveredSources,
  ]) {
    const url = String(source?.url || "").trim();
    if (!url) continue;
    byUrl.set(url, {
      ...(byUrl.get(url) || {}),
      ...source,
      url,
      host: source.host || sourceHost(url),
    });
  }
  return [...byUrl.values()];
}

async function mapBounded(items, concurrency, mapItem) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapItem(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function normalizeQueryResults({ selected, queriesRun, toolTrace, fallbackError = null }) {
  const traceByQuery = new Map(
    toolTrace
      .filter((item) => item.kind === "query")
      .map((item) => [
        String(item.query || "")
          .trim()
          .toLowerCase(),
        item,
      ])
  );
  const normalizedQueries = Array.isArray(queriesRun) ? queriesRun : [];

  const queryResults = selected.map((prompt) => {
    let queries = normalizedQueries
      .filter((item) => String(item?.prompt_id || "") === prompt.id)
      .map((item) => {
        const query = String(item?.query || "").trim();
        const trace = traceByQuery.get(query.toLowerCase());
        const failed = item?.status === "failed" || trace?.status === "failed";
        return {
          query,
          status: failed ? "failed" : "completed",
          error: failed ? String(item?.error || trace?.error || "The search query failed.") : null,
        };
      })
      .filter((item) => item.query);

    if (fallbackError) {
      queries = [{ query: prompt.text, status: "failed", error: fallbackError }];
    }

    const failedQueries = queries.filter((item) => item.status === "failed");
    const missingCoverage = !queries.length;
    const error = fallbackError
      ? fallbackError
      : failedQueries[0]?.error ||
        (missingCoverage ? "No query coverage was reported for this saved prompt." : null);
    return {
      promptId: prompt.id,
      prompt: prompt.text,
      status: error ? "failed" : "completed",
      queries,
      ...(error ? { error } : {}),
    };
  });

  return {
    queryResults,
    failedPromptIds: queryResults
      .filter((item) => item.status === "failed")
      .map((item) => item.promptId),
  };
}

function mergePromptCoverage({ selected, outcomes }) {
  const queryResults = selected.map((prompt) => {
    const entries = outcomes
      .flatMap((outcome) => outcome.queryResults || [])
      .filter((entry) => entry.promptId === prompt.id);
    const queries = entries.flatMap((entry) => entry.queries || []);
    const primaryEntries = entries.filter((entry) => entry.auxiliary !== true);
    const authoritativeEntries = primaryEntries.length ? primaryEntries : entries;
    const failure = authoritativeEntries.find((entry) => entry.status === "failed");
    return {
      promptId: prompt.id,
      prompt: prompt.text,
      status: failure ? "failed" : "completed",
      queries,
      ...(failure ? { error: failure.error } : {}),
    };
  });
  return {
    queryResults,
    failedPromptIds: queryResults
      .filter((entry) => entry.status === "failed")
      .map((entry) => entry.promptId),
  };
}

function concentratedRejectedHosts(rejections) {
  const counts = new Map();
  for (const { offer } of rejections) {
    const host = sourceHost(offer?.url);
    if (host) counts.set(host, (counts.get(host) || 0) + 1);
  }
  const total = rejections.length;
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count >= 2 && count / total >= 0.6)
      .map(([host]) => host)
  );
}

function unreadableRejectedHosts(rejections) {
  return new Set(
    rejections
      .filter(({ offer }) => offer?.bodyFetchStatus === "deferred")
      .map(({ offer }) => sourceHost(offer?.url))
      .filter(Boolean)
  );
}

function freshnessRecoveryInstruction(rejections) {
  const rejectedPostings = rejections.slice(0, 40).map(({ offer, reason }) => ({
    url: offer.url,
    reason: String(reason || "The canonical posting could not be verified.").slice(0, 240),
  }));
  const rejectedSourceHosts = [...concentratedRejectedHosts(rejections)];
  return [
    "CareerRat's canonical checker rejected every usable candidate from this saved prompt for liveness, posting-identity, or saved hard-filter reasons.",
    "Run one fresh replacement search on the same provider. Return currently active, posting-specific roles that still satisfy every original candidate boundary.",
    "For a rejected third-party URL, first look for the canonical employer-owned or direct ATS posting for the same employer and title. A different canonical direct URL for the same role or requisition is a valid replacement.",
    "Search employer-owned career pages and direct ATS postings first. Return candidates from at least two source hosts when the open web has them, with no more than one candidate from the same third-party host.",
    "Do not return an exact rejected URL below or a host listed in rejected_source_hosts. Do not loosen title, location, compensation, freshness, or fit requirements.",
    JSON.stringify({
      rejected_postings: rejectedPostings,
      rejected_source_hosts: rejectedSourceHosts,
    }),
  ].join("\n");
}

function usefulSetTopUpInstruction(
  consideredCandidates,
  missingTargetTitles = [],
  {
    survivorRoles = [],
    representedBuckets = [],
    missingBuckets = [],
    rejectedSourceHosts = [],
  } = {}
) {
  const consideredPostings = consideredCandidates.slice(0, 60).map(({ offer, reason }) => ({
    url: offer.url,
    reason: String(reason || "CareerRat already considered this posting.").slice(0, 240),
  }));
  return [
    "CareerRat's canonical result set is still underfilled after the saved prompts finished.",
    "Run one bounded additional search on the same provider for this saved prompt. Return additional, distinct, currently active posting-specific roles that satisfy every original candidate boundary.",
    missingTargetTitles.length
      ? `Prioritize these configured target titles that are still unrepresented: ${missingTargetTitles.join(", ")}.`
      : "Prioritize a distinct configured target title that is still unrepresented when one is available.",
    "Search employer-owned career pages and direct ATS postings first. Do not repeat an already considered URL or requisition or use a host listed in rejected_source_hosts. Do not loosen title, location, compensation, freshness, or fit requirements.",
    JSON.stringify({
      missing_target_titles: missingTargetTitles,
      survivor_roles: survivorRoles,
      represented_buckets: representedBuckets,
      missing_buckets: missingBuckets,
      considered_postings: consideredPostings,
      rejected_source_hosts: rejectedSourceHosts,
    }),
  ].join("\n");
}

function sourceTargetUrl(source) {
  const saved = String(source?.url || source?.rssUrl || "").trim();
  if (saved) return saved;
  try {
    return String(buildSourceUrl(source)?.url || "").trim();
  } catch {
    return "";
  }
}

function validatedEnabledSourceHost(source) {
  if (!source || source.enabled === false || source.login_skipped === true) return "";
  const checked = validatePublicHttpUrl(sourceTargetUrl(source));
  if (!checked.ok) return "";
  return new URL(checked.url).hostname.replace(/^www\./, "").toLowerCase();
}

function sourceMatchesTitles(source, titles) {
  if (!titles.length) return false;
  const sourceWords = normalizedTitleWords(
    [source?.query, source?.searchState?.searchQuery, source?.label].filter(Boolean).join(" ")
  );
  return titles.some((title) => {
    const titleWords = normalizedTitleWords(title);
    return titleWords.size > 0 && [...titleWords].every((word) => sourceWords.has(word));
  });
}

function configuredSourceHosts(
  sourceConfig,
  titles,
  { excludedHosts = [], limit = MAX_CONFIGURED_SOURCE_HINTS } = {}
) {
  const entries = Array.isArray(sourceConfig?.searches)
    ? sourceConfig.searches
    : Array.isArray(sourceConfig?.sources)
      ? sourceConfig.sources
      : [];
  const excluded = new Set(
    excludedHosts
      .map((host) =>
        String(host || "")
          .replace(/^www\./, "")
          .toLowerCase()
      )
      .filter(Boolean)
  );
  const candidates = entries
    .map((source, index) => ({
      host: validatedEnabledSourceHost(source),
      index,
      matched: sourceMatchesTitles(source, titles),
    }))
    .filter(({ host }) => host && !excluded.has(host));
  const hosts = [];
  const seen = new Set();
  for (const candidate of candidates.sort(
    (left, right) => Number(right.matched) - Number(left.matched) || left.index - right.index
  )) {
    if (seen.has(candidate.host)) continue;
    seen.add(candidate.host);
    hosts.push(candidate.host);
    if (hosts.length === limit) break;
  }
  return hosts;
}

function normalizedTitleTokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const GENERIC_TARGET_TITLE_SUFFIXES = new Set(["engineer", "engineering", "manager", "management"]);

function phraseRanges(words, phrase) {
  if (!phrase.length || phrase.length > words.length) return [];
  const ranges = [];
  for (let start = 0; start <= words.length - phrase.length; start += 1) {
    if (phrase.every((word, index) => words[start + index] === word)) {
      ranges.push({ start, end: start + phrase.length });
    }
  }
  return ranges;
}

function configuredTitlePhrases(title) {
  const phrases = [normalizedTitleTokens(title)];
  const [head, ...qualifiers] = String(title || "").split(",");
  if (head && qualifiers.length) {
    phrases.push(normalizedTitleTokens(`${qualifiers.join(" ")} ${head}`));
  }
  return phrases.filter((phrase, index, all) => {
    const key = phrase.join(" ");
    return key && all.findIndex((candidate) => candidate.join(" ") === key) === index;
  });
}

function configuredTitlesNamedByPrompt(prompt, bucket) {
  const promptWords = normalizedTitleTokens(prompt?.text);
  const matches = (Array.isArray(bucket?.titles) ? bucket.titles : []).map((title) => {
    const titleWords = normalizedTitleTokens(title);
    const fullRanges = configuredTitlePhrases(title).flatMap((phrase) =>
      phraseRanges(promptWords, phrase)
    );
    const core = GENERIC_TARGET_TITLE_SUFFIXES.has(titleWords.at(-1))
      ? titleWords.slice(0, -1)
      : [];
    return {
      title,
      titleLength: titleWords.length,
      ranges: fullRanges.length
        ? fullRanges
        : core.length >= 2
          ? phraseRanges(promptWords, core)
          : [],
    };
  });
  return matches
    .filter(({ titleLength, ranges }, index) =>
      ranges.some(
        (range) =>
          !matches.some(
            (other, otherIndex) =>
              otherIndex !== index &&
              other.titleLength > titleLength &&
              other.ranges.some(
                (otherRange) => otherRange.start <= range.start && otherRange.end >= range.end
              )
          )
      )
    )
    .map(({ title }) => title);
}

function mostSpecificTitles(titles) {
  return titles.filter((title) => {
    const words = normalizedTitleWords(title);
    return !titles.some((otherTitle) => {
      if (otherTitle === title) return false;
      const otherWords = normalizedTitleWords(otherTitle);
      return otherWords.size > words.size && [...words].every((word) => otherWords.has(word));
    });
  });
}

function promptMatchesBucketName(prompt, bucket) {
  const promptWords = normalizedTitleWords(prompt?.text);
  const bucketWords = normalizedTitleWords(bucket?.name);
  return bucketWords.size >= 2 && [...bucketWords].every((word) => promptWords.has(word));
}

function promptTargetTitles(prompt, bucket, buckets) {
  const namedTitles = configuredTitlesNamedByPrompt(prompt, bucket);
  if (namedTitles.length) return namedTitles;
  const hasAnyNamedTitle = buckets.some(
    (candidate) => configuredTitlesNamedByPrompt(prompt, candidate).length > 0
  );
  return !hasAnyNamedTitle && promptMatchesBucketName(prompt, bucket) ? bucket.titles : [];
}

function promptMatchesBucket(prompt, bucket, buckets) {
  return promptTargetTitles(prompt, bucket, buckets).length > 0;
}

function quoteSearchTerm(value) {
  const text = String(value || "")
    .replace(/["\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? `"${text}"` : "";
}

function searchPlanTitles(prompt, candidateContext) {
  const titles = [];
  const seen = new Set();
  const buckets = Array.isArray(candidateContext?.role_buckets)
    ? candidateContext.role_buckets
    : [];
  for (const bucket of buckets) {
    const selectedTitles = promptTargetTitles(prompt, bucket, buckets);
    for (const title of selectedTitles) {
      const key = String(title || "")
        .trim()
        .toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      titles.push(String(title).trim());
    }
  }
  return titles;
}

function parseSearchPlanRemoteIntent(prompt) {
  let explicit = false;
  let scope = "";
  const clauses = String(prompt?.text || "").split(/[,;.!?]+/);
  const scopedOutsideExclusion = (clause) => {
    const outside = clause.match(/\boutside\s+(?:the\s+)?(.+?)\s*$/i);
    if (!outside) return "";
    const beforeOutside = clause.slice(0, outside.index);
    const excludesOutside =
      /\b(?:exclude|excluding)\b/i.test(beforeOutside) ||
      /\b(?:do\s+not|don't)\s+(?:include|show|find|search(?:\s+for)?)\b/i.test(beforeOutside);
    const excludesAnotherMode =
      /\b(?:local|hybrid|on-?site)\b/i.test(beforeOutside) && !/\bremote\b/i.test(beforeOutside);
    return excludesOutside && !excludesAnotherMode ? outside[1] : "";
  };
  const outsideScope = clauses.map(scopedOutsideExclusion).find(Boolean) || "";

  for (const clause of clauses) {
    for (const match of clause.matchAll(/\bremote\b/gi)) {
      const before = clause.slice(0, match.index);
      const after = clause.slice(match.index + match[0].length);
      const exclusionPrefix = /\b(?:exclude|excluding)\b[^,;.!?]*$/i.test(before);
      const prefixIsNegated =
        (exclusionPrefix && !/\b(?:do\s+not|don't)\s+exclude\b/i.test(before)) ||
        /\bno(?:\s+(?:roles?|jobs?|work|positions?))?(?:\s+that\s+(?:are|is))?\s*$/i.test(before) ||
        /\bnot\s*$/i.test(before) ||
        /\bwithout(?:\s+(?:any|all))?(?:\s+(?:roles?|jobs?|work|positions?)(?:\s+that\s+(?:are|is))?)?\s+(?:fully\s+)?$/i.test(
          before
        ) ||
        /\b(?:do\s+not|don't)\s+(?:include|show|find|search(?:\s+for)?)\b[^,;.!?]*$/i.test(before);
      const suffixIsNegated =
        /^(?:\s+(?:roles?|jobs?|work|positions?))?\s+(?:are\s+)?(?:excluded|not\s+allowed|off\s+limits)\b/i.test(
          after
        );
      const occurrenceOutsideScope = scopedOutsideExclusion(clause);
      const isNegated = prefixIsNegated || suffixIsNegated;

      if (!isNegated || occurrenceOutsideScope) explicit = true;
      scope ||=
        occurrenceOutsideScope ||
        (!isNegated &&
          after.match(
            /\b(?:in|within)\s+(?:the\s+)?(.+?)(?=\s+(?:and|but)\s+(?:available|eligible|open|accessible)\b|$)/i
          )?.[1]) ||
        "";
    }
  }
  if (explicit && !scope) scope = outsideScope;
  return { explicit, scope };
}

function searchPlanLocationClause(prompt, location = {}) {
  const alternatives = [];
  const home = quoteSearchTerm(location.home);
  const remoteIntent = parseSearchPlanRemoteIntent(prompt);
  if (home) alternatives.push(home);
  if (location.remote === true && remoteIntent.explicit) {
    alternatives.push(["remote", quoteSearchTerm(remoteIntent.scope)].filter(Boolean).join(" "));
  }
  if (!home && location.hybrid === true) alternatives.push("hybrid");
  if (!home && location.onsite === true) alternatives.push("onsite");
  if (!alternatives.length) return "";
  return alternatives.length === 1 ? alternatives[0] : `(${alternatives.join(" OR ")})`;
}

function searchTitleClause(titles, fallback = "") {
  if (!titles.length) return quoteSearchTerm(fallback);
  return titles.length === 1
    ? quoteSearchTerm(titles[0])
    : `(${titles.map(quoteSearchTerm).join(" OR ")})`;
}

function searchQuery(titles, locationClause, sourceClause = "") {
  return [searchTitleClause(titles), locationClause, sourceClause].filter(Boolean).join(" ");
}

function boundedFallbackQuery(fallback, locationClause, sourceClause = "") {
  const tail = [[locationClause, sourceClause], [locationClause], [sourceClause], []]
    .map((parts) => parts.filter(Boolean).join(" "))
    .find((candidate) => candidate.length <= MAX_SEARCH_QUERY_LENGTH - 3);
  const available = Math.max(0, MAX_SEARCH_QUERY_LENGTH - tail.length - (tail ? 1 : 0) - 2);
  const normalized = String(fallback || "")
    .replace(/["\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const clipped = normalized.slice(0, available);
  const title =
    clipped.length < normalized.length ? clipped.replace(/\s+\S*$/, "").trim() : clipped;
  return [quoteSearchTerm(title), tail].filter(Boolean).join(" ");
}

function boundedSearchQuery(titles, locationClause, sourceClause = "") {
  const query = searchQuery(titles, locationClause, sourceClause);
  if (query.length <= MAX_SEARCH_QUERY_LENGTH) return query;
  const withoutSource = searchQuery(titles, locationClause);
  if (withoutSource.length <= MAX_SEARCH_QUERY_LENGTH) return withoutSource;
  const titlesOnly = searchTitleClause(titles);
  if (titlesOnly.length <= MAX_SEARCH_QUERY_LENGTH) return titlesOnly;
  if (titles.length > 1) {
    const compactTitles = [];
    for (const title of titles) {
      const candidate = [...compactTitles, title];
      if (searchQuery(candidate, locationClause).length > MAX_SEARCH_QUERY_LENGTH) break;
      compactTitles.push(title);
    }
    if (compactTitles.length) return searchQuery(compactTitles, locationClause);
    return boundedSearchQuery([titles[0]], locationClause);
  }
  return boundedFallbackQuery(titles.join(" OR "), "");
}

function directSourceClause(
  titles,
  locationClause,
  sourceHosts = [],
  excludedHosts = [],
  preferDirectSources = false
) {
  const excluded = new Set(
    excludedHosts.map((host) =>
      String(host || "")
        .replace(/^www\./, "")
        .toLowerCase()
    )
  );
  const atsCandidates = COMMON_ATS_SEARCH_HOSTS.map((host) => `site:${host}`);
  const directCandidates = ["careers", ...atsCandidates];
  const configuredCandidates = sourceHosts.map((host) => `site:${host}`);
  const candidates = preferDirectSources
    ? [...directCandidates, ...configuredCandidates]
    : sourceHosts.length
      ? [configuredCandidates[0], "careers", ...configuredCandidates.slice(1), ...atsCandidates]
      : directCandidates;
  const sources = [];
  for (const candidate of candidates) {
    if (candidate.startsWith("site:") && excluded.has(candidate.slice("site:".length))) continue;
    if (sources.includes(candidate)) continue;
    const candidateSources = [...sources, candidate];
    const candidateClause =
      candidateSources.length === 1 ? candidateSources[0] : `(${candidateSources.join(" OR ")})`;
    if (searchQuery(titles, locationClause, candidateClause).length > MAX_SEARCH_QUERY_LENGTH) {
      continue;
    }
    sources.push(candidate);
  }
  if (!sources.length) return "";
  return sources.length === 1 ? sources[0] : `(${sources.join(" OR ")})`;
}

function partitionSearchTitles(titles, locationClause) {
  if (titles.length <= 1) return [titles];
  const groups = [];
  let current = [];
  for (const title of titles) {
    const candidate = [...current, title];
    if (
      current.length > 0 &&
      searchQuery(candidate, locationClause, "careers").length > MAX_SEARCH_QUERY_LENGTH
    ) {
      groups.push(current);
      current = [title];
    } else {
      current = candidate;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

function buildSearchQueryHints(
  titles,
  locationClause,
  fallback,
  initialKind,
  sourceHosts = [],
  excludedHosts = [],
  preferDirectSources = false
) {
  if (!titles.length) {
    const sourceClause = directSourceClause(
      [],
      locationClause,
      sourceHosts,
      excludedHosts,
      preferDirectSources
    );
    const directQuery = boundedFallbackQuery(fallback, locationClause, sourceClause || "careers");
    return [
      { kind: initialKind, query: boundedFallbackQuery(fallback, locationClause) },
      {
        kind: sourceHosts.some((host) => directQuery.includes(`site:${host}`))
          ? "configured-source-or-direct"
          : "direct-employer-or-ats",
        query: directQuery,
      },
    ];
  }
  const titleGroups = partitionSearchTitles(titles, locationClause);
  const sourceHint = (hintTitles, directFirst) => {
    const sourceClause = directSourceClause(
      hintTitles,
      locationClause,
      sourceHosts,
      excludedHosts,
      preferDirectSources || directFirst
    );
    const query = boundedSearchQuery(hintTitles, locationClause, sourceClause);
    return {
      kind: sourceHosts.some((host) => query.includes(`site:${host}`))
        ? "configured-source-or-direct"
        : "direct-employer-or-ats",
      query,
    };
  };
  if (titles.length >= 3) {
    if (titleGroups.length > 2) {
      const hints = titleGroups.slice(0, 4).map((hintTitles) => sourceHint(hintTitles, true));
      for (const hintTitles of titleGroups) {
        if (hints.length >= 4) break;
        hints.push({ kind: initialKind, query: boundedSearchQuery(hintTitles, locationClause) });
      }
      return hints;
    }
    const [broadTitles, directTitles = broadTitles] = titleGroups;
    return [
      { kind: initialKind, query: boundedSearchQuery(broadTitles, locationClause) },
      { kind: initialKind, query: boundedSearchQuery(directTitles, locationClause) },
      sourceHint(broadTitles, true),
      sourceHint(directTitles, false),
    ];
  }
  const [broadTitles, directTitles = broadTitles] = titleGroups;
  return [
    { kind: initialKind, query: boundedSearchQuery(broadTitles, locationClause) },
    sourceHint(directTitles, false),
  ];
}

function buildPromptSearchPlan(
  prompt,
  candidateContext,
  {
    sourceConfig,
    rejectedCandidates = [],
    missingTargetTitles = [],
    excludedHosts = [],
    preferDirectSources = false,
  } = {}
) {
  const titles = missingTargetTitles.length
    ? missingTargetTitles
    : searchPlanTitles(prompt, candidateContext);
  const locationClause = searchPlanLocationClause(prompt, candidateContext?.location);
  const rejectedHosts = [
    ...new Set([
      ...rejectedCandidates.map(({ offer }) => sourceHost(offer?.url)).filter(Boolean),
      ...excludedHosts,
    ]),
  ];
  const sourceHints = configuredSourceHosts(sourceConfig, titles, {
    excludedHosts: rejectedHosts,
  });
  const queryHints = buildSearchQueryHints(
    titles,
    locationClause,
    prompt.text,
    missingTargetTitles.length ? "missing-target-title" : "target-title-and-location",
    sourceHints,
    rejectedHosts,
    preferDirectSources
  );

  // Native agent CLIs dispatch their own WebSearch/WebFetch calls before the
  // server sees a tool event, so CareerRat cannot preempt an over-budget call
  // provider-neutrally. A frozen per-turn plan plus the skill's hard-stop
  // instruction is the strongest deterministic input contract available
  // without provider-specific hooks.
  return Object.freeze({
    limits: AI_WEB_SEARCH_TURN_LIMITS,
    query_hints: Object.freeze(queryHints.map((hint) => Object.freeze(hint))),
    source_hints: Object.freeze(sourceHints),
    ...(missingTargetTitles.length
      ? {
          focus: Object.freeze({
            missing_target_titles: Object.freeze([...missingTargetTitles]),
          }),
        }
      : {}),
    ...((rejectedCandidates.length || rejectedHosts.length) && titles.length
      ? {
          rejected_sources: Object.freeze({
            urls: Object.freeze(rejectedCandidates.map(({ offer }) => offer?.url).filter(Boolean)),
            hosts: Object.freeze(rejectedHosts),
          }),
        }
      : {}),
  });
}

// search-jobs is deliberately excluded from the embedded runtime's default
// allowlist (see skill-runtime.mjs's own DEFAULT_RUNTIME_SKILLS comment) — a
// blanket CAREERRAT_RUNTIME_SKILLS opt-in shouldn't also hand every other
// one-shot skill run WebSearch access. This dedicated route is the authority
// to run search-jobs, so it always grants that one skill for this call.
function buildAiWebSearchEnv({ repoRoot, env }) {
  const allowed = resolveAllowedSkills({ repoRoot, env });
  return {
    ...env,
    CAREERRAT_RUNTIME_SKILLS: [...new Set([...allowed, "search-jobs"])].join(","),
  };
}

// ---------------------------------------------------------------------------
// runAiWebSearch — the driver. See the module header above for the full
// contract; the short version for callers:
//
//   runAiWebSearch({ repoRoot, env, promptIds, onProgress }) resolves to
//   { searched, found, new, duplicates, errors }:
//     searched   - number of saved prompts actually run (after promptIds
//                  selection + the per-mode cap)
//     found      - number of roles the model returned before dedup
//     new        - number of roles actually persisted after hard-dedup
//     duplicates - found - new (dropped as a dupe of the current batch or an
//                  existing sourced/application row)
//     errors     - human-readable messages; empty on a clean run, populated
//                  (with found/new/duplicates left at 0) when the model
//                  never produced valid structured output
//
//   Throws (with `.code`) only for precondition failures: "NO_DATABASE" (no
//   SQLite candidate setup yet) or "NO_SAVED_PROMPTS" (nothing to run).
//
//   `onProgress`, if given, is called with { type: "activity", message }
//   narration lines as the run progresses. Per-prompt lifecycle events also
//   carry phase/promptId/promptIndex/promptTotal/promptStatus fields so the
//   durable route can persist exact progress independently of the live SSE.
//
//   `signal`, if given, cancels the whole durable run. It is passed through to
//   every provider call and checked before each structured-output retry and
//   again before persistence, so cancellation never starts another attempt
//   or writes a partial result.
// ---------------------------------------------------------------------------
export async function runAiWebSearch({
  repoRoot,
  env = process.env,
  promptIds,
  onProgress,
  runSkillStream = defaultRunSkillStream,
  fetchImpl = fetch,
  resolveHost,
  resolveJobUrlImpl,
  signal,
  writeGuard,
  executionPlan,
} = {}) {
  if (!dbExists({ repoRoot, env })) {
    throwPreconditionError(
      "SQLite candidate setup is required before AI web search can run",
      "NO_DATABASE"
    );
  }

  const config = candidateConfigGet({ repoRoot, env });
  const fitFloor = savedFitFloor(config);
  const presentationIdentityOptions = {
    requireLocation: searchRequiresCanonicalLocation(config),
  };
  const modesGate = computeAllows("search:ai-web", config.modes);
  const promptCap = PROMPT_CAP_BY_MODE[modesGate.usage_mode] ?? PROMPT_CAP_BY_MODE.standard;

  const stored = getSearchPrompts({ repoRoot, env }).prompts;
  const requestedIds = Array.isArray(promptIds) ? promptIds.map((id) => String(id)) : null;
  const matching = requestedIds?.length
    ? stored.filter((p) => requestedIds.includes(p.id))
    : stored;
  const selected = matching.slice(0, promptCap);

  if (!selected.length) {
    throwPreconditionError(
      "No saved AI search prompts to run. Generate or add some first.",
      "NO_SAVED_PROMPTS"
    );
  }

  if (modesGate.decision === "downshift") {
    onProgress?.({
      type: "activity",
      message: `Lean usage mode: running ${selected.length} of ${matching.length} saved prompt${matching.length === 1 ? "" : "s"}.`,
    });
  }
  onProgress?.({
    type: "activity",
    message: `Running ${selected.length} saved search prompt${selected.length === 1 ? "" : "s"}…`,
  });

  // includeSearchLimits: true — this lane's STEP 3 coarse-triage flags
  // (company-history-*, app-limit-*) are otherwise unreachable here (no CLI,
  // no tracker read; see this skill's AI Web Search mode section). dbExists()
  // was already confirmed above, so the summary's tracker read is safe.
  const candidateContext = buildSearchPromptContext({
    repoRoot,
    env,
    config,
    includeSearchLimits: true,
  });
  const sourceConfig = sourceConfigGet({ repoRoot, env, name: "search-sources" }).data;
  const searchPlansByPrompt = new Map(
    selected.map((prompt) => [
      prompt.id,
      buildPromptSearchPlan(prompt, candidateContext, { sourceConfig }),
    ])
  );
  // Scoped once for the whole run, not per-attempt — see buildAiWebSearchEnv's
  // own comment on why search-jobs needs a per-call override here rather
  // than living in the embedded runtime's own default allowlist.
  const skillEnv = buildAiWebSearchEnv({ repoRoot, env });
  const outputSchema = loadSchema(repoRoot);
  const promptTotal = selected.length;

  async function runSavedPrompt(
    prompt,
    promptIndex,
    {
      rejectedCandidates = [],
      topUpCandidates = null,
      missingTargetTitles = [],
      topUpState = {},
    } = {}
  ) {
    const promptNumber = promptIndex + 1;
    const topUp = Array.isArray(topUpCandidates);
    const topUpRejectedHosts = topUp ? topUpState.rejectedSourceHosts || [] : [];
    const searchInstruction = rejectedCandidates.length
      ? freshnessRecoveryInstruction(rejectedCandidates)
      : topUp
        ? usefulSetTopUpInstruction(topUpCandidates, missingTargetTitles, topUpState)
        : null;
    const lifecycle = {
      phase: "prompt",
      promptId: prompt.id,
      promptIndex: promptNumber,
      promptTotal,
      ...(searchInstruction ? { recovery: true } : {}),
      ...(topUp ? { topUp: true } : {}),
    };
    onProgress?.({
      type: "activity",
      message: topUp
        ? `Searching for additional roles for saved prompt ${promptNumber} of ${promptTotal}…`
        : searchInstruction
          ? `Searching for fresh replacements for saved prompt ${promptNumber} of ${promptTotal}…`
          : `Searching saved prompt ${promptNumber} of ${promptTotal}…`,
      ...lifecycle,
      promptStatus: "running",
    });

    const kickoffInput = {
      mode: "ai-web-search",
      prompts: [{ id: prompt.id, text: prompt.text }],
      candidate: candidateContext,
      search_plan:
        rejectedCandidates.length || topUp
          ? buildPromptSearchPlan(prompt, candidateContext, {
              sourceConfig,
              rejectedCandidates,
              missingTargetTitles,
              excludedHosts: topUpRejectedHosts,
              preferDirectSources: topUpRejectedHosts.length > 0,
            })
          : searchPlansByPrompt.get(prompt.id),
      result_url_policy: RESULT_URL_POLICY,
    };
    const toolCalls = new Map();
    const toolTrace = [];
    let runtimeFailure = null;
    let previousRawText = "";
    let transientRetryUsed = false;
    const heartbeat = setInterval(() => {
      onProgress?.({
        type: "activity",
        message: `Still searching saved prompt ${promptNumber} of ${promptTotal}…`,
        ...lifecycle,
        promptStatus: "running",
        heartbeat: true,
      });
    }, AI_WEB_SEARCH_HEARTBEAT_MS);
    heartbeat.unref?.();

    async function invokeAiWebSearch({ correction }) {
      throwIfSearchAborted(signal);
      let rawText = "";
      let runtimeResult;
      const baseInput = searchInstruction
        ? `${JSON.stringify(kickoffInput)}\n\n${searchInstruction}`
        : kickoffInput;
      const correctionContext =
        correction && previousRawText
          ? `\n\nThe previous JSON response was:\n<careerrat-previous-json>\n${previousRawText.slice(0, MAX_CORRECTION_CONTEXT_CHARS)}\n</careerrat-previous-json>`
          : "";
      try {
        runtimeResult = await runSkillStream({
          skill: AI_WEB_SEARCH_LABELS.skill,
          action: AI_WEB_SEARCH_LABELS.action,
          operation: AI_WEB_SEARCH_LABELS.operation,
          ...(executionPlan ? { executionPlan } : { aiOperation: "research.web" }),
          useExecutionPlanRoute: Boolean(executionPlan),
          input: correction
            ? `${typeof baseInput === "string" ? baseInput : JSON.stringify(baseInput)}${correctionContext}\n\n${correction}\n\nDo not run WebSearch, WebFetch, or any other tools during this correction. Return the complete corrected JSON. Every successfully fetched exact posting named above must appear in roles[].url or rejected_postings[].url with a short factual reason.`
            : baseInput,
          repoRoot,
          env: skillEnv,
          signal,
          toolProfile: "chat",
          ...(correction ? { tools: [] } : {}),
          outputSchema,
          timeoutMs: AI_WEB_SEARCH_PROMPT_TIMEOUT_MS,
          onEvent: (evt) => {
            if (evt.type === "tool_use") {
              if (evt.data?.name === "WebSearch") {
                const query = String(evt.data?.input?.query || "").trim();
                if (query) {
                  const item = { kind: "query", query, status: "completed", error: null };
                  toolTrace.push(item);
                  if (evt.data?.id) toolCalls.set(evt.data.id, item);
                  onProgress?.({
                    type: "activity",
                    message: `Searching: ${query}…`,
                    ...lifecycle,
                    promptStatus: "running",
                  });
                }
              } else if (evt.data?.name === "WebFetch") {
                const rawUrl = String(evt.data?.input?.url || "").trim();
                if (rawUrl) {
                  const host = sourceHost(rawUrl);
                  const item = {
                    kind: "source",
                    url: rawUrl,
                    host,
                    status: "completed",
                    error: null,
                  };
                  toolTrace.push(item);
                  if (evt.data?.id) toolCalls.set(evt.data.id, item);
                  onProgress?.({
                    type: "activity",
                    message: `Reading ${host}…`,
                    ...lifecycle,
                    promptStatus: "running",
                  });
                }
              }
              return;
            }
            if (evt.type === "tool_result") {
              const item = toolCalls.get(evt.data?.toolUseId);
              if (item && evt.data?.isError) {
                item.status = "failed";
                item.error = safeToolError(evt.data?.content);
              }
              return;
            }
            if (evt.type !== "assistant") return;
            for (const block of evt.data?.message?.content ?? []) {
              if (block?.type === "text" && typeof block.text === "string") {
                rawText += block.text;
              }
            }
          },
        });
      } catch (error) {
        runtimeFailure = error;
        throw error;
      }
      if (!correction && isTransientAuthorizedRuntimeResponse({ runtimeResult, rawText })) {
        if (!transientRetryUsed) {
          transientRetryUsed = true;
          toolCalls.clear();
          toolTrace.length = 0;
          onProgress?.({
            type: "activity",
            message: `The search response was unavailable. Trying saved prompt ${promptNumber} of ${promptTotal} once more…`,
            ...lifecycle,
            promptStatus: "running",
            retry: true,
          });
          return invokeAiWebSearch({ correction: null });
        }
        const error = new Error("Search response was unavailable in the authorized runtime.");
        error.code = "AI_WEB_SEARCH_TRANSIENT_UNAVAILABLE";
        runtimeFailure = error;
        throw error;
      }
      if (runtimeResult?.ok === false) {
        const error = new Error(runtimeResult.error || "AI search could not finish.");
        error.code = runtimeResult.code || "AI_WEB_SEARCH_RUNTIME_FAILED";
        runtimeFailure = error;
        throw error;
      }
      previousRawText = rawText;
      return rawText;
    }

    let outcome;
    try {
      outcome = await runBoundedAI({
        labels: AI_WEB_SEARCH_LABELS,
        schema: outputSchema,
        manual: MANUAL_FALLBACK,
        structuredMode: "fallback",
        maxRetries: 1,
        validateData: (data) => fetchedPostingAccountabilityErrors(data, toolTrace),
        invoke: async ({ correction }) => {
          if (correction) {
            onProgress?.({
              type: "activity",
              message: `Checking the results for saved prompt ${promptNumber} again…`,
              ...lifecycle,
              promptStatus: "running",
            });
          }
          return invokeAiWebSearch({ correction });
        },
      });
    } finally {
      clearInterval(heartbeat);
    }

    // runBoundedAI intentionally turns provider exceptions into a safe error
    // envelope. Cancellation is different and must remain terminal for the
    // whole durable run rather than becoming one failed prompt.
    throwIfSearchAborted(signal);

    if (!outcome.body.ok) {
      const message = safePromptFailure({ outcome, runtimeFailure });
      const coverage = normalizeQueryResults({
        selected: [prompt],
        queriesRun: [],
        toolTrace,
        fallbackError: message,
      });
      onProgress?.({
        type: "activity",
        message: `Saved prompt ${promptNumber} of ${promptTotal} couldn't finish.`,
        ...lifecycle,
        promptStatus: "failed",
        foundCount: 0,
        error: message,
      });
      return {
        promptId: prompt.id,
        roles: [],
        rejectedPostings: [],
        validationFailures: Array.isArray(outcome.body.error?.details)
          ? outcome.body.error.details
          : [],
        toolTrace,
        errors: [message],
        topUp,
        queryResults: coverage.queryResults.map((entry) => ({
          ...entry,
          auxiliary: topUp,
        })),
        failedPromptIds: coverage.failedPromptIds,
      };
    }

    const roles = Array.isArray(outcome.body.data?.roles) ? outcome.body.data.roles : [];
    const rejectedPostings = Array.isArray(outcome.body.data?.rejected_postings)
      ? outcome.body.data.rejected_postings
      : [];
    const coverage = normalizeQueryResults({
      selected: [prompt],
      queriesRun: outcome.body.data?.queries_run,
      toolTrace,
    });
    const promptFailed = coverage.failedPromptIds.length > 0;
    onProgress?.({
      type: "activity",
      message: promptFailed
        ? `Saved prompt ${promptNumber} of ${promptTotal} finished without complete search coverage.`
        : `Finished saved prompt ${promptNumber} of ${promptTotal}.`,
      ...lifecycle,
      promptStatus: promptFailed ? "failed" : "completed",
      foundCount: roles.length,
      ...(promptFailed ? { error: coverage.queryResults[0]?.error } : {}),
    });
    return {
      promptId: prompt.id,
      roles,
      rejectedPostings,
      validationFailures: [],
      toolTrace,
      errors: [],
      topUp,
      queryResults: coverage.queryResults.map((entry) => ({
        ...entry,
        auxiliary: topUp,
      })),
      failedPromptIds: coverage.failedPromptIds,
    };
  }

  const promptOutcomes = await mapBounded(
    selected,
    AI_WEB_SEARCH_PROMPT_CONCURRENCY,
    runSavedPrompt
  );
  throwIfSearchAborted(signal);

  const allPromptOutcomes = [...promptOutcomes];
  const roles = [];
  const { seenPostingKeys } = buildDbSeenSets({ repoRoot, env });
  const preliminaryPostingKeys = new Set(seenPostingKeys);
  const canonicalCandidates = [];
  const captureFailures = [];
  const recoveredSources = [];
  const resolutionCache = new Map();
  let duplicates = 0;
  let invalid = 0;

  async function collectPromptOutcomes(
    outcomes,
    {
      recovery = false,
      rejectedPostingKeys = new Set(),
      rejectedSourceUrls = new Set(),
      rejectedSourceHostsByPrompt = new Map(),
      allowCanonicalReplacement = false,
    } = {}
  ) {
    const preliminary = [];
    const receiptOnly = [];
    const rejectionsByPrompt = new Map();
    for (const outcome of outcomes) {
      for (const role of outcome.roles || []) {
        roles.push(role);
        if (!role?.company || !role?.title || !role?.url || !isPostingEvidenceUrl(role.url)) {
          invalid += 1;
          continue;
        }
        const key = normalizeCompanyRoleKey(role.company, role.title);
        const req = extractReqId(role.url);
        const offer = toScanOffer(role, { key, reqId: req.id });
        const exactRejectedUrl = rejectedSourceUrls.has(normalizedSourceUrl(offer.url));
        if (
          recovery &&
          (exactRejectedUrl ||
            (!allowCanonicalReplacement && postingIdentityIsSeen(offer, rejectedPostingKeys)))
        ) {
          duplicates += 1;
          continue;
        }
        const offerHost = sourceHost(offer.url);
        if (recovery && rejectedSourceHostsByPrompt.get(outcome.promptId)?.has(offerHost)) {
          const reason = `Source host ${offerHost} already produced an unreadable or concentrated rejected batch.`;
          captureFailures.push({
            company: offer.company,
            title: offer.title,
            url: offer.url,
            reason,
          });
          recoveredSources.push({ url: offer.url, status: "failed", error: reason });
          if (!rejectionsByPrompt.has(outcome.promptId)) {
            rejectionsByPrompt.set(outcome.promptId, []);
          }
          rejectionsByPrompt.get(outcome.promptId).push({ offer, reason });
          continue;
        }
        const entry = { offer, promptId: outcome.promptId };
        const isDuplicate = postingIdentityIsSeen(offer, preliminaryPostingKeys);
        const canonicalReplacement =
          recovery &&
          allowCanonicalReplacement &&
          !exactRejectedUrl &&
          !postingIdentityIsSeen(offer, seenPostingKeys);
        if (isDuplicate && !canonicalReplacement) {
          duplicates += 1;
          receiptOnly.push(entry);
          continue;
        }
        addPostingIdentity(preliminaryPostingKeys, offer);
        preliminary.push(entry);
      }
    }

    const hydrationInputs = [
      ...preliminary.map((entry) => ({ ...entry, receiptOnly: false })),
      ...receiptOnly.map((entry) => ({ ...entry, receiptOnly: true })),
    ];
    let hydratedCount = 0;
    if (hydrationInputs.length) {
      onProgress?.({
        type: "activity",
        message: recovery
          ? `Checking details for ${hydrationInputs.length} replacement job${hydrationInputs.length === 1 ? "" : "s"}…`
          : `Checking details for ${hydrationInputs.length} discovered job${hydrationInputs.length === 1 ? "" : "s"}…`,
      });
    }
    const hydratedInputs = await mapBounded(
      hydrationInputs,
      HYDRATION_CONCURRENCY,
      async ({ offer, promptId, receiptOnly: isReceiptOnly }) => {
        throwIfSearchAborted(signal);
        const hydrated = await hydrateJobOffer(offer, {
          fetchImpl,
          resolveHost,
          resolveJobUrlImpl,
          force: true,
          rejectExpired: true,
          requirePostingIdentity: true,
          signal,
          resolutionCache,
        });
        throwIfSearchAborted(signal);
        hydratedCount += 1;
        onProgress?.({
          type: "activity",
          message: recovery
            ? `Checked details for ${hydratedCount} of ${hydrationInputs.length} replacement jobs…`
            : `Checked details for ${hydratedCount} of ${hydrationInputs.length} discovered jobs…`,
        });
        return { offer, promptId, receiptOnly: isReceiptOnly, hydrated };
      }
    );

    const canonicalPromptIds = new Set();
    const receiptPromptIds = new Set();
    for (const { offer, promptId, receiptOnly: isReceiptOnly, hydrated } of hydratedInputs) {
      throwIfSearchAborted(signal);
      const bodyText = String(hydrated?.bodyText || "").trim();
      recoveredSources.push({
        url: offer.url,
        status:
          hydrated?.bodyFetchStatus === "unavailable"
            ? "failed"
            : hydrated?.bodyPartial === true
              ? "deferred"
              : "completed",
        ...(hydrated?.url && hydrated.url !== offer.url ? { canonicalUrl: hydrated.url } : {}),
        ...(hydrated?.bodyFetchReason ? { error: hydrated.bodyFetchReason } : {}),
      });
      if (!bodyText || hydrated?.bodyFetchStatus === "unavailable") {
        const reason = hydrated?.bodyFetchReason || "The job description could not be read.";
        captureFailures.push({
          company: offer.company,
          title: offer.title,
          url: offer.url,
          reason,
        });
        if (!rejectionsByPrompt.has(promptId)) rejectionsByPrompt.set(promptId, []);
        rejectionsByPrompt.get(promptId).push({ offer, reason });
        continue;
      }

      const canonicalKey = normalizeCompanyRoleKey(hydrated.company, hydrated.title);
      const canonicalReq = extractReqId(hydrated.url);
      const canonicalOffer = { ...hydrated, key: canonicalKey, reqId: canonicalReq.id };
      const recoveryRejection = canonicalRecoveryRejectionReason(canonicalOffer, { config });
      if (recoveryRejection) {
        if (!isReceiptOnly) canonicalCandidates.push(canonicalOffer);
        if (!rejectionsByPrompt.has(promptId)) rejectionsByPrompt.set(promptId, []);
        rejectionsByPrompt.get(promptId).push({ offer: canonicalOffer, reason: recoveryRejection });
        continue;
      }

      const canonicalDuplicate = postingIdentityIsSeen(canonicalOffer, seenPostingKeys);
      const fitFloorRejection = fitFloorRecoveryRejectionReason(canonicalOffer, fitFloor);
      if (fitFloorRejection) {
        if (!canonicalDuplicate) {
          addPostingIdentity(seenPostingKeys, canonicalOffer);
          canonicalCandidates.push(canonicalOffer);
        }
        if (!rejectionsByPrompt.has(promptId)) rejectionsByPrompt.set(promptId, []);
        rejectionsByPrompt.get(promptId).push({ offer: canonicalOffer, reason: fitFloorRejection });
        continue;
      }

      if (canonicalDuplicate) {
        if (!isReceiptOnly) duplicates += 1;
        const existingIndex = matchingCanonicalCandidateIndex(canonicalCandidates, canonicalOffer);
        if (
          existingIndex >= 0 &&
          !offerMeetsFitFloor(canonicalCandidates[existingIndex], fitFloor)
        ) {
          canonicalCandidates[existingIndex] = canonicalOffer;
        }
        if (isReceiptOnly) receiptPromptIds.add(promptId);
        else canonicalPromptIds.add(promptId);
        continue;
      }

      addPostingIdentity(seenPostingKeys, canonicalOffer);
      canonicalCandidates.push(canonicalOffer);
      canonicalPromptIds.add(promptId);
      if (canonicalOffer.bodyFetchStatus === "deferred") {
        const reason =
          canonicalOffer.bodyFetchReason ||
          "The exact posting could not be read without a browser session.";
        if (!rejectionsByPrompt.has(promptId)) rejectionsByPrompt.set(promptId, []);
        rejectionsByPrompt.get(promptId).push({ offer: canonicalOffer, reason });
      }
    }

    return { canonicalPromptIds, receiptPromptIds, rejectionsByPrompt };
  }

  const canonicalRejectionsByPrompt = new Map();
  function mergeCanonicalRejections(rejectionsByPrompt) {
    for (const [promptId, rejections] of rejectionsByPrompt) {
      const merged = new Map(
        (canonicalRejectionsByPrompt.get(promptId) || []).map((rejection) => [
          `${normalizedSourceUrl(rejection.offer?.url)}\n${rejection.reason}`,
          rejection,
        ])
      );
      for (const rejection of rejections) {
        merged.set(`${normalizedSourceUrl(rejection.offer?.url)}\n${rejection.reason}`, rejection);
      }
      canonicalRejectionsByPrompt.set(promptId, [...merged.values()]);
    }
  }

  const initialCollection = await collectPromptOutcomes(promptOutcomes);
  mergeCanonicalRejections(initialCollection.rejectionsByPrompt);
  let recoverySpecs = selected
    .map((prompt, promptIndex) => ({
      prompt,
      promptIndex,
      rejectedCandidates: canonicalRejectionsByPrompt.get(prompt.id) || [],
    }))
    .filter(
      ({ prompt, rejectedCandidates }) =>
        rejectedCandidates.length > 0 &&
        !initialCollection.canonicalPromptIds.has(prompt.id) &&
        !initialCollection.receiptPromptIds.has(prompt.id)
    );

  for (
    let recoveryTurn = 1;
    recoveryTurn <= MAX_FRESHNESS_RECOVERY_TURNS && recoverySpecs.length;
    recoveryTurn += 1
  ) {
    const rejectedPostingKeys = new Set();
    const rejectedSourceUrls = new Set();
    const rejectedSourceHostsByPrompt = new Map();
    for (const { prompt, rejectedCandidates } of recoverySpecs) {
      for (const { offer } of rejectedCandidates) {
        addPostingIdentity(rejectedPostingKeys, offer);
        rejectedSourceUrls.add(normalizedSourceUrl(offer?.url));
      }
      rejectedSourceHostsByPrompt.set(prompt.id, concentratedRejectedHosts(rejectedCandidates));
    }
    const recoveryOutcomes = await mapBounded(
      recoverySpecs,
      AI_WEB_SEARCH_PROMPT_CONCURRENCY,
      ({ prompt, promptIndex, rejectedCandidates }) =>
        runSavedPrompt(prompt, promptIndex, { rejectedCandidates })
    );
    allPromptOutcomes.push(...recoveryOutcomes);
    const recoveryCollection = await collectPromptOutcomes(recoveryOutcomes, {
      recovery: true,
      rejectedPostingKeys,
      rejectedSourceUrls,
      rejectedSourceHostsByPrompt,
      allowCanonicalReplacement: true,
    });
    mergeCanonicalRejections(recoveryCollection.rejectionsByPrompt);
    recoverySpecs = recoverySpecs
      .filter(
        ({ prompt }) =>
          !recoveryCollection.canonicalPromptIds.has(prompt.id) &&
          !recoveryCollection.receiptPromptIds.has(prompt.id)
      )
      .map((spec) => ({
        ...spec,
        rejectedCandidates: canonicalRejectionsByPrompt.get(spec.prompt.id) || [],
      }));
  }

  const configuredTargetBuckets = Array.isArray(config?.targeting?.role_buckets)
    ? config.targeting.role_buckets.filter((bucket) =>
        Array.isArray(bucket?.titles) ? bucket.titles.length > 0 : false
      )
    : [];
  const targetBuckets = configuredTargetBuckets.filter((bucket) =>
    selected.some((prompt) => promptMatchesBucket(prompt, bucket, configuredTargetBuckets))
  );
  const requiredBucketCount = Math.min(MIN_USEFUL_SET_BUCKETS, targetBuckets.length);
  const selectedTargetTitles = new Map();
  for (const bucket of targetBuckets) {
    const scopedTitleKeys = new Set();
    for (const prompt of selected) {
      const promptTitles = promptTargetTitles(prompt, bucket, configuredTargetBuckets);
      for (const title of promptTitles) scopedTitleKeys.add(String(title).trim().toLowerCase());
    }
    for (const title of bucket.titles) {
      const key = String(title || "")
        .trim()
        .toLowerCase();
      if (!key || !scopedTitleKeys.has(key)) continue;
      const existing = selectedTargetTitles.get(key) || {
        title: String(title).trim(),
        buckets: [],
      };
      existing.buckets.push(bucket);
      selectedTargetTitles.set(key, existing);
    }
  }
  const requiredTitleCount = Math.min(MIN_USEFUL_SET_ROLES, selectedTargetTitles.size);
  const interimCoverage = mergePromptCoverage({ selected, outcomes: allPromptOutcomes });
  const usefulSetPromptIds = new Set(
    interimCoverage.queryResults
      .filter((entry) => entry.status === "completed")
      .map((entry) => entry.promptId)
  );

  function usefulSetState() {
    const qualification = requalifyCanonicalOffers(canonicalCandidates, { config });
    const offers = qualification.kept.filter((offer) =>
      offerCanBePresented(offer, fitFloor, presentationIdentityOptions)
    );
    const representedBuckets = new Set(
      targetBuckets
        .filter((bucket) => offers.some((offer) => titleMatchesBucket(offer.title, bucket)))
        .map((bucket) => bucket.name || JSON.stringify(bucket.titles))
    );
    const distinctRoleTitles = new Set(
      offers
        .map((offer) =>
          String(offer.title || "")
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    );
    const representedTargetTitles = new Set();
    for (const offer of offers) {
      const matchingTargetTitles = [...selectedTargetTitles.values()]
        .filter((target) =>
          target.buckets.some((bucket) =>
            titleMatchesBucket(offer.title, { ...bucket, titles: [target.title] })
          )
        )
        .map((target) => target.title);
      for (const title of mostSpecificTitles(matchingTargetTitles)) {
        representedTargetTitles.add(String(title).trim().toLowerCase());
      }
    }
    return {
      complete:
        offers.length >= MIN_USEFUL_SET_ROLES &&
        representedBuckets.size >= requiredBucketCount &&
        distinctRoleTitles.size >= requiredTitleCount &&
        representedTargetTitles.size >= requiredTitleCount,
      missingBuckets: targetBuckets.filter(
        (bucket) => !representedBuckets.has(bucket.name || JSON.stringify(bucket.titles))
      ),
      representedBuckets: targetBuckets.filter((bucket) =>
        representedBuckets.has(bucket.name || JSON.stringify(bucket.titles))
      ),
      survivorRoles: offers.slice(0, 40).map((offer) => ({
        company: offer.company,
        title: offer.title,
        url: offer.url,
      })),
      missingTargetTitles: [...selectedTargetTitles.entries()]
        .filter(([key]) => !representedTargetTitles.has(key))
        .map(([, target]) => target),
    };
  }

  const topUpCounts = new Map(selected.map((prompt) => [prompt.id, 0]));
  for (
    let topUpTurn = 0;
    usefulSetPromptIds.size > 0 && topUpTurn < MAX_USEFUL_SET_TOP_UP_TURNS;
    topUpTurn += 1
  ) {
    const state = usefulSetState();
    if (state.complete) break;
    const topUpSpec = selected
      .map((prompt, promptIndex) => ({
        prompt,
        promptIndex,
        topUpCount: topUpCounts.get(prompt.id) || 0,
        missingTargetTitles: state.missingTargetTitles.filter((target) =>
          target.buckets.some((bucket) =>
            promptMatchesBucket(prompt, bucket, configuredTargetBuckets)
          )
        ),
        targetsMissingBucket: state.missingBuckets.some((bucket) =>
          promptMatchesBucket(prompt, bucket, configuredTargetBuckets)
        ),
      }))
      .filter(({ prompt }) => usefulSetPromptIds.has(prompt.id))
      .sort(
        (left, right) =>
          Number(right.missingTargetTitles.length > 0) -
            Number(left.missingTargetTitles.length > 0) ||
          Number(right.targetsMissingBucket) - Number(left.targetsMissingBucket) ||
          left.topUpCount - right.topUpCount ||
          left.promptIndex - right.promptIndex
      )[0];
    const genericConsideredCandidates = roles
      .filter((role) => role?.company && role?.title && role?.url && isPostingEvidenceUrl(role.url))
      .map((role) => ({
        offer: { company: role.company, title: role.title, url: role.url },
        reason: "CareerRat already accepted or rejected this posting in the current run.",
      }));
    const canonicalRejections = canonicalRejectionsByPrompt.get(topUpSpec.prompt.id) || [];
    const topUpRejectedHosts = new Set([
      ...concentratedRejectedHosts(canonicalRejections),
      ...unreadableRejectedHosts(canonicalRejections),
    ]);
    const consideredByUrl = new Map();
    for (const candidate of [...canonicalRejections, ...genericConsideredCandidates]) {
      const url = normalizedSourceUrl(candidate.offer?.url);
      if (url && !consideredByUrl.has(url)) consideredByUrl.set(url, candidate);
    }
    const consideredCandidates = [...consideredByUrl.values()];
    const consideredPostingKeys = new Set();
    for (const { offer } of consideredCandidates) addPostingIdentity(consideredPostingKeys, offer);
    topUpCounts.set(topUpSpec.prompt.id, topUpSpec.topUpCount + 1);
    const topUpOutcome = await runSavedPrompt(topUpSpec.prompt, topUpSpec.promptIndex, {
      topUpCandidates: consideredCandidates,
      missingTargetTitles: topUpSpec.missingTargetTitles.map((target) => target.title),
      topUpState: {
        survivorRoles: state.survivorRoles,
        representedBuckets: state.representedBuckets.map(
          (bucket) => bucket.name || JSON.stringify(bucket.titles)
        ),
        missingBuckets: state.missingBuckets.map(
          (bucket) => bucket.name || JSON.stringify(bucket.titles)
        ),
        rejectedSourceHosts: [...topUpRejectedHosts],
      },
    });
    allPromptOutcomes.push(topUpOutcome);
    const topUpCollection = await collectPromptOutcomes([topUpOutcome], {
      recovery: true,
      rejectedPostingKeys: consideredPostingKeys,
      rejectedSourceHostsByPrompt: new Map([[topUpSpec.prompt.id, topUpRejectedHosts]]),
    });
    mergeCanonicalRejections(topUpCollection.rejectionsByPrompt);
    if ((topUpOutcome.errors || []).length > 0 || (topUpOutcome.failedPromptIds || []).length > 0) {
      break;
    }
  }

  const toolTrace = allPromptOutcomes.flatMap((result) => result.toolTrace);
  const promptErrors = [
    ...new Set(
      allPromptOutcomes.filter((result) => result.topUp !== true).flatMap((result) => result.errors)
    ),
  ];
  const warnings = [
    ...new Set(
      allPromptOutcomes
        .filter((result) => result.topUp === true)
        .flatMap((result) => [
          ...(result.errors || []),
          ...(result.queryResults || [])
            .filter((entry) => entry.status === "failed")
            .map((entry) => entry.error)
            .filter(Boolean),
        ])
    ),
  ];
  const coverage = mergePromptCoverage({ selected, outcomes: allPromptOutcomes });
  const validationFailures = allPromptOutcomes
    .flatMap((outcome) =>
      (outcome.validationFailures || []).map((failure) => ({
        promptId: outcome.promptId,
        path: String(failure?.path || ""),
        message: String(failure?.message || ""),
      }))
    )
    .filter((failure) => failure.path || failure.message)
    .slice(0, 20);
  const fetchedPostingDecisionKeys = new Set();
  const fetchedPostingDecisions = [];
  for (const outcome of allPromptOutcomes) {
    for (const decision of outcome.rejectedPostings || []) {
      const url = normalizedSourceUrl(decision?.url);
      const reason = String(decision?.reason || "").trim();
      const key = `${url}\n${reason}`;
      if (!url || !reason || fetchedPostingDecisionKeys.has(key)) continue;
      fetchedPostingDecisionKeys.add(key);
      fetchedPostingDecisions.push({ promptId: outcome.promptId, url, reason });
      if (fetchedPostingDecisions.length >= MAX_FETCHED_POSTING_DECISIONS) break;
    }
    if (fetchedPostingDecisions.length >= MAX_FETCHED_POSTING_DECISIONS) break;
  }

  const canonicalQualification = requalifyCanonicalOffers(canonicalCandidates, {
    config,
  });
  const incompletePresentedRows = canonicalQualification.kept.filter(
    (offer) => !offerHasCompletePresentationIdentity(offer, presentationIdentityOptions)
  );
  invalid += incompletePresentedRows.length;
  const survivors = canonicalQualification.kept
    .filter((offer) => offerHasCompletePresentationIdentity(offer, presentationIdentityOptions))
    .map((offer) => ({
      ...offer,
      gate: deriveGate(offer.ruleFlags),
    }));
  const reasonCounts = {
    location: canonicalQualification.filteredLocation.length,
    salary: canonicalQualification.filteredSalary.length,
    seniority: canonicalQualification.filteredSeniority.length,
    age: canonicalQualification.filteredAge.length,
    eligibility: canonicalQualification.filteredEligibility.length,
    identity: incompletePresentedRows.length,
  };
  for (const key of Object.keys(reasonCounts)) {
    if (reasonCounts[key] === 0) delete reasonCounts[key];
  }
  const disqualified = Object.values(reasonCounts).reduce((sum, count) => sum + count, 0);
  const canonicalDisqualifications = [
    ...canonicalQualification.filteredSeniority,
    ...canonicalQualification.filteredLocation,
    ...canonicalQualification.filteredAge,
    ...canonicalQualification.filteredSalary,
    ...canonicalQualification.filteredEligibility,
    ...incompletePresentedRows.map((offer) => ({
      ...offer,
      qualificationReason: `incomplete-presentation-identity:${missingPresentationIdentityFields(
        offer,
        presentationIdentityOptions
      ).join(",")}`,
    })),
  ]
    .slice(0, MAX_CANONICAL_DISQUALIFICATIONS)
    .map((offer) => ({
      company: String(offer.company || ""),
      title: String(offer.title || ""),
      url: String(offer.url || ""),
      location: offer.location == null ? null : String(offer.location),
      reason: String(offer.qualificationReason || "canonical-hard-gate-rejection"),
    }));

  // A disconnect that lands after the model finished but before this point
  // must not write a partial result or return a success-shaped summary.
  throwIfSearchAborted(signal);
  const savedAt = new Date();
  const revalidatedExisting = revalidatePersistedSourcedRows({
    repoRoot,
    env,
    config,
    now: savedAt,
    guard: writeGuard,
  });
  if (survivors.length) {
    onProgress?.({
      type: "activity",
      message: `Saving ${survivors.length} qualified job${survivors.length === 1 ? "" : "s"}…`,
    });
  }
  const persistedOffers = survivors.length
    ? captureAndPersistOffersIfDb({
        repoRoot,
        env,
        offers: survivors,
        savedAt,
        guard: writeGuard,
        dedupeCanonical: true,
      })?.offers || []
    : [];
  duplicates += Math.max(0, survivors.length - persistedOffers.length);

  return {
    searched: selected.length,
    found: roles.length,
    new: persistedOffers.length,
    presented: persistedOffers.filter((offer) =>
      offerCanBePresented(offer, fitFloor, presentationIdentityOptions)
    ).length,
    fitFloor,
    duplicates,
    invalid,
    disqualified,
    reasonCounts,
    canonicalDisqualifications,
    fetchedPostingDecisions,
    partial: persistedOffers.filter((offer) => offer.bodyPartial === true).length,
    unreadable: captureFailures.length,
    errors: promptErrors,
    warnings,
    validationFailures,
    captureFailures: captureFailures.slice(0, 10),
    revalidatedExisting,
    offers: persistedOffers.map((offer) => ({
      company: offer.company,
      title: offer.title,
      url: offer.url,
      fitScore: Number.isFinite(Number(offer.score)) ? Number(offer.score) : null,
      qualificationUnknowns: Array.isArray(offer.qualificationUnknowns)
        ? [...offer.qualificationUnknowns]
        : [],
      unverified: true,
    })),
    ...coverage,
    sources: mergeSourceReceipts(toolTrace, recoveredSources),
  };
}
