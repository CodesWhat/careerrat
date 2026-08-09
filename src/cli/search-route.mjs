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
//                              job queue). 400 if neither
//                              DB source config is not configured yet.
//   GET  /api/search/results   DB sourced rows in stable database row order.
//   GET  /api/search/sources   {searches:{enabled,total}, trackedCompanies}
//                              — the presence/health strip
//                              src/core/onboarding/search-page.mjs's header
//                              renders on load.
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
//                              flight; 501/422 pre-stream if no AI route is
//                              configured / there are no saved prompts to run.
//
// `fetchImpl` is dependency-injected (defaults to the real global `fetch`)
// the same way `runSkillStream` is in skill-run-route.mjs, so tests can drive
// a scan against a stub network instead of hitting real ATS APIs.

import { runSourcedScan } from "../../scripts/scan-sourced.mjs";
import { resolveAIRoute } from "../core/ai/call-ai.mjs";
import { readDbScannerRows } from "../core/db/scan-context.mjs";
import { sourceConfigGet } from "../core/db/verbs/source-config.mjs";
import {
  sourcingRunComplete,
  sourcingRunFail,
  sourcingRunProgress,
  sourcingRunStart,
} from "../core/db/verbs/sourcing-runs.mjs";
import {
  countDeterministicSources,
  healSearchSourceConfig,
} from "../core/onboarding/first-search-run.mjs";
import { runAiWebSearch as defaultRunAiWebSearch } from "../core/search/ai-web-search.mjs";
import {
  generateSearchPrompts,
  getSearchPrompts,
  saveSearchPrompts,
} from "../core/search/search-prompts.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB — same cap the other route modules use.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function queryParam(req, name) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams.get(name);
}

