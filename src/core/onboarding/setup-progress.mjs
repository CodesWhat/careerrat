import { authorizationDeclared } from "../db/verbs.mjs";
import { hasConfiguredCompensationFloor } from "../profile/compensation.mjs";

const SETUP_PROGRESS_ITEMS = [
  "engine",
  "resume",
  "roles",
  "companies",
  "evidence",
  "guardrails",
  "quickFacts",
  "authorization",
];

function authorizationValuePresent(data = {}) {
  return authorizationDeclared(data.profile || {}, data["form-defaults"] || {});
}

function resumeValuePresent(data = {}, sourceResumePresent = false) {
  if (sourceResumePresent) return true;
  return !!data["form-defaults"]?.declined_fields?.resume;
}

export function computeSetupProgress({
  data = {},
  sourceResumePresent = false,
  keyConfigured = false,
} = {}) {
  const targeting = data.targeting || {};
  const profile = data.profile || {};
  const profileLocation = profile.location || {};
  const locationReady =
    profileLocation.mode_preferences_confirmed === true &&
    (!!String(profileLocation.home || "").trim() ||
      profileLocation.remote === true ||
      !!profileLocation.hybrid ||
      !!profileLocation.onsite ||
      (Array.isArray(profileLocation.relocation) && profileLocation.relocation.length > 0));

  const done = {
    engine: !!keyConfigured,
    resume: resumeValuePresent(data, sourceResumePresent),
    roles: (targeting.role_buckets ?? []).some((bucket) => (bucket?.titles ?? []).length > 0),
    companies:
      targeting.company_preferences?.confirmed === true ||
      (targeting.tracked_companies ?? []).length > 0,
    evidence: (data.evidence?.claims ?? []).length > 0,
    guardrails: (targeting.cut_signals ?? []).length > 0,
    quickFacts: locationReady && hasConfiguredCompensationFloor(profile.compensation),
    authorization: authorizationValuePresent(data),
  };

  const completedCount = SETUP_PROGRESS_ITEMS.filter((key) => done[key]).length;
  return {
    items: SETUP_PROGRESS_ITEMS.map((key) => ({ key, done: done[key] })),
    completedCount,
    total: SETUP_PROGRESS_ITEMS.length,
    complete: completedCount === SETUP_PROGRESS_ITEMS.length,
  };
}
