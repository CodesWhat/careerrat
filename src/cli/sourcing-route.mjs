import { WORKSPACE_THREAD_ID } from "../core/agent/workspace-thread.mjs";
import {
  latestSourcingRunForUi,
  runFirstSearchInBackground,
  startFirstSearchRun,
  startManualSearchRun,
} from "../core/onboarding/first-search-run.mjs";

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function errorStatus(err) {
  if (err?.code === "NO_DATABASE" || err?.code === "NOT_SEARCH_READY") return 409;
  if (err?.code === "BAD_REQUEST") return 400;
  if (err?.code === "CONFLICT") return 409;
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
    .catch(() => {});
}

async function startThroughWorkspace({ workspaceAgentRuntime, purpose, retryFailed }) {
  const thread = await workspaceAgentRuntime.executeIntent({
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { purpose, retryFailed: retryFailed === true },
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
      const latest = latestSourcingRunForUi({ repoRoot, env, purpose: purposeFromUrl(req) });
      sendJson(res, 200, latest);
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

  addRoute("POST", "/api/sourcing/search/start", async (_req, res) => {
    try {
      const result = workspaceAgentRuntime
        ? await startThroughWorkspace({
            workspaceAgentRuntime,
            purpose: "manual-search",
            retryFailed: false,
          })
        : await startManualSearchImpl({ repoRoot, env, fetchImpl });
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
