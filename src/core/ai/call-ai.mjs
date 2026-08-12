// call-ai.mjs — the one seam every skill calls through to reach a model.
//
// All candidate state stays local. In the desktop/app runtime, the primary AI
// route is a supported CLI already installed and authenticated on this
// computer; CareerRat invokes that executable with fixed argv and never copies
// its credentials. Provider routes remain explicit Advanced fallbacks.
// resolveAIRoute() applies one fixed priority so callers never re-derive it:
//
//   1. selected/desktop installed CLI, unless provider fallback is explicit.
//   2. ANTHROPIC_API_KEY set -> BYOK, direct to Anthropic.
//   3. CAREERRAT_AI_PROXY_URL set -> the managed-AI proxy (Bearer token +
//      x-careerrat-skill/x-careerrat-action labels the proxy meters by).
//   4. none -> an actionable no-route error (manual operation stays available).
//
// The proxy meters server-side, so callAI() never writes a usage_event on that
// path. On BYOK, nothing else is watching, so callAI() writes the usage_event
// itself (source: "byok") whenever a `root` is given — skipped silently
// otherwise, since a bare library caller may not have (or want) a workspace.
//
// Streaming returns a thin async iterator over parsed SSE events (not a
// re-wrapped SDK object) — extractSSEEvents() is the pure chunk-boundary parser
// shared with ai-proxy.mjs's byte-faithful tee, so the two places that ever
// read raw Anthropic SSE agree on framing.

import { resolveModelConfig } from "./ai-config.mjs";
import { detectInstalledRuntimes, runInstalledRuntime } from "./installed-runtimes.mjs";
import { loadInstalledRuntimeSelection } from "./runtime-selection.mjs";
import { appendUsageEvent } from "./usage-log.mjs";

const ANTHROPIC_VERSION = "2023-06-01";

// Host of a base URL, for the usage log's `upstream` field (cost-drift
// visibility across providers) — never throws on a malformed URL, since a
// metering label must never be the reason a real request fails.
function hostOf(url) {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export function resolveAIRoute(
  env = process.env,
  { repoRoot = null, runtimeInventory = null } = {}
) {
  if (repoRoot) {
    const selection = loadInstalledRuntimeSelection({ repoRoot, env });
    const installedRuntimeEnabled =
      selection.runtimeId !== null ||
      env.CAREERRAT_DESKTOP_SHELL === "1" ||
      env.CAREERRAT_INSTALLED_AI === "1";
    if (installedRuntimeEnabled && !selection.providerFallback) {
      // "custom" isn't in the fixed registry detectInstalledRuntimes() scans
      // (see installed-runtimes.mjs's probeCustomRuntimeCommand /
      // buildInstalledRuntimeInvocation "custom" branch) — its "path" is the
      // raw command string persisted by
      // POST /api/settings/ai-runtime/custom/select, not a resolved binary.
      if (selection.runtimeId === "custom" && selection.customCommand) {
        return {
          type: "installed",
          runtime: { id: "custom", name: "Custom command", path: selection.customCommand },
        };
      }
      const inventory = runtimeInventory || detectInstalledRuntimes({ env });
      const runtime = selection.runtimeId
        ? inventory.find(({ id, available }) => id === selection.runtimeId && available)
        : inventory.find(({ available }) => available);
      if (runtime) return { type: "installed", runtime };
      if (selection.runtimeId) {
        return {
          type: "none",
          error:
            `selected installed AI runtime "${selection.runtimeId}" is unavailable; ` +
            "re-detect it in Settings or choose the Advanced provider fallback",
        };
      }
    }
  }

  const apiKey = String(env.ANTHROPIC_API_KEY || "").trim();
  if (apiKey) {
    return {
      type: "byok",
      baseUrl: (
        String(env.CAREERRAT_ANTHROPIC_BASE_URL || "").trim() ||
        "https://api.anthropic.com"
      ).replace(/\/+$/, ""),
      apiKey,
    };
  }

  const proxyUrl = String(env.CAREERRAT_AI_PROXY_URL || "").trim();
  if (proxyUrl) {
    return {
      type: "proxy",
      baseUrl: proxyUrl.replace(/\/+$/, ""),
      token: String(env.CAREERRAT_AI_PROXY_TOKEN || "").trim(),
    };
  }

  return {
    type: "none",
    error:
      "no AI route configured: install and sign in to a supported AI CLI, or use the " +
      "Advanced provider fallback with ANTHROPIC_API_KEY / CAREERRAT_AI_PROXY_URL",
  };
}

// ---------------------------------------------------------------------------
// SSE framing — pure, shared with ai-proxy.mjs's tee.
// ---------------------------------------------------------------------------

// Split accumulated SSE text into complete events + a remainder to carry into
// the next chunk. Per the SSE spec an event may have multiple "data:" lines;
// they're joined before JSON.parse. Malformed payloads and the "[DONE]"
// sentinel some gateways emit are skipped, never thrown.
export function extractSSEEvents(buffer) {
  const events = [];
  let rest = buffer;
  let idx = rest.indexOf("\n\n");
  while (idx !== -1) {
    const rawEvent = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const dataLines = rawEvent
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length) {
      const payload = dataLines.join("\n");
      if (payload !== "[DONE]") {
        try {
          events.push(JSON.parse(payload));
        } catch {
          // skip malformed chunk rather than crash the stream
        }
      }
    }
    idx = rest.indexOf("\n\n");
  }
  return { events, remainder: rest };
}

