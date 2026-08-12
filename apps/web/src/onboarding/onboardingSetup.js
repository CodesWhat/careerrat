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
  companies: "Companies",
  evidence: "Evidence",
  guardrails: "Guardrails",
  quickFacts: "Quick facts",
  authorization: "Work authorization",
};

// Bug 2 fix ("receipt lines state things that are not true") — the real
// candidate file each item's completion actually writes, for the interview's
// ✓ receipt lines (InterviewSurface.jsx's checkProgressDelta). Every prior
// receipt hardcoded "TARGETING.YML UPDATED" for every non-resume item, which
// was wrong for engine (writes nothing at all) and for quickFacts/
// authorization (write profile.yml, not targeting.yml). `null` means the
// item's completion writes no candidate file. resume is intentionally
// omitted — its receipt line depends on whether a résumé was actually
// uploaded vs. declined, which checkProgressDelta handles as a special case
// rather than a single static file label.
export const SETUP_ITEM_FILE = {
  engine: null,
  roles: "targeting.yml",
  companies: "targeting.yml",
  evidence: "evidence.yml",
  guardrails: "targeting.yml",
  quickFacts: "profile.yml",
  authorization: "profile.yml",
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
  const companies = state?.data?.targeting?.tracked_companies ?? [];
  if (!companies.length) return null;
  return `${companies.length} tracked`;
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
