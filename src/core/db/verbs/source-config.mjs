// verbs/source-config.mjs — DB-owned search/source setup config.
//
// These are setup/config verbs, not tracker mutations: no tracker meta bump,
// no activity event, and no tracker export. Legacy config files are compatibility
// output only; DB-mode readers should load these rows first.

import { validatePublicHttpUrl } from "../../net/public-http-fetch.mjs";
import {
  addSearchFromUrl,
  canonicalSearchSourceUrl,
  normalizeSearchSourceConfig,
} from "../../providers/search-sources.mjs";
import { inferProvider, isCompanyProviderSupported } from "../../scoring/sourced-scanner.mjs";
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";

const CONFIG_NAMES = new Set(["search-sources", "sourced-scan"]);

const DEFAULTS = {
  "search-sources": {
    title_filter: { positive: [], negative: [] },
    location_filter: { always_allow: [], allow: [], block: [] },
    searches: [],
    tracked_companies: [],
    source_catalog: {},
  },
  "sourced-scan": {
    title_filter: { positive: [], negative: [] },
    location_filter: null,
    tracked_companies: [],
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertConfigName(name) {
  if (!CONFIG_NAMES.has(name)) {
    const err = new Error(`unknown source config "${name}"`);
    err.code = "NOT_FOUND";
    throw err;
  }
}

function readSourceConfig(db, name) {
  assertConfigName(name);
  const row = db.prepare("SELECT data FROM candidate_source_configs WHERE name = ?").get(name);
  const data = row ? JSON.parse(row.data) : clone(DEFAULTS[name]);
  return {
    name,
    stored: Boolean(row),
    data: name === "search-sources" ? normalizeSearchSourceConfig(data) : data,
  };
}

function putSourceConfig(db, name, data) {
  assertConfigName(name);
  const storedData = name === "search-sources" ? normalizeSearchSourceConfig(data) : data;
  db.prepare(
    `INSERT INTO candidate_source_configs (name, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
  ).run(name, JSON.stringify(storedData || clone(DEFAULTS[name])), new Date().toISOString());
}

function normalizeCompanyEntry(entry = {}) {
  const name = String(entry.name || "").trim();
  const careersUrl = String(entry.careers_url || entry.url || "").trim();
  if (!name || !careersUrl) {
    const err = new Error("company ATS entry requires name and careers_url");
    err.code = "BAD_REQUEST";
    throw err;
  }
  const requestedProvider = String(entry.provider || "")
    .trim()
    .toLowerCase();
  const provider = requestedProvider || inferProvider({ careers_url: careersUrl });
  if (requestedProvider && !isCompanyProviderSupported(requestedProvider)) {
    const err = new Error(`unsupported ATS provider: cannot scan with "${entry.provider}"`);
    err.code = "BAD_REQUEST";
    throw err;
  }
  if (!provider) {
    const err = new Error(`unsupported ATS host: cannot scan "${careersUrl}"`);
    err.code = "BAD_REQUEST";
    throw err;
  }
  return {
    name,
    careers_url: careersUrl,
    ...(requestedProvider ? { provider } : {}),
  };
}

function sameCompanyOrUrl(a, b) {
  return (
    String(a.name || "").toLowerCase() === String(b.name || "").toLowerCase() ||
    String(a.careers_url || "") === String(b.careers_url || "")
  );
}

export function sourceConfigGet({ repoRoot, env, name } = {}) {
  const db = requireDb({ repoRoot, env });
  return { ok: true, ...readSourceConfig(db, name) };
}

export function sourceConfigPut({ repoRoot, env, name, data } = {}) {
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    putSourceConfig(db, name, data);
    return { ok: true, ...readSourceConfig(db, name) };
  });
}

export function sourceConfigMutate({ repoRoot, env, name, mutate, guard } = {}) {
  if (typeof mutate !== "function") {
    const err = new Error("sourceConfigMutate requires a mutation function");
    err.code = "BAD_REQUEST";
    throw err;
  }
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    if (typeof guard === "function") guard(db);
    const current = readSourceConfig(db, name).data;
    const next = mutate(clone(current));
    putSourceConfig(db, name, next);
    return { ok: true, ...readSourceConfig(db, name) };
  });
}

// Pure-on-the-passed-db half of companyAtsUpsert (no transaction of its own)
// — the same "InDb" split refreshAnalyticsInDb uses, so a caller that already
// holds an open transaction (public-intel.mjs's publicIntelReviewDecision)
// can compose this in without a nested BEGIN IMMEDIATE, which node:sqlite
// rejects. companyAtsUpsert below is the standalone verb for callers that
// don't already have a transaction open.
export function companyAtsUpsertInDb(db, entry) {
  const normalized = normalizeCompanyEntry(entry);
  const current = readSourceConfig(db, "sourced-scan").data;
  const companies = Array.isArray(current.tracked_companies)
    ? current.tracked_companies.slice()
    : [];
  const index = companies.findIndex((company) => sameCompanyOrUrl(company, normalized));

  let status = "added";
  if (index === -1) {
    companies.push(normalized);
  } else {
    const existing = companies[index];
    const sameName =
      String(existing.name || "").toLowerCase() === String(normalized.name || "").toLowerCase();
    const sameUrl = String(existing.careers_url || "") === String(normalized.careers_url || "");
    if (sameName && sameUrl) {
      status = "already-tracked";
    } else {
      companies[index] = normalized;
      status = "updated";
    }
  }

  const next = { ...current, tracked_companies: companies };
  putSourceConfig(db, "sourced-scan", next);
  return {
    ok: true,
    status,
    entry: index === -1 ? normalized : companies[index],
    total: companies.length,
    data: readSourceConfig(db, "sourced-scan").data,
  };
}

export function companyAtsUpsert({ repoRoot, env, entry } = {}) {
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => companyAtsUpsertInDb(db, entry));
}

export function publicSearchSourceUpsert({ repoRoot, env, entry } = {}) {
  const name = String(entry?.name || entry?.label || "").trim();
  const checked = validatePublicHttpUrl(entry?.url || entry?.careers_url);
  if (!name) {
    const error = new Error("public search source requires a name");
    error.code = "BAD_REQUEST";
    throw error;
  }
  if (!checked.ok) {
    const error = new Error(`public search source URL is unsafe: ${checked.reason}`);
    error.code = "UNSAFE_COMPANY_BOARD_URL";
    throw error;
  }

  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = readSourceConfig(db, "search-sources").data;
    const next = addSearchFromUrl(current, checked.url, {
      label: name,
      sourceType: "browser",
    });
    const status = next === current ? "already-tracked" : "added";
    if (status === "added") putSourceConfig(db, "search-sources", next);
    const stored = readSourceConfig(db, "search-sources").data;
    const canonicalTarget = canonicalSearchSourceUrl(checked.url);
    const source = stored.searches.find(
      (candidate) => canonicalSearchSourceUrl(candidate.url) === canonicalTarget
    );
    return {
      ok: true,
      status,
      entry: source,
      total: stored.searches.length,
      data: stored,
    };
  });
}

export function companyAtsRemove({ repoRoot, env, name } = {}) {
  const target = String(name || "")
    .trim()
    .toLowerCase();
  if (!target) {
    const err = new Error("company name is required");
    err.code = "BAD_REQUEST";
    throw err;
  }
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = readSourceConfig(db, "sourced-scan").data;
    const companies = Array.isArray(current.tracked_companies)
      ? current.tracked_companies.slice()
      : [];
    const match = companies.find((entry) => String(entry.name || "").toLowerCase() === target);
    if (!match) {
      return { ok: true, status: "not-found", name, total: companies.length, data: current };
    }
    const nextCompanies = companies.filter((entry) => entry !== match);
    const next = { ...current, tracked_companies: nextCompanies };
    putSourceConfig(db, "sourced-scan", next);
    return {
      ok: true,
      status: "removed",
      name: match.name,
      total: nextCompanies.length,
      data: readSourceConfig(db, "sourced-scan").data,
    };
  });
}
