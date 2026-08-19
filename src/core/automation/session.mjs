// session.mjs — the tool-agnostic "session browser" descriptor.
//
// Layer 3 of the browser substrate (docs/BROWSER.md) is the live, agent-driven
// session browser. This module deliberately drives NOTHING — it imports no browser,
// pins no MCP namespace, holds no credentials. It only describes WHICH provider the
// agent should reach for and WHERE a Playwright persistent profile lives, so the
// CLI/doctor/skills speak about the session browser consistently. The actual DOM
// driving stays agent-side (snapshot/read each step, zero hardcoded selectors).
//
// Provider preference (see AGENTS.md → Browser Automation Contract):
//   1. auto       — use Orca in an Orca workspace, otherwise the compatible
//                   extension session.
//   2. extension  — Chrome extension (Claude-in-Chrome / Codex), which holds the
//                   user's logins + password store.
//   3. orca       — Orca's supervised embedded browser.
//   4. playwright — a persistent Playwright profile the user signs into once per
//                   platform (the scripts/capture-board-snapshot.mjs model).

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDER_PREFERENCE = ["auto", "extension", "orca", "playwright"];

// `automatedApply` marks whether `apply-job`'s scripted/headless apply path
// (createConfiguredApplyExecutor, src/core/apply/apply-executor-factory.mjs) can
// drive this provider. `extension` is agent-driven, turn-by-turn only — it still
// works for interactive, in-the-loop browsing (skills reading pages, agent-driven
// apply while an agent is live) but has no callable surface for a headless script,
// so automatic apply on this provider is not available yet.
export const PROVIDERS = {
  auto: {
    id: "auto",
    label: "Automatic browser connection",
    preferred: true,
    needs: "a supported supervised browser available in the current CareerRat session",
    storesCreds: false,
    automatedApply: true,
  },
  extension: {
    id: "extension",
    label: "Chrome extension (Claude-in-Chrome / Codex)",
    preferred: false,
    needs: "the browser extension installed and signed into the platform",
    storesCreds: false,
    automatedApply: false,
  },
  orca: {
    id: "orca",
    label: "Orca supervised browser",
    preferred: false,
    needs: "CareerRat running inside an Orca workspace with its browser available",
    storesCreds: false,
    automatedApply: true,
  },
  playwright: {
    id: "playwright",
    label: "Playwright persistent profile",
    preferred: false,
    needs: "a one-time interactive login per platform (persistent profile reused after)",
    storesCreds: false,
    automatedApply: true,
  },
};

// The persistent-profile root must match scripts/capture-board-snapshot.mjs so the
// session browser and the headless capture path share one set of logged-in profiles.
export function defaultProfileRoot() {
  return join(homedir(), ".careerrat", "board-profiles");
}

// Per-provider/per-platform profile dir, e.g. ~/.careerrat/board-profiles/linkedin.
export function profilePath(platform, { profileRoot } = {}) {
  return join(profileRoot || defaultProfileRoot(), String(platform || "default"));
}

export function describeProviders() {
  return PROVIDER_PREFERENCE.map((id) => PROVIDERS[id]);
}

// Resolve the configured session for display. `data` is a loaded automation config
// (or its absence => defaults). Returns the provider, its descriptor, and the
// effective Playwright profile root (only meaningful when provider === playwright).
export function resolveSession({ data, env = process.env } = {}) {
  const configuredProvider = data?.session?.provider || "auto";
  const configured = PROVIDERS[configuredProvider] ? configuredProvider : "auto";
  const provider =
    configured === "auto" && env?.ORCA_WORKTREE_ID
      ? "orca"
      : configured === "auto"
        ? "extension"
        : configured;
  const profileRoot = data?.session?.profile_root || defaultProfileRoot();
  return {
    provider,
    configuredProvider: configured,
    descriptor: PROVIDERS[provider],
    preference: PROVIDER_PREFERENCE,
    profileRoot: provider === "playwright" ? profileRoot : null,
    note:
      configured === "auto"
        ? `Automatic setup selected ${PROVIDERS[provider].label}.`
        : `Using ${PROVIDERS[provider].label}.`,
  };
}

