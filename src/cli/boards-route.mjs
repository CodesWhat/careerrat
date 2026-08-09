// boards-route.mjs — additive M8 backend route BUILDER B (wizard UI) had to
// add: the frozen M8 contract's Targeting-step "board URL preview" and
// Companies/Finish-step "add LinkedIn saved search" affordances have no
// server surface without it — src/core/providers/hiringcafe.mjs's
// buildHiringCafeUrl() and linkedin.mjs's buildLinkedInSearchUrl() are pure
// server-side ES modules, unreachable from the browser bundle, and
// search-sources.mjs's addSearchFromUrl() has no HTTP caller anywhere
// (src/cli/searches.mjs is a CLI, not a route). The M8 design doc
// (scratchpad/m8-design-deep-reasoner.md §5) named this exact route
// (`src/cli/boards-route.mjs: POST /api/boards/preview` /
// `POST /api/boards/add`) but it was not in Builder A's committed frozen
// contract/deliverables — this is the smallest additive change that makes
// the wizard's board-preview step possible at all. Split out the same way
// every other M8 route module is: `addRoute` is the mount point, `sendJson`/
// `readJsonBodyCapped` are imported from skill-run-route.mjs rather than
// duplicated.
//
// mountBoardsRoutes({addRoute, repoRoot, env}) registers:
//
//   POST /api/boards/preview   { keywords, location?, remote?, minimumBase?,
//                                windowHours? } -> 200 { hiringCafe, linkedin }
//                              Deterministic, no persistence — both builders
//                              are pure functions; either side degrades to
//                              null + an `*Error` string if its own inputs
//                              don't satisfy that builder (never a 500 for a
//                              partial preview).
//   POST /api/boards/add      { url, label? } -> 200 { ok:true, searches }
//                              Reads DB source config, calls the EXISTING
//                              addSearchFromUrl (search-sources.mjs) — same
//                              platform/auth/enabled:false gating every other
//                              pasted-URL source already gets — validates
//                              against config/search-sources.schema.json, and
//                              persists through DB source-config verbs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceConfigGet, sourceConfigPut } from "../core/db/verbs/source-config.mjs";
import { buildHiringCafeUrl } from "../core/providers/hiringcafe.mjs";
import { buildLinkedInSearchUrl, salaryBandForMinimumBase } from "../core/providers/linkedin.mjs";
import {
  addSearchFromQuery,
  addSearchFromUrl,
  listSearches,
  validateConfig,
} from "../core/providers/search-sources.mjs";
import { inferProvider, isBoardProviderSupported } from "../core/scoring/sourced-scanner.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB — same cap the other M8 route modules use.
const SEARCH_SOURCES_CONFIG_NAME = "search-sources";
const SEARCH_SOURCES_SCHEMA_PATH = "config/search-sources.schema.json";

export function readDbSearchSources(pathCtx = {}) {
  return sourceConfigGet({ ...pathCtx, name: SEARCH_SOURCES_CONFIG_NAME }).data;
}

export function writeDbSearchSources(pathCtx = {}, next) {
  return sourceConfigPut({ ...pathCtx, name: SEARCH_SOURCES_CONFIG_NAME, data: next }).data;
}

function sendSourceConfigError(res, err) {
  const status = err?.code === "NO_DATABASE" ? 409 : err?.code === "BAD_REQUEST" ? 400 : 500;
  sendJson(res, status, { ok: false, error: err?.message || "source config failed" });
}

function badRequest(message) {
  const error = new Error(message);
  error.code = "BAD_REQUEST";
  throw error;
}

function readIndex(body, length) {
  const index = Number(body?.index);
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    badRequest(`source index must be between 0 and ${Math.max(0, length - 1)}`);
  }
  return index;
}

function searchLegitimacy(search) {
  if (search?.auth === true) return "consent-required";
  if (search?.source_type === "rss" || search?.rssUrl) return "supported";
  if (search?.source_type === "board" && isBoardProviderSupported(search.provider)) {
    return "supported";
  }
  if (["HiringCafe", "Lever"].includes(String(search?.provider || ""))) return "supported";
  return "review-needed";
}