function hasConfiguredDbSourcesOnly(pathCtx) {
  const sourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
  const searchSources = sourceConfigGet({ ...pathCtx, name: "search-sources" }).data;
  return Boolean(
    (Array.isArray(sourcedScan.tracked_companies) && sourcedScan.tracked_companies.length > 0) ||
      (Array.isArray(searchSources.searches) && searchSources.searches.length > 0)
  );
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
  workspaceAgentRuntime,
}) {
  const pathCtx = { repoRoot, env };

  // A single in-module flag is enough here — see the header comment.
  let scanning = false;
  // Same reasoning, separate flag: the deterministic sweep and the AI web
  // search lane are independent operations and may legitimately overlap.
  let aiWebSearchRunning = false;

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

    let hasConfig = false;
    try {
      hasConfig = hasConfiguredDbSourcesOnly(pathCtx);
    } catch (err) {
      if (sendDbError(res, err)) return;
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
      return;
    }

    if (!hasConfig) {
      sendJson(res, 400, {
        error: "No search config found — run /onboard write-config first",
      });
      return;
    }

    scanning = true;
    try {
      const summary = await runSourcedScan({ repoRoot, env, fetchImpl, write: true });
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
      let searchSources = sourceConfigGet({ ...pathCtx, name: "search-sources" }).data;
      const sourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
      let deterministicSources = countDeterministicSources({ searchSources, sourcedScan });
      // Self-heal on the read path (see healSearchSourceConfig's own header
      // comment): a pre-6de6fa6b install can be stuck at zero deterministic
      // sources forever otherwise, since the only repair path used to be
      // search-time-only. Only attempted when the stored count is already 0
      // — never on every load — and it makes no AI calls.
      if (deterministicSources.attempted === 0) {
        const healed = healSearchSourceConfig({ repoRoot, env });
        if (healed.healed) {
          searchSources = healed.searchSources;
          deterministicSources = healed.deterministicSources;
        }
      }
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
      outcome = await generateSearchPrompts({ repoRoot, env });
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
      sendJson(res, 200, { ok: true, data: { prompts: result.prompts } });
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
  // heartbeat, and res.on("close") close-guard as
  // POST /api/onboard/resume-ai-stream (see onboard-route.mjs's own header
  // comment on that exact mechanics), but a narrower frame set: there's no
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
  // Unlike resume-ai-stream, "no AI route configured" and "no saved prompts"
  // are both zero-AI-call checks (an env read and a DB read) resolvable
  // BEFORE opening the SSE response, so they come back as a real HTTP status
  // (501 / 422) here rather than an in-band error frame. The per-mode prompt
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

    if (aiWebSearchRunning) {
      sendJson(res, 409, {
        ok: false,
        error: { message: "an AI web search is already running" },
      });
      return;
    }

    const route = resolveAIRoute(env, { repoRoot });
    if (route.type === "none") {
      sendJson(res, 501, { ok: false, error: { message: route.error } });
      return;
    }

    let storedPrompts;
    try {
      storedPrompts = getSearchPrompts({ repoRoot, env }).prompts;
    } catch (err) {
      sendSearchPromptsError(res, err);
      return;
    }
    const requested = promptIds?.length
      ? storedPrompts.filter((p) => promptIds.includes(p.id))
      : storedPrompts;
    if (!requested.length) {
      sendJson(res, 422, {
        ok: false,
        error: { message: "No saved AI search prompts to run — generate or add some first." },
      });
      return;
    }

    let durableRun;
    try {
      const started = sourcingRunStart({
        repoRoot,
        env,
        purpose: "ai-web-search",
        metadata: {
          promptIds: requested.map((prompt) => prompt.id),
          prompts: requested.map((prompt) => ({ id: prompt.id, text: prompt.text })),
        },
        trigger: promptIds?.length ? "retry-failed" : "jobs-search",
      });
      if (started.reused) {
        sendJson(res, 409, {
          ok: false,
          error: { message: "an AI web search is already recorded as running" },
          run: started.run,
        });
        return;
      }
      durableRun = started.run;
    } catch (err) {
      sendJson(res, err?.code === "NO_DATABASE" ? 409 : 500, {
        ok: false,
        error: { message: err?.message || "AI web search run could not be recorded." },
      });
      return;
    }

    try {
      await workspaceAgentRuntime?.recordSearchStart?.({
        run: durableRun,
        input: {
          purpose: "ai-web-search",
          promptIds: requested.map((prompt) => prompt.id),
        },
        sources: { promptCount: requested.length },
      });
    } catch (err) {
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
        // Preserve the workspace-history error returned below.
      }
      sendJson(res, 500, {
        ok: false,
        error: {
          message:
            err?.message || "The AI web search could not be attached to the career workspace.",
        },
      });
      return;
    }

    // Client-disconnect guard: `res.on("close")`, not `req.on("close")` —
    // see skill-run-route.mjs's own comment on this exact choice. The
    // AbortController's signal is threaded into runAiWebSearch (and from
    // there into runSkillStream's own SDK-query abort) so a disconnect
    // actually stops the underlying model call instead of just silencing
    // the now-unreachable SSE writes below.
    let closed = false;
    const controller = new AbortController();
    res.on("close", () => {
      closed = true;
      controller.abort();
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

    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(": ping\n\n");
      } catch {
        closed = true;
      }
    }, 10000);

    aiWebSearchRunning = true;
    let terminalRun = null;
    try {
      const activities = [];
      const result = await runAiWebSearch({
        repoRoot,
        env,
        promptIds,
        onProgress: (event) => {
          emit(event);
          if (event?.type !== "activity" || !event.message) return;
          activities.push(String(event.message));
          try {
            sourcingRunProgress({
              repoRoot,
              env,
              id: durableRun.id,
              progress: {
                lastActivity: String(event.message),
                activities: activities.slice(-40),
              },
            });
          } catch {
            // The stream remains usable if a progress-only persistence write
            // races a shutdown; terminal persistence below still decides the run.
          }
        },
        signal: controller.signal,
      });
      const failedPromptIds = Array.isArray(result?.failedPromptIds) ? result.failedPromptIds : [];
      const allSelectedPromptsFailed =
        Number(result?.searched || 0) > 0 && failedPromptIds.length >= Number(result.searched);
      if (allSelectedPromptsFailed) {
        terminalRun = sourcingRunFail({
          repoRoot,
          env,
          id: durableRun.id,
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
        }).run;
      } else {
        terminalRun = sourcingRunComplete({
          repoRoot,
          env,
          id: durableRun.id,
          summary: result,
        }).run;
      }
      emit({ type: "done", data: result });
    } catch (err) {
      try {
        terminalRun = sourcingRunFail({
          repoRoot,
          env,
          id: durableRun.id,
          error: {
            code:
              err?.code ||
              (controller.signal.aborted ? "AI_WEB_SEARCH_ABORTED" : "AI_WEB_SEARCH_FAILED"),
            message: err?.message || "AI web search failed unexpectedly.",
            action: "retry-failed",
            failedPromptIds: requested.map((prompt) => prompt.id),
            queryResults: requested.map((prompt) => ({
              promptId: prompt.id,
              prompt: prompt.text,
              status: "failed",
              queries: [],
              error: err?.message || "AI web search failed unexpectedly.",
            })),
          },
        }).run;
      } catch {
        // Preserve the original runtime error in the SSE response.
      }
      emit({
        type: "error",
        message: err?.message || "AI web search failed unexpectedly.",
        status: err?.code === "NO_DATABASE" ? 409 : err?.code === "NO_SAVED_PROMPTS" ? 422 : 500,
      });
    } finally {
      aiWebSearchRunning = false;
      clearInterval(heartbeat);
      if (terminalRun) {
        try {
          await workspaceAgentRuntime?.recordSearchCompletion?.({ run: terminalRun });
        } catch {
          // The durable sourcing run remains authoritative if history mirroring fails during shutdown.
        }
      }
      if (!closed) {
        try {
          res.end();
        } catch {
          // client already gone
        }
      }
    }
  });
}
