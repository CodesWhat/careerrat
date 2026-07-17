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

// The system-browser Google OAuth handoff (see src/cli/desktop-auth-route.mjs's
// header comment for the full flow). Google rejects OAuth performed inside
// Electron's embedded Chromium (JS engine fingerprinting), so the sign-in
// affordance deliberately navigates to this one same-origin path to hand it
// off to the OS browser instead of completing it in-window — every other
// same-origin navigation still stays in-window (see the same-origin check in
// decideExternalOpen below).
export const DESKTOP_SIGN_IN_PATH = "/app/desktop-sign-in";

export function decideExternalOpen({ target, baseUrl, allowedProtocols } = {}) {
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
        if (url.pathname === DESKTOP_SIGN_IN_PATH) {
          return { action: "open-external", reason: "desktop-sign-in", url: url.href };
        }
        return { action: "ignore", reason: "same-origin", url: url.href };
      }
    } catch {
      // A malformed base URL should not make an unsafe target openable.
    }
  }

  if (!isAllowedExternalUrl(url.href, { allowedProtocols })) {
    return { action: "deny", reason: `blocked-protocol:${url.protocol}`, url: url.href };
  }

  return { action: "open-external", url: url.href };
}
