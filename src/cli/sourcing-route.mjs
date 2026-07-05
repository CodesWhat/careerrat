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

function startBackground({ repoRoot, env, fetchImpl, result }) {
  if (result?.reused === true || result?.run?.status !== "running") return;
  void runFirstSearchInBackground({
    repoRoot,
    env,
    fetchImpl,
    runId: result.run.id,
  }).catch(() => {});
}

export function mountSourcingRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  addRoute("GET", "/api/sourcing/runs/latest", (req, res) => {
    try {
      const latest = latestSourcingRunForUi({ repoRoot, env, purpose: purposeFromUrl(req) });
      sendJson(res, 200, latest);
    } catch (err) {
      sendRouteError(res, err);
    }
  });

  addRoute("POST", "/api/sourcing/first-run/start", (_req, res) => {
    try {
      const latest = latestSourcingRunForUi({ repoRoot, env, purpose: "first-search" });
      const retryFailed = latest.run?.status === "failed";
      const result = startFirstSearchRun({ repoRoot, env, retryFailed });
      startBackground({ repoRoot, env, fetchImpl, result });
      sendJson(res, result.reused ? 200 : 202, result);
    } catch (err) {
      sendRouteError(res, err);
    }
  });

  addRoute("POST", "/api/sourcing/search/start", (_req, res) => {
    try {
      const result = startManualSearchRun({ repoRoot, env });
      startBackground({ repoRoot, env, fetchImpl, result });
      sendJson(res, result.reused ? 200 : 202, result);
    } catch (err) {
      sendRouteError(res, err);
    }
  });
}
