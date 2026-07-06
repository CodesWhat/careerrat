export const DEFAULT_RUNTIME_TOOL_PROFILE = "app-safe";

export const APP_SAFE_RUNTIME_TOOLS = Object.freeze(["Read", "Glob", "Grep", "WebFetch", "Skill"]);

export const TOOL_HEAVY_RUNTIME_TOOLS = Object.freeze([
  ...APP_SAFE_RUNTIME_TOOLS,
  "Write",
  "Edit",
  "Bash",
]);

export const CHAT_RUNTIME_TOOLS = Object.freeze([...APP_SAFE_RUNTIME_TOOLS, "WebSearch"]);

export const RUNTIME_TOOL_PROFILES = Object.freeze({
  "app-safe": APP_SAFE_RUNTIME_TOOLS,
  "tool-heavy": TOOL_HEAVY_RUNTIME_TOOLS,
  chat: CHAT_RUNTIME_TOOLS,
});

export function isToolHeavyProfile(toolProfile) {
  return toolProfile === "tool-heavy";
}

export function resolveRuntimeTools({ tools, toolProfile, profile } = {}) {
  if (Array.isArray(tools)) return [...tools];

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
