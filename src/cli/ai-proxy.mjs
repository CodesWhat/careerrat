#!/usr/bin/env node
// Rolester managed-AI proxy — the one cloud surface in Shape 2 (see
// docs/ARCHITECTURE.md / Productization roadmap P0-3). Every other piece of
// candidate data — resumes, JDs, tracker state — stays on the user's machine;
// this process's only job is to sit between callAI()'s proxy route and the
// real model provider, injecting the real API key so the user never holds one,
// and metering what went through. It is intentionally stateless about content:
//
//   PRIVACY INVARIANT — this process never writes a request or response BODY
//   to disk, and never console.logs one (including on error paths). The usage
//   log (src/core/ai/usage-log.mjs) holds only counts, a model id, and the
//   skill/action labels the caller sent — never a prompt, a JD, or a resume.
//
// The upstream slot is generic on purpose (a base URL + a headers bag), not
// hardcoded to Anthropic's first-party API, so a later drop-in — e.g. Portkey,
// via ROLESTER_UPSTREAM_URL + ROLESTER_UPSTREAM_HEADERS carrying
// x-portkey-config — needs no code change here.
//
// Usage:
//   ROLESTER_PROXY_TOKEN=devtoken ROLESTER_UPSTREAM_KEY=sk-ant-... npm run ai-proxy
//
//   curl -s http://127.0.0.1:7788/v1/messages \
//     -H "authorization: Bearer devtoken" -H "content-type: application/json" \
//     -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
//
// Env:
//   ROLESTER_PROXY_TOKEN     required — the Bearer token clients present (dev-stub auth).
//   ROLESTER_UPSTREAM_KEY    required — the real provider key injected into upstream calls.
//   ROLESTER_UPSTREAM_URL    default https://api.anthropic.com — the gateway slot.
//   ROLESTER_UPSTREAM_HEADERS  optional JSON object of extra headers to inject upstream
//                              (e.g. {"x-portkey-config":"..."} when fronting Portkey).
//   ROLESTER_UPSTREAM_REPORTING  optional "1" to inject Vercel AI Gateway attribution
//                                headers on every outbound request: ai-reporting-user
//                                (a stable pseudonymous id, sha256 of the caller's own
//                                proxy token — never the raw token) and ai-reporting-tags
//                                (skill:.../action:... from x-rolester-skill/-action when
//                                present). Off by default; harmless to other upstreams.
//   ROLESTER_PROXY_PORT      default 7788.
//   ROLESTER_PROXY_METER_ROOT  default process.cwd() — root the usage log is written under.
//
// createProxyServer() below is a pure factory — no listen — so tests can construct
// one against an isolated meter root and mock upstream and drive it directly.
// main() is the only caller that reads env, validates it, and binds a socket, and
// only runs when this file is the entry script (see the import.meta.url guard).

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { extractSSEEvents } from "../core/ai/call-ai.mjs";
import { appendUsageEvent, computeCost, readUsageEvents } from "../core/ai/usage-log.mjs";

const ANTHROPIC_VERSION = "2023-06-01";

// Headers that are either transport-specific (must not be forwarded verbatim
// through fetch) or carry the client's own auth/metering labels (must never
// reach the upstream provider or leak which skill/action is asking).
const STRIPPED_INBOUND_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-authorization",
]);

// Response headers we don't pass through: they describe the upstream
// connection/encoding, not the body we're re-serving byte-for-byte over ours.
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "keep-alive",
]);

