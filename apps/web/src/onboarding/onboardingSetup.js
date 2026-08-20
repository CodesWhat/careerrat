// onboardingSetup.js — pure view-model helpers for the W4 chat-first
// onboarding surface (OnboardingPage.jsx, EngineScreen.jsx,
// InterviewSurface.jsx, FilePane.jsx). Kept dependency-free (no React, no
// fetch) so every branch here is trivially unit-testable and reusable across
// the engine gate, the file pane, and the mini-progress row without either
// component re-deriving the same shape.
//
// The 8 setup items (engine, resume, roles, companies, evidence, guardrails,
// quickFacts, authorization — the last added for Lane A / R5) mirror
// src/cli/onboard-route.mjs's computeSetupProgress() — GET
// /api/onboard/state's `setupProgress` field is the source of truth for
// which items are "done"; this module only adds display copy (labels,
// detail lines, UP NEXT) on top of that server-computed done/undone shape.
//
// `consent` (automation setup_mode) was REMOVED from the setup checklist —
// see computeSetupProgress's own SETUP_PROGRESS_ITEMS comment in
// onboard-route.mjs for why. Automation consent still works everywhere it
// already lived (Settings' automation controls, the interview's own
// consent_mode/consent_capability confirm pills) — it's just no longer a
// setup row here.

export const SETUP_ITEM_ORDER = [
  "engine",
  "resume",
  "roles",
  "companies",
  "evidence",
  "guardrails",
  "quickFacts",
  "authorization",
];

export const SETUP_ITEM_LABELS = {
  engine: "Engine",
  resume: "Resume",
  roles: "Roles",
  companies: "Company focus",
  evidence: "Evidence",
  guardrails: "Guardrails",
  quickFacts: "Quick facts",
  authorization: "Work authorization",
};

// The compact mono-caps chip row shown in 3a (centered, before docking) —
// same items, just uppercase short labels.
const SETUP_CHIP_LABELS = {
  engine: "ENGINE",
  resume: "RESUME",
  roles: "ROLES",
  companies: "COMPANIES",
  evidence: "EVIDENCE",
  guardrails: "GUARDRAILS",
  quickFacts: "QUICK FACTS",
  authorization: "AUTHORIZATION",
};

const ARRANGEMENT_FLOORS = [
  ["remote", "Remote"],
  ["hybrid", "Hybrid"],
  ["onsite", "On-site"],
  ["relocation", "Relocation"],
];

function compactFloor(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return `$${Math.round(amount / 1000)}K floor`;
}

function arrangementFloorDetails(compensation = {}) {
  const floors = compensation.comp_floors ?? {};
  return ARRANGEMENT_FLOORS.flatMap(([key, label]) => {
    const floor = compactFloor(floors[key]);
    return floor ? [`${label} ${floor}`] : [];
  });
}

// Builds the ordered row view model the mini-progress row and the file
// pane both render from. `doneByKey` comes straight off
// state.setupProgress.items (server-computed); this never re-derives
// done-ness itself. The "next" flag marks the first not-done item after the
// last done one (design's "UP NEXT" chip) — only ever one row at a time.
export function buildSetupItemViewModels(doneByKey = {}) {
  let nextAssigned = false;
  return SETUP_ITEM_ORDER.map((key) => {
    const done = !!doneByKey[key];
    const isNext = !done && !nextAssigned;
    if (isNext) nextAssigned = true;
    return { key, label: SETUP_ITEM_LABELS[key], chipLabel: SETUP_CHIP_LABELS[key], done, isNext };
  });
}

export function setupProgressFromState(state) {
  const items = state?.setupProgress?.items;
  if (!Array.isArray(items)) return {};
  return Object.fromEntries(items.map((item) => [item.key, !!item.done]));
}

