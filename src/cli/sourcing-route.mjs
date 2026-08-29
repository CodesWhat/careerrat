import { WORKSPACE_THREAD_ID } from "../core/agent/workspace-thread.mjs";
import { searchExecutionGet } from "../core/db/verbs/search-executions.mjs";
import { sourcingRunFail, sourcingRunGet } from "../core/db/verbs/sourcing-runs.mjs";
import {
  latestSourcingRunForUi,
  runFirstSearchInBackground,
  startFirstSearchRun,
  startManualSearchRun,
} from "../core/onboarding/first-search-run.mjs";
import { readJsonBodyCapped } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function errorStatus(err) {
  if ([400, 413, 415].includes(err?.status)) return err.status;
  if (err?.code === "NO_DATABASE" || err?.code === "NOT_SEARCH_READY") return 409;
  if (err?.code === "BAD_REQUEST") return 400;
  if (err?.code === "CONFLICT") return 409;
  if (err?.code === "NOT_FOUND") return 404;
  return 500;
}

function sendRouteError(res, err) {
  sendJson(res, errorStatus(err), {
    ok: false,
    error: err?.message || String(err),
    code: err?.code || undefined,
    readiness: err?.readiness || undefined,
    missing: err?.missing || undefined,
    errors: err?.errors || undefined,
  });
}

function purposeFromUrl(req) {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  return requestUrl.searchParams.get("purpose") || "first-search";
}

function idFromUrl(req) {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  return requestUrl.searchParams.get("id") || null;
}

function searchExecutionIdFromBody(body) {
  if (body?.searchExecutionId == null || body.searchExecutionId === "") return undefined;
  if (
    typeof body.searchExecutionId !== "string" ||
    !/^[A-Za-z0-9:_-]{1,128}$/.test(body.searchExecutionId)
  ) {
    const error = new Error("searchExecutionId must be a short identifier");
    error.code = "BAD_REQUEST";
    throw error;
  }
  return body.searchExecutionId;
}

function startBackground({
  repoRoot,
  env,
  fetchImpl,
  result,
  runSearchInBackgroundImpl,
  workspaceAgentRuntime,
}) {
  if (result?.reused === true || result?.run?.status !== "running") return;
  void runSearchInBackgroundImpl({ repoRoot, env, fetchImpl, runId: result.run.id })
    .then((run) => workspaceAgentRuntime?.recordSearchCompletion?.({ run }))
    .catch((error) => {
      try {
        const failed = sourcingRunFail({
          repoRoot,
          env,
          id: result.run.id,
          error: {
            code: error?.code || "SOURCING_SCAN_FAILED",
            message: error?.message || "Sourcing scan failed.",
          },
        }).run;
        return workspaceAgentRuntime?.recordSearchCompletion?.({ run: failed });
      } catch {
        return undefined;
      }
    });
}

async function startThroughWorkspace({
  workspaceAgentRuntime,
  purpose,
  retryFailed,
  searchExecutionId,
}) {
  const thread = await workspaceAgentRuntime.executeIntent({
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {
        purpose,
        retryFailed: retryFailed === true,
        ...(searchExecutionId ? { searchExecutionId } : {}),
      },
    },
  });
  if (!thread?.operationResult) {
    const error = new Error("The workspace agent did not return a search run.");
    error.code = "SEARCH_START_FAILED";
    throw error;
  }
  return thread.operationResult;
}

export function mountSourcingRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  workspaceAgentRuntime,
  startFirstSearchImpl = startFirstSearchRun,
  startManualSearchImpl = startManualSearchRun,
  runSearchInBackgroundImpl = runFirstSearchInBackground,
} = {}) {
  addRoute("GET", "/api/sourcing/runs/latest", (req, res) => {
    try {
      const purpose = purposeFromUrl(req);
      const id = idFromUrl(req);
      const latest = id
        ? sourcingRunGet({ repoRoot, env, purpose, id })
        : latestSourcingRunForUi({ repoRoot, env, purpose });
      sendJson(res, 200, latest);
    } catch (err) {
      sendRouteError(res, err);
    }
  });

  addRoute("GET", "/api/sourcing/execution", (req, res) => {
    try {
      const id = idFromUrl(req);
      if (!id) {
        const error = new Error("search execution id is required");
        error.code = "BAD_REQUEST";
        throw error;
      }
      sendJson(res, 200, searchExecutionGet({ repoRoot, env, id }));
    } catch (err) {
      sendRouteError(res, err);
    }
  });

  addRoute("POST", "/api/sourcing/first-run/start", async (_req, res) => {
    try {
      const latest = latestSourcingRunForUi({ repoRoot, env, purpose: "first-search" });
      const retryFailed = latest.run?.status === "failed";
      const result = workspaceAgentRuntime
        ? await startThroughWorkspace({
            workspaceAgentRuntime,
            purpose: "first-search",
            retryFailed,
          })
        : await startFirstSearchImpl({ repoRoot, env, fetchImpl, retryFailed });
      if (!workspaceAgentRuntime?.startsSearchInBackground) {
        startBackground({
          repoRoot,
          env,
          fetchImpl,
          result,
          runSearchInBackgroundImpl,
          workspaceAgentRuntime,
        });
      }
      sendJson(res, result.reused ? 200 : 202, result);
    } catch (err) {
      sendRouteError(res, err);
    }
  });

  addRoute("POST", "/api/sourcing/search/start", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      const searchExecutionId = searchExecutionIdFromBody(body);
      const result = workspaceAgentRuntime
        ? await startThroughWorkspace({
            workspaceAgentRuntime,
            purpose: "manual-search",
            retryFailed: false,
            searchExecutionId,
          })
        : await startManualSearchImpl({ repoRoot, env, fetchImpl, searchExecutionId });
      if (!workspaceAgentRuntime?.startsSearchInBackground) {
        startBackground({
          repoRoot,
          env,
          fetchImpl,
          result,
          runSearchInBackgroundImpl,
          workspaceAgentRuntime,
        });
      }
      sendJson(res, result.reused ? 200 : 202, result);
    } catch (err) {
      sendRouteError(res, err);
    }
  });
}
