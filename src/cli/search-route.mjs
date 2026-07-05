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
//
// `fetchImpl` is dependency-injected (defaults to the real global `fetch`)
// the same way `runSkillStream` is in skill-run-route.mjs, so tests can drive
// a scan against a stub network instead of hitting real ATS APIs.

import { runSourcedScan } from "../../scripts/scan-sourced.mjs";
import { readDbScannerRows } from "../core/db/scan-context.mjs";
import { sourceConfigGet } from "../core/db/verbs/source-config.mjs";
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

export function mountSearchRoutes({ addRoute, repoRoot, env = process.env, fetchImpl = fetch }) {
  const pathCtx = { repoRoot, env };

  // A single in-module flag is enough here — see the header comment.
  let scanning = false;

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
      throw err;
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
      const searchSources = sourceConfigGet({ ...pathCtx, name: "search-sources" }).data;
      const sourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
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
      });
    } catch (err) {
      if (sendDbError(res, err)) return;
      sendJson(res, 500, { error: err.message });
    }
  });
}
