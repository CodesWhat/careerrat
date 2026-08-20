import { BOUNDED_AI_CODES, makeBoundedAIEnvelope, runBoundedAI } from "../ai/bounded-ai.mjs";
import { resolveAIRoute } from "../ai/call-ai.mjs";
import { validate } from "../profile/schema-validator.mjs";
import { COMPANY_DISCOVERY_BATCH_MAX, normalizeCompanyKey } from "./company-board-resolver.mjs";
import { buildCompanySeedContext } from "./company-context.mjs";

export const COMPANY_SEED_LABELS = Object.freeze({
  skill: "discover-companies",
  action: "seed-generate",
  operation: "company-seeds",
});

// Distinct operation from COMPANY_SEED_LABELS so usage logging can tell the
// two bounded-AI calls apart: this one only fills a missing domain_hint on
// bare-name manual seeds, it never proposes new companies.
const COMPANY_SEED_DOMAIN_FILL_LABELS = Object.freeze({
  skill: "discover-companies",
  action: "seed-generate",
  operation: "company-seeds-domain-fill",
});

const MANUAL_SEED_FALLBACK = Object.freeze({
  available: true,
  reason: "manual-company-seeds",
  action: "Paste company names or homepages to generate a proposal batch without AI.",
});

const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);

export const companySeedSchema = Object.freeze({
  type: "object",
  required: ["companies"],
  additionalProperties: false,
  properties: {
    companies: {
      type: "array",
      maxItems: COMPANY_DISCOVERY_BATCH_MAX,
      items: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          domain_hint: { type: "string" },
          why: { type: "string" },
          role_family_hint: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          source_hint: { type: "string" },
        },
      },
    },
  },
});

// Companion schema for COMPANY_SEED_DOMAIN_FILL_LABELS: a name-only lookup,
// never a proposal. No why/confidence/etc — those already exist on the
// manual seed being filled.
const companySeedDomainFillSchema = Object.freeze({
  type: "object",
  required: ["companies"],
  additionalProperties: false,
  properties: {
    companies: {
      type: "array",
      maxItems: COMPANY_DISCOVERY_BATCH_MAX,
      items: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          domain_hint: { type: "string" },
        },
      },
    },
  },
});

function trimString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function clampRequestedCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return COMPANY_DISCOVERY_BATCH_MAX;
  return Math.max(1, Math.min(parsed, COMPANY_DISCOVERY_BATCH_MAX));
}

function domainHintFromManual(raw = {}) {
  return trimString(raw.domain_hint || raw.domainHint || raw.domain || raw.homepage || raw.url);
}

function confidence(value, fallback = "medium") {
  const normalized = trimString(value).toLowerCase();
  return CONFIDENCE_VALUES.has(normalized) ? normalized : fallback;
}

function normalizeSeed(raw, { manual = false } = {}) {
  const input = typeof raw === "string" ? { name: raw } : raw || {};
  const name = trimString(input.name || input.company);
  if (!name) return null;
  const seed = {
    name,
    domain_hint: manual ? domainHintFromManual(input) : trimString(input.domain_hint),
    why: trimString(input.why) || (manual ? "Manual company seed." : ""),
    role_family_hint: trimString(input.role_family_hint || input.roleFamilyHint),
    confidence: confidence(input.confidence, manual ? "medium" : "low"),
    source_hint: trimString(input.source_hint || input.sourceHint) || (manual ? "manual" : "ai"),
  };
  return seed;
}

function validationFailure(message) {
  const err = new Error(message);
  err.code = "VALIDATION_FAILED";
  err.status = 422;
  return err;
}

export function normalizeManualCompanySeeds(seeds = []) {
  if (!Array.isArray(seeds)) throw validationFailure("manualSeeds must be an array");
  if (seeds.length > COMPANY_DISCOVERY_BATCH_MAX) {
    throw validationFailure(`manual seed batch exceeds maximum of ${COMPANY_DISCOVERY_BATCH_MAX}`);
  }
  return seeds.map((seed) => normalizeSeed(seed, { manual: true })).filter(Boolean);
}

export function validateCompanySeedResponse(response) {
  const result = validate(response, companySeedSchema);
  const errors = Array.isArray(result.errors) ? result.errors.slice() : [];
  const companies = response?.companies;
  if (Array.isArray(companies) && companies.length > COMPANY_DISCOVERY_BATCH_MAX) {
    errors.push({
      path: "companies",
      message: `companies must contain a maximum of ${COMPANY_DISCOVERY_BATCH_MAX} items`,
    });
  }
  return { valid: result.valid && errors.length === 0, errors };
}

