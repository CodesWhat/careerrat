import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { userPath } from "../paths/workspace.mjs";
import { isKnownStatusLabel } from "./dashboard.mjs";

// Canonical application-status vocabulary — the normalization target set used by
// the automation status-map (sync-status normalizes raw ATS labels into one of
// these before handing transitions to track-outcomes). The integrity validator no
// longer exact-matches against this set: the tracker preserves the candidate's raw
// status label by design, and the dashboard's classifyStage() keyword ladder
// renders any non-empty label, so validateTrackerData() recognizes statuses the
// same way the renderer does (via isKnownStatusLabel).
const VALID_APP_STATUSES = new Set([
  "applied",
  "submitted",
  "awaiting",
  "waiting",
  "pending",
  "interview",
  "screen",
  "screening",
  "onsite",
  "offer",
  "passed",
  "reviewing",
  "panel",
  "assessment",
  "hm",
  "rejected",
  "declined",
  "closed",
  "withdrawn",
  // First-class lifecycle statuses the renderer classifies (STAGE_RULES) and the
  // status map may emit — keep in sync so the validator doesn't warn on them.
  "sourced",
  "reviewed-hold",
  "manual-apply",
  "cut",
]);
const VALID_MODES = new Set(["remote", "hybrid", "onsite", "relo"]);
const VALID_CHANNELS = new Set(["board", "linkedin", "portal", "referral", "recruiter"]);

export function parseTrackerHtml(html) {
  return {
    apps: parseConstArray(html, "APPS"),
    sourced: parseConstArray(html, "PROSPECTS"),
  };
}

// Load the live tracker data from workspace/tracker.json (the source of truth the
// dashboard renders from) and normalize it to the {apps, sourced} contract the
// analysis/validation helpers expect (co/score field names from the legacy HTML
// shape). This replaces the dead HTML-scraping path for the CLI scripts — the
// rendered dashboard no longer embeds const APPS/PROSPECTS arrays.
export function loadTrackerData(jsonPath) {
  const data = JSON.parse(readFileSync(jsonPath, "utf8"));
  const apps = (data.applications || []).map((a) => ({
    co: a.company,
    role: a.role,
    status: a.status,
    channel: a.channel,
    mode: a.mode,
    score: a.fitScore,
    link: a.link,
    date: a.appliedAt,
    loc: a.loc,
    base: a.base,
    tc: a.tc,
  }));
  // Back-compat: legacy tracker.json files use "prospects" as the key;
  // canonical key is now "sourced". Read either, downstream sees only "sourced".
  const sourcedRaw = data.sourced || data.prospects || [];
  const sourced = sourcedRaw.map((p) => ({
    co: p.company,
    role: p.role,
    score: p.fitScore,
    mode: p.mode,
    channel: p.channel,
    link: p.link,
    loc: p.loc,
    base: p.base,
    tc: p.tc,
    fitBucket: p.fitBucket,
  }));
  return { apps, sourced };
}

// loadTrackerData but never throws: a fresh workspace with no tracker.json yet
// yields empty sets instead of an ENOENT crash. Used by buildSeenSets so the
// sourced scanners run cleanly before any tracker data exists.
function loadTrackerDataSafe(jsonPath) {
  try {
    return loadTrackerData(jsonPath);
  } catch {
    return { apps: [], sourced: [] };
  }
}

function parseConstArray(sourceText, name) {
  const marker = `const ${name} = `;
  const start = sourceText.indexOf(marker);
  if (start === -1) throw new Error(`Could not find ${name} array`);

  const arrayStart = sourceText.indexOf("[", start + marker.length);
  if (arrayStart === -1) throw new Error(`Could not find ${name} array start`);

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = arrayStart; i < sourceText.length; i++) {
    const ch = sourceText[i];
    const next = sourceText[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (depth === 0) {
      const literal = sourceText.slice(arrayStart, i + 1);
      return Function(`"use strict"; return (${literal});`)();
    }
  }

  throw new Error(`Could not find ${name} array end`);
}

export function normalizeTextKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeCompanyRoleKey(company, role) {
  return `${normalizeTextKey(company)}::${normalizeTextKey(role)}`;
}

export function findDuplicateCompanyRoles({ apps = [], sourced = [] }) {
  const seen = new Map();
  const duplicates = [];
  for (const [bucket, rows] of [
    ["APPS", apps],
    ["SOURCED", sourced],
  ]) {
    rows.forEach((row, index) => {
      const key = normalizeCompanyRoleKey(row.co, row.role);
      if (!row.co || !row.role) return;
      const hit = seen.get(key);
      const ref = { bucket, index, co: row.co, role: row.role, key };
      if (hit) duplicates.push({ key, first: hit, duplicate: ref });
      else seen.set(key, ref);
    });
  }
  return duplicates;
}

