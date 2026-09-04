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
    // Board/portal root URLs (e.g. .../External_Career_Site) share the
    // myworkdayjobs.com host and can have an underscored last path segment,
    // but they aren't a specific posting: only a URL with a genuine
    // `/job/<leaf>` segment (mirroring resolvePostingEndpoint's own posting
    // check in the vendor file, which this deliberately duplicates rather
    // than import, since that helper isn't exported and the vendor file
    // stays byte-identical apart from the two locally-ported fixes
    // documented in its README) names one. Without this guard,
    // workdayDedupKey accepts ANY underscored last segment, so a board URL
    // like ".../External_Career_Site" derives requisition "career_site",
    // which then collides with ".../Internal_Career_Site" and can make
    // Universal Intake report the board itself as an expired job (CR-29
    // round 3).
    const isWorkdayPostingPath = path
      .split("/")
      .filter(Boolean)
      .some(
        (segment, index, segments) => segment.toLowerCase() === "job" && index < segments.length - 1
      );
    const workdayId = isWorkdayPostingPath ? workdayDedupKey({ url: rawUrl }) : null;
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
  const derived = extractReqId(url);
  const reqId = explicitReqId(row) || derived.id;
  const keys = [];
  if (url) keys.push(`url:${normalizePostingUrl(url)}`);
  if (reqId) keys.push(`req:${reqId}`);
  // Aggregators (HiringCafe et al.) stamp their own reqId ahead of the
  // posting URL, which wins above. That alone would suppress the
  // URL-derived requisition id (e.g. Workday's hostname-scoped dedup key),
  // so canonical dedupe against a row keyed only by the URL would miss it.
  // Keep both keys whenever they diverge.
  if (derived.id && derived.id !== reqId) keys.push(`req:${derived.id}`);
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

// A canonical row's OWN fields (url, reqId) only carry the identity it was
// captured under. When canonical dedupe discards a differently-sourced
// duplicate of that row (e.g. a HiringCafe-bridged republish of a direct
// Workday posting), the discarded row's other identity keys are persisted
// here so a LATER capture that only carries one of those other
// representations (no outbound board URL, just the aggregator's own page)
// still resolves back to the same row instead of inserting a duplicate.
export function rowAliasKeys(row = {}) {
  return Array.isArray(row.aliasKeys)
    ? row.aliasKeys.filter((key) => typeof key === "string" && key)
    : [];
}

// The keys addPostingIdentity/postingIdentityIsSeen should treat this row as
// answering for: its own postingIdentityKeys() plus whatever aliases were
// merged onto it by a prior duplicate-suppression (see rowAliasKeys above).
export function identityKeysWithAliases(row = {}) {
  return [...postingIdentityKeys(row), ...rowAliasKeys(row)];
}

// The identity keys `duplicate` carries that `canonicalRow` doesn't already
// answer for (via its own fields or its existing aliasKeys): what a caller
// discarding `duplicate` as a match for `canonicalRow` needs to add to
// canonicalRow.aliasKeys so a future lookup by one of those keys still finds
// it. Empty when the duplicate adds nothing new (the common case).
export function identityAliasAdditions(canonicalRow, duplicate) {
  const covered = new Set(identityKeysWithAliases(canonicalRow));
  return postingIdentityKeys(duplicate).filter((key) => !covered.has(key));
}

export function addPostingIdentity(seenKeys, row) {
  for (const key of identityKeysWithAliases(row)) seenKeys.add(key);
  return seenKeys;
}
