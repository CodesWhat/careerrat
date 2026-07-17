import { join } from "node:path";

export const SAFE_EXTERNAL_PROTOCOLS = Object.freeze(["https:", "mailto:"]);

export function resolveDesktopRuntimePaths({
  isPackaged,
  appDir,
  userDataPath,
  resourcesPath,
} = {}) {
  const isBrandedDevLaunch =
    isPackaged && appDir && isNodeModulesElectronResourcesPath(resourcesPath);

  if (!isPackaged || isBrandedDevLaunch) {
    if (!appDir) {
      throw new TypeError("resolveDesktopRuntimePaths: appDir is required in dev mode");
    }

    return {
      isPackaged: false,
      rolesterHome: null,
      repoRoot: join(appDir, "../.."),
    };
  }

  if (isPackaged) {
    if (!userDataPath) {
      throw new TypeError("resolveDesktopRuntimePaths: userDataPath is required in packaged mode");
    }
    if (!resourcesPath) {
      throw new TypeError("resolveDesktopRuntimePaths: resourcesPath is required in packaged mode");
    }

    return {
      isPackaged: true,
      rolesterHome: join(userDataPath, "data"),
      repoRoot: join(resourcesPath, "rolester"),
    };
  }
}

function isNodeModulesElectronResourcesPath(resourcesPath) {
  return String(resourcesPath || "")
    .replaceAll("\\", "/")
    .includes("/node_modules/electron/dist/Electron.app/Contents/Resources");
}

// The Clerk dev-browser cookie/localStorage state that OAuth relies on is
// keyed by origin, which for a loopback app includes the port. In dev mode
// an ephemeral port (0) is fine — a fresh session each launch is expected.
// In packaged mode a stable port lets a signed-in session survive a relaunch.
export const DEFAULT_PACKAGED_PORT = 46753;

export function choosePreferredPort({ isPackaged, env } = {}) {
  if (!isPackaged) return 0;

  const parsed = Number(env?.ROLESTER_DESKTOP_PORT);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;

  return DEFAULT_PACKAGED_PORT;
}

export function isAllowedExternalUrl(target, { allowedProtocols = SAFE_EXTERNAL_PROTOCOLS } = {}) {
  if (!String(target || "").trim()) return false;

  try {
    const url = new URL(String(target));
    return allowedProtocols.includes(url.protocol);
  } catch {
    return false;
  }
}

// Clicking "Continue with Google" on the Clerk sign-in card leaves our own
// origin on purpose: a top-level navigation to Clerk's frontend-API domain,
// then accounts.google.com, then back. Left to the default off-origin
// handling below, every hop would bounce out to the OS browser and the
// session Google hands back would never reach this window. These are the
// hosts that dance is known to pass through — entries starting with "."
// match any subdomain (Clerk's per-app dev instances), everything else is
// an exact host match.
export const AUTH_NAVIGATION_HOSTS = Object.freeze([
  "accounts.google.com",
  "accounts.youtube.com", // Google's own login chain can bounce through this host
  ".clerk.accounts.dev", // Clerk development frontend-API instances
]);

function parseExtraAuthHosts(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function isAuthNavigationHost(hostname, { extraHosts = [] } = {}) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;

  return [...AUTH_NAVIGATION_HOSTS, ...extraHosts].some((pattern) =>
    pattern.startsWith(".") ? host.endsWith(pattern) : host === pattern
  );
}

// Google's "This browser or app may not be secure" rejection isn't the UA
// string itself — Electron's fallback UA (even with the Rolester/Electron
// tokens stripped in main.mjs) still reads as Chromium, and Chromium sends
// Client Hints (Sec-CH-UA, Sec-CH-UA-Platform, …) that let Google
// cross-check the UA against the actual engine and catch the mismatch.
// Firefox sends no client hints at all, so there's nothing for that
// cross-check to trip on — presenting a Firefox UA to the OAuth-chain hosts
// only (never the app's own origin) is the standard Electron workaround for
// this exact Google error.
export const AUTH_FLOW_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:141.0) Gecko/20100101 Firefox/141.0";

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

// ROLESTER_AUTH_HOSTS is deliberately tolerant of junk entries for matching
// (isAuthNavigationHost above just never matches them) but a malformed host
// can't be handed to Electron's webRequest URL-pattern filter — a pattern
// built from something like "://bad host" would either fail to register or
// silently match nothing useful. Filter to syntactically plausible hostnames
// before building patterns from them.
function isValidHostEntry(pattern) {
  const bare = pattern.startsWith(".") ? pattern.slice(1) : pattern;
  return bare.length > 0 && HOSTNAME_PATTERN.test(bare);
}

// Builds the Electron webRequest `urls` filter patterns for the auth-host
// allowlist (built-in + ROLESTER_AUTH_HOSTS), so main.mjs can scope the
// Firefox User-Agent override to exactly the OAuth-chain hosts and nowhere
// else. Suffix entries (leading ".") become a wildcard-subdomain pattern;
// exact hosts match only themselves.
export function buildAuthUaFilterPatterns(env) {
  const extraHosts = parseExtraAuthHosts(env?.ROLESTER_AUTH_HOSTS);

  return [...AUTH_NAVIGATION_HOSTS, ...extraHosts]
    .filter(isValidHostEntry)
    .map((pattern) =>
      pattern.startsWith(".") ? `https://*${pattern}/*` : `https://${pattern}/*`
    );
}

export function decideExternalOpen({ target, baseUrl, allowedProtocols, env } = {}) {
  if (!String(target || "").trim()) {
    return { action: "deny", reason: "missing-url" };
  }

  let url;
  try {
    url = new URL(String(target));
  } catch {
    return { action: "deny", reason: "malformed-url" };
  }

  if (baseUrl) {
    try {
      const base = new URL(String(baseUrl));
      if (url.origin === base.origin) {
        return { action: "ignore", reason: "same-origin", url: url.href };
      }
    } catch {
      // A malformed base URL should not make an unsafe target openable.
    }
  }

  // ROLESTER_AUTH_HOSTS lets a future production Clerk domain (or any other
  // OAuth-chain host) be allowlisted without a code change: comma-separated,
  // exact-or-suffix (a leading "." matches any subdomain).
  const extraHosts = parseExtraAuthHosts(env?.ROLESTER_AUTH_HOSTS);
  if (url.protocol === "https:" && isAuthNavigationHost(url.hostname, { extraHosts })) {
    return { action: "ignore", reason: "auth-origin", url: url.href };
  }

  if (!isAllowedExternalUrl(url.href, { allowedProtocols })) {
    return { action: "deny", reason: `blocked-protocol:${url.protocol}`, url: url.href };
  }

  return { action: "open-external", url: url.href };
}