// profile.location.remote starts true as a search-recall fallback, not as a
// candidate answer. New writes carry mode_preferences_confirmed so the UI can
// distinguish the two. The setup-progress fallback keeps older completed
// profiles readable without letting an unrelated profile write expose Remote.
export function locationModePreferencesConfirmed(state) {
  const explicit = state?.data?.profile?.location?.mode_preferences_confirmed;
  if (typeof explicit === "boolean") return explicit;
  const quickFacts = state?.setupProgress?.items?.find((item) => item?.key === "quickFacts");
  return quickFacts ? quickFacts.done === true : true;
}

export function setupCompletedCount(state) {
  return state?.setupProgress?.completedCount ?? 0;
}

// Lane A / R5 — the header/completion-screen "X of N" copy must read the
// server-computed total rather than a hardcoded item count, so a future
// setup-item addition never desyncs the two.
export function setupTotal(state) {
  return state?.setupProgress?.total ?? SETUP_ITEM_ORDER.length;
}

export function setupIsComplete(state) {
  return (
    state?.setupProgress?.complete === true && state?.data?.setup?.readiness?.search_ready === true
  );
}

function deterministicSourceCount(state) {
  const attempted =
    state?.data?.sourcing?.sourceSetup?.deterministicSources?.attempted ??
    state?.deterministicSources?.attempted ??
    0;
  const count = Number(attempted);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

export function firstSearchStatus(state) {
  const firstSearchRun =
    state?.data?.sourcing?.firstSearchRun ?? state?.sourcing?.firstSearchRun ?? null;
  return firstSearchRun?.run?.status ?? firstSearchRun?.status ?? "not_started";
}

export function setupCanGraduate(state) {
  return (
    setupIsComplete(state) &&
    deterministicSourceCount(state) > 0 &&
    ["running", "completed"].includes(firstSearchStatus(state))
  );
}

export function setupDisclosureRows({ state, runtime } = {}) {
  const data = state?.data ?? {};
  const profile = data.profile ?? {};
  const candidate = profile.candidate ?? {};
  const targeting = data.targeting ?? {};
  const claims = data.evidence?.claims ?? [];
  const declined = data["form-defaults"]?.declined_fields ?? {};
  const roleTitles = (targeting.role_buckets ?? []).flatMap((bucket) => bucket.titles ?? []);
  const companyPreferences = targeting.company_preferences ?? {};
  const companySignals = [
    ...(companyPreferences.industries ?? []),
    ...(companyPreferences.organization_types ?? []),
    ...(companyPreferences.sizes ?? []),
    ...(companyPreferences.stages ?? []),
    ...(companyPreferences.business_models ?? []),
    ...(companyPreferences.values ?? []),
    ...(companyPreferences.geographies ?? []),
  ];
  const companyExamples = companyPreferences.examples ?? [];
  const trackedCompanies = targeting.tracked_companies ?? [];
  const guardrails = targeting.cut_signals ?? [];
  const location = candidate.location || profile.location?.home;
  const modes = locationModePreferencesConfirmed(state)
    ? [
        profile.location?.remote ? "Remote" : null,
        profile.location?.hybrid ? "Hybrid" : null,
        profile.location?.onsite ? "On-site" : null,
      ].filter(Boolean)
    : [];
  const minimumBase = Number(profile.compensation?.minimum_base);
  const arrangementFloors = arrangementFloorDetails(profile.compensation);
  const quickFacts = [
    candidate.full_name,
    candidate.email,
    candidate.phone,
    location,
    ...modes,
    Number.isFinite(minimumBase) && minimumBase > 0
      ? `$${minimumBase.toLocaleString("en-US")} minimum base`
      : arrangementFloors.join(" · ") || null,
  ].filter(Boolean);
  const authorization = profile.authorization ?? {};

  let resumeValue = "Not provided";
  if (state?.sourceResumePresent) {
    resumeValue = `Uploaded · ${claims.length} evidence claim${claims.length === 1 ? "" : "s"}`;
  } else if (declined.resume) {
    resumeValue = "Built from your answers";
  }

  let authorizationValue = "Not provided";
  if (declined.authorization) authorizationValue = "Declined";
  else if (authorization.requires_sponsorship === true) authorizationValue = "Needs sponsorship";
  else if (authorization.work_authorized === true) authorizationValue = "Authorized";

  const evidenceValue = claims.length
    ? [
        `${claims.length} claim${claims.length === 1 ? "" : "s"}`,
        ...claims
          .slice(0, 2)
          .map((item) => item?.claim)
          .filter(Boolean),
      ].join(" · ")
    : "Not provided";

  return [
    { key: "engine", label: SETUP_ITEM_LABELS.engine, value: runtime?.name || "Connected" },
    { key: "resume", label: SETUP_ITEM_LABELS.resume, value: resumeValue },
    {
      key: "roles",
      label: SETUP_ITEM_LABELS.roles,
      value: roleTitles.length ? roleTitles.join(", ") : "Not provided",
    },
    {
      key: "companies",
      label: SETUP_ITEM_LABELS.companies,
      value:
        companyPreferences.confirmed === true
          ? [
              ...(companySignals.length ? companySignals : ["No narrow focus"]),
              companyExamples.length ? `Examples: ${companyExamples.join(", ")}` : null,
              "Broad discovery on",
            ]
              .filter(Boolean)
              .join(" · ")
          : trackedCompanies.length
            ? `Tracked sources: ${trackedCompanies.join(", ")} · Broad discovery on`
            : "Not provided",
    },
    { key: "evidence", label: SETUP_ITEM_LABELS.evidence, value: evidenceValue },
    {
      key: "guardrails",
      label: SETUP_ITEM_LABELS.guardrails,
      value: guardrails.length ? guardrails.join(" · ") : "Not provided",
    },
    {
      key: "quickFacts",
      label: SETUP_ITEM_LABELS.quickFacts,
      value: quickFacts.length ? quickFacts.join(" · ") : "Not provided",
    },
    {
      key: "authorization",
      label: SETUP_ITEM_LABELS.authorization,
      value: authorizationValue,
    },
  ];
}

// Bug 4 fix ("the file pane presents data the user never entered") —
// GET /api/onboard/state's files[] array (state.files) carries {name,
// exists} per raw candidate YAML doc (profile/targeting/evidence/honesty/
// form-defaults — see CANDIDATE_FILES in src/core/profile/candidate-setup.mjs).
// A detail line whose backing file hasn't actually been written yet must
// never surface data as if the candidate entered it — that data is either
// the template's illustrative fallback content or (per the QA report) a
// leaked demo-persona row, neither of which the user typed. Permissive
// (renders normally) whenever the signal isn't there: `state.files` missing
// or not an array, or no entry for the given name — so callers that don't
// pass `files` (every existing fixture in this module's own tests) and files
// with no files[] entry at all (automation.yml is deliberately never
// scaffolded — see AUTOMATION_ROUTE_ENTRY's own comment in
// src/cli/onboard-route.mjs, so it has no files[] entry today) keep behaving
// exactly as before.
function fileWritten(state, fileName) {
  const files = state?.files;
  if (!Array.isArray(files)) return true;
  const entry = files.find((f) => f?.name === fileName);
  return entry ? entry.exists !== false : true;
}

// Detail lines for each file-pane row (design's grey sub-line under the
// title, e.g. "Claude Code v2.3 · launch probe", "2 buckets · 5 titles").
// Best-effort: falls back to null (row renders without a sub-line) rather
// than guessing at data that isn't there yet.
export function engineDetailLine({ runtime } = {}) {
  if (!runtime) return null;
  if (runtime.id === "custom") return runtime.commandShape ? `${runtime.commandShape}` : null;
  return runtime.name ? `${runtime.name} · launch probe` : null;
}

export function resumeDetailLine({ state } = {}) {
  const claimCount = (state?.data?.evidence?.claims ?? []).length;
  if (!state?.sourceResumePresent) {
    // No résumé is a supported way in (the interview builds the history by
    // asking) — say so rather than leaving the row blank like an unstarted
    // one, but only once the decline is actually recorded in form-defaults.yml.
    const declined = state?.data?.["form-defaults"]?.declined_fields?.resume;
    if (!declined) return null;
    return fileWritten(state, "form-defaults") ? "Built from your answers" : null;
  }
  return claimCount ? `${claimCount} claim${claimCount === 1 ? "" : "s"} extracted` : "Uploaded";
}

export function rolesDetailLine({ state } = {}) {
  if (!fileWritten(state, "targeting")) return null;
  const buckets = state?.data?.targeting?.role_buckets ?? [];
  if (!buckets.length) return null;
  const titleCount = buckets.reduce((sum, b) => sum + (b.titles?.length ?? 0), 0);
  return `${buckets.length} bucket${buckets.length === 1 ? "" : "s"} · ${titleCount} title${titleCount === 1 ? "" : "s"}`;
}

export function companiesDetailLine({ state } = {}) {
  if (!fileWritten(state, "targeting")) return null;
  const preferences = state?.data?.targeting?.company_preferences ?? {};
  const examples = preferences.examples ?? [];
  if (preferences.confirmed === true && !examples.length) {
    return "Broad discovery · no narrow focus";
  }
  if (examples.length) {
    return `${examples.length} focus example${examples.length === 1 ? "" : "s"} · broad discovery on`;
  }
  const tracked = state?.data?.targeting?.tracked_companies ?? [];
  if (!tracked.length) return null;
  return `${tracked.length} tracked source${tracked.length === 1 ? "" : "s"} · broad discovery on`;
}

export function evidenceDetailLine({ state } = {}) {
  if (!fileWritten(state, "evidence")) return null;
  const claims = state?.data?.evidence?.claims ?? [];
  if (!claims.length) return null;
  return `${claims.length} claim${claims.length === 1 ? "" : "s"} kept`;
}

export function guardrailsDetailLine({ state } = {}) {
  if (!fileWritten(state, "targeting")) return null;
  const signals = state?.data?.targeting?.cut_signals ?? [];
  if (!signals.length) return null;
  return `${signals.length} dealbreaker${signals.length === 1 ? "" : "s"}`;
}

export function quickFactsDetailLine({ state } = {}) {
  if (!fileWritten(state, "profile")) return null;
  const compensation = state?.data?.profile?.compensation ?? {};
  const minimumBase = Number(compensation.minimum_base);
  const location = state?.data?.profile?.location ?? {};
  const modes = locationModePreferencesConfirmed(state)
    ? [
        location.remote ? "Remote" : null,
        location.hybrid ? "Hybrid" : null,
        location.onsite ? "On-site" : null,
      ].filter(Boolean)
    : [];
  const hasMinimumBase = Number.isFinite(minimumBase) && minimumBase > 0;
  const arrangementFloors = arrangementFloorDetails(compensation);
  if (!modes.length && !hasMinimumBase && !arrangementFloors.length) return null;
  if (!hasMinimumBase && arrangementFloors.length) return arrangementFloors.join(" · ");
  const details = [
    ...modes,
    hasMinimumBase ? `$${Math.round(minimumBase / 1000)}K floor` : "Add minimum base",
  ];
  return details.join(" · ");
}

export function authorizationDetailLine({ state } = {}) {
  const declined = !!state?.data?.["form-defaults"]?.declined_fields?.authorization;
  if (declined) return fileWritten(state, "form-defaults") ? "Declined" : null;
  if (!fileWritten(state, "profile")) return null;
  const auth = state?.data?.profile?.authorization ?? {};
  if (auth.work_authorized === true) return "Authorized";
  if (auth.requires_sponsorship === true) return "Needs sponsorship";
  return null;
}

const DETAIL_LINE_BUILDERS = {
  engine: engineDetailLine,
  resume: resumeDetailLine,
  roles: rolesDetailLine,
  companies: companiesDetailLine,
  evidence: evidenceDetailLine,
  guardrails: guardrailsDetailLine,
  quickFacts: quickFactsDetailLine,
  authorization: authorizationDetailLine,
};

export function detailLineFor(key, ctx) {
  return DETAIL_LINE_BUILDERS[key]?.(ctx) ?? null;
}
