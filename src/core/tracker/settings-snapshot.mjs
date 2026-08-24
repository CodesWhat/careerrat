import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { displayPath, userPath } from "../paths/workspace.mjs";
import {
  CANDIDATE_DOCS,
  candidateDocNames,
  loadCandidateConfig,
} from "../profile/config-store.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const CONFIG_FILES = [
  "candidate/profile.yml",
  "candidate/targeting.yml",
  "candidate/honesty.yml",
  "candidate/form-defaults.yml",
  "candidate/modes.yml",
  "candidate/application-limits.yml",
  "candidate/automation.yml",
  "candidate/research-prefs.yml",
  "candidate/stories.yml",
];

const CAPABILITY_LABELS = {
  status_polling: "Status polling",
  authenticated_search: "Authenticated search",
  messaging: "Messaging",
  authenticated_apply_preparation: "Authenticated apply preparation",
  mail_access: "Mail access",
  profile_optimize: "Profile optimization",
  profile_apply: "Profile write-back",
};

const PROVIDER_LABELS = {
  auto: "Automatic browser connection",
  extension: "Browser extension",
  orca: "Orca supervised browser",
  playwright: "Playwright profile",
};

function formatBase(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "Not set";
  if (num >= 1000) return `$${Math.round(num / 1000)}K`;
  return `$${num}`;
}

// Raw $K figure alongside the display string above — the Jobs drawer's comp
// pins need a real number to plot on the gauge, not a formatted "$200K"
// string to re-parse. null when unset so callers never fabricate a number.
function baseK(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num / 1000) : null;
}

function compactLocation(location = {}, candidate = {}) {
  const modes = [];
  if (location.remote) modes.push("Remote");
  if (location.hybrid) modes.push("hybrid");
  if (location.onsite) modes.push("on-site");
  const home = String(location.home || candidate.location || "").trim();
  if (!modes.length && !home) return "Not set";
  if (!modes.length) return home;
  return home ? `${modes.join(" / ")} - ${home}` : modes.join(" / ");
}

function workAuthorization(auth = {}) {
  if (auth.work_authorized && auth.requires_sponsorship === false) {
    return "Authorized; no sponsorship";
  }
  if (auth.work_authorized) return "Authorized";
  if (auth.requires_sponsorship) return "Needs sponsorship";
  return "Not set";
}

function enabledCapabilities(automation = {}) {
  const caps = automation.capabilities || {};
  return Object.entries(caps)
    .filter(([, value]) => value?.enabled)
    .map(([key]) => CAPABILITY_LABELS[key] || key.replace(/_/g, " "))
    .sort((a, b) => a.localeCompare(b));
}

export function buildSettingsSnapshot({
  profile = {},
  targeting = {},
  honesty = {},
  automation = {},
  files = [],
} = {}) {
  const candidate = profile.candidate || {};
  const compensation = profile.compensation || {};
  const location = profile.location || {};
  const authorization = profile.authorization || {};
  const sessionProvider = automation?.session?.provider || "not configured";
  // Optional logo.dev publishable token (PRIVATE candidate config; never committed).
  // Absent → dashboard avatars stay initials chips. No hardcoded default.
  const logoToken = automation?.integrations?.logo_dev_token || automation?.logo_dev_token || "";

  return {
    logoToken,
    profile: {
      candidate: candidate.full_name || candidate.preferred_name || "Not set",
      headline: candidate.headline || candidate.domain || "Not set",
      location: compactLocation(location, candidate),
      minimumBase: formatBase(compensation.minimum_base),
      targetBase: formatBase(compensation.target_base),
      expectedBase: formatBase(compensation.expected_base),
      minimumBaseK: baseK(compensation.minimum_base),
      targetBaseK: baseK(compensation.target_base),
      expectedBaseK: baseK(compensation.expected_base),
      workAuthorization: workAuthorization(authorization),
    },
    targeting: {
      primaryRoles: (targeting.role_buckets || [])
        .filter((bucket) => bucket && (!bucket.priority || bucket.priority === "primary"))
        .flatMap((bucket) => bucket.titles || [])
        .filter(Boolean)
        .slice(0, 4),
      excludedCompanies: (targeting.excluded_companies || []).filter(Boolean).slice(0, 6),
    },
    honesty: {
      boundaries: [
        ...(honesty?.tools?.do_not_claim || []),
        ...(honesty?.claims?.do_not_fabricate || []),
      ]
        .filter(Boolean)
        .slice(0, 5),
    },
    automation: {
      sessionProvider: PROVIDER_LABELS[sessionProvider] || sessionProvider,
      enabledCapabilities: enabledCapabilities(automation),
    },
    files: files.filter(Boolean),
  };
}

export function loadSettingsSnapshot({ root = DEFAULT_ROOT } = {}) {
  const config = loadCandidateConfig({ repoRoot: root });
  const files = new Set(
    CONFIG_FILES.filter((relPath) => existsSync(userPath({ repoRoot: root }, relPath))).map(
      (relPath) => displayPath({ repoRoot: root }, relPath)
    )
  );
  if (config.mode === "db") {
    for (const name of candidateDocNames()) {
      if (name === "automation" && Object.keys(config.automation || {}).length === 0) continue;
      files.add(displayPath({ repoRoot: root }, CANDIDATE_DOCS[name].candidatePath));
    }
  }
  return buildSettingsSnapshot({
    profile: config.profile || {},
    targeting: config.targeting || {},
    honesty: config.honesty || {},
    automation: config.automation || {},
    files: [...files],
  });
}
