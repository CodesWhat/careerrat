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
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

// A hung connection must never wedge the app. Abort and treat it as a
// silent failure past this point.
const REQUEST_TIMEOUT_MS = 10000;

export const DEFAULT_STATE = Object.freeze({
  enabled: true,
  lastCheckedAt: null,
  skippedVersion: null,
  latestVersion: null,
  latestReleaseUrl: null,
  latestDmgUrl: null,
});

// --- Pure functions ---------------------------------------------------------

// Parses "1.2.3", "v1.2.3", or "1.2.3-rc.1" into a comparable { core,
// prerelease } shape: core is a [major, minor, patch] tuple, prerelease is
// either null (no "-rc.1" suffix) or the array of dot-separated identifiers
// after the hyphen. Returns null for anything that doesn't parse: callers
// treat that as "unknown", never as "older".
function parseVersion(raw) {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^v/i, "");
  if (!cleaned) return null;

  const [core, ...prereleaseParts] = cleaned.split("-");
  const parts = core.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;
  while (parts.length < 3) parts.push(0);

  // Rejoin with "-" in case the prerelease string itself contained a hyphen
  // (rare, but valid semver, e.g. "1.0.0-x-y-z").
  const prereleaseRaw = prereleaseParts.join("-");
  const prerelease = prereleaseRaw ? prereleaseRaw.split(".") : null;

  return { core: parts, prerelease };
}

// Semver precedence for the prerelease portion (semver.org section 11): a
// version with no prerelease outranks the same version with one, so
// "0.9.0-rc.1" < "0.9.0". This is the case that actually matters here: this
// repo ships release candidates (publish.yml routes any hyphenated version to
// the npm "rc" dist-tag), and GitHub's /releases/latest endpoint only ever
// returns the GA release, so an rc user must compare as older than GA or they
// are never told the final version shipped.
//
// When both sides have a prerelease, compare identifiers left to right:
// purely-numeric identifiers compare numerically, everything else compares
// as ASCII strings, a numeric identifier always ranks below an alphanumeric
// one, and if every shared identifier is equal, the side with fewer
// identifiers ranks lower ("1.0.0-rc" < "1.0.0-rc.1").
function comparePrerelease(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;

    const ai = a[i];
    const bi = b[i];
    const aNumeric = /^\d+$/.test(ai);
    const bNumeric = /^\d+$/.test(bi);

    if (aNumeric && bNumeric) {
      const diff = Number.parseInt(ai, 10) - Number.parseInt(bi, 10);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

// Naive string comparison breaks on "0.9.0" vs "0.10.0" ("0.10.0" < "0.9.0"
// lexicographically), so the core is compared as integer segments. The
// prerelease suffix, if either side has one, is then compared per semver
// precedence above. Returns -1, 0, or 1 (a vs b); unparseable input never
// outranks parseable input.
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  for (let i = 0; i < 3; i += 1) {
    const diff = (pa.core[i] || 0) - (pb.core[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  return comparePrerelease(pa.prerelease, pb.prerelease);
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

export function nextUpdateCheckDelay({
  enabled = true,
  lastCheckedAt = null,
  now = Date.now(),
  initialDelayMs = 0,
  intervalMs = CHECK_INTERVAL_MS,
  maxDelayMs = MAX_TIMER_DELAY_MS,
} = {}) {
  if (!enabled) return null;
  if (lastCheckedAt === null || lastCheckedAt === undefined || lastCheckedAt === "") {
    return Math.min(maxDelayMs, Math.max(0, initialDelayMs));
  }
  const checkedAt = new Date(lastCheckedAt).getTime();
  if (!Number.isFinite(checkedAt)) return 0;
  return Math.min(maxDelayMs, Math.max(0, checkedAt + intervalMs - now));
}

const ALLOWED_RELEASE_HOST = "github.com";

// Host-pins any URL taken from the GitHub API response before it can reach
// the renderer or openExternalIfAllowed (main.mjs). decideExternalOpen's own
// SAFE_EXTERNAL_PROTOCOLS allowlist (desktop-runtime.mjs) already denies any
// non-https/mailto scheme, so a file:/javascript: URL was never reachable
// through the normal open path. The residual risk this guards is narrower: a
// compromised or MITM'd API response could return a plausible https:// URL
// on an attacker-controlled host, which would pass that protocol check and
// open in the browser. Pinning to github.com is defense in depth against
// exactly that. Returns null for anything that doesn't parse, isn't https,
// or isn't on the pinned host.
function validateGithubUrl(url) {
  if (typeof url !== "string" || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== ALLOWED_RELEASE_HOST) return null;
  return url;
}

function findDmgAssetUrl(assets) {
  if (!Array.isArray(assets)) return null;
  const dmg = assets.find(
    (asset) =>
      typeof asset?.browser_download_url === "string" &&
      /\.dmg$/i.test(asset?.name || asset.browser_download_url)
  );
  return validateGithubUrl(dmg?.browser_download_url);
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
  const releaseUrl = validateGithubUrl(release?.html_url);
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

// Folds one completed check's outcome into persisted state, then re-applies
// `enabled` and `skippedVersion` from `liveState` last. A check can be in
// flight for up to REQUEST_TIMEOUT_MS; if the user flips the Settings toggle
// or skips a version through an IPC handler while it's running, that write
// already landed on the caller's live in-memory state (and was already
// persisted by its own handler) by the time the check resolves. Without this
// re-merge, persisting `nextState` (built from the snapshot the check
// started with) would silently revert that write, including reverting an
// opt-out and leaving checks running after the user turned them off.
export function mergeCheckedState({ nextState, fetchSucceeded, result, liveState }) {
  const base =
    fetchSucceeded && result
      ? {
          ...nextState,
          latestVersion: result.version,
          latestReleaseUrl: result.releaseUrl,
          latestDmgUrl: result.dmgUrl,
        }
      : nextState; // a failed fetch still records lastCheckedAt, never clobbers the last known release

  return {
    ...base,
    enabled: liveState.enabled,
    skippedVersion: liveState.skippedVersion,
  };
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
  force = false,
  now = Date.now(),
  intervalMs = CHECK_INTERVAL_MS,
  url = GITHUB_RELEASES_URL,
  timeoutMs = REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const merged = { ...DEFAULT_STATE, ...state };

  if (
    !force &&
    !shouldCheckNow({
      enabled: merged.enabled,
      lastCheckedAt: merged.lastCheckedAt,
      now,
      intervalMs,
    })
  ) {
    return { state: merged, result: null, checked: false, fetchSucceeded: false };
  }

  const release = await fetchLatestRelease({ url, timeoutMs, fetchImpl });
  const fetchSucceeded = release !== null;
  const result = resolveUpdateResult({ currentVersion, release });
  const nextState = withCheckRecorded(merged, { checkedAt: now });

  return { state: nextState, result, checked: true, fetchSucceeded };
}
