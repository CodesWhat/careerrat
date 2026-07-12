// apps/web/src/dev/devTools.js — runtime gate for dev-only UI (the accent
// picker in AccentLab.jsx, the /dev/v2 design-lab route). This deliberately
// ships in the production bundle — inert unless one of the signals below is
// present — because the review loop that matters (tracker-dev on 7788, the
// Electron app) serves the BUILT bundle, where import.meta.env.DEV is always
// false. A build-time gate would make these tools invisible everywhere
// except `vite dev`, so the gate has to be a runtime check instead.

const STORAGE_KEY = "rolester-dev-tools";

export function isDevToolsEnabled() {
  if (import.meta.env.DEV) return true;
  if (typeof window === "undefined") return false;

  try {
    if (localStorage.getItem(STORAGE_KEY) === "true") return true;
  } catch {
    /* localStorage unavailable — fall through to the URL check */
  }

  if (window.location.search.includes("devtools")) {
    try {
      localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      /* best-effort persistence only */
    }
    return true;
  }

  return false;
}
