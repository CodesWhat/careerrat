import { authorizationDeclared } from "../db/verbs.mjs";

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
  const minimumBase = Number(profile.compensation?.minimum_base);
  const locationReady =
    !!String(profileLocation.home || "").trim() ||
    !!profileLocation.hybrid ||
    !!profileLocation.onsite ||
    (Array.isArray(profileLocation.relocation) && profileLocation.relocation.length > 0);

  const done = {
    engine: !!keyConfigured,
    resume: resumeValuePresent(data, sourceResumePresent),
    roles: (targeting.role_buckets ?? []).some((bucket) => (bucket?.titles ?? []).length > 0),
    companies: (targeting.tracked_companies ?? []).length > 0,
    evidence: (data.evidence?.claims ?? []).length > 0,
    guardrails: (targeting.cut_signals ?? []).length > 0,
    quickFacts: locationReady && Number.isFinite(minimumBase) && minimumBase > 0,
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
