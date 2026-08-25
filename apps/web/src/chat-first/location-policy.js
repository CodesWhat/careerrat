const US_HOME_ALIASES = [
  /\bnyc\b/i,
  /\bnew york(?: city)?(?:,? ny)?\b/i,
  /\bunited states\b/i,
  /\bu\.?s\.?a?\.?\b/i,
];

function text(value) {
  return String(value || "").trim();
}

function compactPolicy(value) {
  const raw = text(value);
  if (!raw || raw === "Not set") return null;
  const divider = raw.lastIndexOf(" - ");
  const modes = divider >= 0 ? raw.slice(0, divider) : "";
  const home = divider >= 0 ? raw.slice(divider + 3).trim() : raw;
  return {
    home,
    remote: /\bremote\b/i.test(modes),
    remote_scope: /\bworldwide\b/i.test(modes) ? "worldwide" : "home-country",
    hybrid: /\bhybrid\b/i.test(modes),
    onsite: /\bon-?site\b/i.test(modes),
    relocation: [],
    mode_preferences_confirmed: true,
  };
}

function locationInput(value) {
  if (typeof value === "string") return compactPolicy(value);
  if (!value || typeof value !== "object") return null;
  return value;
}

function isUnitedStatesHome(home) {
  return US_HOME_ALIASES.some((pattern) => pattern.test(home));
}

export function buildLocationPolicy(value) {
  const location = locationInput(value);
  if (!location) return null;
  const home = text(location.home);
  const remote = location.remote === true;
  const remoteScope = location.remote_scope === "worldwide" ? "worldwide" : "home-country";
  const hybrid = location.hybrid === true;
  const onsite = location.onsite === true;
  const relocation = Array.isArray(location.relocation)
    ? location.relocation.map(text).filter(Boolean)
    : [];
  if (!home && !remote && !hybrid && !onsite) return null;

  const remoteRegion = remote
    ? remoteScope === "worldwide"
      ? "Worldwide"
      : isUnitedStatesHome(home)
        ? "United States"
        : "Home country"
    : null;
  const summaryParts = [];
  if (home && (hybrid || onsite)) summaryParts.push(`${home} local`);
  if (remote) {
    summaryParts.push(
      remoteScope === "worldwide"
        ? "worldwide remote"
        : `${remoteRegion === "United States" ? "US" : "Home-country"} remote`
    );
  }

  const onsitePlaces = [home, ...relocation].filter(Boolean);
  return {
    home: home || "Not set",
    remoteRegion,
    remoteScope,
    hybrid,
    onsite,
    confirmed: location.mode_preferences_confirmed === true,
    summary: summaryParts.join(" + ") || "Location policy needs confirmation",
    boundary: onsite
      ? `On-site limited to ${onsitePlaces.join(" + ") || "saved locations"}`
      : "On-site roles excluded",
  };
}
