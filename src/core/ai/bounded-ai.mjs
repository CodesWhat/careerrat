export const BOUNDED_AI_CODES = Object.freeze({
  AI_SCHEMA_INVALID: "AI_SCHEMA_INVALID",
  NO_AI_ROUTE: "NO_AI_ROUTE",
  AI_PROVIDER_FAILED: "AI_PROVIDER_FAILED",
  AI_LABELS_INVALID: "AI_LABELS_INVALID",
});

export const BOUNDED_AI_MODES = Object.freeze({
  fallback: "fallback",
});

export function requireBoundedAILabels(labels) {
  return labels;
}

export function makeBoundedAIEnvelope() {
  return { status: 500, body: { ok: false } };
}

export async function runBoundedAI() {
  return { status: 500, body: { ok: false } };
}
