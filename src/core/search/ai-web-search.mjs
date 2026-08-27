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
import { candidateConfigGet } from "../db/verbs.mjs";
import { hydrateJobOffer } from "../intake/resolve.mjs";
import { computeAllows } from "../profile/modes.mjs";
import {
  addPostingIdentity,
  extractReqId,
  postingIdentityIsSeen,
} from "../scoring/sourced-identity.mjs";
import {
  captureAndPersistOffersIfDb,
  revalidatePersistedSourcedRows,
} from "../scoring/sourced-persistence.mjs";
import { normalizeCompanyRoleKey, requalifyCanonicalOffers } from "../scoring/sourced-scanner.mjs";
import { buildSearchPromptContext, getSearchPrompts } from "./search-prompts.mjs";

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
  return {
    company: role.company,
    title: role.title,
    url: role.url,
    location: role.location || "",
    comp: role.comp_text || "",
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
  "search",
  "work-for-us",
  "work-with-us",
]);

const POSTING_ID_QUERY_KEYS = new Set([
  "gh_jid",
  "jid",
  "jk",
  "jl",
  "job_id",
  "jobid",
  "joblistingid",
  "req_id",
  "reqid",
  "requisition_id",
  "requisitionid",
  "vjk",
]);

function isGenericCareerHubUrl(url) {
  const hasPostingId = [...url.searchParams].some(
    ([key, value]) => POSTING_ID_QUERY_KEYS.has(key.toLowerCase()) && value.trim()
  );
  if (hasPostingId) return false;

  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  return (
    segments.length === 0 || segments.every((segment) => GENERIC_CAREER_HUB_SEGMENTS.has(segment))
  );
}

export function isPostingEvidenceUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
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
  if (isGenericCareerHubUrl(url)) return false;
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
  return true;
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
    const failure = entries.find((entry) => entry.status === "failed");
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

function freshnessRecoveryInstruction(rejections) {
  const rejectedPostings = rejections.slice(0, 40).map(({ offer, reason }) => ({
    url: offer.url,
    reason: String(reason || "The canonical posting could not be verified.").slice(0, 240),
  }));
  const rejectedSourceHosts = [...concentratedRejectedHosts(rejections)];
  return [
    "CareerRat's canonical checker rejected every usable candidate from this saved prompt for liveness, posting-identity, or saved hard-filter reasons.",
    "Run one fresh replacement search on the same provider. Return different, currently active, posting-specific roles that still satisfy every original candidate boundary.",
    "Search employer-owned career pages and direct ATS postings first. Return candidates from at least two source hosts when the open web has them, with no more than one candidate from the same third-party host.",
    "Do not return any rejected URL below, another URL for the same rejected requisition, or a host listed in rejected_source_hosts. Do not loosen title, location, compensation, freshness, or fit requirements.",
    JSON.stringify({
      rejected_postings: rejectedPostings,
      rejected_source_hosts: rejectedSourceHosts,
    }),
  ].join("\n");
}

function usefulSetTopUpInstruction(consideredCandidates) {
  const consideredPostings = consideredCandidates.slice(0, 60).map(({ offer, reason }) => ({
    url: offer.url,
    reason: String(reason || "CareerRat already considered this posting.").slice(0, 240),
  }));
  return [
    "CareerRat's canonical result set is still underfilled after the saved prompts finished.",
    "Run one bounded additional search on the same provider for this saved prompt. Return additional, distinct, currently active posting-specific roles that satisfy every original candidate boundary.",
    "Search employer-owned career pages and direct ATS postings first. Do not repeat an already considered URL or requisition, and do not loosen title, location, compensation, freshness, or fit requirements.",
    JSON.stringify({ considered_postings: consideredPostings }),
  ].join("\n");
}

function normalizedTitleWords(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  );
}

