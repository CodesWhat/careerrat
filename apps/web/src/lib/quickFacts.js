// apps/web/src/lib/quickFacts.js — pure profile-links/comp/authorization/
// location save-payload shaping, moved out of the dead onboarding wizard
// step (formerly onboarding/steps/PrefsStep.jsx) that this logic survived.
// settings/SettingsPage.jsx is the sole consumer, via buildQuickFactsSavePayload.
// The rest of these are private composition helpers — moved verbatim,
// behavior unchanged.

const DEFAULT_MODES = {
  usage_mode: "standard",
  application_mode: "balanced",
  agent_voice: "standard",
};

const LINK_FIELDS = ["linkedin", "github", "portfolio"];
const ADDITIONAL_LINK_PREFIX = "https://";

const LINK_PREFIXES = {
  linkedin: "https://linkedin.com/in/",
  github: "https://github.com/",
  portfolio: "https://",
};

function normalizePrefixedLinkValue(value, prefix) {
  let text = String(value || "").trim();
  const normalizedPrefix = String(prefix || "");
  while (
    normalizedPrefix &&
    text.toLowerCase().startsWith(normalizedPrefix.toLowerCase()) &&
    /^[a-z][a-z0-9+.-]*:\/\//i.test(text.slice(normalizedPrefix.length))
  ) {
    text = text.slice(normalizedPrefix.length);
  }
  return text;
}

function cleanPrimaryLinkFields(values = {}) {
  return Object.fromEntries(
    LINK_FIELDS.map((field) => [
      field,
      normalizePrefixedLinkValue(values[field], LINK_PREFIXES[field]),
    ])
  );
}

function cleanAdditionalLinks(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((link) => ({
      label: String(link?.label || "").trim() || "Link",
      url: normalizePrefixedLinkValue(link?.url, ADDITIONAL_LINK_PREFIX),
    }))
    .filter((link) => link.url);
}

function cleanLinkFields(values = {}) {
  return {
    ...cleanPrimaryLinkFields(values),
    additional_links: cleanAdditionalLinks(values.additional_links),
  };
}

function compensationPatch(minimumBase) {
  return typeof minimumBase === "number" && Number.isFinite(minimumBase) && minimumBase > 0
    ? { compensation: { minimum_base: minimumBase } }
    : {};
}

function authorizationPatch(authChoice) {
  if (authChoice === "authorized") {
    return { authorization: { work_authorized: true, requires_sponsorship: false } };
  }
  if (authChoice === "sponsorship") {
    return { authorization: { work_authorized: false, requires_sponsorship: true } };
  }
  return {};
}

// profile.location shape mirrors EXACTLY what generate-search-sources.mjs
// reads (loc.remote / loc.home / loc.relocation, ~lines 115-127 there) — no
// extra fields. Lenient like compensationPatch/authorizationPatch above: any
// signal (a work mode pick, a home base, or a relocation city) is enough to
// write the object; all-empty means nothing to say yet, so skip the patch
// rather than stomping a previously-saved value with zeros.
function locationPatch({
  workModes = [],
  homeBase = "",
  relocationList = [],
  commuteRadiusMiles = null,
} = {}) {
  const remote = Array.isArray(workModes) && workModes.includes("remote");
  const hybrid = Array.isArray(workModes) && workModes.includes("hybrid");
  const onsite = Array.isArray(workModes) && workModes.includes("onsite");
  const home = String(homeBase || "").trim();
  const relocation = (Array.isArray(relocationList) ? relocationList : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!remote && !hybrid && !onsite && !home && !relocation.length) return {};
  const commuteRadius = Number(commuteRadiusMiles);
  return {
    location: {
      remote,
      hybrid,
      onsite,
      home,
      relocation,
      ...(Number.isFinite(commuteRadius) && commuteRadius > 0
        ? { commute_radius_miles: commuteRadius }
        : {}),
    },
  };
}

// The resume-header location string (candidate.location) only gets filled in
// from the onboarding home-base field when it's genuinely empty — never
// overwritten once the resume (or a prior save) already set it.
function candidateLocationPatch({ homeBase = "", existingCandidateLocation = "" } = {}) {
  const home = String(homeBase || "").trim();
  const existing = String(existingCandidateLocation || "").trim();
  if (!home || existing) return {};
  return { location: home };
}

export function buildQuickFactsSavePayload({
  links = {},
  modesData = {},
  formDefaultsData = {},
  minimumBase = null,
  authChoice = null,
  workModes = [],
  homeBase = "",
  relocationList = [],
  commuteRadiusMiles = null,
  existingCandidateLocation = "",
} = {}) {
  const cleanedLinks = cleanLinkFields(links);
  return {
    profile: {
      candidate: {
        ...cleanedLinks,
        ...candidateLocationPatch({ homeBase, existingCandidateLocation }),
      },
      ...compensationPatch(minimumBase),
      ...authorizationPatch(authChoice),
      ...locationPatch({ workModes, homeBase, relocationList, commuteRadiusMiles }),
    },
    modes: {
      usage_mode: modesData.usage_mode ?? DEFAULT_MODES.usage_mode,
      application_mode: modesData.application_mode ?? DEFAULT_MODES.application_mode,
      agent_voice: modesData.agent_voice ?? DEFAULT_MODES.agent_voice,
    },
    formDefaults: {
      auto_submit: false,
      eeo_default: String(formDefaultsData.eeo_default || "").trim() || "Prefer not to answer",
      ...cleanedLinks,
    },
  };
}
