// ai-web-search.mjs — server-side driver for the Jobs page's "AI Web Search"
// lane: runs the search-jobs skill's AI Web Search mode (see that SKILL.md's
// own section) via the embedded one-shot runtime (runSkillStream, "chat" tool
// profile — Read/Glob/Grep/WebFetch/WebSearch/Skill, no Bash/Write/Edit/
// browser — see runtime-tools.mjs), buffers the model's single fenced JSON
// reply, validates it against config/ai-web-search.schema.json via the same
// bounded/correction-retry helper POST /api/onboard/resume-ai(-stream) uses
// (bounded-ai.mjs's runBoundedAI, structuredMode: "fallback" — see
// onboard-route.mjs's runResumeExtractBounded), hard-dedupes survivors by
// normalized company+title against BOTH the current batch and existing
// sourced offers + tracker applications (reusing sourced-scanner.mjs's own
// normalizeCompanyRoleKey/extractReqId and scan-context.mjs's
// buildDbSeenSets — the exact machinery scan-sourced.mjs's deterministic
// sweep already dedupes with), and persists survivors through the same DB
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
import { runBoundedAI } from "../ai/bounded-ai.mjs";
import {
  runSkillStream as defaultRunSkillStream,
  resolveAllowedSkills,
} from "../ai/skill-runtime.mjs";
import { dbExists } from "../db/connection.mjs";
import { buildDbSeenSets } from "../db/scan-context.mjs";
import { candidateConfigGet } from "../db/verbs.mjs";
import { readEnv } from "../env-compat.mjs";
import { computeAllows } from "../profile/modes.mjs";
import { captureAndPersistOffersIfDb } from "../scoring/sourced-persistence.mjs";
import { extractReqId, normalizeCompanyRoleKey } from "../scoring/sourced-scanner.mjs";
import { buildSearchPromptContext, getSearchPrompts } from "./search-prompts.mjs";

const AI_WEB_SEARCH_SCHEMA_PATH = "config/ai-web-search.schema.json";