async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, remainder } = extractSSEEvents(buffer);
      buffer = remainder;
      for (const event of events) yield event;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

// ---------------------------------------------------------------------------
// callAI()
// ---------------------------------------------------------------------------

// Keys that constrain a *value* (length/range/format/uniqueness/default)
// rather than describe *structure* (type/properties/required/etc). Anthropic's
// native structured-output wire format (output_config.format.schema) only
// accepts a subset of JSON Schema and 400s on these ("property 'X' is not
// supported"). Product schemas are authored for local validation and
// legitimately use the fuller vocabulary, so we strip only at this wire seam.
const NATIVE_SCHEMA_STRIPPED_KEYS = new Set([
  "maxItems",
  "minItems",
  "maxLength",
  "minLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "default",
]);

// Deep-clones `schema` and strips value-constraint keywords the native
// structured-output API rejects, recursing into properties/items/$defs/
// definitions/anyOf/allOf/oneOf/additionalProperties. Structural keywords
// (type, properties, required, enum, items, description, title, const,
// anyOf/allOf/oneOf, $ref, $defs) are left intact. The stripped constraints
// stay enforced locally by the bounded-AI validation layer after parse, so
// this only loosens model-side guidance — it never weakens correctness.
// Never mutates its input (callers often pass frozen module constants).
// Non-object input is returned unchanged.
export function sanitizeNativeOutputSchema(schema) {
  if (Array.isArray(schema)) {
    return schema.map((entry) => sanitizeNativeOutputSchema(entry));
  }
  if (schema === null || typeof schema !== "object") {
    return schema;
  }

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (NATIVE_SCHEMA_STRIPPED_KEYS.has(key)) continue;

    if (key === "properties" || key === "$defs" || key === "definitions") {
      const nested = {};
      for (const [propKey, propValue] of Object.entries(value || {})) {
        nested[propKey] = sanitizeNativeOutputSchema(propValue);
      }
      out[key] = nested;
    } else if (key === "items") {
      out[key] = sanitizeNativeOutputSchema(value);
    } else if (key === "anyOf" || key === "allOf" || key === "oneOf") {
      out[key] = Array.isArray(value)
        ? value.map((entry) => sanitizeNativeOutputSchema(entry))
        : value;
    } else if (key === "additionalProperties") {
      out[key] =
        value && typeof value === "object" && !Array.isArray(value)
          ? sanitizeNativeOutputSchema(value)
          : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function buildRequest(
  route,
  {
    model,
    system,
    messages,
    maxTokens,
    stream,
    feature,
    skill,
    action,
    operation,
    outputSchema,
    outputMode,
  }
) {
  const body = { model, max_tokens: maxTokens, messages, stream };
  if (system) body.system = system;
  if (outputMode === "native" && outputSchema) {
    // output_config.format takes only { type, schema } — the API rejects any
    // extra field (400 "Extra inputs are not permitted"). outputName is only
    // meaningful for the tool-based fallback mode, never sent natively. The
    // schema itself is sanitized (see sanitizeNativeOutputSchema) since the
    // native API also rejects several JSON-Schema value-constraint keywords
    // that product schemas legitimately use for local validation.
    body.output_config = {
      format: { type: "json_schema", schema: sanitizeNativeOutputSchema(outputSchema) },
    };
  }

  const headers = { "content-type": "application/json" };
  let url;
  if (route.type === "byok") {
    url = `${route.baseUrl}/v1/messages`;
    headers["x-api-key"] = route.apiKey;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  } else {
    url = `${route.baseUrl}/v1/messages`;
    headers.authorization = `Bearer ${route.token}`;
    if (feature) headers["x-careerrat-feature"] = feature;
    if (skill) headers["x-careerrat-skill"] = skill;
    if (action) headers["x-careerrat-action"] = action;
    if (operation) headers["x-careerrat-operation"] = operation;
  }
  return { url, headers, body };
}

function usageRow({ source, feature, skill, action, operation, model, usage, upstream }) {
  return {
    source,
    feature,
    skill,
    action,
    operation,
    model,
    upstream,
    tokens_in: usage?.input_tokens,
    tokens_out: usage?.output_tokens,
    cache_read_tokens: usage?.cache_read_input_tokens,
    cache_creation_tokens: usage?.cache_creation_input_tokens,
  };
}

// Engine identity for the ask bar's receipt line ("AI · <ENGINE LABEL> · <N>S")
// — derived from the resolved route, never invented. Installed CLI runtimes
// carry their own id/display name straight from the registry
// (installed-runtimes.mjs); the version isn't tracked anywhere today, so it's
// omitted rather than guessed. BYOK/proxy routes have no registry entry (they
// aren't an installed CLI), so they get a fixed, honest label for the
// provider actually serving the request.
export function describeAIEngine(route) {
  if (route.type === "installed") {
    return { id: route.runtime.id, label: route.runtime.name };
  }
  if (route.type === "byok") return { id: "anthropic", label: "Anthropic API" };
  if (route.type === "proxy") return { id: "proxy", label: "Managed AI Proxy" };
  return null;
}

function messageContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return String(part.text || "");
      return JSON.stringify(part);
    })
    .join("\n");
}

