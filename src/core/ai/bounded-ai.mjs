import { callAI } from "./call-ai.mjs";
import {
  buildCorrectiveAddendum,
  parseStructuredJson,
  runStructuredOneshot,
} from "./structured-oneshot.mjs";

export const BOUNDED_AI_CODES = Object.freeze({
  AI_SCHEMA_INVALID: "AI_SCHEMA_INVALID",
  NO_AI_ROUTE: "NO_AI_ROUTE",
  AI_PROVIDER_FAILED: "AI_PROVIDER_FAILED",
  AI_LABELS_INVALID: "AI_LABELS_INVALID",
  AI_CAP_EXCEEDED: "AI_CAP_EXCEEDED",
});

export const BOUNDED_AI_MODES = Object.freeze({
  fallback: "fallback",
  native: "native",
});

const STRUCTURED_MODES = Object.freeze({
  fallback: "fallback",
  nativePreferred: "native-preferred",
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
  if (ai.executionPlan && typeof ai.executionPlan === "object") {
    output.executionPlan = ai.executionPlan;
  }
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

export function extractAIText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (!block || typeof block !== "object") return "";
        if (block.type === "text" || Object.hasOwn(block, "text")) {
          return String(block.text ?? "");
        }
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object") {
    if (Object.hasOwn(content, "text")) return String(content.text ?? "");
    if (Object.hasOwn(content, "content")) return extractAIText(content.content);
  }
  return String(content ?? "");
}

function unwrapInvocationResult(result) {
  if (typeof result === "string") return { text: result, model: null, executionPlan: null };
  if (!result || typeof result !== "object") {
    return { text: String(result ?? ""), model: null, executionPlan: null };
  }
  return {
    text: extractAIText(result.text ?? result.rawText ?? result.raw ?? result.content ?? ""),
    model: trimString(result.model) || null,
    executionPlan:
      result.executionPlan && typeof result.executionPlan === "object"
        ? result.executionPlan
        : null,
  };
}

function isNoAIError(err) {
  return (
    err?.code === BOUNDED_AI_CODES.NO_AI_ROUTE ||
    /no AI route configured/i.test(String(err?.message || ""))
  );
}

// call-ai.mjs throws this (err.code === "AI_CAP_EXCEEDED") when the managed-AI
// proxy's per-tester spend cap rejected the request with a 402 before it ever
// reached the model provider — see the matching throw in call-ai.mjs. The
// regex fallback covers a caller that only inspects the message text.
function isCapExceededError(err) {
  return (
    err?.code === "AI_CAP_EXCEEDED" || /reached its usage cap/i.test(String(err?.message || ""))
  );
}