export const AI_WEB_SEARCH_LABELS = Object.freeze({
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
export const PROMPT_CAP_BY_MODE = Object.freeze({ lean: 1, standard: 3, full: 5 });

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
  return ruleFlags.some((flag) => CUT_GATE_FLAGS.has(flag)) ? "likely-cut" : "review";
}

// Map one AI-web-search schema role into the "offer" shape
// sourced-persistence.mjs's sourcedRowsFromScanOffers()/offersWithCapturedJobs()
// expect (the same shape scoreSourcedOffer()'s callers produce) — reusing
// that write path rather than hand-rolling a second one.
function toScanOffer(role, { key, reqId }) {
  const ruleFlags = Array.isArray(role.rule_flags) ? role.rule_flags.filter(Boolean) : [];
  const score = Number(role.fit_score);
  return {
    company: role.company,
    title: role.title,
    url: role.url,
    location: role.location || "",
    comp: role.comp_text || "",
    bodyText: role.body_text || "",
    score: Number.isFinite(score) ? score : 0,
    fit: role.fit_bucket || "",
    gate: deriveGate(ruleFlags),
    ratingReason: role.source_evidence || "",
    ruleFlags,
    source: "ai-web-search",
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
  if (readEnv("CAREERRAT_RUNTIME_SKILLS", { env }) === "") return env;
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
//   narration lines as the run progresses (mode-cap notice, per-prompt
//   WebSearch/WebFetch activity, retry notice) — the SSE route
//   (search-route.mjs) forwards these straight through as "activity" frames.
//
//   `signal`, if given, is a client-disconnect AbortSignal (search-route.mjs
//   wires one up from the SSE request's res.on("close")) — passed straight
//   through to runSkillStream (which aborts the underlying SDK query on it)
//   and checked before each structured-output retry so an already-aborted
//   run never starts a second attempt, and again right before persisting so
//   an abort that lands after the model finished but before persistence
//   never writes a partial result.
// ---------------------------------------------------------------------------
export async function runAiWebSearch({
  repoRoot,
  env = process.env,
  promptIds,
  onProgress,
  runSkillStream = defaultRunSkillStream,
  signal,
} = {}) {
  if (!dbExists({ repoRoot, env })) {
    throwPreconditionError(
      "SQLite candidate setup is required before AI web search can run",
      "NO_DATABASE"
    );
  }

  const config = candidateConfigGet({ repoRoot, env });
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
      "No saved AI search prompts to run — generate or add some first.",
      "NO_SAVED_PROMPTS"
    );
  }

  if (modesGate.decision === "downshift") {
    onProgress?.({
      type: "activity",
      message: `Lean usage mode — running ${selected.length} of ${matching.length} saved prompt${matching.length === 1 ? "" : "s"}.`,
    });
  }
  onProgress?.({
    type: "activity",
    message: `Running ${selected.length} saved search prompt${selected.length === 1 ? "" : "s"}…`,
  });

  const candidateContext = buildSearchPromptContext({ repoRoot, env, config });
  const kickoffInput = {
    mode: "ai-web-search",
    prompts: selected.map((p) => ({ id: p.id, text: p.text })),
    candidate: candidateContext,
  };
  // Scoped once for the whole run, not per-attempt — see buildAiWebSearchEnv's
  // own comment on why search-jobs needs a per-call override here rather
  // than living in the embedded runtime's own default allowlist.
  const skillEnv = buildAiWebSearchEnv({ repoRoot, env });
  const toolCalls = new Map();
  const toolTrace = [];

  async function invokeAiWebSearch({ correction }) {
    // A disconnect that landed between retry attempts (see
    // runStructuredOneshot's attempt loop) — bail before spending another
    // model call on a client that's already gone.
    if (signal?.aborted) return "";
    let rawText = "";
    await runSkillStream({
      skill: AI_WEB_SEARCH_LABELS.skill,
      action: AI_WEB_SEARCH_LABELS.action,
      operation: AI_WEB_SEARCH_LABELS.operation,
      input: correction ? `${JSON.stringify(kickoffInput)}\n\n${correction}` : kickoffInput,
      repoRoot,
      env: skillEnv,
      signal,
      toolProfile: "chat",
      onEvent: (evt) => {
        if (evt.type === "tool_use") {
          if (evt.data?.name === "WebSearch") {
            const query = String(evt.data?.input?.query || "").trim();
            if (query) {
              const item = { kind: "query", query, status: "completed", error: null };
              toolTrace.push(item);
              if (evt.data?.id) toolCalls.set(evt.data.id, item);
              onProgress?.({ type: "activity", message: `Searching: ${query}…` });
            }
          } else if (evt.data?.name === "WebFetch") {
            const rawUrl = String(evt.data?.input?.url || "").trim();
            if (rawUrl) {
              let host = rawUrl;
              try {
                host = new URL(rawUrl).hostname || rawUrl;
              } catch {
                // not a parseable URL — narrate the raw string as a fallback
              }
              const item = {
                kind: "source",
                url: rawUrl,
                host,
                status: "completed",
                error: null,
              };
              toolTrace.push(item);
              if (evt.data?.id) toolCalls.set(evt.data.id, item);
              onProgress?.({ type: "activity", message: `Reading ${host}…` });
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
    return rawText;
  }

  const outcome = await runBoundedAI({
    labels: AI_WEB_SEARCH_LABELS,
    schema: loadSchema(repoRoot),
    manual: MANUAL_FALLBACK,
    structuredMode: "fallback",
    maxRetries: 1,
    invoke: async ({ correction }) => {
      if (correction) onProgress?.({ type: "activity", message: "Retrying with corrections…" });
      return invokeAiWebSearch({ correction });
    },
  });

  if (!outcome.body.ok) {
    const message =
      outcome.body.error?.message || "AI web search failed to produce usable results.";
    const coverage = normalizeQueryResults({
      selected,
      queriesRun: [],
      toolTrace,
      fallbackError: message,
    });
    return {
      searched: selected.length,
      found: 0,
      new: 0,
      duplicates: 0,
      errors: [message],
      ...coverage,
      sources: toolTrace.filter((item) => item.kind === "source").map(({ kind, ...item }) => item),
    };
  }

  const roles = Array.isArray(outcome.body.data?.roles) ? outcome.body.data.roles : [];
  const coverage = normalizeQueryResults({
    selected,
    queriesRun: outcome.body.data?.queries_run,
    toolTrace,
  });
  const { seenUrls, seenReqIds, seenCompanyRoles } = buildDbSeenSets({ repoRoot, env });

  const survivors = [];
  for (const role of roles) {
    if (!role?.company || !role?.title || !role?.url) continue;
    const key = normalizeCompanyRoleKey(role.company, role.title);
    const req = extractReqId(role.url);
    const isDuplicate =
      seenUrls.has(role.url) || (req.id && seenReqIds.has(req.id)) || seenCompanyRoles.has(key);
    if (isDuplicate) continue;
    seenUrls.add(role.url);
    if (req.id) seenReqIds.add(req.id);
    seenCompanyRoles.add(key);
    survivors.push(toScanOffer(role, { key, reqId: req.id }));
  }

  // A disconnect that lands after the model finished but before this point
  // must not write a partial result — see the header comment on `signal`.
  if (survivors.length && !signal?.aborted) {
    captureAndPersistOffersIfDb({ repoRoot, env, offers: survivors, savedAt: new Date() });
  }

  return {
    searched: selected.length,
    found: roles.length,
    new: survivors.length,
    duplicates: roles.length - survivors.length,
    errors: [],
    ...coverage,
    sources: toolTrace.filter((item) => item.kind === "source").map(({ kind, ...item }) => item),
  };
}