function log(msg) {
  // Never interpolate request/response bodies here — see the privacy invariant above.
  process.stderr.write(`[ai-proxy] ${msg}\n`);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Fixed-length digest compare: avoids both a length-branch timing leak and
// timingSafeEqual's own throw-on-mismatched-length-buffers behavior.
function digest(s) {
  return createHash("sha256")
    .update(String(s ?? ""), "utf8")
    .digest();
}
function tokensMatch(provided, expected) {
  return timingSafeEqual(digest(provided), digest(expected));
}

// Accepts the proxy token two ways: `authorization: Bearer <token>` (how
// call-ai.mjs's own proxy route sends it) or a bare `x-api-key: <token>` —
// the header the real Anthropic SDK client sends when ANTHROPIC_API_KEY is
// set (verified against the installed @anthropic-ai/claude-agent-sdk bundle,
// not assumed), which is how the embedded skill runtime (P0-4) routes the
// Agent SDK's own traffic through this proxy without an Authorization header
// at all. Shared with buildUpstreamHeaders() below, which hashes whichever
// token was actually presented into the (opt-in) ai-reporting-user header.
function extractProvidedToken(headers) {
  const header = String(headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const bearer = match ? match[1] : "";
  const apiKey = String(headers["x-api-key"] || "").trim();
  return bearer || apiKey;
}

function requireAuth(req, res, proxyToken) {
  const provided = extractProvidedToken(req.headers);
  if (!provided || !tokensMatch(provided, proxyToken)) {
    sendJson(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// First 12 hex chars of sha256(token) — stable per token, never the token
// itself. Long enough to attribute usage per-caller at the gateway without
// being reversible or colliding across a realistic number of proxy tokens.
function reportingUserId(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex").slice(0, 12);
}

// "skill:x,action:y" from the x-rolester-* labels, or null when neither is
// present — never emit an empty ai-reporting-tags header.
function buildReportingTags(inboundHeaders) {
  const tags = [];
  const feature = inboundHeaders["x-rolester-feature"];
  const skill = inboundHeaders["x-rolester-skill"];
  const action = inboundHeaders["x-rolester-action"];
  const operation = inboundHeaders["x-rolester-operation"];
  if (feature) tags.push(`feature:${Array.isArray(feature) ? feature.join(",") : feature}`);
  if (skill) tags.push(`skill:${Array.isArray(skill) ? skill.join(",") : skill}`);
  if (action) tags.push(`action:${Array.isArray(action) ? action.join(",") : action}`);
  if (operation)
    tags.push(`operation:${Array.isArray(operation) ? operation.join(",") : operation}`);
  return tags.length ? tags.join(",") : null;
}

function buildUpstreamHeaders(
  inboundHeaders,
  upstreamKey,
  extraHeaders,
  { env = process.env } = {}
) {
  const out = {};
  for (const [key, value] of Object.entries(inboundHeaders)) {
    if (value === undefined) continue;
    const k = key.toLowerCase();
    if (STRIPPED_INBOUND_HEADERS.has(k)) continue;
    if (k.startsWith("x-rolester-")) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  out["x-api-key"] = upstreamKey;
  out["anthropic-version"] = inboundHeaders["anthropic-version"] || ANTHROPIC_VERSION;
  Object.assign(out, extraHeaders || {});

  // Opt-in Vercel AI Gateway attribution headers — see the ROLESTER_UPSTREAM_REPORTING
  // doc at the top of this file. Off by default; harmless to other upstreams.
  if (String(env.ROLESTER_UPSTREAM_REPORTING || "").trim() === "1") {
    const providedToken = extractProvidedToken(inboundHeaders);
    if (providedToken) out["ai-reporting-user"] = reportingUserId(providedToken);
    const tags = buildReportingTags(inboundHeaders);
    if (tags) out["ai-reporting-tags"] = tags;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createProxyServer({
  proxyToken,
  upstreamKey,
  upstreamUrl = "https://api.anthropic.com",
  upstreamHeaders = {},
  meterRoot = process.cwd(),
  env = process.env,
} = {}) {
  if (!String(proxyToken || "").trim())
    throw new Error("ai-proxy: ROLESTER_PROXY_TOKEN is required");
  if (!String(upstreamKey || "").trim())
    throw new Error("ai-proxy: ROLESTER_UPSTREAM_KEY is required");

  const base = upstreamUrl.replace(/\/+$/, "");
  // Host of the upstream base URL, for the usage log's `upstream` field (cost-
  // drift visibility across providers) — never throws on a malformed URL.
  const upstreamHost = (() => {
    try {
      return new URL(base).host || null;
    } catch {
      return null;
    }
  })();

  // Since-boot totals, seeded from any prior proxy-sourced rows in the usage
  // log so a restart doesn't reset /meter to zero (see usage-log.mjs's own
  // append-only ledger — this is just a running fold over it).
  const counters = { requests: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, unpriced_requests: 0 };
  for (const event of readUsageEvents({ root: meterRoot })) {
    if (event.source !== "proxy") continue;
    counters.requests += 1;
    counters.tokens_in += event.tokens_in || 0;
    counters.tokens_out += event.tokens_out || 0;
    if (event.priced) counters.cost_usd += event.cost_usd || 0;
    else counters.unpriced_requests += 1;
  }

  function recordUsage({ model, feature, skill, action, operation, usage }) {
    const row = {
      source: "proxy",
      feature: feature || null,
      skill: skill || null,
      action: action || null,
      operation: operation || null,
      model,
      upstream: upstreamHost,
      tokens_in: usage.input_tokens,
      tokens_out: usage.output_tokens,
      cache_read_tokens: usage.cache_read_input_tokens,
      cache_creation_tokens: usage.cache_creation_input_tokens,
    };
    const { event } = appendUsageEvent(row, { root: meterRoot });
    counters.requests += 1;
    counters.tokens_in += event.tokens_in;
    counters.tokens_out += event.tokens_out;
    if (event.priced) counters.cost_usd += event.cost_usd;
    else counters.unpriced_requests += 1;
  }

  async function proxyPass(req, res) {
    const url = new URL(req.url, "http://internal");
    const path = url.pathname;
    const featureLabel = req.headers["x-rolester-feature"];
    const skillLabel = req.headers["x-rolester-skill"];
    const actionLabel = req.headers["x-rolester-action"];
    const operationLabel = req.headers["x-rolester-operation"];

    let bodyBuffer = Buffer.alloc(0);
    if (req.method !== "GET" && req.method !== "HEAD") {
      bodyBuffer = await readRequestBody(req);
    }

    const outboundHeaders = buildUpstreamHeaders(req.headers, upstreamKey, upstreamHeaders, {
      env,
    });
    const upstreamUrlFull = `${base}${path}${url.search}`;

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreamUrlFull, {
        method: req.method,
        headers: outboundHeaders,
        body: bodyBuffer.length ? bodyBuffer : undefined,
      });
    } catch (err) {
      // err.message may echo the target URL but never body content — safe to log.
      log(`upstream unreachable: ${err.message}`);
      sendJson(res, 502, { error: "upstream_unreachable" });
      return;
    }

    const resHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
      resHeaders[key] = value;
    }
    res.writeHead(upstreamRes.status, resHeaders);

    if (!upstreamRes.body) {
      res.end();
      return;
    }

    const shouldMeter = path === "/v1/messages" && req.method === "POST";
    const contentType = upstreamRes.headers.get("content-type") || "";
    const isSSE = contentType.includes("text/event-stream");

    const decoder = shouldMeter && isSSE ? new TextDecoder() : null;
    let sseBuffer = "";
    const jsonChunks = shouldMeter && !isSSE ? [] : null;

    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    let modelSeen = null;
    let sawUsage = false;

    const reader = upstreamRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Forward the exact bytes first — metering parses a copy, never mutates
        // what's sent to the client.
        res.write(value);
        if (!shouldMeter) continue;

        if (isSSE) {
          sseBuffer += decoder.decode(value, { stream: true });
          const { events, remainder } = extractSSEEvents(sseBuffer);
          sseBuffer = remainder;
          for (const event of events) {
            if (event?.type === "message_start" && event.message?.usage) {
              usage.input_tokens = event.message.usage.input_tokens || 0;
              usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens || 0;
              usage.cache_creation_input_tokens =
                event.message.usage.cache_creation_input_tokens || 0;
              modelSeen = event.message.model || modelSeen;
              sawUsage = true;
            } else if (event?.type === "message_delta" && event.usage?.output_tokens != null) {
              usage.output_tokens = event.usage.output_tokens;
              sawUsage = true;
            }
          }
        } else {
          jsonChunks.push(value);
        }
      }
    } finally {
      res.end();
    }

    if (!shouldMeter) return;

    if (!isSSE) {
      try {
        const parsed = JSON.parse(Buffer.concat(jsonChunks).toString("utf8"));
        if (parsed?.usage) {
          usage.input_tokens = parsed.usage.input_tokens || 0;
          usage.output_tokens = parsed.usage.output_tokens || 0;
          usage.cache_read_input_tokens = parsed.usage.cache_read_input_tokens || 0;
          usage.cache_creation_input_tokens = parsed.usage.cache_creation_input_tokens || 0;
          modelSeen = parsed.model || modelSeen;
          sawUsage = true;
        }
      } catch {
        // malformed/non-JSON upstream body — nothing to meter, never logged
      }
    }

    if (sawUsage) {
      recordUsage({
        model: modelSeen,
        feature: featureLabel,
        skill: skillLabel,
        action: actionLabel,
        operation: operationLabel,
        usage,
      });
    }
  }

  function handleMeter(_req, res) {
    sendJson(res, 200, {
      requests: counters.requests,
      tokens_in: counters.tokens_in,
      tokens_out: counters.tokens_out,
      cost_usd: counters.cost_usd,
      unpriced_requests: counters.unpriced_requests,
    });
  }

  const server = createServer((req, res) => {
    if (!requireAuth(req, res, proxyToken)) return;

    const path = (req.url || "/").split("?")[0];

    if (req.method === "GET" && path === "/meter") {
      handleMeter(req, res);
      return;
    }

    if (path.startsWith("/v1/")) {
      proxyPass(req, res).catch((err) => {
        log(`proxy pass failed: ${err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: "proxy_error" });
        else res.end();
      });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  });

  return { server, counters, meterRoot };
}

// Exported for tests that want to check cost math against the same table the
// proxy uses without re-deriving it.
export { computeCost };

// ---------------------------------------------------------------------------
// Boot (CLI entry point only — see the import.meta.url guard at the bottom)
// ---------------------------------------------------------------------------

function parseUpstreamHeaders(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    log("ROLESTER_UPSTREAM_HEADERS is not valid JSON — ignoring");
    return {};
  }
}

function main() {
  const proxyToken = process.env.ROLESTER_PROXY_TOKEN;
  const upstreamKey = process.env.ROLESTER_UPSTREAM_KEY;

  if (!String(proxyToken || "").trim() || !String(upstreamKey || "").trim()) {
    log("refusing to start: ROLESTER_PROXY_TOKEN and ROLESTER_UPSTREAM_KEY are both required");
    process.exit(1);
  }

  const port = Number(process.env.ROLESTER_PROXY_PORT) || 7788;
  const upstreamUrl = process.env.ROLESTER_UPSTREAM_URL || "https://api.anthropic.com";
  const upstreamHeaders = parseUpstreamHeaders(process.env.ROLESTER_UPSTREAM_HEADERS);
  const meterRoot = process.env.ROLESTER_PROXY_METER_ROOT || process.cwd();

  const { server } = createProxyServer({
    proxyToken,
    upstreamKey,
    upstreamUrl,
    upstreamHeaders,
    meterRoot,
  });

  server.listen(port, "127.0.0.1", () => {
    log(`serving http://127.0.0.1:${port} → upstream ${upstreamUrl}`);
  });
  server.on("error", (err) => {
    log(`server error: ${err.message}`);
    process.exit(1);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