// Read the live tracker (workspace/tracker.json) and saved job bodies
// (workspace/jobs) and build the dedupe sets the scanners use. Reads the JSON
// source of truth via loadTrackerData — the legacy tracker.html scraping path is
// gone — and degrades to empty sets when a fresh workspace has no tracker yet.
export function buildSeenSets(root = ".") {
  const pathCtx = { repoRoot: root };
  const data = loadTrackerDataSafe(userPath(pathCtx, "workspace/tracker.json"));
  const seenUrls = new Set();
  const seenReqIds = new Set();
  const seenCompanyRoles = new Set();

  for (const row of [...data.apps, ...data.sourced]) {
    if (row.link) seenUrls.add(row.link);
    if (row.link) addReqId(seenReqIds, row.link);
    if (row.co && row.role) seenCompanyRoles.add(normalizeCompanyRoleKey(row.co, row.role));
  }

  for (const job of parseJobFrontmatters(userPath(pathCtx, "workspace/jobs"))) {
    if (job.source) seenUrls.add(job.source);
    if (job.source) addReqId(seenReqIds, job.source);
    if (job.reqId && job.company)
      seenReqIds.add(`${normalizeTextKey(job.company)}:${normalizeTextKey(job.reqId)}`);
    if (job.company && job.role)
      seenCompanyRoles.add(normalizeCompanyRoleKey(job.company, job.role));
  }

  return { seenUrls, seenReqIds, seenCompanyRoles, tracker: data };
}

function parseJobFrontmatters(jobsDir = "jobs") {
  let files = [];
  try {
    files = readdirSync(jobsDir).filter((file) => file.endsWith(".md") && file !== "README.md");
  } catch {
    return [];
  }

  return files.map((file) => {
    const text = readFileSync(join(jobsDir, file), "utf8");
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    const data = { file };
    if (!match) return data;
    for (const line of match[1].split("\n")) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) data[kv[1]] = kv[2].trim();
    }
    return data;
  });
}

export function validateTrackerData(data) {
  const errors = [];
  const warnings = [];

  data.apps.forEach((row, index) => {
    const label = `APPS[${index}] ${row.co || "(missing company)"} - ${row.role || "(missing role)"}`;
    validateCommon(row, label, errors, warnings);
    if (!row.status || !String(row.status).trim()) {
      errors.push(`${label}: missing status`);
    } else if (!isKnownStatusLabel(row.status)) {
      warnings.push(`${label}: unrecognized status "${row.status}" (renders as Applied)`);
    }
    if (row.status === "awaiting" && (!row.date || row.date === "-"))
      warnings.push(`${label}: awaiting role has no submit date`);
  });

  data.sourced.forEach((row, index) => {
    const label = `SOURCED[${index}] ${row.co || "(missing company)"} - ${row.role || "(missing role)"}`;
    validateCommon(row, label, errors, warnings);
    if (!row.link || !/^https?:\/\//.test(row.link))
      warnings.push(`${label}: sourced entry has no usable link`);
  });

  for (const dupe of findDuplicateCompanyRoles(data)) {
    warnings.push(
      `Duplicate company-role: ${dupe.key} (${dupe.first.bucket}[${dupe.first.index}] and ${dupe.duplicate.bucket}[${dupe.duplicate.index}])`
    );
  }

  return { errors, warnings };
}

function validateCommon(row, label, errors, warnings) {
  if (!row.co) errors.push(`${label}: missing co`);
  if (!row.role) errors.push(`${label}: missing role`);
  if (!Number.isFinite(row.score) || row.score < 0 || row.score > 100)
    errors.push(`${label}: score must be 0-100`);
  if (row.mode && !VALID_MODES.has(row.mode)) errors.push(`${label}: invalid mode "${row.mode}"`);
  if (row.channel && !VALID_CHANNELS.has(row.channel))
    errors.push(`${label}: invalid channel "${row.channel}"`);
  if (!row.base) warnings.push(`${label}: missing base comp`);
}

function addReqId(set, rawUrl) {
  const reqId = extractLikelyReqId(rawUrl);
  if (reqId) set.add(reqId);
}

function extractLikelyReqId(rawUrl) {
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
  } catch {
    return null;
  }
  return null;
}

export { VALID_APP_STATUSES };
