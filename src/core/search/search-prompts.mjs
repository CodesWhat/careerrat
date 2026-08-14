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

import { BOUNDED_AI_CODES, makeBoundedAIEnvelope, runBoundedAI } from "../ai/bounded-ai.mjs";
import { candidateConfigGet, candidateConfigPatch } from "../db/verbs.mjs";

export const SEARCH_PROMPTS_LABELS = Object.freeze({
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

export const searchPromptsSchema = Object.freeze({
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

// ---------------------------------------------------------------------------
// Context builder — the ONLY place candidate targeting/profile fields are
// read for this feature. Strips anything absent rather than defaulting it,
// so the model's instructions never see a fabricated field.
// ---------------------------------------------------------------------------

export function buildSearchPromptContext({ repoRoot, env, config } = {}) {
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

  const excludedCompanies = compact(targeting.excluded_companies);
  if (excludedCompanies.length) context.excluded_companies = excludedCompanies;

  const location = profile.location || {};
  const locationPosture = {};
  if (location.remote === true) locationPosture.remote = true;
  if (location.hybrid === true) locationPosture.hybrid = true;
  if (location.onsite === true) locationPosture.onsite = true;
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
  if (minimumBase) {
    context.compensation_floor = {
      minimum_base: minimumBase,
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

  return context;
}

function promptInstructions({ context, minPrompts, maxPrompts }) {
  return [
    "Generate plain-English prompts a job seeker could paste directly into an AI search assistant (e.g. ChatGPT, Claude, Perplexity) to find matching job openings.",
    `Return between ${minPrompts} and ${maxPrompts} prompts.`,
    "Derive every detail in the prompts — role titles, seniority, location posture, compensation floor, work authorization — ONLY from the candidate data provided below. Never invent or assume a role, location, salary, or company that isn't present in that data.",
    "Each prompt must be self-contained (useful on its own if pasted alone), written as natural plain-English sentences (no JSON, no bullet lists, no field labels inside the prompt text), and cover a complementary angle on the candidate's targeting — for example one prompt per distinct role lane, a seniority-adjacent variant, or a location/remote-constrained variant, as the underlying data actually supports.",
    "If the candidate data doesn't support a particular angle (e.g. no location noted, no comp floor set), skip that angle rather than fabricating one.",
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

export async function generateSearchPrompts({ repoRoot, env = process.env, call, config } = {}) {
  const context = buildSearchPromptContext({ repoRoot, env, config });
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
    system:
      "You generate AI job-search prompt JSON for CareerRat's search-jobs route. Return only JSON matching the supplied schema — no prose outside the JSON.",
    messages: [
      {
        role: "user",
        content: promptInstructions({ context, minPrompts: MIN_PROMPTS, maxPrompts: MAX_PROMPTS }),
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
  const result = candidateConfigPatch({
    repoRoot,
    env,
    name: "targeting",
    patch: { search_preferences: { ai_prompts: normalized } },
  });
  return {
    ok: true,
    prompts: result.data?.search_preferences?.ai_prompts || normalized,
  };
}

export function getSearchPrompts({ repoRoot, env } = {}) {
  const config = candidateConfigGet({ repoRoot, env });
  const prompts = config.targeting?.search_preferences?.ai_prompts;
  return { ok: true, prompts: Array.isArray(prompts) ? prompts : [] };
}
