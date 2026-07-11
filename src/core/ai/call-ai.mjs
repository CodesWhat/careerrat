// call-ai.mjs — the one seam every skill calls through to reach a model.
//
// Shape 2 (see docs/ARCHITECTURE.md / the Productization roadmap): all candidate
// data stays local; the only cloud surface is a stateless metering proxy
// (src/cli/ai-proxy.mjs), and a user who'd rather use their own Anthropic key
// never has to touch it. resolveAIRoute() picks between the two with a fixed
// priority so callers (and tests) never have to re-derive it:
//
//   1. ANTHROPIC_API_KEY set  -> BYOK, direct to Anthropic.
//   2. ROLESTER_AI_PROXY_URL set -> the managed-AI proxy (Bearer token +
//      x-rolester-skill/x-rolester-action labels the proxy meters by).
//   3. neither -> throw, naming both options (never a silent no-op).
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

export function resolveAIRoute(env = process.env) {
  const apiKey = String(env.ANTHROPIC_API_KEY || "").trim();
  if (apiKey) {
    return {
      type: "byok",
      baseUrl: (
        String(env.ROLESTER_ANTHROPIC_BASE_URL || "").trim() || "https://api.anthropic.com"
      ).replace(/\/+$/, ""),
      apiKey,
    };
  }

  const proxyUrl = String(env.ROLESTER_AI_PROXY_URL || "").trim();
  if (proxyUrl) {
    return {
      type: "proxy",
      baseUrl: proxyUrl.replace(/\/+$/, ""),
      token: String(env.ROLESTER_AI_PROXY_TOKEN || "").trim(),
    };
  }

  return {
    type: "none",
    error:
      "no AI route configured: set ANTHROPIC_API_KEY to call Anthropic directly (BYOK), " +
      "or ROLESTER_AI_PROXY_URL (+ ROLESTER_AI_PROXY_TOKEN) to use the managed-AI proxy",
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
    outputName,
    outputMode,
  }
) {
  const body = { model, max_tokens: maxTokens, messages, stream };
  if (system) body.system = system;
  if (outputMode === "native" && outputSchema) {
    const format = { type: "json_schema", schema: outputSchema };
    if (outputName) format.name = outputName;
    body.output_config = { format };
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
    if (feature) headers["x-rolester-feature"] = feature;
    if (skill) headers["x-rolester-skill"] = skill;
    if (action) headers["x-rolester-action"] = action;
    if (operation) headers["x-rolester-operation"] = operation;
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
} = {}) {
  const route = resolveAIRoute(env);
  if (route.type === "none") throw new Error(route.error);

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

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `AI request failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`
    );
  }

  if (stream) {
    return streamAI({ res, route, model: resolvedModel, feature, skill, action, operation, root });
  }

  const data = await res.json();

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
  };
}