export function buildInstalledRuntimePrompt({ system, messages } = {}) {
  const sections = [];
  if (system) sections.push(`System instructions:\n${String(system).trim()}`);
  const turns = (Array.isArray(messages) ? messages : []).map(
    (message) =>
      `${String(message?.role || "user").toUpperCase()}:\n${messageContentText(message?.content)}`
  );
  if (turns.length) sections.push(`Conversation:\n${turns.join("\n\n")}`);
  sections.push(
    "Complete this request without reading or changing workspace files and return only the requested final answer."
  );
  return sections.join("\n\n");
}

async function runInstalledAI({
  route,
  system,
  messages,
  outputSchema,
  signal,
  root,
  env,
  feature,
  skill,
  action,
  operation,
  runInstalledRuntimeImpl,
}) {
  const startedAt = performance.now();
  const result = await runInstalledRuntimeImpl({
    runtime: route.runtime,
    prompt: buildInstalledRuntimePrompt({ system, messages }),
    outputSchema,
    model: String(env.CAREERRAT_INSTALLED_AI_MODEL || "").trim() || undefined,
    cwd: root,
    env,
    signal,
  });
  const elapsedMs = Math.round(performance.now() - startedAt);
  const runtimeModel = result.model || `installed:${route.runtime.id}`;
  if (root && result.usage) {
    appendUsageEvent(
      usageRow({
        source: "installed",
        feature,
        skill,
        action,
        operation,
        model: runtimeModel,
        upstream: `local-cli:${route.runtime.id}`,
        usage: result.usage,
      }),
      { root }
    );
  }
  return { ...result, model: runtimeModel, elapsedMs, engine: describeAIEngine(route) };
}

async function* streamInstalledAI(options) {
  const result = await runInstalledAI(options);
  yield {
    type: "message_start",
    message: {
      model: result.model,
      usage: result.usage || { input_tokens: 0, output_tokens: 0 },
    },
  };
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
  yield {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: result.text },
  };
  yield { type: "content_block_stop", index: 0 };
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: result.usage || { output_tokens: 0 },
  };
  yield { type: "message_stop" };
}

