import { BOUNDED_AI_CODES, makeBoundedAIEnvelope, runBoundedAI } from "../ai/bounded-ai.mjs";
import { validate } from "../profile/schema-validator.mjs";
import { COMPANY_DISCOVERY_BATCH_MAX } from "./company-board-resolver.mjs";
import { buildCompanySeedContext } from "./company-context.mjs";

export const COMPANY_SEED_LABELS = Object.freeze({
  skill: "discover-companies",
  action: "seed-generate",
  operation: "company-seeds",
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

function seedPrompt({ context, maxCompanies, now }) {
  return [
    "Generate candidate-specific company seeds for Rolester's discover-companies workflow.",
    "Return only companies worth resolving against supported ATS boards; do not include URLs, provider names, approval state, or write decisions.",
    "Avoid companies already tracked, sourced, applied to, or excluded.",
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

  if (normalizedManual.length > 0) {
    return makeBoundedAIEnvelope({
      ok: true,
      status: 200,
      data: { companies: normalizedManual.slice(0, maxCompanies) },
      ai: { used: false },
      manual: MANUAL_SEED_FALLBACK,
    });
  }

  const safeContext = context || buildCompanySeedContext({ repoRoot, env });
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
        content: seedPrompt({ context: safeContext, maxCompanies, now }),
      },
    ],
  });

  if (!result.body?.ok) return result;

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
    data: { companies: normalizeAICompanies(result.body.data.companies).slice(0, maxCompanies) },
    ai: result.body.ai,
    manual: result.body.manual,
  });
}
