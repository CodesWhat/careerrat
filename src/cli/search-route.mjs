// search-route.mjs — M3 of the paid-POC journey: the /search surface's HTTP
// surface over the existing deterministic (non-AI) ATS-board sweep
// (scripts/scan-sourced.mjs's exported runSourcedScan(), see that file's own
// header comment for the M3 promotion). Split out the same way
// onboard-route.mjs/skill-run-route.mjs/chat-route.mjs were: `addRoute` is
// the mount point, `readJsonBodyCapped`/`sendJson` are imported from
// skill-run-route.mjs rather than duplicated.
//
// mountSearchRoutes({addRoute, repoRoot, env, fetchImpl}) registers:
//
//   POST /api/search/scan     Runs runSourcedScan({write:true}) in-process
//                              and returns the summary JSON. 409 while a scan
//                              is already running (a single in-module flag —
//                              this is one local dev-server process, not a
//                              job queue). The route heals source config
//                              before scanning and settles an empty valid
//                              workspace as an honest zero-result run.
//   GET  /api/search/results   DB sourced rows in stable database row order.
//   GET  /api/search/sources   {searches:{enabled,total}, trackedCompanies}
//                              — source health for the React search surface.
//   POST /api/search/prompts/generate
//                              Generates AI search-assistant prompts from the
//                              candidate's stored targeting/profile
//                              (src/core/search/search-prompts.mjs), persists
//                              them, and returns the stored list. Bounded-AI
//                              envelope passthrough on failure (501/422/502 —
//                              see runBoundedAI's own contract).
//   GET  /api/search/prompts   Stored ai_prompts (targeting.search_preferences).
//   PUT  /api/search/prompts   { prompts:[{id?, text}] } — validates non-empty
//                              text, persists (mints ids for new rows), and
//                              returns the stored list.
//   POST /api/search/ai-web-search/run
//                              { promptIds?: string[] } — runs the search-jobs
//                              skill's AI Web Search mode via the embedded
//                              runtime (src/core/search/ai-web-search.mjs) and
//                              streams progress as SSE (activity/done/error
//                              frames, 10s ping heartbeat — see that route's
//                              own comment below for the full frame
//                              contract). 409 while a run is already in
//                              flight; 501 pre-stream if no AI route is
//                              configured. When no prompts are saved, the
//                              route generates and saves them before starting.
//
// `fetchImpl` is dependency-injected (defaults to the real global `fetch`)
// the same way `runSkillStream` is in skill-run-route.mjs, so tests can drive
// a scan against a stub network instead of hitting real ATS APIs.

import { createHash } from "node:crypto";
import { runSourcedScan } from "../../scripts/scan-sourced.mjs";
import { loadAIPreferences } from "../core/ai/ai-preferences.mjs";
import { resolveAIRoute } from "../core/ai/call-ai.mjs";
import { aiRuntimeIdForRoute, resolveAIExecutionPlan } from "../core/ai/operation-policy.mjs";
import { readDbScannerRows } from "../core/db/scan-context.mjs";
import { sourceConfigGet } from "../core/db/verbs/source-config.mjs";
import {
  assertSourcingRunActiveInDb,
  sourcingRunFail,
  sourcingRunLatest,
  sourcingRunStart,
} from "../core/db/verbs/sourcing-runs.mjs";
import { healSearchSourceConfig } from "../core/onboarding/first-search-run.mjs";
import {
  compactDeterministicCoverage,
  runAiWebSearch as defaultRunAiWebSearch,
} from "../core/search/ai-web-search.mjs";
import {
  buildSearchPromptInputFingerprint,
  generateSearchPrompts,
  getSearchPrompts,
  saveSearchPrompts,
} from "../core/search/search-prompts.mjs";
import { createSourcingWorkerManager } from "../core/search/sourcing-worker-manager.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB — same cap the other route modules use.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function searchExecutionIdFromBody(body) {
  if (body?.searchExecutionId == null || body.searchExecutionId === "") return undefined;
  if (
    typeof body.searchExecutionId !== "string" ||
    !/^[A-Za-z0-9:_-]{1,128}$/.test(body.searchExecutionId)
  ) {
    const error = new Error("searchExecutionId must be a short identifier");
    error.status = 400;
    throw error;
  }
  return body.searchExecutionId;
}

