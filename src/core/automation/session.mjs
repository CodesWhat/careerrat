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
//   1. auto       — use Orca in an Orca workspace, bundled Playwright in the
//                   packaged desktop app, otherwise the compatible extension.
//   2. extension  — Chrome extension (Claude-in-Chrome / Codex), which holds the
//                   user's logins + password store.
//   3. orca       — Orca's supervised embedded browser.
//   4. playwright — a persistent Playwright profile CareerRat creates on demand;
//                   workflows surface authentication only when a site requires it.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const requireFromSession = createRequire(import.meta.url);

const DEFAULT_PLAYWRIGHT_TOOLING_DEPENDENCIES = {
  resolvePackage: () => requireFromSession.resolve("playwright"),
  loadPackage: () => requireFromSession("playwright"),
  pathExists: existsSync,
};

export const PROVIDER_PREFERENCE = ["auto", "extension", "orca", "playwright"];

export function detectPlaywrightTooling(dependencies = {}) {
  const {
    resolvePackage = DEFAULT_PLAYWRIGHT_TOOLING_DEPENDENCIES.resolvePackage,
    loadPackage = DEFAULT_PLAYWRIGHT_TOOLING_DEPENDENCIES.loadPackage,
    pathExists = DEFAULT_PLAYWRIGHT_TOOLING_DEPENDENCIES.pathExists,
  } = dependencies;

  try {
    resolvePackage();
  } catch {
    return {
      packageInstalled: false,
      browserInstalled: false,
      ready: false,
      detail: "Playwright is not installed.",
    };
  }

  try {
    const playwright = loadPackage();
    const executablePath = playwright?.chromium?.executablePath?.();
    if (typeof executablePath !== "string" || executablePath.length === 0) {
      throw new Error("Chromium executable path is unavailable");
    }
    const browserInstalled = pathExists(executablePath) === true;
    return {
      packageInstalled: true,
      browserInstalled,
      ready: browserInstalled,
      detail: browserInstalled
        ? "Playwright and Chromium are installed."
        : "Playwright is installed, but its Chromium executable is missing.",
    };
  } catch {
    return {
      packageInstalled: true,
      browserInstalled: false,
      ready: false,
      detail: "Playwright is installed, but Chromium readiness could not be verified.",
    };
  }
}

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
    needs: "CareerRat opens a supervised browser when a workflow needs it",
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

// resolveAutoTarget — the one piece of resolveSession()'s logic that decides what
// the "auto" meta-provider actually becomes right now: Orca inside an Orca
// workspace, bundled Playwright in the packaged desktop app, and the extension
// otherwise. Shared so describeProviders() can report the SAME resolved provider
// resolveSession() would pick, instead of each re-deriving it (and risking drift).
function resolveAutoTarget(env) {
  if (env?.ORCA_WORKTREE_ID) return "orca";
  if (env?.CAREERRAT_PACKAGED_DESKTOP === "1") return "playwright";
  return "extension";
}

// describeProviders — the provider list for display (Settings, `automation
// status`). "auto" is a meta-choice, not a concrete provider, so its advertised
// `automatedApply` is resolved against what it actually becomes right now (Orca /
// packaged desktop state) rather than the descriptor's own optimistic `true`.
// Outside Orca and the packaged desktop app, "auto" resolves to the extension
// executor, which genuinely can't drive automatic apply. The same resolved-provider
// truth backs both the option list here and the session JSON.
export function describeProviders({ env = process.env } = {}) {
  return PROVIDER_PREFERENCE.map((id) => {
    const descriptor = PROVIDERS[id];
    if (id !== "auto") return descriptor;
    const resolved = resolveAutoTarget(env);
    return { ...descriptor, automatedApply: PROVIDERS[resolved].automatedApply };
  });
}

// automaticApplyGap — the single, provider-neutral verdict on whether a given
// session provider can drive apply-job's scripted/headless apply path. This is a
// core-layer decision (what's true about the provider), not a CLI or executor
// concern, so both `src/cli/automation.mjs` (session/status display) and
// `src/core/apply/apply-executor-factory.mjs` (the actual executor result) format
// this SAME result instead of each hardcoding their own copy of "this provider
// can't do it" — which is exactly how those two messages drifted apart before.
//
// Deliberately never names a specific replacement provider: which provider a
// candidate should switch to is a choice for them to make, not a fact this layer
// can assert (see AGENTS.md Domain-Neutral Rule — no hardcoded fallback
// recommendation). Callers point the user at `careerrat automation status` to see
// the actual provider options rather than one baked-in suggestion.
export function automaticApplyGap(provider) {
  const descriptor = PROVIDERS[provider];
  if (descriptor?.automatedApply !== false) return null;
  return {
    provider,
    label: descriptor.label,
    reason:
      `Automatic apply isn't available on the ${descriptor.label} provider yet. ` +
      "Choose a provider that supports automatic apply (see `careerrat automation status`) " +
      "with `careerrat automation session <provider> --write`.",
  };
}

// Resolve the configured session for display. `data` is a loaded automation config
// (or its absence => defaults). Returns the provider, its descriptor, and the
// effective Playwright profile root (only meaningful when provider === playwright).
export function resolveSession({ data, env = process.env } = {}) {
  const configuredProvider = data?.session?.provider || "auto";
  const configured = PROVIDERS[configuredProvider] ? configuredProvider : "auto";
  const provider = configured === "auto" ? resolveAutoTarget(env) : configured;
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

// detectSession — resolveSession() PLUS a best-effort, never-throwing presence
// probe so `doctor`/`configure` can tell the user whether the session browser is
// actually ready, not just which provider is configured. Status values:
//   ready      — verifiable signal that the session browser can launch.
//   unverified — a compatible browser is installed but the extension can't be seen
//                from outside the browser; the user must confirm it in Chrome.
//   missing    — nothing launchable was detected.
//   unknown    — the probe itself failed (informational only; never fatal).
// This NEVER drives a browser and NEVER throws — doctor must not fail on it.
export function detectSession({ data, env = process.env, playwrightToolingDependencies } = {}) {
  const base = resolveSession({ data, env });
  let presence;
  try {
    if (base.provider === "playwright") {
      const tooling = detectPlaywrightTooling(playwrightToolingDependencies);
      presence = tooling.ready
        ? {
            status: "ready",
            detail: "CareerRat can open a browser when a job needs one.",
          }
        : {
            status: "missing",
            detail: "CareerRat's browser isn't ready yet.",
          };
    } else if (base.provider === "orca") {
      presence = env?.ORCA_WORKTREE_ID
        ? {
            status: "ready",
            detail: "CareerRat can open a browser when a job needs one.",
          }
        : {
            status: "unverified",
            detail: "CareerRat will check the browser when you start an application.",
          };
    } else {
      const browsers = detectChromeFamily();
      presence = browsers.length
        ? {
            status: "unverified",
            browsers,
            detail: "CareerRat needs one more setup step before it can help with job forms.",
            nextStep: {
              kind: "choose",
              provider: "playwright",
              label: "Use CareerRat browser",
            },
          }
        : {
            status: "missing",
            browsers: [],
            detail: "CareerRat needs a browser connection before it can help with job forms.",
            nextStep: {
              kind: "choose",
              provider: "playwright",
              label: "Use CareerRat browser",
            },
          };
    }
  } catch {
    presence = {
      status: "unknown",
      detail: "CareerRat couldn't check the browser. Try again.",
    };
  }
  return { ...base, presence };
}
