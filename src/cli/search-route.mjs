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
//                              DB source config (DB mode) or legacy source
//                              files (legacy mode) are not configured yet.
//   GET  /api/search/results   The newest workspace/scan-results/sourced-*.json
//                              (by mtime, so it works regardless of whether
//                              the file used --timestamped naming), or
//                              ?date=YYYY-MM-DD for a specific day. 404 if
//                              none exist yet.
//   GET  /api/search/sources   {searches:{enabled,total}, trackedCompanies}
//                              — the presence/health strip
//                              src/core/onboarding/search-page.mjs's header
//                              renders on load.
//
// `fetchImpl` is dependency-injected (defaults to the real global `fetch`)
// the same way `runSkillStream` is in skill-run-route.mjs, so tests can drive
// a scan against a stub network instead of hitting real ATS APIs.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runSourcedScan } from "../../scripts/scan-sourced.mjs";
import { dbExists } from "../core/db/connection.mjs";
import { sourceConfigGet } from "../core/db/verbs/source-config.mjs";
import { userPath } from "../core/paths/workspace.mjs";
import { parseYaml } from "../core/profile/yaml.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB — same cap the other route modules use.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function queryParam(req, name) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams.get(name);
}

// Newest sourced-*.json in workspace/scan-results by mtime — not filename
// sort: a --timestamped run's filename ("sourced-20260703-153045.json") and a
// plain run's ("sourced-2026-07-03.json") don't compare consistently as
// strings, but mtime always reflects "most recently written" correctly.
function findLatestScanFile(scanResultsDir) {
  let entries;
  try {
    entries = readdirSync(scanResultsDir);
  } catch {
    return null;
  }
  const files = entries
    .filter((name) => /^sourced-.+\.json$/.test(name))
    .map((name) => ({ name, mtimeMs: statSync(join(scanResultsDir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.name || null;
}

function readScanFile(scanResultsDir, fileName) {
  return JSON.parse(readFileSync(join(scanResultsDir, fileName), "utf8"));
}

function hasConfiguredDbSources(pathCtx) {
  if (!dbExists(pathCtx)) return false;
  const sourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
  const searchSources = sourceConfigGet({ ...pathCtx, name: "search-sources" }).data;
  return Boolean(
    (Array.isArray(sourcedScan.tracked_companies) && sourcedScan.tracked_companies.length > 0) ||
      (Array.isArray(searchSources.searches) && searchSources.searches.length > 0)
  );
}

function hasRunnableSearchConfig(pathCtx) {
  if (dbExists(pathCtx)) return hasConfiguredDbSources(pathCtx);
  return (
    existsSync(userPath(pathCtx, "config/search-sources.yml")) ||
    existsSync(userPath(pathCtx, "config/sourced-scan.json"))
  );
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

    if (!hasRunnableSearchConfig(pathCtx)) {
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
      sendJson(res, 500, { error: err.message });
    } finally {
      scanning = false;
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/search/results — ?date=YYYY-MM-DD optional
  // -------------------------------------------------------------------------
  addRoute("GET", "/api/search/results", (req, res) => {
    const scanResultsDir = userPath(pathCtx, "workspace/scan-results");
    const dateParam = queryParam(req, "date");

    if (dateParam) {
      if (!DATE_RE.test(dateParam)) {
        sendJson(res, 400, { error: "date must be YYYY-MM-DD" });
        return;
      }
      const fileName = `sourced-${dateParam}.json`;
      if (!existsSync(join(scanResultsDir, fileName))) {
        sendJson(res, 404, { error: `no scan results for ${dateParam}` });
        return;
      }
      try {
        sendJson(res, 200, { date: dateParam, ...readScanFile(scanResultsDir, fileName) });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    const latest = findLatestScanFile(scanResultsDir);
    if (!latest) {
      sendJson(res, 404, { error: "no scan results yet — run a sweep first" });
      return;
    }
    try {
      const date = latest.replace(/^sourced-/, "").replace(/\.json$/, "");
      sendJson(res, 200, { date, ...readScanFile(scanResultsDir, latest) });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/search/sources
  // -------------------------------------------------------------------------
  addRoute("GET", "/api/search/sources", (_req, res) => {
    if (dbExists(pathCtx)) {
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
      return;
    }

    const searchSourcesPath = userPath(pathCtx, "config/search-sources.yml");
    let searches = { enabled: 0, total: 0 };
    if (existsSync(searchSourcesPath)) {
      try {
        const doc = parseYaml(readFileSync(searchSourcesPath, "utf8")) || {};
        const list = Array.isArray(doc.searches) ? doc.searches : [];
        searches = {
          enabled: list.filter((s) => s && s.enabled !== false).length,
          total: list.length,
        };
      } catch {
        // keep the zeroed default — a malformed config shouldn't 500 the strip
      }
    }

    let trackedCompanies = 0;
    const sourcedScanPath = userPath(pathCtx, "config/sourced-scan.json");
    if (existsSync(sourcedScanPath)) {
      try {
        const doc = JSON.parse(readFileSync(sourcedScanPath, "utf8"));
        trackedCompanies = Array.isArray(doc.tracked_companies) ? doc.tracked_companies.length : 0;
      } catch {
        // keep zero
      }
    }

    sendJson(res, 200, { searches, trackedCompanies });
  });
}
