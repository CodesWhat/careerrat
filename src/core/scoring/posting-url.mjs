// The one posting-identity URL normalizer. Scanner identity keys, snapshot
// delta, intake matching and evaluate persistence all compare posting URLs
// through this, so they can't disagree about whether two links are the same
// posting. Fetch-cache, search-source and provenance URL policies are
// separate on purpose and don't use it.
//
// Tracking params are an EXACT key list (plus the utm_ family). Prefix
// matching ("ref*", "source*") is what collapsed ?referenceId=77 and
// ?referenceId=78 into one posting, so identifying params (referenceId,
// gh_jid, jobId, id, req, ...) always survive.
const TRACKING_QUERY_KEYS = new Set([
  "ref",
  "referrer",
  "source",
  "sourceid",
  "trackingid",
  "gh_src",
  "trk",
  "trkinfo",
]);

function isTrackingKey(key) {
  const lower = key.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_QUERY_KEYS.has(lower);
}

export function normalizePostingUrl(raw) {
  if (!raw) return "";
  try {
    const url = new URL(String(raw).trim());
    for (const key of [...url.searchParams.keys()]) {
      if (isTrackingKey(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    const text = url.toString();
    return url.search ? text : text.replace(/\/$/u, "");
  } catch {
    return String(raw).trim();
  }
}