function titleMatchesBucket(title, bucket) {
  const actual = normalizedTitleWords(title);
  return (Array.isArray(bucket?.titles) ? bucket.titles : []).some((targetTitle) => {
    const target = normalizedTitleWords(targetTitle);
    return target.size > 0 && [...target].every((word) => actual.has(word));
  });
}

function promptMatchesBucket(prompt, bucket) {
  const promptWords = normalizedTitleWords(prompt?.text);
  return (Array.isArray(bucket?.titles) ? bucket.titles : []).some((targetTitle) => {
    const target = normalizedTitleWords(targetTitle);
    return target.size > 0 && [...target].every((word) => promptWords.has(word));
  });
}

// search-jobs is deliberately excluded from the embedded runtime's default
// allowlist (see skill-runtime.mjs's own DEFAULT_RUNTIME_SKILLS comment) — a
// blanket CAREERRAT_RUNTIME_SKILLS opt-in shouldn't also hand every other
// one-shot skill run WebSearch access. This lane is the one place search-jobs
// may run, so it builds its own scoped env override for just this
// runSkillStream call: whatever the operator already allows, plus
// search-jobs — UNLESS the operator explicitly locked the runtime down
// (CAREERRAT_RUNTIME_SKILLS === "", resolveSkillAllowlist's own "empty means
// nothing is allowed" contract), in which case this lane respects that and
// lets runSkillStream reject with the standard SKILL_NOT_ALLOWED error rather
// than silently punching a hole in an explicit lockdown.
function buildAiWebSearchEnv({ repoRoot, env }) {
  if (env.CAREERRAT_RUNTIME_SKILLS === "") return env;
  const allowed = resolveAllowedSkills({ repoRoot, env });
  return { ...env, CAREERRAT_RUNTIME_SKILLS: [...allowed, "search-jobs"].join(",") };
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
  // Scoped once for the whole run, not per-attempt — see buildAiWebSearchEnv's
  // own comment on why search-jobs needs a per-call override here rather
  // than living in the embedded runtime's own default allowlist.
  const skillEnv = buildAiWebSearchEnv({ repoRoot, env });
  const outputSchema = loadSchema(repoRoot);
  const promptTotal = selected.length;

  async function runSavedPrompt(
    prompt,
    promptIndex,
    { rejectedCandidates = [], topUpCandidates = null } = {}
  ) {
    const promptNumber = promptIndex + 1;
    const topUp = Array.isArray(topUpCandidates);
    const searchInstruction = rejectedCandidates.length
      ? freshnessRecoveryInstruction(rejectedCandidates)
      : topUp
        ? usefulSetTopUpInstruction(topUpCandidates)
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
    };
    const toolCalls = new Map();
    const toolTrace = [];
    let runtimeFailure = null;
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
      try {
        runtimeResult = await runSkillStream({
          skill: AI_WEB_SEARCH_LABELS.skill,
          action: AI_WEB_SEARCH_LABELS.action,
          operation: AI_WEB_SEARCH_LABELS.operation,
          ...(executionPlan ? { executionPlan } : { aiOperation: "research.web" }),
          useExecutionPlanRoute: Boolean(executionPlan),
          input: correction
            ? `${typeof baseInput === "string" ? baseInput : JSON.stringify(baseInput)}\n\n${correction}`
            : baseInput,
          repoRoot,
          env: skillEnv,
          signal,
          toolProfile: "chat",
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
      if (runtimeResult?.ok === false) {
        const error = new Error(runtimeResult.error || "AI search could not finish.");
        error.code = runtimeResult.code || "AI_WEB_SEARCH_RUNTIME_FAILED";
        runtimeFailure = error;
        throw error;
      }
      return rawText;
    }

    let outcome;
    try {
      outcome = await runBoundedAI({
        labels: AI_WEB_SEARCH_LABELS,
        schema: outputSchema,
        manual: MANUAL_FALLBACK,
        structuredMode: "fallback",
        maxRetries: searchInstruction ? 0 : 1,
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
      return { promptId: prompt.id, roles: [], toolTrace, errors: [message], ...coverage };
    }

    const roles = Array.isArray(outcome.body.data?.roles) ? outcome.body.data.roles : [];
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
    return { promptId: prompt.id, roles, toolTrace, errors: [], ...coverage };
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
      rejectedSourceHostsByPrompt = new Map(),
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
        if (recovery && postingIdentityIsSeen(offer, rejectedPostingKeys)) {
          duplicates += 1;
          continue;
        }
        const offerHost = sourceHost(offer.url);
        if (recovery && rejectedSourceHostsByPrompt.get(outcome.promptId)?.has(offerHost)) {
          const reason = `Source host ${offerHost} already produced a concentrated rejected batch.`;
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
        if (isDuplicate) {
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
      if (isReceiptOnly) {
        receiptPromptIds.add(promptId);
        continue;
      }
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
      const canonicalDuplicate = postingIdentityIsSeen(canonicalOffer, seenPostingKeys);
      if (canonicalDuplicate) {
        duplicates += 1;
        canonicalPromptIds.add(promptId);
        continue;
      }
      addPostingIdentity(seenPostingKeys, canonicalOffer);
      canonicalCandidates.push(canonicalOffer);
      const recoveryRejection = canonicalRecoveryRejectionReason(canonicalOffer, { config });
      if (recoveryRejection) {
        if (!rejectionsByPrompt.has(promptId)) rejectionsByPrompt.set(promptId, []);
        rejectionsByPrompt.get(promptId).push({ offer: canonicalOffer, reason: recoveryRejection });
        continue;
      }
      canonicalPromptIds.add(promptId);
    }

    return { canonicalPromptIds, receiptPromptIds, rejectionsByPrompt };
  }

  const initialCollection = await collectPromptOutcomes(promptOutcomes);
  let recoverySpecs = selected
    .map((prompt, promptIndex) => ({
      prompt,
      promptIndex,
      rejectedCandidates: initialCollection.rejectionsByPrompt.get(prompt.id) || [],
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
    const rejectedSourceHostsByPrompt = new Map();
    for (const { prompt, rejectedCandidates } of recoverySpecs) {
      for (const { offer } of rejectedCandidates) addPostingIdentity(rejectedPostingKeys, offer);
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
      rejectedSourceHostsByPrompt,
    });
    recoverySpecs = recoverySpecs
      .filter(
        ({ prompt }) =>
          !recoveryCollection.canonicalPromptIds.has(prompt.id) &&
          !recoveryCollection.receiptPromptIds.has(prompt.id)
      )
      .map((spec) => ({
        ...spec,
        rejectedCandidates: [
          ...spec.rejectedCandidates,
          ...(recoveryCollection.rejectionsByPrompt.get(spec.prompt.id) || []),
        ],
      }));
  }

  const configuredTargetBuckets = Array.isArray(config?.targeting?.role_buckets)
    ? config.targeting.role_buckets.filter((bucket) =>
        Array.isArray(bucket?.titles) ? bucket.titles.length > 0 : false
      )
    : [];
  const targetBuckets = configuredTargetBuckets.filter((bucket) =>
    selected.some((prompt) => promptMatchesBucket(prompt, bucket))
  );
  const requiredBucketCount = Math.min(MIN_USEFUL_SET_BUCKETS, targetBuckets.length);
  const interimCoverage = mergePromptCoverage({ selected, outcomes: allPromptOutcomes });
  const canRecoverUsefulSet =
    interimCoverage.failedPromptIds.length === 0 &&
    allPromptOutcomes.every((outcome) => (outcome.errors || []).length === 0);

  function usefulSetState() {
    const qualification = requalifyCanonicalOffers(canonicalCandidates, { config });
    const offers = qualification.kept.filter((offer) => offerMeetsFitFloor(offer, fitFloor));
    const representedBuckets = new Set(
      targetBuckets
        .filter((bucket) => offers.some((offer) => titleMatchesBucket(offer.title, bucket)))
        .map((bucket) => bucket.name || JSON.stringify(bucket.titles))
    );
    return {
      complete:
        offers.length >= MIN_USEFUL_SET_ROLES && representedBuckets.size >= requiredBucketCount,
      missingBuckets: targetBuckets.filter(
        (bucket) => !representedBuckets.has(bucket.name || JSON.stringify(bucket.titles))
      ),
    };
  }

  const topUpCounts = new Map(selected.map((prompt) => [prompt.id, 0]));
  for (
    let topUpTurn = 0;
    canRecoverUsefulSet && topUpTurn < MAX_USEFUL_SET_TOP_UP_TURNS;
    topUpTurn += 1
  ) {
    const state = usefulSetState();
    if (state.complete) break;
    const topUpSpec = selected
      .map((prompt, promptIndex) => ({
        prompt,
        promptIndex,
        topUpCount: topUpCounts.get(prompt.id) || 0,
        targetsMissingBucket: state.missingBuckets.some((bucket) =>
          promptMatchesBucket(prompt, bucket)
        ),
      }))
      .sort(
        (left, right) =>
          Number(right.targetsMissingBucket) - Number(left.targetsMissingBucket) ||
          left.topUpCount - right.topUpCount ||
          left.promptIndex - right.promptIndex
      )[0];
    const consideredCandidates = roles
      .filter((role) => role?.company && role?.title && role?.url && isPostingEvidenceUrl(role.url))
      .map((role) => ({
        offer: { company: role.company, title: role.title, url: role.url },
        reason: "CareerRat already accepted or rejected this posting in the current run.",
      }));
    const consideredPostingKeys = new Set();
    for (const { offer } of consideredCandidates) addPostingIdentity(consideredPostingKeys, offer);
    topUpCounts.set(topUpSpec.prompt.id, topUpSpec.topUpCount + 1);
    const topUpOutcome = await runSavedPrompt(topUpSpec.prompt, topUpSpec.promptIndex, {
      topUpCandidates: consideredCandidates,
    });
    allPromptOutcomes.push(topUpOutcome);
    await collectPromptOutcomes([topUpOutcome], {
      recovery: true,
      rejectedPostingKeys: consideredPostingKeys,
    });
    if ((topUpOutcome.errors || []).length > 0 || (topUpOutcome.failedPromptIds || []).length > 0) {
      break;
    }
  }

  const toolTrace = allPromptOutcomes.flatMap((result) => result.toolTrace);
  const promptErrors = [...new Set(allPromptOutcomes.flatMap((result) => result.errors))];
  const coverage = mergePromptCoverage({ selected, outcomes: allPromptOutcomes });

  const canonicalQualification = requalifyCanonicalOffers(canonicalCandidates, {
    config,
  });
  const survivors = canonicalQualification.kept.map((offer) => ({
    ...offer,
    gate: deriveGate(offer.ruleFlags),
  }));
  const reasonCounts = {
    location: canonicalQualification.filteredLocation.length,
    salary: canonicalQualification.filteredSalary.length,
    seniority: canonicalQualification.filteredSeniority.length,
    age: canonicalQualification.filteredAge.length,
    eligibility: canonicalQualification.filteredEligibility.length,
  };
  for (const key of Object.keys(reasonCounts)) {
    if (reasonCounts[key] === 0) delete reasonCounts[key];
  }
  const disqualified = Object.values(reasonCounts).reduce((sum, count) => sum + count, 0);

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
    presented: persistedOffers.filter((offer) => offerMeetsFitFloor(offer, fitFloor)).length,
    fitFloor,
    duplicates,
    invalid,
    disqualified,
    reasonCounts,
    partial: persistedOffers.filter((offer) => offer.bodyPartial === true).length,
    unreadable: captureFailures.length,
    errors: promptErrors,
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
