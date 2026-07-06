import { join } from "node:path";

export const SAFE_EXTERNAL_PROTOCOLS = Object.freeze(["https:", "mailto:"]);

export function resolveDesktopRuntimePaths({
  isPackaged,
  appDir,
  userDataPath,
  resourcesPath,
} = {}) {
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

  if (!appDir) {
    throw new TypeError("resolveDesktopRuntimePaths: appDir is required in dev mode");
  }

  return {
    isPackaged: false,
    rolesterHome: null,
    repoRoot: join(appDir, "../.."),
  };
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
