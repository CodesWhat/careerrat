// Career Ops' original helper reads its own config/profile.yml. CareerRat keeps
// candidate state in its workspace database, so the registry translates generic
// search keywords into provider-specific entry fields before invoking VDAB. This
// compatibility module intentionally has no ambient filesystem fallback.

function cleanKeywords(value) {
  const values = Array.isArray(value) ? value : [];
  return [
    ...new Set(
      values
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    ),
  ];
}

export function profileTargetKeywords(profile) {
  const roles = profile?.target_roles;
  if (!roles || typeof roles !== "object") return [];
  return cleanKeywords([
    ...(Array.isArray(roles.primary) ? roles.primary : []),
    ...(Array.isArray(roles.archetypes)
      ? roles.archetypes.map((archetype) => archetype?.name)
      : []),
  ]);
}

export function resolveProfileKeywords() {
  return [];
}

