export const DEFAULT_RUNTIME_TOOL_PROFILE = "app-safe";

export const APP_SAFE_RUNTIME_TOOLS = Object.freeze(["Read", "Glob", "Grep", "Skill"]);

// Network research is deliberately disjoint from local file reads. This is a
// structural prompt-injection boundary: fetched content cannot read candidate
// files or credentials, and local-data workflows cannot make outbound calls.
export const CHAT_RUNTIME_TOOLS = Object.freeze(["WebSearch", "WebFetch", "Skill"]);

const NETWORK_CHAT_SKILLS = new Set([
  "research-boards",
  "discover-companies",
  "search-jobs",
  "research-company",
  "research-comp",
  "company-health",
]);

export const INSTALLED_SKILL_CAPABILITIES = Object.freeze({
  // The model may interpret the skill and propose the next step, but every
  // mutation/browser action stays in CareerRat's typed app workflow after a
  // visible user action. `Skill` is not a side-effect authority.
  appWorkflow: Object.freeze([
    "apply-job",
    "calendar-sync",
    "configure",
    "ingest-mail",
    "ingest-messages",
    "optimize-linkedin",
    "relationship-sourcing",
    "report-issue",
    "schedule-meeting",
    "setup-searches",
    "sync-status",
    "track-outcomes",
  ]),
  // These produce a bounded model result from server-supplied context. They
  // receive no local file, network, browser, shell, or mutation capability.
  modelResult: Object.freeze([
    "answer-question",
    "coach-gaps",
    "email-comms",
    "evaluate-job",
    "ingest-profile",
    "interview-prep",
    "reevaluate-strategy",
    "tailor-application",
  ]),
  exactRead: Object.freeze(["intake-extract", "resume-extract"]),
  publicWeb: Object.freeze([
    "company-health",
    "discover-companies",
    "research-boards",
    "research-comp",
    "research-company",
    "search-jobs",
  ]),
});

const INSTALLED_SKILL_CAPABILITY_BY_NAME = new Map(
  Object.entries(INSTALLED_SKILL_CAPABILITIES).flatMap(([capability, skills]) =>
    skills.map((skill) => [skill, capability])
  )
);

export function resolveInstalledSkillRuntimeTools({ skill } = {}) {
  return resolveInstalledSkillRuntimeCapability({ skill }).tools;
}

export function resolveInstalledSkillRuntimeCapability({ skill } = {}) {
  const normalized = String(skill || "").trim();
  const kind = INSTALLED_SKILL_CAPABILITY_BY_NAME.get(normalized);
  if (!kind) {
    const error = new Error(`skill "${normalized}" has no installed runtime capability`);
    error.code = "RUNTIME_SKILL_CAPABILITY_UNKNOWN";
    throw error;
  }
  const tools =
    kind === "exactRead"
      ? ["Read", "Skill"]
      : kind === "publicWeb"
        ? [...CHAT_RUNTIME_TOOLS]
        : ["Skill"];
  return {
    kind,
    completion:
      kind === "appWorkflow"
        ? "app_owned_workflow"
        : kind === "publicWeb"
          ? "visible_save_required"
          : "model_result",
    tools,
  };
}

export function installedSkillRuntimePosture({ skill } = {}) {
  const { completion } = resolveInstalledSkillRuntimeCapability({ skill });
  if (completion === "app_owned_workflow") {
    return "CareerRat's app-owned typed workflow performs every write or side effect after a visible user action. Propose the next action; do not claim it ran.";
  }
  if (completion === "visible_save_required") {
    return "Research is read-only in this runtime. Any durable save is a visible app-owned action; do not claim it was saved.";
  }
  return "Do not claim any write or side effect; this run can only return its bounded model result.";
}

export const RUNTIME_TOOL_PROFILES = Object.freeze({
  "app-safe": APP_SAFE_RUNTIME_TOOLS,
  chat: CHAT_RUNTIME_TOOLS,
});

export function resolveChatRuntimeTools({ skill } = {}) {
  return NETWORK_CHAT_SKILLS.has(String(skill || "").trim())
    ? [...CHAT_RUNTIME_TOOLS]
    : [...APP_SAFE_RUNTIME_TOOLS];
}

export function resolveRuntimeTools({ tools, toolProfile, profile } = {}) {
  if (Array.isArray(tools)) {
    const safeTools = new Set([...APP_SAFE_RUNTIME_TOOLS, ...CHAT_RUNTIME_TOOLS]);
    const invalid = tools.find((tool) => !safeTools.has(tool));
    if (invalid) {
      const err = new Error(`runtime tool "${invalid}" is not allowed by any sandboxed profile`);
      err.code = "RUNTIME_TOOL_PROFILE_INVALID";
      throw err;
    }
    return [...tools];
  }

  const selectedProfile = String(toolProfile ?? profile ?? DEFAULT_RUNTIME_TOOL_PROFILE).trim();
  const normalizedProfile = selectedProfile || DEFAULT_RUNTIME_TOOL_PROFILE;
  if (!Object.hasOwn(RUNTIME_TOOL_PROFILES, normalizedProfile)) {
    const err = new Error(
      `unsupported runtime tool profile "${normalizedProfile}" (expected: ${Object.keys(
        RUNTIME_TOOL_PROFILES
      ).join(", ")})`
    );
    err.code = "RUNTIME_TOOL_PROFILE_INVALID";
    err.profile = normalizedProfile;
    err.allowedProfiles = Object.keys(RUNTIME_TOOL_PROFILES);
    throw err;
  }

  return [...RUNTIME_TOOL_PROFILES[normalizedProfile]];
}
