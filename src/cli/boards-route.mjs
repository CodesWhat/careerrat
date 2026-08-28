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
  addProviderSource,
  addSearchFromQuery,
  addSearchFromUrl,
  canonicalSearchSourceUrl,
  listSearches,
  validateConfig,
} from "../core/providers/search-sources.mjs";
import {
  inferProvider,
  isBoardProviderSupported,
  isCompanyProviderSupported,
} from "../core/scoring/sourced-scanner.mjs";
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

function humanizeCompanySlug(value) {
  return decodeURIComponent(String(value || ""))
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function resolvedBoardLabel(url, label) {
  const provided = String(label || "").trim();
  if (!provided) return undefined;

  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^www\./, "");
  if (provided.replace(/^www\./, "").toLowerCase() !== hostname.toLowerCase()) return provided;

  const provider = inferProvider({ careers_url: parsed.toString() });
  if (!provider || !isCompanyProviderSupported(provider)) return provided;

  const companySlug = parsed.pathname.split("/").filter(Boolean)[0];
  return companySlug ? humanizeCompanySlug(companySlug) : provided;
}

function readIndex(body, length) {
  const index = Number(body?.index);
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    badRequest(`source index must be between 0 and ${Math.max(0, length - 1)}`);
  }
  return index;
}

function searchLegitimacy(search) {
  if (search?.auth === true) return search?.enabled === false ? "login-needed" : "supported";
  if (search?.source_type === "rss" || search?.rssUrl) return "supported";
  if (["ats", "board"].includes(search?.source_type) && isBoardProviderSupported(search.provider)) {
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

export function addBoardSource({ repoRoot, env = process.env, url, label } = {}) {
  const pathCtx = { repoRoot, env };
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) badRequest("body.url is required");
  let canonicalUrl;
  try {
    canonicalUrl = new URL(normalizedUrl).toString();
  } catch {
    badRequest(`addSearchFromUrl: unparseable URL: ${normalizedUrl}`);
  }

  const current = readDbSearchSources(pathCtx);
  const currentSearches = listSearches(current);
  const existing = currentSearches.find((source) => {
    try {
      return new URL(source.target).toString() === canonicalUrl;
    } catch {
      return false;
    }
  });
  if (existing) {
    return {
      added: false,
      source: {
        ...existing,
        sourceType: existing.source_type,
        auth: existing.auth === true,
      },
      searches: currentSearches,
    };
  }
  const next = addSearchFromUrl(current, normalizedUrl, {
    label: resolvedBoardLabel(canonicalUrl, label),
  });
  const schema = JSON.parse(readFileSync(join(repoRoot, SEARCH_SOURCES_SCHEMA_PATH), "utf8"));
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
  const stored = writeDbSearchSources(pathCtx, next);
  const searches = listSearches(stored);
  const addedSource = searches.at(-1);
  return {
    added: true,
    source: addedSource
      ? {
          ...addedSource,
          sourceType: addedSource.source_type,
          auth: addedSource.auth === true,
        }
      : null,
    searches,
  };
}

export function addSearchSourceQuery({
  repoRoot,
  env = process.env,
  query,
  provider = "HiringCafe",
  label,
} = {}) {
  const pathCtx = { repoRoot, env };
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) badRequest("body.query is required");
  const normalizedProvider = String(provider || "HiringCafe").trim() || "HiringCafe";
  const current = readDbSearchSources(pathCtx);
  const currentModel = maintenanceView(pathCtx);
  const existing = currentModel.searches.find(
    (entry) =>
      String(entry.provider || "").toLowerCase() === normalizedProvider.toLowerCase() &&
      String(entry.target || "").toLowerCase() === normalizedQuery.toLowerCase()
  );
  if (existing) return { added: false, source: existing, model: currentModel };
  const sourceOptions = {
    query: normalizedQuery,
    label: String(label || "").trim() || undefined,
    provider: normalizedProvider,
  };
  const next =
    normalizedProvider.toLowerCase() === "hiringcafe"
      ? addSearchFromQuery(current, sourceOptions)
      : addProviderSource(current, sourceOptions);
  const added = next !== current;
  const model = added ? validateAndWriteSearchConfig(pathCtx, next) : currentModel;
  const source = model.searches.find(
    (entry) =>
      String(entry.provider || "").toLowerCase() === normalizedProvider.toLowerCase() &&
      String(entry.target || "").toLowerCase() === normalizedQuery.toLowerCase()
  );
  return { added, source: source || null, model };
}

function sourceSelectorKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function sourceSelectorTiers(source) {
  const tiers = [source.label, source.provider, source.platform].map(
    (value) => new Set([sourceSelectorKey(value)].filter(Boolean))
  );
  const hostKeys = [];
  try {
    const host = new URL(source.target).hostname.replace(/^www\./, "");
    hostKeys.push(sourceSelectorKey(host), sourceSelectorKey(host.split(".")[0]));
  } catch {
    // Query-only sources have no URL-derived selector.
  }
  tiers.push(new Set(hostKeys.filter(Boolean)));
  return tiers;
}

export function setSearchSourceEnabled({
  repoRoot,
  env = process.env,
  selector,
  sourceUrl,
  enabled,
} = {}) {
  const pathCtx = { repoRoot, env };
  const normalizedSelector = sourceSelectorKey(selector);
  if (!normalizedSelector) badRequest("source selector is required");
  if (typeof enabled !== "boolean") badRequest("source enabled state must be boolean");
  const current = readDbSearchSources(pathCtx);
  const model = maintenanceView(pathCtx);
  let matches = [];
  const canonicalUrl = sourceUrl == null ? "" : canonicalSearchSourceUrl(sourceUrl);
  if (sourceUrl != null) {
    if (!canonicalUrl) badRequest("source URL is invalid");
    matches = model.searches.filter(
      (source) => canonicalSearchSourceUrl(source.target) === canonicalUrl
    );
    if (!matches.length) {
      badRequest("That saved search source no longer matches the login question.");
    }
  } else {
    for (let tier = 0; tier < 4; tier += 1) {
      matches = model.searches.filter((source) =>
        sourceSelectorTiers(source)[tier].has(normalizedSelector)
      );
      if (matches.length) break;
    }
  }
  if (!matches.length) badRequest(`No search source matches "${selector}"`);
  if (matches.length > 1) {
    badRequest(
      `More than one search source matches "${selector}": ${matches
        .map((source) => source.label)
        .join(", ")}`
    );
  }
  const match = matches[0];
  const searches = Array.isArray(current.searches) ? current.searches.slice() : [];
  const existing = searches[match.index];
  const { enabled_reason: _generatedEnabledReason, ...userOwned } = existing;
  const changed = existing.enabled !== enabled || existing.enabled_reason != null;
  searches[match.index] = { ...userOwned, enabled };
  const nextModel = changed
    ? validateAndWriteSearchConfig(pathCtx, { ...current, searches })
    : model;
  return {
    changed,
    source: nextModel.searches.find((source) => source.index === match.index) || null,
    model: nextModel,
  };
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

    try {
      const operation = addBoardSource({ repoRoot, env, url, label });
      sendJson(res, 200, { ok: true, searches: operation.searches });
    } catch (err) {
      sendSourceConfigError(res, err);
    }
  });

  addRoute("POST", "/api/boards/search/add", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      const query = String(body?.query || "").trim();
      if (!query) badRequest("body.query is required");
      const provider = String(body?.provider || "HiringCafe").trim() || "HiringCafe";
      const operation = addSearchSourceQuery({
        repoRoot,
        env,
        query,
        label: String(body?.label || "").trim() || undefined,
        provider,
      });
      sendJson(res, 200, { ok: true, ...operation.model });
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
      if (existing.source_type === "ats") updated.name = label;
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
      const requestedProvider = String(body?.provider || "")
        .trim()
        .toLowerCase();
      if (requestedProvider && !isCompanyProviderSupported(requestedProvider)) {
        badRequest(`unsupported ATS provider: cannot scan with "${body.provider}"`);
      }
      const provider = requestedProvider || inferProvider({ careers_url: url });
      if (!provider) badRequest(`unsupported ATS host: cannot scan "${url}"`);
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
        ...(requestedProvider ? { provider } : {}),
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
