import { workdayDedupKey } from "../providers/career-ops/vendor/workday.mjs";
import { normalizeCompanyRoleKey, normalizeTextKey } from "../tracker/tracker-data.mjs";

function postingUrl(row = {}) {
  return String(row.url || row.link || "").trim();
}

function normalizePostingUrl(rawUrl = "") {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch {
    return String(rawUrl || "")
      .trim()
      .toLowerCase();
  }
}

// Mirrors workdayDedupKey's "last path segment, split at its first
// underscore" tokenization, but returns the tail verbatim (original case,
// suffix untouched) instead of the lowercased/stripped reqId it keys on.
// Kept local rather than exported from the vendor file, which stays
// byte-identical to upstream.
function workdayLiteralTail(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) return null;
  const underscoreIdx = lastSegment.indexOf("_");
  if (underscoreIdx === -1) return null;
  return lastSegment.slice(underscoreIdx + 1);
}

export function extractReqId(rawUrl = "") {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname;
    const greenhouse = path.match(/\/jobs\/(\d+)/);
    const greenhouseHost =
      url.hostname === "greenhouse.io" || url.hostname.endsWith(".greenhouse.io");
    if (greenhouse && greenhouseHost)
      return { provider: "greenhouse", value: greenhouse[1], id: `greenhouse:${greenhouse[1]}` };
    const ashby = path.match(/\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/|$)/i);
    if (ashby && url.hostname === "jobs.ashbyhq.com")
      return {
        provider: "ashby",
        value: ashby[1].toLowerCase(),
        id: `ashby:${ashby[1].toLowerCase()}`,
      };
    const lever = path.match(/\/([^/]+)$/);
    if (url.hostname === "jobs.lever.co" && lever)
      return { provider: "lever", value: lever[1], id: `lever:${lever[1].toLowerCase()}` };
    const apple = path.match(/\/details\/([0-9-]+)/);
    if ((url.hostname === "apple.com" || url.hostname.endsWith(".apple.com")) && apple)
      return { provider: "apple", value: apple[1], id: `apple:${apple[1]}` };
    const hiringCafe = path.match(/\/job\/([a-z0-9_-]+)/i);
    if (url.hostname === "hiring.cafe" && hiringCafe)
      return {
        provider: "hiringcafe",
        value: hiringCafe[1].toLowerCase(),
        id: `hiringcafe:${hiringCafe[1].toLowerCase()}`,
      };
    const linkedIn = path.match(/\/jobs\/view\/(\d+)/);
    if ((url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) && linkedIn)
      return { provider: "linkedin", value: linkedIn[1], id: `linkedin:${linkedIn[1]}` };
    const hireology = path.match(/^\/[^/]+\/(\d+)\/description\/?$/i);
    if (url.hostname === "careers.hireology.com" && hireology)
      return {
        provider: "hireology",
        value: hireology[1],
        id: `hireology:${hireology[1]}`,
      };
    // Migration note (2026-09-04, CR-29): this used to compute a Workday key
    // independently of the vendored workdayDedupKey (src/core/providers/
    // career-ops/vendor/workday.mjs) and the two diverged. This function
    // scoped by tenant only (dropping the "wdN" instance from the hostname)
    // and matched a narrow "_LETTERSdigits" pattern anywhere in the path,
    // where workdayDedupKey scopes by the full hostname and keeps the whole
    // tail after the final path segment's FIRST underscore. That let
    // matchTrackerRecord's exact_req_id and filterAndDedupeOffers's
    // req_id_batch either miss a real duplicate (same tenant, different wd
    // instance) or falsely collide (different requisition-id prefixes
    // sharing a "LETTERSdigits" tail, e.g. "REQ_US12345" vs "OTHER_US12345").
    // Fixed by calling workdayDedupKey directly instead of re-deriving the
    // same key with different rules, so the two can no longer drift apart.
    // Key shape changed as a result: "workday:<tenant>:<id>" (tenant-only)
    // is now "workday:<full-hostname>:<id>". No persisted data was found
    // keyed on the old shape (see report). `value` still comes from a local
    // literal-tail read (not workdayDedupKey's lowercased, "-N"-stripped
    // reqId): src/core/intake/resolve.mjs threads it through as job.reqId
    // and workday.mjs's fetchDetail compares it case-insensitively but
    // otherwise verbatim against the CXS detail response's jobReqId, so a
    // stripped "-N" suffix would make a genuine exact-detail lookup fail.
    const workdayId = workdayDedupKey({ url: rawUrl });
    if (workdayId) {
      const workdayValue =
        workdayLiteralTail(rawUrl) ?? workdayId.slice(workdayId.lastIndexOf(":") + 1);
      return { provider: "workday", value: workdayValue, id: workdayId };
    }
  } catch {
    return { provider: null, value: null, id: null };
  }
  return { provider: null, value: null, id: null };
}

function explicitReqId(row = {}) {
  return String(row.reqId || row.scanner?.reqId || "")
    .trim()
    .toLowerCase();
}

export function postingIdentityKeys(row = {}) {
  const url = postingUrl(row);
  const reqId = explicitReqId(row) || extractReqId(url).id;
  const keys = [];
  if (url) keys.push(`url:${normalizePostingUrl(url)}`);
  if (reqId) keys.push(`req:${reqId}`);
  if (keys.length) return keys;

  const company = String(row.company || row.co || "").trim();
  const role = String(row.role || row.title || "").trim();
  const location = normalizeTextKey(row.location || row.loc || "");
  if (company && role && location) {
    keys.push(`company-role-location:${normalizeCompanyRoleKey(company, role)}::${location}`);
  }
  return keys;
}

export function postingIdentityIsSeen(row, seenKeys) {
  return postingIdentityKeys(row).some((key) => seenKeys.has(key));
}

export function addPostingIdentity(seenKeys, row) {
  for (const key of postingIdentityKeys(row)) seenKeys.add(key);
  return seenKeys;
}
