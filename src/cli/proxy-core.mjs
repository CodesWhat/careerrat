#!/usr/bin/env node
// proxy-core.mjs — the per-request pipeline shared by the two managed-AI
// proxy front ends: the long-lived node:http server (src/cli/ai-proxy.mjs,
// `npm run ai-proxy`) and the Vercel serverless function
// (apps/proxy-vercel/api/v1/[...path].mjs). Both wrap this module; neither
// re-implements auth, header injection/stripping, SSE usage parsing, or the
// metering row shape — the two front ends differ only in how they source a
// per-request spend figure (an in-memory accumulator for the long-lived
// server vs. a per-request DB sum for serverless, since there's no process
// to hold an accumulator between invocations) and how they pump response
// bytes to the client (node:http `res.write()` vs. a Web ReadableStream
// handed to a `Response`).
//
//   PRIVACY INVARIANT — same one ai-proxy.mjs's header holds: nothing in this
//   module ever sees, logs, or returns a request/response BODY or a raw
//   token. Every function here only ever touches headers, byte counts, and
//   the already-parsed `usage` block of an Anthropic Messages response —
//   never message content.
//
// Pure functions only (no fs, no sockets, no process.env reads baked in —
// env is always an explicit parameter) so both front ends, and their tests,
// can drive this module directly without a live server.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const ANTHROPIC_VERSION = "2023-06-01";

// Headers that are either transport-specific (must not be forwarded verbatim
// through fetch) or carry the client's own auth/metering labels (must never
// reach the upstream provider or leak which skill/action is asking).
export const STRIPPED_INBOUND_HEADERS = new Set([
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
export const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "keep-alive",
]);

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

// Normalizes either a Web Headers instance (the Vercel handler's
// request.headers) or a plain object (node:http's req.headers, already
// lowercase-keyed) into a plain lowercase-keyed object, so every function
// below can treat "headers" as one shape regardless of front end.
export function normalizeHeaders(headers) {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const out = {};
    for (const [key, value] of headers.entries()) out[key.toLowerCase()] = value;
    return out;
  }
  return headers || {};
}

