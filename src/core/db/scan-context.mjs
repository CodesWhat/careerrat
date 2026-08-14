// scan-context.mjs — DB-derived scanner context for app/product search routes.
//
// This module intentionally reads SQLite JSON rows directly and does not import
// tracker storage adapters or generated-file helpers. Generated tracker exports
// remain compatibility artifacts; DB-mode scanner context comes from canonical
// applications[] and sourced[] rows.
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
  const reqId = extractReqId(rawUrl);
  if (reqId) set.add(reqId);
}

function extractReqId(rawUrl = "") {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname;
    const greenhouse = path.match(/\/jobs\/(\d+)/);
    if (greenhouse) return `greenhouse:${greenhouse[1]}`;
    const ashby = path.match(/\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/|$)/i);
    if (ashby) return `ashby:${ashby[1].toLowerCase()}`;
    const lever = path.match(/\/([^/]+)$/);
    if (url.hostname === "jobs.lever.co" && lever) return `lever:${lever[1].toLowerCase()}`;
    const apple = path.match(/\/details\/([0-9-]+)/);
    if ((url.hostname === "apple.com" || url.hostname.endsWith(".apple.com")) && apple)
      return `apple:${apple[1]}`;
    const hiringCafe = path.match(/\/job\/([a-z0-9_-]+)/i);
    if (url.hostname === "hiring.cafe" && hiringCafe)
      return `hiringcafe:${hiringCafe[1].toLowerCase()}`;
    const linkedIn = path.match(/\/jobs\/view\/(\d+)/);
    if ((url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) && linkedIn)
      return `linkedin:${linkedIn[1]}`;
  } catch {
    return null;
  }
  return null;
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
  const apps = readDbRows(db, "applications").map(toTrackerApp);
  const sourced = readDbRows(db, "sourced").map(toTrackerSourced);
  const tracker = { apps, sourced };

  const seenUrls = new Set();
  const seenReqIds = new Set();
  const seenCompanyRoles = new Set();
  for (const row of [...apps, ...sourced]) {
    addSeenRow(row, { seenUrls, seenReqIds, seenCompanyRoles });
  }

  return { seenUrls, seenReqIds, seenCompanyRoles, tracker };
}

export function readDbScannerRows({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  return readDbRows(db, "sourced");
}
