import { existsSync, readFileSync } from "node:fs";
import { dbExists, requireDb } from "../db/connection.mjs";
import { candidateConfigGet, sourceConfigGet } from "../db/verbs.mjs";
import { userPath } from "../paths/workspace.mjs";
import { loadCandidateConfig } from "../profile/config-store.mjs";
import { loadScannerConfig } from "../scoring/sourced-scanner.mjs";

function trimString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function compactStrings(values) {
  const output = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = trimString(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
  return output;
}

function compactNames(rows) {
  return compactStrings(
    (Array.isArray(rows) ? rows : [])
      .map((row) => (typeof row === "string" ? row : row?.name || row?.company))
      .filter(Boolean)
  );
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roleFamiliesFromTargeting(targeting = {}) {
  return (Array.isArray(targeting.role_buckets) ? targeting.role_buckets : [])
    .map((bucket) => ({
      name: trimString(bucket?.name),
      priority: trimString(bucket?.priority),
      titles: compactStrings(bucket?.titles),
    }))
    .filter((bucket) => bucket.name || bucket.titles.length);
}

function locationPostureFromProfile(profile = {}) {
  const location = profile.location || {};
  return {
    home: trimString(location.home || profile.candidate?.location),
    remote: location.remote === true,
    hybrid: location.hybrid === true,
    onsite: location.onsite === true,
    relocation: compactStrings(location.relocation),
  };
}

function compensationFloorsFromProfile(profile = {}) {
  const compensation = profile.compensation || {};
  const output = {};
  const currency = trimString(compensation.currency);
  const minimumBase = finiteNumber(compensation.minimum_base);
  const oeMinBase = finiteNumber(compensation.oe_min_base);
  if (currency) output.currency = currency;
  if (minimumBase !== null) output.minimum_base = minimumBase;
  if (oeMinBase !== null) output.oe_min_base = oeMinBase;
  return output;
}

function companyPreferencesFromTargeting(targeting = {}) {
  const input = targeting.company_preferences || {};
  const output = {};
  if (input.confirmed === true) output.confirmed = true;
  for (const key of [
    "industries",
    "organization_types",
    "sizes",
    "stages",
    "business_models",
    "values",
    "geographies",
    "examples",
  ]) {
    const values = compactStrings(input[key]);
    if (values.length) output[key] = values;
  }
  return output;
}

function readDbRows({ repoRoot, env }, table) {
  const db = requireDb({ repoRoot, env });
  return db
    .prepare(`SELECT data FROM ${table} ORDER BY rowid ASC`)
    .all()
    .map((row) => JSON.parse(row.data));
}

function readLegacyTrackerRows({ repoRoot, env }, key) {
  const trackerPath = userPath({ repoRoot, env }, "workspace/tracker.json");
  if (!existsSync(trackerPath)) return [];
  try {
    const tracker = JSON.parse(readFileSync(trackerPath, "utf8"));
    return Array.isArray(tracker?.[key]) ? tracker[key] : [];
  } catch {
    return [];
  }
}

function readDbSourceCompanies(pathCtx) {
  try {
    return compactNames(
      sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data.tracked_companies
    );
  } catch {
    return [];
  }
}

function readLegacySourceCompanies(pathCtx) {
  try {
    return compactNames(
      loadScannerConfig(userPath(pathCtx, "config/sourced-scan.json")).tracked_companies
    );
  } catch {
    return [];
  }
}

function normalizeCompanyKey(value) {
  return trimString(value)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildCompanySeedContext({ repoRoot, env = process.env } = {}) {
  const pathCtx = { repoRoot, env };
  const usingDb = dbExists(pathCtx);
  const candidateConfig = usingDb
    ? candidateConfigGet(pathCtx)
    : loadCandidateConfig({ repoRoot, env, fallbackToTemplate: false });
  const profile = candidateConfig.profile || {};
  const targeting = candidateConfig.targeting || {};
  const sourceCompanies = usingDb
    ? readDbSourceCompanies(pathCtx)
    : readLegacySourceCompanies(pathCtx);
  const applicationRows = usingDb
    ? readDbRows(pathCtx, "applications")
    : readLegacyTrackerRows(pathCtx, "applications");
  const sourcedRows = usingDb
    ? readDbRows(pathCtx, "sourced")
    : readLegacyTrackerRows(pathCtx, "sourced");

  const trackedCompanies = compactStrings([
    ...sourceCompanies,
    ...compactNames(targeting.tracked_companies),
  ]);
  const applications = compactNames(applicationRows);
  const sourcedCompanies = compactNames(sourcedRows);
  const excludedCompanies = compactNames(targeting.excluded_companies);
  const dedupeCompanies = compactStrings([
    ...trackedCompanies,
    ...applications,
    ...sourcedCompanies,
    ...excludedCompanies,
  ]);

  return {
    profileDomain: trimString(profile.candidate?.domain || profile.candidate?.headline),
    roleFamilies: roleFamiliesFromTargeting(targeting),
    locationPosture: locationPostureFromProfile(profile),
    keepSignals: compactStrings(targeting.keep_signals),
    cutSignals: compactStrings(targeting.cut_signals),
    companyPreferences: companyPreferencesFromTargeting(targeting),
    excludedCompanies,
    trackedCompanies,
    applications,
    sourcedCompanies,
    compensationFloors: compensationFloorsFromProfile(profile),
    dedupe: {
      companies: dedupeCompanies,
      keys: compactStrings(dedupeCompanies.map(normalizeCompanyKey)),
    },
  };
}