function normalizeAICompanies(companies = []) {
  return companies.map((company) => normalizeSeed(company, { manual: false })).filter(Boolean);
}

function uniqueSeeds(seeds = []) {
  const output = [];
  const seen = new Set();
  for (const seed of seeds) {
    const key = normalizeCompanyKey(seed?.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(seed);
  }
  return output;
}

function preferenceSeeds(context = {}) {
  return (context.companyPreferences?.examples || []).map((name) => ({
    name,
    why: "Focus example from the candidate's company thesis.",
    confidence: "high",
    sourceHint: "company-preference",
  }));
}

function contextForBroaderDiscovery(context = {}, focusSeeds = []) {
  const focusNames = focusSeeds.map((seed) => seed.name);
  return {
    ...context,
    priorityCompanySeeds: focusNames,
    dedupe: {
      ...(context.dedupe || {}),
      companies: [...(context.dedupe?.companies || []), ...focusNames],
      keys: [...(context.dedupe?.keys || []), ...focusNames.map(normalizeCompanyKey)],
    },
  };
}

function seedPrompt({ context, maxCompanies, now }) {
  return [
    "Generate candidate-specific company seeds for CareerRat's discover-companies workflow.",
    "Return only companies worth resolving against supported ATS boards; do not include URLs, provider names, approval state, or write decisions.",
    "Avoid companies already tracked, sourced, applied to, excluded, or already included as priorityCompanySeeds.",
    "Priority company seeds are focus examples, not an allowlist. Generate additional companies beyond them that match the broader company thesis, role, and location context.",
    JSON.stringify(
      {
        generatedAt:
          now instanceof Date ? now.toISOString() : new Date(now || Date.now()).toISOString(),
        maxCompanies,
        context,
      },
      null,
      2
    ),
  ].join("\n\n");
}

function domainFillPrompt({ context, names, now }) {
  return [
    "For each company name below, return its official primary domain (the one its careers page lives on) if you can identify it with confidence.",
    "This fills in a bare company name typed or extracted from a resume for CareerRat's discover-companies workflow; it is not a proposal to add a company.",
    "Use the candidate context only to disambiguate an ambiguous or generic name, never to invent a domain.",
    "Omit a company from the response entirely rather than guessing at a domain you are not confident about.",
    JSON.stringify(
      {
        generatedAt:
          now instanceof Date ? now.toISOString() : new Date(now || Date.now()).toISOString(),
        companies: names,
        context,
      },
      null,
      2
    ),
  ].join("\n\n");
}

// Manual seeds that are bare names (no domain/homepage/url given) can never
// resolve to a board downstream (resolveCompanyBoard throws without a URL or
// domain hint). One batched lookup call fills in what it confidently can;
// everything else degrades to the seeds exactly as normalized, never thrown.
// Exported so other bounded-AI-gated callers (first-search-run.mjs's
// company-board backfill rescue) can reuse this exact batched call instead
// of duplicating the prompt/schema.
export async function fillManualDomainHints({ repoRoot, env, context, seeds, call, now }) {
  const hintless = seeds.filter((seed) => !seed.domain_hint);
  if (hintless.length === 0) return { seeds, ai: { used: false } };
  if (resolveAIRoute(env, { repoRoot }).type === "none") return { seeds, ai: { used: false } };

  const safeContext = context || buildCompanySeedContext({ repoRoot, env });
  const fillResult = await runBoundedAI({
    labels: COMPANY_SEED_DOMAIN_FILL_LABELS,
    schema: companySeedDomainFillSchema,
    manual: MANUAL_SEED_FALLBACK,
    structuredMode: "native-preferred",
    outputName: "company_seed_domain_fill_response",
    tier: "smallFast",
    maxTokens: 512,
    root: repoRoot,
    env,
    call,
    system:
      "You resolve official company domains for a confirm-first company-discovery workflow. Return only JSON matching the supplied schema; omit any company you cannot identify with confidence.",
    messages: [
      {
        role: "user",
        content: domainFillPrompt({
          context: safeContext,
          names: hintless.map((seed) => seed.name),
          now,
        }),
      },
    ],
  });

  if (!fillResult.body?.ok) return { seeds, ai: fillResult.body?.ai || { used: false } };

  const hints = new Map();
  for (const company of fillResult.body.data?.companies || []) {
    const key = normalizeCompanyKey(company?.name);
    const hint = trimString(company?.domain_hint);
    if (key && hint) hints.set(key, hint);
  }
  if (hints.size === 0) return { seeds, ai: fillResult.body.ai };

  const filled = seeds.map((seed) => {
    if (seed.domain_hint) return seed;
    const hint = hints.get(normalizeCompanyKey(seed.name));
    return hint ? { ...seed, domain_hint: hint } : seed;
  });

  return { seeds: filled, ai: fillResult.body.ai };
}

export async function generateCompanySeeds({
  repoRoot,
  env = process.env,
  context,
  manualSeeds = [],
  requestedCount,
  call,
  now = new Date(),
} = {}) {
  const maxCompanies = clampRequestedCount(requestedCount);
  const safeContext = context || buildCompanySeedContext({ repoRoot, env });
  let normalizedManual;
  try {
    normalizedManual = normalizeManualCompanySeeds(manualSeeds);
  } catch (err) {
    return makeBoundedAIEnvelope({
      ok: false,
      status: err.status || 422,
      code: err.code || "VALIDATION_FAILED",
      error: { message: err.message },
      ai: { used: false },
      manual: MANUAL_SEED_FALLBACK,
    });
  }

  const normalizedFocus = uniqueSeeds([
    ...normalizedManual,
    ...normalizeManualCompanySeeds(preferenceSeeds(safeContext)),
  ]);
  const focusCapacity =
    normalizedFocus.length && maxCompanies > 1 ? maxCompanies - 1 : maxCompanies;
  const cappedFocus = normalizedFocus.slice(0, focusCapacity);
  let filledFocus = cappedFocus;
  let focusAI = { used: false };
  if (cappedFocus.length > 0) {
    const { seeds: filledManual, ai: fillAI } = await fillManualDomainHints({
      repoRoot,
      env,
      context: safeContext,
      seeds: cappedFocus,
      call,
      now,
    });
    filledFocus = filledManual;
    focusAI = fillAI;
  }

  const remaining = maxCompanies - filledFocus.length;
  if (remaining <= 0) {
    return makeBoundedAIEnvelope({
      ok: true,
      status: 200,
      data: {
        companies: filledFocus,
        broadDiscovery: { status: "deferred", code: "BATCH_FULL" },
      },
      ai: focusAI,
      manual: MANUAL_SEED_FALLBACK,
    });
  }

  const broaderContext = contextForBroaderDiscovery(safeContext, filledFocus);
  const result = await runBoundedAI({
    labels: COMPANY_SEED_LABELS,
    schema: companySeedSchema,
    manual: MANUAL_SEED_FALLBACK,
    structuredMode: "native-preferred",
    outputName: "company_seed_response",
    maxTokens: 1200,
    root: repoRoot,
    env,
    call,
    system:
      "You generate company seed JSON for a confirm-first company-discovery proposal route. Return only JSON matching the supplied schema.",
    messages: [
      {
        role: "user",
        content: seedPrompt({ context: broaderContext, maxCompanies: remaining, now }),
      },
    ],
  });

  if (!result.body?.ok) {
    if (!filledFocus.length) return result;
    return makeBoundedAIEnvelope({
      ok: true,
      status: 200,
      data: {
        companies: filledFocus,
        broadDiscovery: {
          status: "unavailable",
          code: result.body?.code || BOUNDED_AI_CODES.AI_PROVIDER_FAILED,
        },
      },
      ai: result.body?.ai || focusAI,
      manual: result.body?.manual || MANUAL_SEED_FALLBACK,
    });
  }

  const validation = validateCompanySeedResponse(result.body.data);
  if (!validation.valid) {
    return makeBoundedAIEnvelope({
      ok: false,
      status: 422,
      code: BOUNDED_AI_CODES.AI_SCHEMA_INVALID,
      error: {
        message: "Model output did not match the route schema.",
        details: validation.errors,
      },
      ai: result.body.ai,
      manual: MANUAL_SEED_FALLBACK,
    });
  }

  return makeBoundedAIEnvelope({
    ok: true,
    status: 200,
    data: {
      companies: uniqueSeeds([
        ...filledFocus,
        ...normalizeAICompanies(result.body.data.companies),
      ]).slice(0, maxCompanies),
      broadDiscovery: { status: "complete" },
    },
    ai: result.body.ai,
    manual: result.body.manual,
  });
}