function maintenanceView(pathCtx) {
  const searchConfig = readDbSearchSources(pathCtx);
  const companyConfig = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
  return {
    searches: listSearches(searchConfig).map((search) => ({
      index: search.index,
      provider: search.provider || "unknown",
      label: search.label || "Untitled source",
      target: search.target || "",
      sourceType: search.source_type || "unknown",
      enabled: search.enabled !== false,
      lastRunAt: search.lastRunAt || null,
      legitimacy: searchLegitimacy({
        ...(searchConfig.searches?.[search.index] || {}),
        ...search,
      }),
      auth: search.auth === true,
      platform: search.platform || null,
    })),
    companies: (companyConfig.tracked_companies || []).map((company, index) => ({
      index,
      name: company.name,
      url: company.careers_url,
      provider: inferProvider(company) || "unsupported",
      enabled: company.enabled !== false,
      lastRunAt: company.lastRunAt || null,
      legitimacy: inferProvider(company) ? "verified-ats" : "unsupported",
    })),
  };
}

function validateAndWriteSearchConfig(pathCtx, next) {
  const schema = JSON.parse(
    readFileSync(join(pathCtx.repoRoot, SEARCH_SOURCES_SCHEMA_PATH), "utf8")
  );
  const { valid, errors } = validateConfig(next, schema);
  if (!valid) {
    const error = new Error(
      errors
        .map((item) => item.message)
        .filter(Boolean)
        .join("; ") || "Invalid source config"
    );
    error.code = "BAD_REQUEST";
    throw error;
  }
  writeDbSearchSources(pathCtx, next);
  return maintenanceView(pathCtx);
}