// Accepts the proxy token two ways: `authorization: Bearer <token>` (how
// call-ai.mjs's own proxy route sends it) or a bare `x-api-key: <token>` —
// the header the real Anthropic SDK client sends when ANTHROPIC_API_KEY is
// set, which is how the embedded skill runtime (P0-4) routes the Agent
// SDK's own traffic through this proxy without an Authorization header at
// all. Shared with buildUpstreamHeaders() below, which hashes whichever
// token was actually presented into the (opt-in) ai-reporting-user header.
export function extractProvidedToken(headers) {
  const header = String(headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const bearer = match ? match[1] : "";
  const apiKey = String(headers["x-api-key"] || "").trim();
  return bearer || apiKey;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// Fixed-length digest compare: avoids both a length-branch timing leak and
// timingSafeEqual's own throw-on-mismatched-length-buffers behavior.
function digest(s) {
  return createHash("sha256")
    .update(String(s ?? ""), "utf8")
    .digest();
}
export function tokensMatch(provided, expected) {
  return timingSafeEqual(digest(provided), digest(expected));
}

// Builds the effective set of valid (label, token) pairs from the two config
// surfaces: the single ROLESTER_PROXY_TOKEN (labeled "default" for usage-log
// attribution) and the multi-tester ROLESTER_PROXY_TOKENS map. Both may be
// set at once — the valid token set is their union. Labels are operator-
// facing only and are never sent upstream.
export function buildTokenEntries(proxyToken, proxyTokens) {
  const entries = [];
  const single = String(proxyToken || "").trim();
  if (single) entries.push({ label: "default", token: single });
  for (const [label, token] of Object.entries(proxyTokens || {})) {
    const t = String(token || "").trim();
    if (t) entries.push({ label: String(label || "").trim() || "default", token: t });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Minted proxy tokens — the beta Clerk-session exchange
// (apps/proxy-vercel/api/auth/exchange.mjs) mints one of these per Clerk
// user and stores only its hash (meter-db.mjs's createTokenStore()), never
// the raw token. The "rlp_" prefix lets authenticate() below cheaply tell a
// minted token from a static ROLESTER_PROXY_TOKEN(S) value before paying for
// a DB round trip.
// ---------------------------------------------------------------------------

export const MINTED_TOKEN_PREFIX = "rlp_";
const MINTED_TOKEN_RE = /^rlp_[0-9a-f]{64}$/;

export function looksLikeMintedToken(token) {
  return MINTED_TOKEN_RE.test(String(token ?? ""));
}

// "rlp_" + 64 hex chars (32 random bytes) — long enough to be unguessable,
// distinct enough from operator-issued static tokens to route straight to
// the DB lookup path in authenticate() below.
export function mintProxyToken() {
  return MINTED_TOKEN_PREFIX + randomBytes(32).toString("hex");
}

// Full SHA-256 hex of the token string — this, never the token itself, is
// what's persisted (proxy_tokens.token_hash) and looked up on every request.
export function hashProxyToken(token) {
  return createHash("sha256")
    .update(String(token ?? ""), "utf8")
    .digest("hex");
}

// Checks the presented token against every configured (label, token) pair —
// never breaks early on a match, so auth timing doesn't vary with how many
// testers are configured or which one matched. That static check is the
// FIRST thing this function does, unchanged and synchronous internally, so
// the common case (a static ROLESTER_PROXY_TOKEN(S) match) never pays for an
// awaited DB lookup. Only when there's no static match, the presented token
// looks like a minted token (see looksLikeMintedToken above), and a caller
// injected `lookupMintedToken` (the front end's token store, when a meter DB
// is configured) does this fall through to an async minted-token lookup —
// hashProxyToken(token), never the raw token, is what's looked up. A missing
// row or one with revokedAt set is a rejection. Returns the matched entry's
// label + the raw provided token (for reportingUserId()/reportingUserIdForClerk()
// and the cap check downstream) plus clerkUserId (null for a static token,
// the Clerk user id for a minted one), or null on failure — writing the 401
// response is each front end's own job. Never logs the token.
export async function authenticate(headers, tokenEntries, { lookupMintedToken } = {}) {
  const provided = extractProvidedToken(headers);
  let matchedLabel = null;
  if (provided) {
    for (const { label, token } of tokenEntries) {
      if (tokensMatch(provided, token)) matchedLabel = label;
    }
  }
  if (matchedLabel) return { label: matchedLabel, token: provided, clerkUserId: null };

  if (provided && looksLikeMintedToken(provided) && lookupMintedToken) {
    const row = await lookupMintedToken(hashProxyToken(provided));
    if (!row || row.revokedAt) return null;
    return { label: row.label, token: provided, clerkUserId: row.clerkUserId };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Upstream header injection/stripping + Vercel AI Gateway attribution
// ---------------------------------------------------------------------------

// First 12 hex chars of sha256(token) — stable per token, never the token
// itself. Long enough to attribute usage per-caller at the gateway without
// being reversible or colliding across a realistic number of proxy tokens.
export function reportingUserId(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex").slice(0, 12);
}

// The same 12-hex pseudonymization contract as reportingUserId() above, but
// keyed off a Clerk user id instead of a proxy token — so a beta tester's
// spend history stays attributed to the same stable id across a minted
// token's rotation/reissue (each reissue gets a fresh token, and thus a
// fresh reportingUserId(token), but the same Clerk user always folds to the
// same reportingUserIdForClerk(clerkUserId)). The "clerk:" prefix keeps this
// id space disjoint from reportingUserId()'s token-keyed hashes.
export function reportingUserIdForClerk(clerkUserId) {
  return createHash("sha256")
    .update(`clerk:${String(clerkUserId ?? "")}`, "utf8")
    .digest("hex")
    .slice(0, 12);
}

// "skill:x,action:y" from the x-rolester-* labels, or null when neither is
// present — never emit an empty ai-reporting-tags header.
export function buildReportingTags(inboundHeaders) {
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

export function buildUpstreamHeaders(
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
  // doc in ai-proxy.mjs. Off by default; harmless to other upstreams.
  if (String(env.ROLESTER_UPSTREAM_REPORTING || "").trim() === "1") {
    const providedToken = extractProvidedToken(inboundHeaders);
    if (providedToken) out["ai-reporting-user"] = reportingUserId(providedToken);
    const tags = buildReportingTags(inboundHeaders);
    if (tags) out["ai-reporting-tags"] = tags;
  }

  return out;
}

// Strips connection/encoding-specific response headers before re-serving an
// upstream Headers object over the client connection — shared by both front
// ends' response-header pass-through.
export function buildResponseHeaders(upstreamHeaders) {
  const out = {};
  for (const [key, value] of upstreamHeaders.entries()) {
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spend caps
// ---------------------------------------------------------------------------

// Per-tester spend cap resolution: a global default plus optional per-label
// overrides. 0/absent = no cap (null). Pure — callers own where the cap
// figures came from (env-parsed options for the node server, the same
// options threaded into the Vercel handler).
export function resolveUserCap({ label, globalUserCap, userCaps = {} }) {
  if (label && Object.hasOwn(userCaps, label)) {
    const override = Number(userCaps[label]);
    return Number.isFinite(override) && override > 0 ? override : null;
  }
  return Number.isFinite(globalUserCap) && globalUserCap > 0 ? globalUserCap : null;
}

// The fixed 402 body both front ends send when a tester is at or over their
// cap — never includes the label or token (see the callers' own leakage
// tests).
export function buildCapExceededBody() {
  return {
    type: "error",
    error: {
      type: "cap_exceeded",
      message:
        "This beta account has reached its usage cap. Contact the person who invited you to raise it.",
    },
  };
}

// ---------------------------------------------------------------------------
// Which requests get metered
// ---------------------------------------------------------------------------

export function shouldMeterRequest(path, method) {
  return path === "/v1/messages" && method === "POST";
}

// ---------------------------------------------------------------------------
// Usage extraction — incremental SSE + whole-body JSON
// ---------------------------------------------------------------------------

export function newUsageAccumulator() {
  return {
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelSeen: null,
    sawUsage: false,
  };
}

// Mutates `acc` from one parsed SSE event (message_start carries the initial
// input/cache usage + model id; the final message_delta carries the real
// output_tokens, overwriting message_start's placeholder). Returns `acc` for
// chaining.
export function applySSEUsageEvent(acc, event) {
  if (event?.type === "message_start" && event.message?.usage) {
    acc.usage.input_tokens = event.message.usage.input_tokens || 0;
    acc.usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens || 0;
    acc.usage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens || 0;
    acc.modelSeen = event.message.model || acc.modelSeen;
    acc.sawUsage = true;
  } else if (event?.type === "message_delta" && event.usage?.output_tokens != null) {
    acc.usage.output_tokens = event.usage.output_tokens;
    acc.sawUsage = true;
  }
  return acc;
}

// Mutates `acc` from a fully-parsed non-streaming Messages response body.
export function applyNonStreamUsage(acc, parsedBody) {
  if (parsedBody?.usage) {
    acc.usage.input_tokens = parsedBody.usage.input_tokens || 0;
    acc.usage.output_tokens = parsedBody.usage.output_tokens || 0;
    acc.usage.cache_read_input_tokens = parsedBody.usage.cache_read_input_tokens || 0;
    acc.usage.cache_creation_input_tokens = parsedBody.usage.cache_creation_input_tokens || 0;
    acc.modelSeen = parsedBody.model || acc.modelSeen;
    acc.sawUsage = true;
  }
  return acc;
}

// The canonical pre-canonicalization usage-log row both front ends build
// after a metered call completes — canonicalizeUsageEvent() (usage-log.mjs)
// fills defaults/derives feature/computes cost from this shape.
export function buildUsageRow({
  model,
  feature,
  skill,
  action,
  operation,
  usage,
  user,
  userLabel,
  upstreamHost,
}) {
  return {
    source: "proxy",
    feature: feature || null,
    skill: skill || null,
    action: action || null,
    operation: operation || null,
    model,
    upstream: upstreamHost,
    user: user || null,
    userLabel: userLabel || null,
    tokens_in: usage.input_tokens,
    tokens_out: usage.output_tokens,
    cache_read_tokens: usage.cache_read_input_tokens,
    cache_creation_tokens: usage.cache_creation_input_tokens,
  };
}

// ---------------------------------------------------------------------------
// Upstream forward + host resolution
// ---------------------------------------------------------------------------

export function normalizeUpstreamBase(url) {
  return String(url || "").replace(/\/+$/, "");
}

// Host of the upstream base URL, for the usage log's `upstream` field (cost-
// drift visibility across providers) — never throws on a malformed URL.
export function resolveUpstreamHost(base) {
  try {
    return new URL(base).host || null;
  } catch {
    return null;
  }
}

// Always uses the real global fetch unless a caller explicitly injects one —
// note neither front end's own upstream call passes an override today (only
// meter-db.mjs's DB sink takes an injectable fetchImpl, for tests); kept
// injectable here anyway so a future test can intercept the upstream call
// without touching global state.
export async function forwardToUpstream({
  fetchImpl = fetch,
  base,
  path,
  search = "",
  method,
  headers,
  body,
}) {
  return fetchImpl(`${base}${path}${search}`, {
    method,
    headers,
    body: body?.length ? body : undefined,
  });
}

// ---------------------------------------------------------------------------
// Metering DB write
// ---------------------------------------------------------------------------

// Fires the DB append and never lets it block or fail the caller — resolves
// once the write (or its failure) has been observed, but the caller decides
// whether to await that resolution (see meterDbWrite() below) or let it run
// detached, which is what the long-lived node server does today: "the
// proxied request/response above has already been fully handled by the time
// this settles — never block or fail it on a metering write."
export function fireAndForgetDbWrite({ dbMeter, event, onFailure }) {
  return dbMeter
    .append(event)
    .then((result) => {
      if (!result.ok) onFailure?.(result.error, "failed");
    })
    .catch((err) => {
      onFailure?.(err.message, "threw");
    });
}

// Serverless-aware wrapper: a long-lived node process can fire-and-forget
// (the process stays up to let the write finish); a serverless invocation
// can be frozen or torn down the instant the response is sent, so an
// unawaited write there is not durable. Use `waitUntil` (the platform's own
// keep-alive hook, e.g. Vercel's request-context waitUntil) when available
// so the write survives after the response ships; otherwise await it
// directly before returning, trading a little latency for durability. A
// no-op when there's no DB sink configured.
export async function meterDbWrite({ dbMeter, event, waitUntil, onFailure }) {
  if (!dbMeter) return;
  const task = fireAndForgetDbWrite({ dbMeter, event, onFailure });
  if (waitUntil) waitUntil(task);
  else await task;
}

// ---------------------------------------------------------------------------
// Env parsing — shared by both front ends' config reads (the node server's
// main(), and the Vercel handler's per-invocation env read). Pure; callers
// own how a parse failure gets logged via the optional `onError` callback
// (defaulting to a no-op), since a long-lived process's stderr and a
// serverless invocation's console.error are different surfaces. Never logs
// a raw env var value itself, only ever the fact that one failed to parse.
// ---------------------------------------------------------------------------

function parseJsonObjectEnv(raw, { onError } = {}) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    onError?.();
    return {};
  }
}

// ROLESTER_UPSTREAM_HEADERS — JSON object of extra headers to inject upstream.
export function parseUpstreamHeadersEnv(raw, opts) {
  return parseJsonObjectEnv(raw, opts);
}

// ROLESTER_PROXY_TOKENS — label -> token map for multi-tester auth.
export function parseProxyTokensEnv(raw, opts) {
  const parsed = parseJsonObjectEnv(raw, opts);
  const out = {};
  for (const [label, token] of Object.entries(parsed)) {
    const t = String(token || "").trim();
    if (t) out[label] = t;
  }
  return out;
}

// ROLESTER_PROXY_USER_CAP_USD — a single float, or null (absent/invalid/<=0
// all mean "no cap").
export function parseUserCapUsdEnv(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ROLESTER_PROXY_USER_CAPS — label -> cap USD override map.
export function parseUserCapsEnv(raw, opts) {
  const parsed = parseJsonObjectEnv(raw, opts);
  const out = {};
  for (const [label, cap] of Object.entries(parsed)) {
    const n = Number(cap);
    if (Number.isFinite(n) && n > 0) out[label] = n;
  }
  return out;
}
