// apps/desktop/update-check.mjs: notify-only update check for the packaged
// desktop app. No electron-updater, no auto-download, no auto-install: this
// module only decides WHETHER a newer release exists and hands back the
// release page + .dmg asset URLs so the renderer can point the user at a
// manual download. main.mjs owns the actual scheduling, persistence, and
// contextBridge wiring; everything below is deliberately Electron-free so it
// can be unit tested with plain `node --test`.
//
// The only network call this module ever makes is an unauthenticated GET to
// GitHub's public "latest release" endpoint, no candidate data, no
// telemetry, no identifiers beyond a plain User-Agent (GitHub requires one).

export const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/CodesWhat/careerrat/releases/latest";

// Re-check at most once a day. Same cadence as the existing npm-side
// update-notifier (src/core/update/update-core.mjs's CACHE_TTL_MS), kept as
// an independent constant here since this module intentionally shares no
// code with that CLI/npm-registry flow.
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// A hung connection must never wedge the app. Abort and treat it as a
// silent failure past this point.
export const REQUEST_TIMEOUT_MS = 10000;

export const DEFAULT_STATE = Object.freeze({
  enabled: true,
  lastCheckedAt: null,
  skippedVersion: null,
  latestVersion: null,
  latestReleaseUrl: null,
  latestDmgUrl: null,
});

// --- Pure functions ---------------------------------------------------------

// Parses "1.2.3", "v1.2.3", or "1.2.3-beta.1" into a comparable [major,
// minor, patch] tuple. Returns null for anything that doesn't parse: callers
// treat that as "unknown", never as "older".
function parseVersion(raw) {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^v/i, "");
  if (!cleaned) return null;

  const [core] = cleaned.split("-");
  const parts = core.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;

  while (parts.length < 3) parts.push(0);
  return parts;
}

// Naive string comparison breaks on "0.9.0" vs "0.10.0" ("0.10.0" < "0.9.0"
// lexicographically). Compare each dot-separated segment as an integer
// instead. Returns -1, 0, or 1 (a vs b); unparseable input never outranks
// parseable input.
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function isNewerVersion(current, candidate) {
  if (!current || !candidate) return false;
  return compareVersions(candidate, current) > 0;
}

// Whether enough time has passed since the last check (or there has never
// been one). The scheduling predicate main.mjs calls both shortly after
// ready and on its recurring interval.
export function shouldCheckNow({
  enabled = true,
  lastCheckedAt = null,
  now = Date.now(),
  intervalMs = CHECK_INTERVAL_MS,
} = {}) {
  if (!enabled) return false;
  if (!lastCheckedAt) return true;

  const last = new Date(lastCheckedAt).getTime();
  if (!Number.isFinite(last)) return true;

  return now - last >= intervalMs;
}

function findDmgAssetUrl(assets) {
  if (!Array.isArray(assets)) return null;
  const dmg = assets.find(
    (asset) =>
      typeof asset?.browser_download_url === "string" &&
      /\.dmg$/i.test(asset?.name || asset.browser_download_url)
  );
  return dmg?.browser_download_url || null;
}

// Takes the current app version plus a parsed GitHub "latest release"
// payload (or null/malformed input, never throws) and resolves whether an
// update is available, the release's version, its release-page URL, and its
// .dmg asset URL when the release actually shipped one. `version`,
// `releaseUrl`, and `dmgUrl` describe the release itself regardless of
// `updateAvailable`, so a caller can cache "the latest known release" even on
// a run where the current version is already caught up.
export function resolveUpdateResult({ currentVersion, release } = {}) {
  const tag = release?.tag_name;
  const version = typeof tag === "string" && tag.trim() ? tag.trim().replace(/^v/i, "") : null;
  const releaseUrl = typeof release?.html_url === "string" ? release.html_url : null;
  const dmgUrl = findDmgAssetUrl(release?.assets);

  const updateAvailable = Boolean(
    version && currentVersion && isNewerVersion(currentVersion, version)
  );

  return { updateAvailable, version, releaseUrl, dmgUrl };
}

// Whether the renderer should actually surface a notice for this result,
// given the version the candidate already dismissed ("skip this version").
export function shouldNotify({ result, skippedVersion = null } = {}) {
  if (!result?.updateAvailable || !result.version) return false;
  return result.version !== skippedVersion;
}

export function withCheckRecorded(state, { checkedAt = Date.now() } = {}) {
  return { ...DEFAULT_STATE, ...state, lastCheckedAt: checkedAt };
}

export function withSkippedVersion(state, version) {
  return { ...DEFAULT_STATE, ...state, skippedVersion: version || null };
}

export function withEnabled(state, enabled) {
  return { ...DEFAULT_STATE, ...state, enabled: Boolean(enabled) };
}

// No auth token, no candidate identifiers, just what GitHub's API requires
// (a User-Agent) plus an explicit Accept.
export function buildRequestHeaders({ userAgent = "CareerRat-Desktop-UpdateCheck" } = {}) {
  return {
    "User-Agent": userAgent,
    Accept: "application/vnd.github+json",
  };
}

// --- Impure I/O (network only, no filesystem access in this module) --------

// GETs the latest-release payload with a hard timeout. Never throws: a
// network failure, a non-200 response, a rate limit, or malformed JSON all
// resolve to null so the caller can degrade silently.
export async function fetchLatestRelease({
  url = GITHUB_RELEASES_URL,
  timeoutMs = REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, { headers: buildRequestHeaders(), signal: controller.signal });
    if (!res?.ok) return null;

    const body = await res.json();
    if (!body || typeof body !== "object") return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Orchestrates one scheduled check: does nothing (and makes no network call)
// unless shouldCheckNow() says it's due, otherwise fetches, resolves, and
// returns the updated persisted state alongside the resolved result.
// `fetchSucceeded` distinguishes "checked, GitHub had nothing newer" from
// "checked, but the request itself failed". main.mjs uses it to decide
// whether to refresh the cached "latest known release" fields or leave them
// untouched on a transient failure.
export async function runUpdateCheck({
  currentVersion,
  state = DEFAULT_STATE,
  now = Date.now(),
  intervalMs = CHECK_INTERVAL_MS,
  url = GITHUB_RELEASES_URL,
  timeoutMs = REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const merged = { ...DEFAULT_STATE, ...state };

  if (!shouldCheckNow({ enabled: merged.enabled, lastCheckedAt: merged.lastCheckedAt, now, intervalMs })) {
    return { state: merged, result: null, checked: false, fetchSucceeded: false };
  }

  const release = await fetchLatestRelease({ url, timeoutMs, fetchImpl });
  const fetchSucceeded = release !== null;
  const result = resolveUpdateResult({ currentVersion, release });
  const nextState = withCheckRecorded(merged, { checkedAt: now });

  return { state: nextState, result, checked: true, fetchSucceeded };
}