export function mountBoardsRoutes({ addRoute, repoRoot, env = process.env }) {
  const pathCtx = { repoRoot, env };

  addRoute("GET", "/api/boards/sources", (_req, res) => {
    try {
      sendJson(res, 200, maintenanceView(pathCtx));
    } catch (err) {
      sendSourceConfigError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/boards/preview
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/boards/preview", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    const keywords = String(body?.keywords || "").trim();
    if (!keywords) {
      sendJson(res, 400, { error: "body.keywords is required" });
      return;
    }
    const location = body?.location ? String(body.location) : null;
    const remote = !!body?.remote;
    const windowHours =
      body?.windowHours !== undefined && body?.windowHours !== null
        ? Number(body.windowHours)
        : null;
    const minimumBase =
      body?.minimumBase !== undefined && body?.minimumBase !== null
        ? Number(body.minimumBase)
        : null;

    const result = {};

    try {
      result.hiringCafe = buildHiringCafeUrl({ query: keywords, windowHours });
    } catch (err) {
      result.hiringCafe = null;
      result.hiringCafeError = err.message;
    }

    try {
      result.linkedin = {
        url: buildLinkedInSearchUrl({
          keywords,
          location,
          remote,
          salaryBand: salaryBandForMinimumBase(minimumBase),
          postedWithin: windowHours,
        }),
      };
    } catch (err) {
      result.linkedin = null;
      result.linkedinError = err.message;
    }

    sendJson(res, 200, result);
  });

  // -------------------------------------------------------------------------
  // POST /api/boards/add
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/boards/add", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    const url = String(body?.url || "").trim();
    if (!url) {
      sendJson(res, 400, { error: "body.url is required" });
      return;
    }
    const label = body?.label ? String(body.label) : undefined;

    try {
      new URL(url);
    } catch {
      sendJson(res, 400, { error: `addSearchFromUrl: unparseable URL: ${url}` });
      return;
    }

    let current;
    try {
      current = readDbSearchSources(pathCtx);
    } catch (err) {
      sendSourceConfigError(res, err);
      return;
    }

    let next;
    try {
      next = addSearchFromUrl(current, url, { label });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }

    const schema = JSON.parse(readFileSync(join(repoRoot, SEARCH_SOURCES_SCHEMA_PATH), "utf8"));
    const { valid, errors } = validateConfig(next, schema);
    if (!valid) {
      sendJson(res, 400, { ok: false, errors });
      return;
    }

    let stored;
    try {
      stored = writeDbSearchSources(pathCtx, next);
    } catch (err) {
      sendSourceConfigError(res, err);
      return;
    }

    sendJson(res, 200, { ok: true, searches: listSearches(stored) });
  });

  addRoute("POST", "/api/boards/search/add", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      const query = String(body?.query || "").trim();
      if (!query) badRequest("body.query is required");
      const current = readDbSearchSources(pathCtx);
      const next = addSearchFromQuery(current, {
        query,
        label: String(body?.label || "").trim() || undefined,
        provider: String(body?.provider || "HiringCafe").trim() || "HiringCafe",
      });
      sendJson(res, 200, { ok: true, ...validateAndWriteSearchConfig(pathCtx, next) });
    } catch (err) {
      sendSourceConfigError(res, err);
    }
  });

  addRoute("POST", "/api/boards/search/update", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      const current = readDbSearchSources(pathCtx);
      const searches = Array.isArray(current.searches) ? current.searches.slice() : [];
      const index = readIndex(body, searches.length);
      const existing = searches[index];
      const label = String(body?.label ?? existing.label ?? "").trim();
      const target = String(
        body?.target ?? existing.query ?? existing.url ?? existing.rssUrl ?? ""
      ).trim();
      if (!label || !target) badRequest("source label and target are required");
      // A Settings save is an explicit user decision. Generated baseline
      // entries carry `enabled_reason: "domain-gate"`, which lets first-search
      // preparation re-evaluate their default on/off state as targeting
      // changes. Leaving that marker behind would make the next search undo
      // the user's toggle. Transfer ownership to the user on every explicit
      // save by removing the generator marker before persisting.
      const { enabled_reason: _generatedEnabledReason, ...userOwnedExisting } = existing;
      const updated = { ...userOwnedExisting, label, enabled: body?.enabled !== false };
      if (existing.rssUrl != null) updated.rssUrl = target;
      else if (existing.query != null) updated.query = target;
      else updated.url = target;
      searches[index] = updated;
      sendJson(res, 200, {
        ok: true,
        ...validateAndWriteSearchConfig(pathCtx, { ...current, searches }),
      });
    } catch (err) {
      sendSourceConfigError(res, err);
    }
  });

  addRoute("POST", "/api/boards/search/remove", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      const current = readDbSearchSources(pathCtx);
      const searches = Array.isArray(current.searches) ? current.searches.slice() : [];
      const index = readIndex(body, searches.length);
      searches.splice(index, 1);
      sendJson(res, 200, {
        ok: true,
        ...validateAndWriteSearchConfig(pathCtx, { ...current, searches }),
      });
    } catch (err) {
      sendSourceConfigError(res, err);
    }
  });

  addRoute("POST", "/api/boards/company/save", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      const name = String(body?.name || "").trim();
      const url = String(body?.url || "").trim();
      if (!name || !url) badRequest("company name and board URL are required");
      const provider = inferProvider({ careers_url: url });
      if (!provider) badRequest(`unsupported ATS host — cannot scan "${url}"`);
      const current = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
      const companies = Array.isArray(current.tracked_companies)
        ? current.tracked_companies.slice()
        : [];
      const originalName = String(body?.originalName || name)
        .trim()
        .toLowerCase();
      const index = companies.findIndex(
        (item) =>
          String(item?.name || "")
            .trim()
            .toLowerCase() === originalName || String(item?.careers_url || "") === url
      );
      const previous = index >= 0 ? companies[index] : {};
      const entry = {
        ...previous,
        name,
        careers_url: url,
        enabled: body?.enabled !== false,
      };
      if (index >= 0) companies[index] = entry;
      else companies.push(entry);
      sourceConfigPut({
        ...pathCtx,
        name: "sourced-scan",
        data: { ...current, tracked_companies: companies },
      });
      sendJson(res, 200, { ok: true, ...maintenanceView(pathCtx) });
    } catch (err) {
      sendSourceConfigError(res, err);
    }
  });

  addRoute("POST", "/api/boards/company/remove", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      const name = String(body?.name || "").trim();
      if (!name) badRequest("company name is required");
      const current = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
      const companies = (current.tracked_companies || []).filter(
        (item) =>
          String(item?.name || "")
            .trim()
            .toLowerCase() !== name.toLowerCase()
      );
      sourceConfigPut({
        ...pathCtx,
        name: "sourced-scan",
        data: { ...current, tracked_companies: companies },
      });
      sendJson(res, 200, { ok: true, ...maintenanceView(pathCtx) });
    } catch (err) {
      sendSourceConfigError(res, err);
    }
  });
}
