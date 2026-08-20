// verbs/source-config.mjs — DB-owned search/source setup config.
//
// These are setup/config verbs, not tracker mutations: no tracker meta bump,
// no activity event, and no tracker export. Legacy config files are compatibility
// output only; DB-mode readers should load these rows first.
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
  return {
    name,
    stored: Boolean(row),
    data: row ? JSON.parse(row.data) : clone(DEFAULTS[name]),
  };
}

function putSourceConfig(db, name, data) {
  assertConfigName(name);
  db.prepare(
    `INSERT INTO candidate_source_configs (name, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
  ).run(name, JSON.stringify(data || clone(DEFAULTS[name])), new Date().toISOString());
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

export function companyAtsUpsert({ repoRoot, env, entry } = {}) {
  const normalized = normalizeCompanyEntry(entry);
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
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
