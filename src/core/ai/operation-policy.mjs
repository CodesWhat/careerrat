export const AI_POLICY_VERSION = 1;
export const AI_ADAPTER_VERSION = 1;

export const AI_OPERATION_DEFAULTS = Object.freeze({
  "paul.conversation": Object.freeze({ quality: "best", reasoning: "medium" }),
  "coach.deep": Object.freeze({ quality: "best", reasoning: "high" }),
  "application.judgment": Object.freeze({ quality: "best", reasoning: "high" }),
  "application.drafting": Object.freeze({ quality: "best", reasoning: "medium" }),
  "communication.drafting": Object.freeze({ quality: "best", reasoning: "medium" }),
  "research.web": Object.freeze({ quality: "balanced", reasoning: "medium" }),
  "structured.extraction": Object.freeze({ quality: "balanced", reasoning: "medium" }),
  "bounded.classification": Object.freeze({ quality: "faster", reasoning: "low" }),
});

const QUALITY_VALUES = new Set(["automatic", "faster", "balanced", "best"]);
const REASONING_VALUES = new Set(["automatic", "low", "medium", "high"]);
const EFFORT_ORDER = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]);
const CLAUDE_MODEL_MAP = Object.freeze({ faster: "haiku", balanced: "sonnet", best: "opus" });
const MODEL_MAP = Object.freeze({
  claude: CLAUDE_MODEL_MAP,
  "anthropic-api": CLAUDE_MODEL_MAP,
  "managed-anthropic": CLAUDE_MODEL_MAP,
  codex: Object.freeze({
    faster: "gpt-5.6-luna",
    balanced: "gpt-5.6-terra",
    best: "gpt-5.6-sol",
  }),
});

function policyError(message) {
  const error = new Error(message);
  error.code = "AI_POLICY_INVALID";
  return error;
}

function normalizeQuality(value) {
  const normalized = String(value || "automatic")
    .trim()
    .toLowerCase();
  const quality = normalized === "fast" ? "faster" : normalized;
  if (!QUALITY_VALUES.has(quality)) {
    throw policyError(`AI quality must be automatic, faster, balanced, or best: ${value}`);
  }
  return quality;
}

function normalizeReasoning(value) {
  const reasoning = String(value || "automatic")
    .trim()
    .toLowerCase();
  if (!REASONING_VALUES.has(reasoning)) {
    throw policyError(`AI reasoning must be automatic, low, medium, or high: ${value}`);
  }
  return reasoning;
}

function normalizeCapabilities(capabilities) {
  const object =
    capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
      ? capabilities
      : {};
  const models = Array.isArray(object.models)
    ? new Set(object.models.map((value) => String(value || "").trim()).filter(Boolean))
    : null;
  const effortLevels = Array.isArray(object.effortLevels)
    ? [...new Set(object.effortLevels.map((value) => String(value || "").trim()).filter(Boolean))]
    : null;
  return { models, effortLevels };
}

function closestEffort(requested, supported) {
  if (!supported?.length || supported.includes(requested)) return requested;
  const requestedIndex = EFFORT_ORDER.indexOf(requested);
  const candidates = supported
    .map((value) => ({ value, index: EFFORT_ORDER.indexOf(value) }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => {
      const distance =
        Math.abs(left.index - requestedIndex) - Math.abs(right.index - requestedIndex);
      return distance || right.index - left.index;
    });
  return candidates[0]?.value || null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function resolveAIExecutionPlan({
  operation,
  runtimeId,
  quality,
  reasoning,
  preferences,
  capabilities,
  modelOverride,
  effortOverride,
} = {}) {
  const operationId = String(operation || "").trim();
  const operationDefaults = AI_OPERATION_DEFAULTS[operationId];
  if (!operationDefaults) throw policyError(`unknown AI operation: ${operationId || "(empty)"}`);

  const selectedRuntime = String(runtimeId || "").trim();
  if (!["claude", "codex", "anthropic-api", "managed-anthropic"].includes(selectedRuntime)) {
    throw policyError(`unsupported AI runtime: ${selectedRuntime || "(empty)"}`);
  }

  const requestedQuality = normalizeQuality(quality ?? preferences?.quality ?? "automatic");
  const requestedReasoning = normalizeReasoning(reasoning ?? preferences?.reasoning ?? "automatic");
  const resolvedQuality =
    requestedQuality === "automatic" ? operationDefaults.quality : requestedQuality;
  const desiredEffort = String(
    effortOverride ||
      (requestedReasoning === "automatic" ? operationDefaults.reasoning : requestedReasoning)
  )
    .trim()
    .toLowerCase();
  if (!EFFORT_ORDER.includes(desiredEffort)) {
    throw policyError(`unsupported AI effort override: ${effortOverride}`);
  }

  const runtimeMap = MODEL_MAP[selectedRuntime] || null;
  const mappedModel = String(modelOverride || runtimeMap?.[resolvedQuality] || "").trim() || null;
  let resolvedModel = mappedModel;
  let modelSource = modelOverride ? "operator-override" : runtimeMap ? "alias" : "provider-default";
  const normalizedCapabilities = normalizeCapabilities(capabilities);
  const fallbackReasons = [];

  if (
    resolvedModel &&
    normalizedCapabilities.models &&
    !normalizedCapabilities.models.has(resolvedModel)
  ) {
    fallbackReasons.push(
      `Requested model ${resolvedModel} is unavailable; using provider default.`
    );
    resolvedModel = null;
    modelSource = "provider-default";
  }

  const resolvedEffort = closestEffort(desiredEffort, normalizedCapabilities.effortLevels);
  if (resolvedEffort !== desiredEffort) {
    fallbackReasons.push(
      resolvedEffort
        ? `Requested effort ${desiredEffort} is unsupported; using ${resolvedEffort}.`
        : `Requested effort ${desiredEffort} is unsupported; using provider default.`
    );
  }

  return deepFreeze({
    policyVersion: AI_POLICY_VERSION,
    operation: operationId,
    runtimeId: selectedRuntime,
    adapterVersion: AI_ADAPTER_VERSION,
    requested: {
      quality: requestedQuality,
      reasoning: requestedReasoning,
    },
    resolved: {
      quality: resolvedQuality,
      reasoning:
        requestedReasoning === "automatic" ? operationDefaults.reasoning : requestedReasoning,
      model: resolvedModel,
      modelSource,
      effort: resolvedEffort,
      speedTier: null,
    },
    fallback: fallbackReasons.length
      ? {
          reason: fallbackReasons.join(" "),
          fromModel: mappedModel,
          toModel: resolvedModel,
          fromEffort: desiredEffort,
          toEffort: resolvedEffort,
        }
      : null,
  });
}

export function aiRuntimeIdForRoute(route) {
  if (route?.type === "installed") return String(route.runtime?.id || "").trim();
  if (route?.type === "byok") return "anthropic-api";
  if (route?.type === "proxy") return "managed-anthropic";
  return null;
}

export function assertAIExecutionPlanForRuntime(plan, runtimeId) {
  if (!plan || typeof plan !== "object") throw policyError("AI execution plan is required");
  if (plan.runtimeId !== runtimeId) {
    const error = new Error(
      `AI execution plan belongs to ${plan.runtimeId || "another runtime"}, not ${runtimeId}`
    );
    error.code = "AI_EXECUTION_PLAN_RUNTIME_MISMATCH";
    throw error;
  }
  if (!AI_OPERATION_DEFAULTS[plan.operation]) {
    throw policyError(`unknown AI operation in execution plan: ${plan.operation || "(empty)"}`);
  }
  return deepFreeze(plan);
}