// Chrome-family browsers that can host the session-browser extension. We can't see
// INSIDE a browser from Node, so this only answers "is a compatible browser even
// installed?" — a real signal, honestly scoped (it never claims the extension itself
// is present). Platform-aware; unknown platforms degrade to "can't tell".
function detectChromeFamily() {
  const found = [];
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push(
      ["Google Chrome", "/Applications/Google Chrome.app"],
      ["Chromium", "/Applications/Chromium.app"],
      ["Brave", "/Applications/Brave Browser.app"],
      ["Microsoft Edge", "/Applications/Microsoft Edge.app"],
      ["Arc", "/Applications/Arc.app"]
    );
  } else if (process.platform === "linux") {
    candidates.push(
      ["Google Chrome", "/usr/bin/google-chrome"],
      ["Google Chrome", "/opt/google/chrome/chrome"],
      ["Chromium", "/usr/bin/chromium"],
      ["Chromium", "/usr/bin/chromium-browser"],
      ["Brave", "/usr/bin/brave-browser"],
      ["Microsoft Edge", "/usr/bin/microsoft-edge"]
    );
  } else if (process.platform === "win32") {
    const pf = process.env.PROGRAMFILES || "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    candidates.push(
      ["Google Chrome", join(pf, "Google", "Chrome", "Application", "chrome.exe")],
      ["Google Chrome", join(pf86, "Google", "Chrome", "Application", "chrome.exe")],
      ["Microsoft Edge", join(pf86, "Microsoft", "Edge", "Application", "msedge.exe")]
    );
  }
  for (const [name, p] of candidates) {
    if (!found.includes(name) && existsSync(p)) found.push(name);
  }
  return found;
}

// Best-effort presence probe for the playwright provider: count the per-platform
// persistent profiles the user has signed into. Empty/absent => "not set up yet".
function detectPlaywrightProfiles(profileRoot) {
  if (!profileRoot || !existsSync(profileRoot)) {
    return {
      status: "missing",
      signedIn: [],
      detail: `no persistent profiles yet (${profileRoot}) — sign in once per platform`,
    };
  }
  const signedIn = readdirSync(profileRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (!signedIn.length) {
    return {
      status: "missing",
      signedIn: [],
      detail: `profile root exists but is empty (${profileRoot}) — sign in once per platform`,
    };
  }
  return {
    status: "ready",
    signedIn,
    detail: `${signedIn.length} signed-in profile(s): ${signedIn.join(", ")}`,
  };
}

// detectSession — resolveSession() PLUS a best-effort, never-throwing presence
// probe so `doctor`/`configure` can tell the user whether the session browser is
// actually ready, not just which provider is configured. Status values:
//   ready      — verifiable signal that the session browser is set up (playwright
//                profiles exist).
//   unverified — a compatible browser is installed but the extension can't be seen
//                from outside the browser; the user must confirm it in Chrome.
//   missing    — nothing detected (no browser / no profiles).
//   unknown    — the probe itself failed (informational only; never fatal).
// This NEVER drives a browser and NEVER throws — doctor must not fail on it.
export function detectSession({ data, env = process.env } = {}) {
  const base = resolveSession({ data, env });
  let presence;
  try {
    if (base.provider === "playwright") {
      presence = detectPlaywrightProfiles(base.profileRoot);
    } else if (base.provider === "orca") {
      presence = env?.ORCA_WORKTREE_ID
        ? {
            status: "ready",
            detail: "Orca workspace detected; browser readiness is verified when Apply starts",
          }
        : {
            status: "unverified",
            detail: "Orca provider selected; browser readiness is verified when Apply starts",
          };
    } else {
      const browsers = detectChromeFamily();
      presence = browsers.length
        ? {
            status: "unverified",
            browsers,
            detail: `${browsers.join(", ")} detected — confirm the extension is installed + signed in (can't be verified from outside the browser). Automatic apply isn't available on this provider yet; switch to the Playwright provider for it.`,
          }
        : {
            status: "missing",
            browsers: [],
            detail:
              "no Chrome-family browser found — install Chrome + the session-browser extension (or switch to the Playwright provider). Automatic apply isn't available on this provider yet either way.",
          };
    }
  } catch {
    presence = { status: "unknown", detail: "presence check failed (non-fatal)" };
  }
  return { ...base, presence };
}
