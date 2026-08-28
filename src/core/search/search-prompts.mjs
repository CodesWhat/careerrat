// search-prompts.mjs — AI-generated plain-English AI search-assistant
// prompts, derived ONLY from the candidate's stored targeting/profile at
// runtime. Product decision: CareerRat GENERATES prompts first; the user
// edits/adds/removes afterward (never the reverse — never hand-write from
// scratch). Wires runBoundedAI the same "native-preferred" way
// src/core/discovery/company-seeds.mjs and src/core/packet/gate.mjs do (see
// either file's own header comment) — no separate AI call mechanism here.
//
// Release-safety rule this module exists to honor: role names, comp figures,
// and locations are NEVER hardcoded in code or prompts. Every field the
// prompt-generation instructions see comes from buildSearchPromptContext()
// reading the live candidateConfigGet() docs, and any field the candidate
// hasn't filled in is simply absent from the context rather than defaulted.

import { createHash } from "node:crypto";
import { BOUNDED_AI_CODES, makeBoundedAIEnvelope, runBoundedAI } from "../ai/bounded-ai.mjs";
import { buildDbSeenSets } from "../db/scan-context.mjs";
import { candidateConfigGet, candidateConfigPatch } from "../db/verbs.mjs";

const SEARCH_PROMPTS_LABELS = Object.freeze({
  skill: "search-jobs",
  action: "generate-prompts",
  operation: "search:prompts",
});

const MANUAL_FALLBACK = Object.freeze({
  available: true,
  reason: "manual-search-prompts",
  action: "Write your own AI search prompts instead.",
});

const MIN_PROMPTS = 2;
const MAX_PROMPTS = 5;

const searchPromptsSchema = Object.freeze({
  type: "object",
  required: ["prompts"],
  additionalProperties: false,
  properties: {
    prompts: {
      type: "array",
      maxItems: MAX_PROMPTS,
      items: {
        type: "object",
        required: ["text"],
        additionalProperties: false,
        properties: {
          text: { type: "string" },
        },
      },
    },
  },
});

