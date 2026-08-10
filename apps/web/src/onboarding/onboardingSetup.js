// onboardingSetup.js — pure view-model helpers for the W4 chat-first
// onboarding surface (OnboardingPage.jsx, EngineScreen.jsx,
// InterviewSurface.jsx, FilePane.jsx). Kept dependency-free (no React, no
// fetch) so every branch here is trivially unit-testable and reusable across
// the engine gate, the file pane, and the mini-progress row without either
// component re-deriving the same shape.
//
// The 9 setup items (engine, resume, roles, companies, evidence, guardrails,
// quickFacts, authorization, consent — the last two added for Lane A / R5)
// mirror src/cli/onboard-route.mjs's computeSetupProgress() — GET
// /api/onboard/state's `setupProgress` field is the source of truth for
// which items are "done"; this module only adds display copy (labels,
// detail lines, UP NEXT) on top of that server-computed done/undone shape.

export const SETUP_ITEM_ORDER = [
  "engine",
  "resume",
  "roles",
  "companies",
  "evidence",
  "guardrails",
  "quickFacts",
  "authorization",
  "consent",
];

export const SETUP_ITEM_LABELS = {
  engine: "Engine",
  resume: "Resume",
  roles: "Roles",
  companies: "Companies",
  evidence: "Evidence",
  guardrails: "Guardrails",
  quickFacts: "Quick facts",
  authorization: "Work authorization",
  consent: "Automation consent",
};

// The compact mono-caps chip row shown in 3a (centered, before docking) —
// same items, just uppercase short labels.
export const SETUP_CHIP_LABELS = {
  engine: "ENGINE",
  resume: "RESUME",
  roles: "ROLES",
  companies: "COMPANIES",
  evidence: "EVIDENCE",
  guardrails: "GUARDRAILS",
  quickFacts: "QUICK FACTS",
  authorization: "AUTHORIZATION",
  consent: "CONSENT",
};

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
  return state?.setupProgress?.complete === true;
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
  if (!state?.sourceResumePresent) return null;
  return claimCount ? `${claimCount} claim${claimCount === 1 ? "" : "s"} extracted` : "Uploaded";
}

export function rolesDetailLine({ state } = {}) {
  const buckets = state?.data?.targeting?.role_buckets ?? [];
  if (!buckets.length) return null;
  const titleCount = buckets.reduce((sum, b) => sum + (b.titles?.length ?? 0), 0);
  return `${buckets.length} bucket${buckets.length === 1 ? "" : "s"} · ${titleCount} title${titleCount === 1 ? "" : "s"}`;
}

export function companiesDetailLine({ state } = {}) {
  const companies = state?.data?.targeting?.tracked_companies ?? [];
  if (!companies.length) return null;
  return `${companies.length} tracked`;
}

export function evidenceDetailLine({ state } = {}) {
  const claims = state?.data?.evidence?.claims ?? [];
  if (!claims.length) return null;
  return `${claims.length} claim${claims.length === 1 ? "" : "s"} kept`;
}

export function guardrailsDetailLine({ state } = {}) {
  const signals = state?.data?.targeting?.cut_signals ?? [];
  if (!signals.length) return null;
  return `${signals.length} dealbreaker${signals.length === 1 ? "" : "s"}`;
}

export function quickFactsDetailLine({ state } = {}) {
  const location = state?.data?.profile?.location ?? {};
  const modes = [
    location.remote ? "Remote" : null,
    location.hybrid ? "Hybrid" : null,
    location.onsite ? "On-site" : null,
  ].filter(Boolean);
  if (!modes.length) return null;
  return modes.join(" · ");
}

export function authorizationDetailLine({ state } = {}) {
  const auth = state?.data?.profile?.authorization ?? {};
  const declined = !!state?.data?.["form-defaults"]?.declined_fields?.authorization;
  if (declined) return "Declined";
  if (auth.work_authorized === true) return "Authorized";
  if (auth.requires_sponsorship === true) return "Needs sponsorship";
  return null;
}

export function consentDetailLine({ state } = {}) {
  const automation = state?.data?.automation ?? {};
  const declined = !!state?.data?.["form-defaults"]?.declined_fields?.consent;
  if (declined) return "Declined";
  if (automation.setup_mode === "advanced") return "Advanced";
  if (automation.setup_mode === "basic") return "Basic";
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
  consent: consentDetailLine,
};

export function detailLineFor(key, ctx) {
  return DETAIL_LINE_BUILDERS[key]?.(ctx) ?? null;
}
