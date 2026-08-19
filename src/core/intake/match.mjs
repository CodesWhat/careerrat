// match.mjs — the M9 dedup/tracker-match: the mechanical implementation of
// what evaluate-job SKILL.md STEP 3.25 today only describes in prose ("check
// the tracker before treating a posting as new"). Reuses extractReqId()
// verbatim from sourced-scanner.mjs, normalizeUrl() verbatim from
// sourced-delta.mjs, and normalizeCompanyRoleKey() verbatim from
// tracker-data.mjs — no second implementation of any of the three.
//
// This is the fix for the known dedup gap AT INTAKE TIME ONLY: today
// sourced-scanner.mjs's filterAndDedupeOffers() only checks company+role
// against an in-memory seenCompanyRoles set built up DURING a single sweep
// batch — never seeded from the persisted applications/sourced tables — so a
// role at a company you already applied to (and were rejected from)
// resurfaces as "new" on the next sweep. matchTrackerRecord() below runs the
// same key as a real query against the db, for the first time, but only for
// intake's own classify step. search-jobs' sweep-level gap is a different
// call site with the same underlying bug — NOT fixed here (see the
// M9 design docs for the natural follow-on).
import { normalizeUrl } from "../scoring/sourced-delta.mjs";
import { extractReqId } from "../scoring/sourced-scanner.mjs";
import { normalizeCompanyRoleKey, normalizeTextKey } from "../tracker/tracker-data.mjs";

function rowsWithParsedData(db, table) {
  return db
    .prepare(`SELECT id, data FROM ${table}`)
    .all()
    .map((row) => ({
      id: row.id,
      recordType: table === "applications" ? "application" : "sourced",
      ...JSON.parse(row.data),
    }));
}

function summarizeApplication(row) {
  const when = row.appliedAt ? ` on ${row.appliedAt}` : "";
  return `You already applied to ${row.company || "this company"}, ${row.role || "this role"}${when}. Current status: ${row.status || "unknown"}.`;
}

function summarizeSourced(row) {
  const fit = row.fitScore != null ? ` (fit ${row.fitScore})` : "";
  return `This posting is already tracked in sourced as "${row.company || "?"}, ${row.role || "?"}"${fit}.`;
}

function summarize(row) {
  return row.recordType === "application" ? summarizeApplication(row) : summarizeSourced(row);
}

// matchTrackerRecord({ db, url, company, role }) ->
// {
//   matched: boolean,
//   confidence: "exact_req_id" | "exact_url" | "company_role" | "company_unique" | null,
//   recordType: "application" | "sourced" | null,
//   id: string | null,
//   company, role, status, summary,
//   companyHistory: [{ id, recordType, role, status, appliedAt }],
// }
export function matchTrackerRecord({ db, url, company, role } = {}) {
  const rows = [...rowsWithParsedData(db, "applications"), ...rowsWithParsedData(db, "sourced")];

  const targetReqId = url ? extractReqId(url) : { id: null };
  const targetUrl = url ? normalizeUrl(url) : "";
  const targetKey = company && role ? normalizeCompanyRoleKey(company, role) : null;
  const targetCompanyKey = company ? normalizeTextKey(company) : null;

  let best = null;
  if (targetReqId.id) {
    best = rows.find((row) => row.link && extractReqId(row.link).id === targetReqId.id);
    if (best) best = { row: best, confidence: "exact_req_id" };
  }
  if (!best && targetUrl) {
    const hit = rows.find((row) => row.link && normalizeUrl(row.link) === targetUrl);
    if (hit) best = { row: hit, confidence: "exact_url" };
  }
  if (!best && targetKey) {
    const hit = rows.find(
      (row) =>
        row.company && row.role && normalizeCompanyRoleKey(row.company, row.role) === targetKey
    );
    if (hit) best = { row: hit, confidence: "company_role" };
  }
  // company_unique — real status-update pastes almost never name the role
  // ("they passed after the final round"). When the caller extracted a
  // company but no role, and exactly one row at that company exists, that's
  // unambiguous, not a guess: match it. Applications take precedence over
  // sourced rows; two-or-more rows at the company (in whichever bucket is
  // checked) leaves this unmatched (ambiguous -> needs_you upstream in
  // dispatch.mjs, same as any other unmatched result).
  if (!best && targetCompanyKey && !role) {
    const appMatches = rows.filter(
      (row) =>
        row.recordType === "application" &&
        row.company &&
        normalizeTextKey(row.company) === targetCompanyKey
    );
    if (appMatches.length === 1) {
      best = { row: appMatches[0], confidence: "company_unique" };
    } else if (appMatches.length === 0) {
      const sourcedMatches = rows.filter(
        (row) =>
          row.recordType === "sourced" &&
          row.company &&
          normalizeTextKey(row.company) === targetCompanyKey
      );
      if (sourcedMatches.length === 1) {
        best = { row: sourcedMatches[0], confidence: "company_unique" };
      }
    }
  }

  const companyHistory = targetCompanyKey
    ? rows
        .filter((row) => row.company && normalizeTextKey(row.company) === targetCompanyKey)
        .filter((row) => !best || row.id !== best.row.id)
        .map((row) => ({
          id: row.id,
          recordType: row.recordType,
          role: row.role || null,
          status: row.status || null,
          appliedAt: row.appliedAt || null,
        }))
    : [];

  if (!best) {
    return {
      matched: false,
      confidence: null,
      recordType: null,
      id: null,
      company: null,
      role: null,
      status: null,
      summary: null,
      companyHistory,
    };
  }

  return {
    matched: true,
    confidence: best.confidence,
    recordType: best.row.recordType,
    id: best.row.id,
    company: best.row.company || null,
    role: best.row.role || null,
    status: best.row.status || null,
    summary: summarize(best.row),
    companyHistory,
  };
}
