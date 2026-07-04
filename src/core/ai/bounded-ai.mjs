import { runStructuredOneshot } from "./structured-oneshot.mjs";

export const BOUNDED_AI_CODES = Object.freeze({
  AI_SCHEMA_INVALID: "AI_SCHEMA_INVALID",
  NO_AI_ROUTE: "NO_AI_ROUTE",
  AI_PROVIDER_FAILED: "AI_PROVIDER_FAILED",
  AI_LABELS_INVALID: "AI_LABELS_INVALID",
});

export const BOUNDED_AI_MODES = Object.freeze({
  fallback: "fallback",
});

const LABEL_FIELDS = ["skill", "action", "operation"];

function trimString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function labelId(labels) {
  return `${labels.skill}:${labels.action}:${labels.operation}`;
}

function labelsError(missing) {
  const err = new Error(`bounded AI labels required: ${missing.join(", ")}`);
  err.code = BOUNDED_AI_CODES.AI_LABELS_INVALID;
  err.details = { missing };
  return err;
}

export function requireBoundedAILabels(labels = {}) {
  const normalized = {};
  const missing = [];
  for (const field of LABEL_FIELDS) {
    const value = trimString(labels?.[field]);
    if (!value) missing.push(field);
    normalized[field] = value;
  }
  if (missing.length) throw labelsError(missing);
  return normalized;
}

function normalizeManual(manual = {}) {
  const input = manual && typeof manual === "object" ? manual : {};
  const output = { available: Boolean(input.available) };
  const reason = trimString(input.reason);
  const action = trimString(input.action);
  if (reason) output.reason = reason;
  if (action) output.action = action;
  return output;
}

function normalizeAI(ai = {}) {
  const output = { used: Boolean(ai.used) };
  for (const field of ["label", "skill", "action", "operation", "mode", "model"]) {
    const value = trimString(ai[field]);
    if (value) output[field] = value;
  }
  if (Object.hasOwn(ai, "retried")) output.retried = Boolean(ai.retried);
  return output;
}

function normalizeDetails(details) {
  if (!Array.isArray(details)) return undefined;
  const safe = details
    .map((entry) => ({
      path: trimString(entry?.path),
      message: trimString(entry?.message),
    }))
    .filter((entry) => entry.path || entry.message);
  return safe.length ? safe : undefined;
}

function normalizeError(error) {
  if (!error) return undefined;
  const input = typeof error === "object" ? error : { message: error };
  const message = trimString(input.message) || "Bounded AI request failed.";
  const output = { message };
  const details = normalizeDetails(input.details || input.errors);
  if (details) output.details = details;
  return output;
}

export function makeBoundedAIEnvelope({ ok, status, code, data, error, ai, manual } = {}) {
  const body = { ok: Boolean(ok) };
  const safeCode = trimString(code);
  if (safeCode) body.code = safeCode;
  if (ok && data !== undefined) body.data = data;
  const safeError = normalizeError(error);
  if (safeError) body.error = safeError;
  body.ai = normalizeAI(ai);
  body.manual = normalizeManual(manual);
  return { status: Number(status) || (ok ? 200 : 500), body };
}

function unwrapInvocationResult(result) {
  if (typeof result === "string") return { text: result, model: null };
  if (!result || typeof result !== "object") return { text: String(result ?? ""), model: null };
  return {
    text: String(result.text ?? result.rawText ?? result.raw ?? result.content ?? ""),
    model: trimString(result.model) || null,
  };
}

function isNoAIError(err) {
  return (
    err?.code === BOUNDED_AI_CODES.NO_AI_ROUTE ||
    /no AI route configured/i.test(String(err?.message || ""))
  );
}

function aiMetadata({
  labels,
  used,
  retried = false,
  model = null,
  mode = BOUNDED_AI_MODES.fallback,
}) {
  const base = labels
    ? {
        label: labelId(labels),
        skill: labels.skill,
        action: labels.action,
        operation: labels.operation,
      }
    : {};
  return {
    used,
    ...base,
    mode,
    retried,
    ...(model ? { model } : {}),
  };
}

function labelFailureEnvelope(err, manual) {
  return makeBoundedAIEnvelope({
    ok: false,
    status: 400,
    code: BOUNDED_AI_CODES.AI_LABELS_INVALID,
    error: {
      message: "Bounded AI calls require skill, action, and operation labels.",
      details: err?.details?.missing?.map((field) => ({
        path: field,
        message: "label is required",
      })),
    },
    ai: { used: false },
    manual,
  });
}

export async function runBoundedAI({
  labels,
  schema,
  manual = {},
  maxRetries = 1,
  invoke,
  mode = BOUNDED_AI_MODES.fallback,
  structuredRunner = runStructuredOneshot,
} = {}) {
  let normalizedLabels;
  try {
    normalizedLabels = requireBoundedAILabels(labels);
  } catch (err) {
    if (err?.code === BOUNDED_AI_CODES.AI_LABELS_INVALID) {
      return labelFailureEnvelope(err, manual);
    }
    throw err;
  }

  let model = null;
  try {
    const outcome = await structuredRunner({
      schema,
      maxRetries,
      invoke: async ({ attempt, correction }) => {
        const invocation = await invoke({ attempt, correction, labels: normalizedLabels });
        const unwrapped = unwrapInvocationResult(invocation);
        if (unwrapped.model) model = unwrapped.model;
        return unwrapped.text;
      },
    });

    if (outcome.ok) {
      return makeBoundedAIEnvelope({
        ok: true,
        status: 200,
        data: outcome.data,
        ai: aiMetadata({
          labels: normalizedLabels,
          used: true,
          mode,
          retried: outcome.retried,
          model,
        }),
        manual,
      });
    }

    return makeBoundedAIEnvelope({
      ok: false,
      status: 422,
      code: BOUNDED_AI_CODES.AI_SCHEMA_INVALID,
      error: {
        message: "Model output did not match the route schema.",
        details: outcome.errors,
      },
      ai: aiMetadata({
        labels: normalizedLabels,
        used: true,
        mode,
        retried: maxRetries > 0,
        model,
      }),
      manual,
    });
  } catch (err) {
    if (isNoAIError(err)) {
      return makeBoundedAIEnvelope({
        ok: false,
        status: 501,
        code: BOUNDED_AI_CODES.NO_AI_ROUTE,
        error: { message: "No AI route is configured for this bounded assist." },
        ai: aiMetadata({ labels: normalizedLabels, used: false, mode, retried: false, model }),
        manual,
      });
    }

    return makeBoundedAIEnvelope({
      ok: false,
      status: 502,
      code: BOUNDED_AI_CODES.AI_PROVIDER_FAILED,
      error: { message: "AI provider request failed." },
      ai: aiMetadata({ labels: normalizedLabels, used: true, mode, retried: false, model }),
      manual,
    });
  }
}