function aiMetadata({
  labels,
  used,
  retried = false,
  model = null,
  mode = BOUNDED_AI_MODES.fallback,
  executionPlan = null,
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
    ...(executionPlan ? { executionPlan } : {}),
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

function withDefined(base, fields) {
  const output = { ...base };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

async function runNativePreferred({
  labels,
  schema,
  manual,
  maxRetries,
  call,
  messages,
  system,
  model: requestedModel,
  effort,
  tier,
  aiOperation,
  quality,
  reasoning,
  aiCapabilities,
  executionPlan,
  maxTokens,
  outputName,
  root,
  env,
  signal,
  validateData,
}) {
  const nativeCall = call || callAI;
  let attempt = 0;
  let lastErrors = null;
  let responseModel = null;
  let responseExecutionPlan = executionPlan || null;
  // Grows one {assistant, user} turn pair per retry so roles strictly
  // alternate (the Messages API rejects two consecutive "user" turns) — the
  // model's own prior (invalid) reply becomes the assistant turn the
  // corrective addendum replies to.
  let conversation = Array.isArray(messages) ? [...messages] : [];

  while (attempt <= maxRetries) {
    const response = await nativeCall(
      withDefined(
        {
          messages: conversation,
          skill: labels.skill,
          action: labels.action,
          operation: labels.operation,
          outputMode: "native",
          outputSchema: schema,
        },
        {
          system,
          model: requestedModel,
          effort,
          tier,
          aiOperation: responseExecutionPlan ? undefined : aiOperation,
          quality,
          reasoning,
          aiCapabilities,
          executionPlan: responseExecutionPlan || undefined,
          maxTokens,
          outputName,
          root,
          env,
          signal,
        }
      )
    );
    const unwrapped = unwrapInvocationResult(response);
    if (unwrapped.model) responseModel = unwrapped.model;
    if (unwrapped.executionPlan) responseExecutionPlan = unwrapped.executionPlan;
    const parsed = parseStructuredJson(unwrapped.text, schema, validateData);
    if (parsed.ok) {
      return makeBoundedAIEnvelope({
        ok: true,
        status: 200,
        data: parsed.data,
        ai: aiMetadata({
          labels,
          used: true,
          mode: BOUNDED_AI_MODES.native,
          retried: attempt > 0,
          model: responseModel,
          executionPlan: responseExecutionPlan,
        }),
        manual,
      });
    }
    lastErrors = parsed.errors;
    conversation = [
      ...conversation,
      { role: "assistant", content: unwrapped.text },
      { role: "user", content: buildCorrectiveAddendum(parsed.errors) },
    ];
    attempt++;
  }

  return makeBoundedAIEnvelope({
    ok: false,
    status: 422,
    code: BOUNDED_AI_CODES.AI_SCHEMA_INVALID,
    error: {
      message: "Model output did not match the route schema.",
      details: lastErrors,
    },
    ai: aiMetadata({
      labels,
      used: true,
      mode: BOUNDED_AI_MODES.native,
      retried: maxRetries > 0,
      model: responseModel,
      executionPlan: responseExecutionPlan,
    }),
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
  structuredMode = STRUCTURED_MODES.fallback,
  call,
  messages,
  system,
  model,
  effort,
  tier,
  aiOperation,
  quality,
  reasoning,
  aiCapabilities,
  executionPlan,
  maxTokens,
  outputName,
  root,
  env,
  signal,
  validateData,
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

  let fallbackModel = null;
  try {
    if (structuredMode === STRUCTURED_MODES.nativePreferred) {
      return await runNativePreferred({
        labels: normalizedLabels,
        schema,
        manual,
        maxRetries,
        call,
        messages,
        system,
        model,
        effort,
        tier,
        aiOperation,
        quality,
        reasoning,
        aiCapabilities,
        executionPlan,
        maxTokens,
        outputName,
        root,
        env,
        signal,
        validateData,
      });
    }

    const outcome = await structuredRunner({
      schema,
      maxRetries,
      validateData,
      invoke: async ({ attempt, correction }) => {
        const invocation = await invoke({ attempt, correction, labels: normalizedLabels });
        const unwrapped = unwrapInvocationResult(invocation);
        if (unwrapped.model) fallbackModel = unwrapped.model;
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
          model: fallbackModel,
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
        model: fallbackModel,
      }),
      manual,
    });
  } catch (err) {
    const failureMode =
      structuredMode === STRUCTURED_MODES.nativePreferred ? BOUNDED_AI_MODES.native : mode;
    if (isNoAIError(err)) {
      return makeBoundedAIEnvelope({
        ok: false,
        status: 501,
        code: BOUNDED_AI_CODES.NO_AI_ROUTE,
        error: { message: "No AI route is configured for this bounded assist." },
        ai: aiMetadata({
          labels: normalizedLabels,
          used: false,
          mode: failureMode,
          retried: false,
          model: fallbackModel,
        }),
        manual,
      });
    }

    if (isCapExceededError(err)) {
      return makeBoundedAIEnvelope({
        ok: false,
        status: 402,
        code: BOUNDED_AI_CODES.AI_CAP_EXCEEDED,
        error: {
          message:
            trimString(err?.message) ||
            "This beta account has reached its usage cap. Contact the person who invited you to raise it.",
        },
        ai: aiMetadata({
          labels: normalizedLabels,
          used: false,
          mode: failureMode,
          retried: false,
          model: fallbackModel,
        }),
        manual,
      });
    }

    return makeBoundedAIEnvelope({
      ok: false,
      status: 502,
      code: BOUNDED_AI_CODES.AI_PROVIDER_FAILED,
      error: { message: "AI provider request failed." },
      ai: aiMetadata({
        labels: normalizedLabels,
        used: true,
        mode: failureMode,
        retried: false,
        model: fallbackModel,
      }),
      manual,
    });
  }
}