async function* streamAI({ res, route, model, feature, skill, action, operation, root }) {
  let inputTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let outputTokens = 0;
  let finalModel = model;
  let sawUsage = false;

  try {
    for await (const event of parseSSE(res.body)) {
      if (event?.type === "message_start") {
        const usage = event.message?.usage;
        if (usage) {
          inputTokens = usage.input_tokens || 0;
          cacheRead = usage.cache_read_input_tokens || 0;
          cacheCreation = usage.cache_creation_input_tokens || 0;
          sawUsage = true;
        }
        finalModel = event.message?.model || finalModel;
      } else if (event?.type === "message_delta" && event.usage?.output_tokens != null) {
        outputTokens = event.usage.output_tokens;
        sawUsage = true;
      }
      yield event;
    }
  } finally {
    if (route.type === "byok" && root && sawUsage) {
      appendUsageEvent(
        usageRow({
          source: "byok",
          feature,
          skill,
          action,
          operation,
          model: finalModel,
          upstream: hostOf(route.baseUrl),
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheCreation,
          },
        }),
        { root }
      );
    }
  }
}

export async function callAI({
  model,
  tier,
  system,
  messages,
  maxTokens,
  stream = false,
  feature = null,
  skill = null,
  action = null,
  operation = null,
  signal,
  root,
  env = process.env,
  outputSchema,
  outputName,
  outputMode = null,
  runtimeInventory = null,
  runInstalledRuntimeImpl = runInstalledRuntime,
} = {}) {
  const route = resolveAIRoute(env, { repoRoot: root, runtimeInventory });
  if (route.type === "none") throw new Error(route.error);

  if (route.type === "installed") {
    const options = {
      route,
      system,
      messages,
      outputSchema,
      signal,
      root,
      env,
      feature,
      skill,
      action,
      operation,
      runInstalledRuntimeImpl,
    };
    if (stream) return streamInstalledAI(options);
    const result = await runInstalledAI(options);
    return {
      content: [{ type: "text", text: result.text }],
      stopReason: "end_turn",
      model: result.model,
      usage: result.usage,
      elapsedMs: result.elapsedMs,
      engine: result.engine,
    };
  }

  // No-code model-swap seam (ai-config.mjs): a caller that doesn't pass a
  // model falls back to config/ai.json#model (itself already env-overridable
  // via ANTHROPIC_MODEL there) rather than sending `model: undefined`. A
  // caller may instead ask for the cheap tier via `tier: "smallFast"`, which
  // resolves to config/ai.json#smallFastModel (or its env override) before
  // falling back to the same default.
  const modelConfig = resolveModelConfig({ root, env });
  const resolvedModel =
    model || (tier === "smallFast" ? modelConfig.smallFastModel : null) || modelConfig.model;

  const { url, headers, body } = buildRequest(route, {
    model: resolvedModel,
    system,
    messages,
    maxTokens,
    stream,
    feature,
    skill,
    action,
    operation,
    outputSchema,
    outputName,
    outputMode,
  });

  const startedAt = performance.now();
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // The managed-AI proxy's per-tester spend cap (src/cli/ai-proxy.mjs) returns
    // this exact shape on 402, without ever reaching the model provider — a
    // non-retryable "you're out of budget" signal, not a generic provider
    // failure. Give it a distinct, human-readable error so callers (see
    // bounded-ai.mjs) can surface the cap message instead of "AI provider
    // request failed." The .code lets bounded-ai.mjs match reliably; the
    // message text itself is the fallback for any caller that only reads it.
    let parsedError = null;
    if (res.status === 402) {
      try {
        parsedError = text ? JSON.parse(text) : null;
      } catch {
        parsedError = null;
      }
    }
    if (parsedError?.error?.type === "cap_exceeded") {
      const capErr = new Error(
        parsedError.error.message ||
          "This beta account has reached its usage cap. Contact the person who invited you to raise it."
      );
      capErr.code = "AI_CAP_EXCEEDED";
      capErr.retryable = false;
      throw capErr;
    }
    throw new Error(
      `AI request failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`
    );
  }

  if (stream) {
    return streamAI({ res, route, model: resolvedModel, feature, skill, action, operation, root });
  }

  const data = await res.json();
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (route.type === "byok" && root) {
    appendUsageEvent(
      usageRow({
        source: "byok",
        feature,
        skill,
        action,
        operation,
        model: data.model || resolvedModel,
        upstream: hostOf(route.baseUrl),
        usage: data.usage,
      }),
      { root }
    );
  }

  return {
    content: data.content,
    stopReason: data.stop_reason,
    model: data.model,
    usage: data.usage,
    elapsedMs,
    engine: describeAIEngine(route),
  };
}
