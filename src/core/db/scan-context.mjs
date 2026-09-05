// scan-context.mjs — DB-derived scanner context for app/product search routes.
//
// This module intentionally reads SQLite JSON rows directly and does not import
// tracker storage adapters or generated-file helpers. Generated tracker exports
// remain compatibility artifacts; DB-mode scanner context comes from canonical
// applications[] and sourced[] rows.

import { addPostingIdentity, extractReqId } from "../scoring/sourced-identity.mjs";
import { requireDb } from "./connection.mjs";

const ROW_TABLES = new Set(["applications", "sourced"]);

function readDbRows(db, table) {
  if (!ROW_TABLES.has(table)) throw new Error(`unsupported scan-context table: ${table}`);
  return db
    .prepare(`SELECT data FROM ${table} ORDER BY rowid ASC`)
    .all()
    .map((row) => JSON.parse(row.data));
}

function normalizeTextKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeCompanyRoleKey(company, role) {
  return `${normalizeTextKey(company)}::${normalizeTextKey(role)}`;
}

function rowUrl(row = {}) {
  return row.link || row.url || "";
}

function addReqId(set, rawUrl) {
  const reqId = extractReqId(rawUrl).id;
  if (reqId) set.add(reqId);
}

function toTrackerApp(row = {}) {
  return {
    co: row.company,
    role: row.role,
    status: row.status,
    channel: row.channel,
    mode: row.mode,
    score: row.fitScore,
    link: rowUrl(row),
    date: row.appliedAt,
    loc: row.loc,
    base: row.base,
    tc: row.tc,
  };
}

function toTrackerSourced(row = {}) {
  return {
    co: row.company,
    role: row.role,
    status: row.status,
    score: row.fitScore,
    mode: row.mode,
    channel: row.channel,
    link: rowUrl(row),
    loc: row.loc,
    base: row.base,
    tc: row.tc,
    fitBucket: row.fitBucket,
  };
}

function addSeenRow(row, { seenUrls, seenReqIds, seenCompanyRoles }) {
  const link = row.link || "";
  if (link) {
    seenUrls.add(link);
    addReqId(seenReqIds, link);
  }
  if (row.co && row.role) seenCompanyRoles.add(normalizeCompanyRoleKey(row.co, row.role));
}

export function buildDbSeenSets({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  const rawApps = readDbRows(db, "applications");
  const rawSourced = readDbRows(db, "sourced");
  const apps = rawApps.map(toTrackerApp);
  const sourced = rawSourced.map(toTrackerSourced);
  const tracker = { apps, sourced };

  const seenUrls = new Set();
  const seenReqIds = new Set();
  const seenCompanyRoles = new Set();
  const seenPostingKeys = new Set();
  for (const row of [...apps, ...sourced]) {
    addSeenRow(row, { seenUrls, seenReqIds, seenCompanyRoles });
  }
  // seenPostingKeys is built from the RAW rows, not the toTrackerApp/
  // toTrackerSourced projections above: those projections only carry the
  // dashboard-display fields (co/role/link/...) and drop scanner.reqId /
  // aliasKeys, so a row with an explicit aggregator reqId (or a persisted
  // identity alias, see sourced-identity.mjs's aliasKeys) would silently
  // lose that identity here and only match by its bare URL (CR-29 round 3).
  for (const row of [...rawApps, ...rawSourced]) {
    addPostingIdentity(seenPostingKeys, row);
  }

  return { seenUrls, seenReqIds, seenCompanyRoles, seenPostingKeys, tracker };
}

export function readDbScannerRows({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  return readDbRows(db, "sourced");
}