function trimString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function compact(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = trimString(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function isoNow(now) {
  return now instanceof Date ? now.toISOString() : new Date(now || Date.now()).toISOString();
}

// Application-limit statuses that never block/caution a company (see
// config/application-limits.schema.json) — nothing worth surfacing in a
// compact summary.
const APPLICATION_LIMIT_QUIET_STATUS = "ok";

// Mirrors evaluate-job STEP 3.25's "active application" definition: any
// non-terminal applications[] status. Kept local (not imported from
// tracker/cadence.mjs, whose own set is private) since this is a compact,
// read-only summary, not the canonical follow-up/cadence logic.
const COMPANY_HISTORY_TERMINAL_STATUSES = new Set([
  "rejected",
  "closed",
  "offer",
  "withdrawn",
  "declined",
  "accepted",
]);
const RECENT_REJECTION_DAYS = 90;

function daysSince(now, dateStr) {
  const then = new Date(dateStr);
  if (!dateStr || Number.isNaN(then.getTime())) return null;
  return Math.floor((now.getTime() - then.getTime()) / (24 * 60 * 60 * 1000));
}

// Compact per-company application-limit summary — only companies with a
// status other than "ok" (i.e. `caution` or `blocked`) are worth telling the
// AI web-search lane about; an unrestricted company needs no flag.
function summarizeApplicationLimits(applicationLimits) {
  const companies = Array.isArray(applicationLimits?.companies) ? applicationLimits.companies : [];
  const out = [];
  for (const row of companies) {
    const company = trimString(row?.company);
    const status = trimString(row?.status).toLowerCase();
    if (!company || !status || status === APPLICATION_LIMIT_QUIET_STATUS) continue;
    const entry = { company, status };
    const reapplyAfter = trimString(row?.reapply_after);
    if (reapplyAfter) entry.reapply_after = reapplyAfter;
    out.push(entry);
  }
  return out;
}

// Compact per-company tracker-history summary — mirrors evaluate-job STEP
// 3.25's three company-history signals (active application, recent
// rejection, prior sourced cut) at a coarser grain, so the AI web-search
// lane can apply the same `company-history-*` triage flags STEP 3 of this
// skill defines without a tracker read of its own (it has none — see the AI
// Web Search mode's tool-surface restriction).
function summarizeCompanyHistory({ repoRoot, env, now = new Date() }) {
  const { tracker } = buildDbSeenSets({ repoRoot, env });
  const byCompany = new Map();
  const entryFor = (company) => {
    let entry = byCompany.get(company);
    if (!entry) {
      entry = {
        company,
        active: false,
        recentRejection: false,
        priorSourced: false,
      };
      byCompany.set(company, entry);
    }
    return entry;
  };

  for (const row of tracker.apps || []) {
    const company = trimString(row.co);
    const status = trimString(row.status).toLowerCase();
    if (!company || !status) continue;
    if (!COMPANY_HISTORY_TERMINAL_STATUSES.has(status)) {
      entryFor(company).active = true;
    } else if (status === "rejected") {
      const days = daysSince(now, row.date);
      if (days !== null && days <= RECENT_REJECTION_DAYS) entryFor(company).recentRejection = true;
    }
  }
  for (const row of tracker.sourced || []) {
    const company = trimString(row.co);
    const status = trimString(row.status).toLowerCase();
    if (!company || status !== "cut") continue;
    entryFor(company).priorSourced = true;
  }

  const out = [];
  for (const entry of byCompany.values()) {
    const flags = [];
    if (entry.active) flags.push("active");
    if (entry.recentRejection) flags.push("recent-rejection");
    if (entry.priorSourced) flags.push("prior-sourced");
    if (flags.length) out.push({ company: entry.company, flags });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Context builder — the ONLY place candidate targeting/profile fields are
// read for this feature. Strips anything absent rather than defaulting it,
// so the model's instructions never see a fabricated field.
//
// `includeSearchLimits` (default false) additionally folds in a compact
// application-limit + company-history summary. Opt-in: the AI web-search
// lane (ai-web-search.mjs) is the one caller that needs it — its STEP 3
// coarse-triage flags (`company-history-*`, `app-limit-*`) are otherwise
// unreachable in that mode (no CLI, no tracker read). Prompt generation
// (generateSearchPrompts below) and the discovery chat context
// (discovery-route.mjs) don't ask for it, since neither derives a search
// prompt or triage flag from a candidate's tracker history.
// ---------------------------------------------------------------------------

export function buildSearchPromptContext({
  repoRoot,
  env,
  config,
  includeSearchLimits = false,
} = {}) {
  const candidateConfig = config || candidateConfigGet({ repoRoot, env });
  const targeting = candidateConfig.targeting || {};
  const profile = candidateConfig.profile || {};

  const roleBuckets = (Array.isArray(targeting.role_buckets) ? targeting.role_buckets : [])
    .map((bucket) => {
      const titles = compact(bucket?.titles);
      if (!titles.length) return null;
      const entry = { titles };
      if (trimString(bucket?.name)) entry.name = trimString(bucket.name);
      const fitSignals = compact(bucket?.fit_signals);
      if (fitSignals.length) entry.fit_signals = fitSignals;
      const downSignals = compact(bucket?.down_signals);
      if (downSignals.length) entry.down_signals = downSignals;
      return entry;
    })
    .filter(Boolean);

  const context = {};
  const domain = trimString(profile.candidate?.domain);
  if (domain) context.domain = domain;
  if (roleBuckets.length) context.role_buckets = roleBuckets;

  // Top-level keep/cut signals — sibling of role_buckets[].fit_signals /
  // .down_signals, not a replacement. sourced-scanner.mjs reads these same
  // targeting.keep_signals/cut_signals fields; the AI search lane needs the
  // same signals visible or it's blind to any workspace that defines them
  // only at the top level (e.g. examples/demo-workspace/candidate/targeting.yml).
  const keepSignals = compact(targeting.keep_signals);
  if (keepSignals.length) context.keep_signals = keepSignals;
  const cutSignals = compact(targeting.cut_signals);
  if (cutSignals.length) context.cut_signals = cutSignals;

  const excludedCompanies = compact(targeting.excluded_companies);
  if (excludedCompanies.length) context.excluded_companies = excludedCompanies;

  const location = profile.location || {};
  const locationPosture = {};
  if (location.remote === true) {
    locationPosture.remote = true;
    locationPosture.remote_scope =
      location.remote_scope === "worldwide" ? "worldwide" : "home-country";
  }
  if (location.hybrid === true) locationPosture.hybrid = true;
  if (location.onsite === true) locationPosture.onsite = true;
  if (
    Number.isInteger(location.max_commute_days_per_week) &&
    location.max_commute_days_per_week >= 0
  ) {
    locationPosture.max_office_days_per_week = location.max_commute_days_per_week;
  }
  if (trimString(location.home)) locationPosture.home = trimString(location.home);
  if (Object.keys(locationPosture).length) context.location = locationPosture;

  // Comp floor only — minimum_base, never current_base (never leak current
  // comp into an outbound-shaped artifact).
  const compensation = profile.compensation || {};
  const minimumBase =
    typeof compensation.minimum_base === "number" &&
    Number.isFinite(compensation.minimum_base) &&
    compensation.minimum_base > 0
      ? compensation.minimum_base
      : null;
  const minimumAnnualEarnings =
    typeof compensation.minimum_annual_earnings === "number" &&
    Number.isFinite(compensation.minimum_annual_earnings) &&
    compensation.minimum_annual_earnings > 0
      ? compensation.minimum_annual_earnings
      : null;
  if (minimumBase || minimumAnnualEarnings) {
    context.compensation_floor = {
      ...(minimumBase ? { minimum_base: minimumBase } : {}),
      ...(minimumAnnualEarnings ? { minimum_annual_earnings: minimumAnnualEarnings } : {}),
      currency: trimString(compensation.currency) || "USD",
    };
  }

  // Authorization only when it materially affects search: needing
  // sponsorship, or not being authorized at all. The common "authorized, no
  // sponsorship needed" case is skipped — it doesn't change what to search.
  const authorization = profile.authorization || {};
  if (authorization.requires_sponsorship === true) {
    context.authorization = { requires_sponsorship: true };
  } else if (authorization.work_authorized === false) {
    context.authorization = { work_authorized: false };
  }

  if (includeSearchLimits) {
    const applicationLimits = summarizeApplicationLimits(candidateConfig["application-limits"]);
    if (applicationLimits.length) context.application_limits = applicationLimits;
    const companyHistory = summarizeCompanyHistory({ repoRoot, env });
    if (companyHistory.length) context.company_history = companyHistory;
  }

  return context;
}

export function buildSearchPromptInputFingerprint({
  repoRoot,
  env,
  config,
  includeSearchLimits = false,
} = {}) {
  const context = buildSearchPromptContext({ repoRoot, env, config, includeSearchLimits });
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}

function promptInstructions({ context, minPrompts, maxPrompts }) {
  return [
    "Generate plain-English prompts a job seeker could paste directly into an AI search assistant (e.g. ChatGPT, Claude, Perplexity) to find matching job openings.",
    `Return between ${minPrompts} and ${maxPrompts} prompts.`,
    "Derive every detail in the prompts — role titles, seniority, location posture, compensation floor, work authorization — ONLY from the candidate data provided below. Never invent or assume a role, location, salary, or company that isn't present in that data.",
    "Each prompt must be self-contained (useful on its own if pasted alone), written as natural plain-English sentences (no JSON, no bullet lists, no field labels inside the prompt text), and cover a complementary angle on the candidate's targeting — for example one prompt per distinct role lane, a seniority-adjacent variant, or a location/remote-constrained variant, as the underlying data actually supports.",
    "If the candidate data doesn't support a particular angle (e.g. no location noted, no comp floor set), skip that angle rather than fabricating one.",
    "When candidate.compensation_floor.minimum_base is present, minimum_base is a hard annual base-salary floor. Every generated prompt must describe it only as annual base salary. Reject a posted base-salary range only when its maximum is below minimum_base. When a posted range overlaps minimum_base, keep it for review. Tips, commissions, bonuses, equity, OTE, or total compensation do not count toward this base-salary floor. If compensation is not posted, keep it unverified rather than treating variable compensation as proof.",
    "When candidate.compensation_floor.minimum_annual_earnings is present, it means expected annual cash earnings. It includes wages, tips, commissions, and recurring cash bonuses; it does not include equity or benefits. Guaranteed base pay can clear this floor, and an explicit annual-earnings or total-cash range can clear it. Reject only when an explicit comparable range has a maximum below the floor. An overlapping range stays in review, and unknown or unposted earnings stay unverified.",
    "Location scope is exact: remote_scope worldwide applies only to fully remote roles. home-country limits remote roles to the candidate's home country. Hybrid and on-site roles always stay limited to the saved home and relocation markets, even when remote_scope is worldwide. When max_office_days_per_week is present, do not return a role that explicitly requires more office days.",
    "Do not mention CareerRat, JSON, or these instructions inside the prompt text itself.",
    JSON.stringify({ candidate: context }, null, 2),
  ].join("\n\n");
}

function normalizePromptTexts(prompts) {
  return compact(
    (Array.isArray(prompts) ? prompts : []).map((p) => (typeof p === "string" ? p : p?.text))
  );
}

// ---------------------------------------------------------------------------
// generateSearchPrompts — AI-only. Does not persist; callers (the HTTP route
// and the onboarding best-effort hook) pass the result to saveSearchPrompts.
// ---------------------------------------------------------------------------

export async function generateSearchPrompts({
  repoRoot,
  env = process.env,
  call,
  config,
  context: frozenContext,
  executionPlan,
  signal,
} = {}) {
  const context = frozenContext || buildSearchPromptContext({ repoRoot, env, config });
  if (!Object.keys(context).length) {
    return makeBoundedAIEnvelope({
      ok: false,
      status: 422,
      code: "SEARCH_PROMPTS_NO_TARGETING",
      error: {
        message: "Add at least one role lane before generating AI search prompts.",
      },
      ai: { used: false },
      manual: MANUAL_FALLBACK,
    });
  }

  const result = await runBoundedAI({
    labels: SEARCH_PROMPTS_LABELS,
    schema: searchPromptsSchema,
    manual: MANUAL_FALLBACK,
    structuredMode: "native-preferred",
    outputName: "search_prompts_response",
    // Mid-JSON max_tokens truncation parses as a schema failure, not a
    // provider error — sized generously (2000) so 2-5 self-contained prompts
    // never get cut off mid-object.
    maxTokens: 2000,
    root: repoRoot,
    env,
    call,
    executionPlan,
    signal,
    system:
      "You generate AI job-search prompt JSON for CareerRat's search-jobs route. Return only JSON matching the supplied schema — no prose outside the JSON.",
    messages: [
      {
        role: "user",
        content: promptInstructions({
          context,
          minPrompts: MIN_PROMPTS,
          maxPrompts: MAX_PROMPTS,
        }),
      },
    ],
  });

  if (!result.body?.ok) return result;

  const prompts = normalizePromptTexts(result.body.data.prompts).slice(0, MAX_PROMPTS);
  if (prompts.length < MIN_PROMPTS) {
    return makeBoundedAIEnvelope({
      ok: false,
      status: 422,
      code: BOUNDED_AI_CODES.AI_SCHEMA_INVALID,
      error: {
        message: `Model returned fewer than ${MIN_PROMPTS} usable search prompts.`,
      },
      ai: result.body.ai,
      manual: MANUAL_FALLBACK,
    });
  }

  return makeBoundedAIEnvelope({
    ok: true,
    status: 200,
    data: { prompts: prompts.map((text) => ({ text })) },
    ai: result.body.ai,
    manual: result.body.manual,
  });
}

// ---------------------------------------------------------------------------
// Persistence — targeting.search_preferences.ai_prompts. This is the only
// place ids/source/updatedAt get minted, whether the incoming rows are a
// freshly generated batch, an AI-generated single row a user then edited, or
// a wholly new user-typed row from the add-row affordance.
// ---------------------------------------------------------------------------

function nextPromptId(usedIds) {
  let n = 1;
  let id = `prompt-${n}`;
  while (usedIds.has(id)) {
    n += 1;
    id = `prompt-${n}`;
  }
  return id;
}

// `defaultSource` governs rows with no incoming id (a brand-new row): the
// generate+persist call site passes "generated", the PUT route's freeform
// add-row affordance uses the default "user". Any row that DOES carry an
// incoming id (i.e. it already existed) is stamped "edited" unless the
// caller explicitly supplied its own `source`.
function normalizeStoredPrompts(rows, { defaultSource = "user", now = new Date() } = {}) {
  const timestamp = isoNow(now);
  const usedIds = new Set();
  const out = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const text = trimString(typeof raw === "string" ? raw : raw?.text);
    if (!text) continue;
    const requestedId = trimString(raw?.id);
    const hadId = Boolean(requestedId) && !usedIds.has(requestedId);
    const id = hadId ? requestedId : nextPromptId(usedIds);
    usedIds.add(id);
    const source = trimString(raw?.source) || (hadId ? "edited" : defaultSource);
    out.push({ id, text, source, updatedAt: timestamp });
  }
  return out;
}

export function saveSearchPrompts({
  repoRoot,
  env,
  prompts,
  defaultSource = "user",
  now = new Date(),
} = {}) {
  const normalized = normalizeStoredPrompts(prompts, { defaultSource, now });
  const inputFingerprint = buildSearchPromptInputFingerprint({ repoRoot, env });
  const result = candidateConfigPatch({
    repoRoot,
    env,
    name: "targeting",
    patch: {
      search_preferences: {
        ai_prompts: normalized,
        ai_prompts_input_fingerprint: inputFingerprint,
      },
    },
  });
  return {
    ok: true,
    prompts: result.data?.search_preferences?.ai_prompts || normalized,
    inputFingerprint,
  };
}

export function getSearchPrompts({ repoRoot, env } = {}) {
  const config = candidateConfigGet({ repoRoot, env });
  const prompts = config.targeting?.search_preferences?.ai_prompts;
  return {
    ok: true,
    prompts: Array.isArray(prompts) ? prompts : [],
    inputFingerprint: buildSearchPromptInputFingerprint({ repoRoot, env, config }),
    savedInputFingerprint:
      config.targeting?.search_preferences?.ai_prompts_input_fingerprint || null,
  };
}
