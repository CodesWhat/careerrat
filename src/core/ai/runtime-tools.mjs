export const DEFAULT_RUNTIME_TOOL_PROFILE = "app-safe";

export const APP_SAFE_RUNTIME_TOOLS = Object.freeze(["Read", "Glob", "Grep", "Skill"]);

// Network research is deliberately disjoint from local file reads. This is a
// structural prompt-injection boundary: fetched content cannot read candidate
// files or credentials, and local-data workflows cannot make outbound calls.
export const CHAT_RUNTIME_TOOLS = Object.freeze(["WebSearch", "WebFetch", "Skill"]);

const NETWORK_CHAT_SKILLS = new Set(["research-boards", "discover-companies", "search-jobs"]);

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