function queryParam(req, name) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams.get(name);
}

function sendDbError(res, error) {
  if (error?.code !== "NO_DATABASE") return false;
  sendJson(res, 409, { ok: false, error: error.message });
  return true;
}

function toSearchResultOffer(row = {}) {
  return {
    id: row.id,
    company: row.company,
    title: row.role || row.title,
    role: row.role || row.title,
    url: row.link || row.url,
    location: row.loc || row.location,
    comp: row.base || row.comp,
    score: row.fitScore,
    fit: row.fitBucket,
    gate: row.gate,
    source: row.source,
    channel: row.channel,
    artifacts: row.artifacts || {},
    sourcedAt: row.sourcedAt,
    updatedAt: row.updatedAt,
  };
}

export function mountSearchRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  runAiWebSearch = defaultRunAiWebSearch,
  generateSearchPromptsImpl = generateSearchPrompts,
  captureBrowserSourceImpl,
  workspaceAgentRuntime,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  const pathCtx = { repoRoot, env };

  // A single in-module flag is enough here — see the header comment.
  let scanning = false;
  const localSourcingWorkers =
    typeof workspaceAgentRuntime?.startSourcingWorker === "function"
      ? null
      : createSourcingWorkerManager({
          repoRoot,
          env,
          heartbeatMs: 30_000,
          setIntervalImpl,
          clearIntervalImpl,
          onTerminal: (input) => workspaceAgentRuntime?.recordSearchCompletion?.(input),
        });
  const registerSourcingWorker =
    workspaceAgentRuntime?.registerSourcingWorker?.bind(workspaceAgentRuntime) ||
    localSourcingWorkers.register;
  const startSourcingWorker =
    workspaceAgentRuntime?.startSourcingWorker?.bind(workspaceAgentRuntime) ||
    localSourcingWorkers.start;

  registerSourcingWorker({
    purpose: "ai-web-search",
    execute: async ({ run, context, signal, reportProgress }) => {
      const promptIds = Array.isArray(run.metadata?.promptIds) ? run.metadata.promptIds : [];
      const prompts = Array.isArray(run.metadata?.prompts) ? run.metadata.prompts : [];
      const activities = Array.isArray(run.progress?.activities)
        ? run.progress.activities.map(String).slice(-40)
        : [];
      try {
        const result = await runAiWebSearch({
          repoRoot,
          env,
          fetchImpl,
          promptIds,
          deterministic: run.metadata?.deterministic,
          executionPlan: run.metadata?.aiExecutionPlan,
          onProgress: (event) => {
            context?.emit?.(event);
            if (event?.type !== "activity" || !event.message) return;
            activities.push(String(event.message));
            const { type: _type, message: _message, ...activity } = event;
            reportProgress({
              lastActivity: String(event.message),
              activities: activities.slice(-40),
              ...(Object.keys(activity).length ? { activity } : {}),
            });
          },
          signal,
          writeGuard: (db) => assertSourcingRunActiveInDb(db, run.id),
        });
        signal.throwIfAborted();
        const failedPromptIds = Array.isArray(result?.failedPromptIds)
          ? result.failedPromptIds
          : [];
        const allSelectedPromptsFailed =
          Number(result?.searched || 0) > 0 && failedPromptIds.length >= Number(result.searched);
        if (!allSelectedPromptsFailed) {
          return {
            settlement: { status: "completed", summary: result },
            value: result,
          };
        }
        return {
          settlement: {
            status: "failed",
            error: {
              code: "AI_WEB_SEARCH_QUERIES_FAILED",
              message:
                result.errors?.[0] ||
                "Every selected AI web-search prompt failed or had no reported query coverage.",
              action: "retry-failed",
              failedPromptIds,
              queryResults: result.queryResults || [],
              sources: result.sources || [],
              errors: result.errors || [],
            },
          },
          value: result,
        };
      } catch (error) {
        if (signal.aborted) throw signal.reason || error;
        return {
          settlement: {
            status: "failed",
            error: {
              code: error?.code || "AI_WEB_SEARCH_FAILED",
              message: error?.message || "AI web search failed unexpectedly.",
              action: "retry-failed",
              failedPromptIds: promptIds,
              queryResults: prompts.map((prompt) => ({
                promptId: prompt.id,
                prompt: prompt.text,
                status: "failed",
                queries: [],
                error: error?.message || "AI web search failed unexpectedly.",
              })),
            },
          },
          value: null,
        };
      }
    },
  });

  async function shutdownAiWebSearch() {
    if (typeof workspaceAgentRuntime?.shutdownSourcingWorkerPurpose === "function") {
      await workspaceAgentRuntime.shutdownSourcingWorkerPurpose("ai-web-search");
      return;
    }
    await localSourcingWorkers.shutdown("ai-web-search");
  }

  // -------------------------------------------------------------------------
  // POST /api/search/scan
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/search/scan", async (req, res) => {
    try {
      await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    if (scanning) {
      sendJson(res, 409, { error: "a scan is already running" });
      return;
    }

    try {
      healSearchSourceConfig({ repoRoot, env });
    } catch (err) {
      if (sendDbError(res, err)) return;
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
      return;
    }

    scanning = true;
    try {
      const summary = await runSourcedScan({
        repoRoot,
        env,
        fetchImpl,
        captureBrowserSourceImpl,
        write: true,
      });
      sendJson(res, 200, summary);
    } catch (err) {
      if (sendDbError(res, err)) return;
      sendJson(res, 500, { error: err.message });
    } finally {
      scanning = false;
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/search/results — ?date=YYYY-MM-DD optional
  // -------------------------------------------------------------------------
  addRoute("GET", "/api/search/results", (req, res) => {
    const dateParam = queryParam(req, "date");

    if (dateParam && !DATE_RE.test(dateParam)) {
      sendJson(res, 400, { error: "date must be YYYY-MM-DD" });
      return;
    }

    try {
      const rows = readDbScannerRows(pathCtx);
      const filteredRows = dateParam
        ? rows.filter((row) => String(row.sourcedAt || row.updatedAt || "").startsWith(dateParam))
        : rows;
      const offers = filteredRows.map(toSearchResultOffer);
      sendJson(res, 200, {
        ok: true,
        source: "db",
        date: dateParam || null,
        count: offers.length,
        scanned: offers.length,
        new: offers.length,
        offers,
      });
    } catch (err) {
      if (sendDbError(res, err)) return;
      sendJson(res, 500, { error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/search/sources
  // -------------------------------------------------------------------------
  addRoute("GET", "/api/search/sources", (_req, res) => {
    try {
      const healed = healSearchSourceConfig({ repoRoot, env });
      const searchSources = healed.searchSources;
      const sourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
      const deterministicSources = healed.deterministicSources;
      const list = Array.isArray(searchSources.searches) ? searchSources.searches : [];
      const tracked = Array.isArray(sourcedScan.tracked_companies)
        ? sourcedScan.tracked_companies
        : [];
      sendJson(res, 200, {
        searches: {
          enabled: list.filter((s) => s && s.enabled !== false).length,
          total: list.length,
        },
        trackedCompanies: tracked.length,
        enabledTrackedCompanies: deterministicSources.supportedAtsCompanies,
        deterministicSources,
      });
    } catch (err) {
      if (sendDbError(res, err)) return;
      sendJson(res, 500, { error: err.message });
    }
  });

  function sendSearchPromptsError(res, err) {
    if (sendDbError(res, err)) return;
    sendJson(res, err?.code === "VALIDATION_FAILED" ? 400 : 500, {
      ok: false,
      error: { message: err?.message || String(err) },
      errors: err?.errors || undefined,
    });
  }

  // -------------------------------------------------------------------------
  // POST /api/search/prompts/generate — generate-first AI search prompts,
  // derived only from stored targeting/profile (see search-prompts.mjs's own
  // header comment). Generates, persists (source "generated"), and returns
  // the stored list. AI failures pass the bounded-AI envelope straight
  // through — same 501 (no route)/422 (schema)/502 (provider) contract every
  // other bounded-AI route uses.
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/search/prompts/generate", async (_req, res) => {
    let outcome;
    try {
      outcome = await generateSearchPromptsImpl({ repoRoot, env });
    } catch (err) {
      sendSearchPromptsError(res, err);
      return;
    }

    if (!outcome.body?.ok) {
      sendJson(res, outcome.status, outcome.body);
      return;
    }

    try {
      const saved = saveSearchPrompts({
        repoRoot,
        env,
        prompts: outcome.body.data.prompts,
        defaultSource: "generated",
      });
      sendJson(res, 200, { ok: true, data: { prompts: saved.prompts } });
    } catch (err) {
      sendSearchPromptsError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/search/prompts — stored targeting.search_preferences.ai_prompts.
  // -------------------------------------------------------------------------
  addRoute("GET", "/api/search/prompts", (_req, res) => {
    try {
      const result = getSearchPrompts({ repoRoot, env });
      sendJson(res, 200, {
        ok: true,
        data: {
          prompts: result.prompts,
          inputFingerprint: result.inputFingerprint,
          savedInputFingerprint: result.savedInputFingerprint,
        },
      });
    } catch (err) {
      sendSearchPromptsError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // PUT /api/search/prompts — { prompts:[{id?, text}] }. Every posted item
  // must carry non-empty text (a malformed/empty row is a 400, not a silent
  // drop); an empty `prompts` array is a legitimate "user cleared the list".
  // -------------------------------------------------------------------------
  addRoute("PUT", "/api/search/prompts", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: { message: err.message } });
      return;
    }

    const posted = Array.isArray(body?.prompts) ? body.prompts : null;
    if (!posted) {
      sendJson(res, 400, { ok: false, error: { message: "body.prompts must be an array" } });
      return;
    }
    const hasEmptyText = posted.some((p) => !String(p?.text ?? "").trim());
    if (hasEmptyText) {
      sendJson(res, 400, {
        ok: false,
        error: { message: "every prompt requires non-empty text" },
      });
      return;
    }

    try {
      const saved = saveSearchPrompts({ repoRoot, env, prompts: posted });
      sendJson(res, 200, { ok: true, data: { prompts: saved.prompts } });
    } catch (err) {
      sendSearchPromptsError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/search/ai-web-search/run — { promptIds?: string[] }
  //
  // Runs the search-jobs skill's AI Web Search mode (see that SKILL.md's own
  // section) via the embedded one-shot runtime, streaming progress as
  // Server-Sent Events — the same `data: <json>\n\n` framing, 10s `: ping`
  // heartbeat, and closed-response write guard as POST
  // /api/onboard/resume-ai-stream, but a narrower frame set: there's no
  // upload step here, so no "saved" frame; the model's reply is buffered and
  // validated entirely server-side (runAiWebSearch), so no "json"/"restart"
  // frame either.
  //
  //   {"type":"activity","message":...}          short human progress lines
  //   {"type":"done","data":{searched,found,new,duplicates,errors}}
  //                                               terminal — the exact shape
  //                                               runAiWebSearch() returns
  //   {"type":"error","message":...,"status":n}  terminal, an unexpected
  //                                               failure (not the normal
  //                                               "model produced nothing
  //                                               usable" case, which comes
  //                                               back as a "done" frame with
  //                                               a non-empty errors[])
  //
  // Unlike resume-ai-stream, "no AI route configured" is a zero-AI-call check
  // resolvable BEFORE opening the SSE response, so it comes back as a real
  // HTTP 501 rather than an in-band error frame. When the user has no saved
  // prompts, the route generates and persists candidate-shaped prompts before
  // opening the stream. The per-mode prompt
  // cap (modes.mjs's "search:ai-web" op — lean=1, standard=3, full=5) is
  // NOT a rejection: the op table never returns "skip" for it, only
  // "downshift" (lean) or "run" — lean mode narrows how many saved prompts
  // run, it never blocks the feature outright, so there's no corresponding
  // pre-stream failure for it; runAiWebSearch() applies the cap itself and
  // narrates it as the first "activity" frame once the stream is open.
  //
  // Single-concurrent-run guard: a second call while one is in flight gets a
  // 409, the same shape as POST /api/search/scan's own `scanning` guard
  // above.
  // -------------------------------------------------------------------------
  function aiSearchStartError(status, message, extra = {}) {
    const error = new Error(message);
    error.status = status;
    error.body = { ok: false, error: { message }, ...extra };
    return error;
  }

  async function startAiWebSearchWorker({
    promptIds,
    searchExecutionId,
    deterministic,
    emit,
  } = {}) {
    const deterministicCoverage = compactDeterministicCoverage(deterministic);
    const active = sourcingRunLatest({ repoRoot, env, purpose: "ai-web-search" }).run;
    if (active?.status === "running") {
      throw aiSearchStartError(409, "an AI web search is already running", { run: active });
    }

    const route = resolveAIRoute(env, { repoRoot });
    if (route.type === "none") throw aiSearchStartError(501, route.error);
    const aiExecutionPlan = resolveAIExecutionPlan({
      operation: "research.web",
      runtimeId: aiRuntimeIdForRoute(route),
      preferences: loadAIPreferences({ repoRoot, env }),
      ...(route.type === "installed" ? { installedRuntime: route.runtime } : {}),
    });

    let storedPrompts = getSearchPrompts({ repoRoot, env }).prompts;
    if (!storedPrompts.length && !promptIds?.length) {
      const generated = await generateSearchPromptsImpl({ repoRoot, env });
      if (!generated.body?.ok) {
        const error = new Error(
          generated.body?.error?.message || "Search prompts could not be generated."
        );
        error.status = generated.status;
        error.body = generated.body;
        throw error;
      }
      storedPrompts = saveSearchPrompts({
        repoRoot,
        env,
        prompts: generated.body.data.prompts,
        defaultSource: "generated",
      }).prompts;
    }
    const requested = promptIds?.length
      ? storedPrompts.filter((prompt) => promptIds.includes(prompt.id))
      : storedPrompts;
    if (!requested.length) {
      throw aiSearchStartError(
        422,
        "No saved AI search prompts to run. Generate or add some first."
      );
    }

    const candidateInputFingerprint = buildSearchPromptInputFingerprint({
      repoRoot,
      env,
      includeSearchLimits: true,
    });
    const inputFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 2,
          candidateInputFingerprint,
          prompts: requested.map((prompt) => ({ id: prompt.id, text: prompt.text })),
          deterministic: deterministicCoverage,
        })
      )
      .digest("hex");
    const started = sourcingRunStart({
      repoRoot,
      env,
      purpose: "ai-web-search",
      inputFingerprint,
      metadata: {
        promptIds: requested.map((prompt) => prompt.id),
        prompts: requested.map((prompt) => ({ id: prompt.id, text: prompt.text })),
        aiExecutionPlan,
        ...(searchExecutionId ? { searchExecutionId } : {}),
        ...(deterministicCoverage ? { deterministic: deterministicCoverage } : {}),
      },
      trigger: promptIds?.length ? "retry-failed" : "jobs-search",
    });
    if (started.reused) {
      throw aiSearchStartError(409, "an AI web search is already recorded as running", {
        run: started.run,
      });
    }
    const durableRun = started.run;

    try {
      await workspaceAgentRuntime?.recordSearchStart?.({
        run: durableRun,
        input: {
          purpose: "ai-web-search",
          promptIds: requested.map((prompt) => prompt.id),
          ...(searchExecutionId ? { searchExecutionId } : {}),
        },
        sources: { promptCount: requested.length },
      });
    } catch (error) {
      try {
        sourcingRunFail({
          repoRoot,
          env,
          id: durableRun.id,
          error: {
            code: "WORKSPACE_HISTORY_FAILED",
            message: "The AI web search could not be attached to the career workspace.",
            action: "retry-failed",
          },
        });
      } catch {
        // Preserve the workspace-history error below.
      }
      throw aiSearchStartError(
        500,
        error?.message || "The AI web search could not be attached to the career workspace."
      );
    }

    return {
      run: durableRun,
      start: (progressEmitter = emit) =>
        startSourcingWorker({ run: durableRun, context: { emit: progressEmitter } }),
    };
  }

  workspaceAgentRuntime?.registerAiWebSearchStarter?.({
    isAvailable: () => resolveAIRoute(env, { repoRoot }).type !== "none",
    start: async ({ searchExecutionId, deterministic, signal, onProgress, onStarted } = {}) => {
      signal?.throwIfAborted?.();
      const started = await startAiWebSearchWorker({
        searchExecutionId,
        deterministic,
        emit: onProgress,
      });
      onStarted?.(started.run);
      const outcome = await started.start().promise;
      signal?.throwIfAborted?.();
      if (outcome?.resumable === true) {
        return { ok: false, resumable: true, run: started.run };
      }
      if (outcome?.run?.status === "failed") {
        return { ok: false, run: outcome.run, error: outcome.run.error };
      }
      return { ok: true, run: outcome?.run || started.run, value: outcome?.value ?? null };
    },
  });

  addRoute("POST", "/api/search/ai-web-search/run", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: { message: err.message } });
      return;
    }

    const promptIds = Array.isArray(body?.promptIds)
      ? body.promptIds.map((id) => String(id)).filter(Boolean)
      : undefined;
    let searchExecutionId;
    try {
      searchExecutionId = searchExecutionIdFromBody(body);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: { message: err.message } });
      return;
    }

    let started;
    try {
      started = await startAiWebSearchWorker({ promptIds, searchExecutionId });
    } catch (err) {
      if (err?.code === "NO_DATABASE") {
        sendJson(res, 409, { ok: false, error: { message: err.message } });
        return;
      }
      if (err?.body) {
        sendJson(res, err.status || 500, err.body);
        return;
      }
      sendSearchPromptsError(res, err);
      return;
    }
    const durableRun = started.run;

    // This response is only a live view onto the durable search worker. A
    // navigation, reload, or dropped SSE connection stops writes to this
    // response, but it must not cancel a search that can take many minutes.
    // The app lifecycle owns the worker AbortController below.
    let closed = false;
    res.on("close", () => {
      closed = true;
    });

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();

    function emit(payload) {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        closed = true;
      }
    }

    const streamHeartbeat = setIntervalImpl(() => {
      if (closed) return;
      try {
        res.write(": ping\n\n");
      } catch {
        closed = true;
      }
    }, 10000);

    emit({ type: "started", run: durableRun });
    const worker = started.start(emit);

    try {
      const outcome = await worker.promise;
      if (outcome?.value) {
        emit({ type: "done", data: outcome.value });
      } else if (outcome?.run?.status === "failed") {
        emit({
          type: "error",
          message: outcome.run.error?.message || "AI web search failed unexpectedly.",
          status: 500,
        });
      }
    } catch (err) {
      emit({
        type: "error",
        message: err?.message || "AI web search failed unexpectedly.",
        status: err?.code === "NO_DATABASE" ? 409 : err?.code === "NO_SAVED_PROMPTS" ? 422 : 500,
      });
    } finally {
      clearIntervalImpl(streamHeartbeat);
      if (!closed) {
        try {
          res.end();
        } catch {
          // client already gone
        }
      }
    }
  });

  return { shutdownAiWebSearch };
}
