#!/usr/bin/env node
// apps/proxy-vercel/api/v1/[...path].mjs — Vercel serverless front end for
// the Rolester managed-AI proxy. Same per-request pipeline as the long-lived
// node:http server (src/cli/ai-proxy.mjs, `npm run ai-proxy`) — both import
// src/cli/proxy-core.mjs so auth, upstream header injection/stripping, SSE
// usage parsing, and the metering row shape never drift between the two
// front ends. This is a genuine monorepo import, not a copy: deploy this
// project with Vercel's "Include files outside the Root Directory" project
// setting enabled (or deploy from the repo root), or the build won't find
// ../../../../src/cli/proxy-core.mjs — see apps/proxy-vercel/README.md.
//
//   PRIVACY INVARIANT — same one proxy-core.mjs and ai-proxy.mjs hold: this
//   handler never persists or logs a request/response BODY or a raw token.
//   The one place it logs anything beyond a short status string is the DB
//   write failure path below, and that logs the already-canonicalized,
//   metadata-only usage row — the exact same shape that would otherwise
//   have gone to the DB, never message content.
//
// What differs from the node:http server, and why:
//
//   - No in-memory per-user spend accumulator. A serverless invocation may
//     be a fresh process every time (or a warm-reused one with no
//     guaranteed prior state) — the cap check re-derives "how much has this
//     user spent" with a per-request DB sum (meter-db.mjs's userCost())
//     instead of an O(1) accumulator lookup. That makes serverless cap
//     enforcement eventually consistent within a few in-flight requests (a
//     burst of concurrent calls can all read the same pre-burst sum and all
//     pass the check before any of their own spend lands) — an acceptable
//     tradeoff for a beta spend guard, not a hard billing limit.
//   - No JSONL fallback. There's no durable local disk on Vercel's Node.js
//     runtime, so ROLESTER_METER_DB_URL/-KEY are REQUIRED here (they're
//     optional, disk-free-upgrade opt-ins on the node server, which
//     defaults to the local JSONL ledger). On a DB write failure this
//     handler logs one metadata-only console.error line (Vercel captures
//     Runtime Logs) — that line is this deployment's only durability signal
//     for a failed write; there is no ledger to replay it from later.
//   - Handler signature: the Web-standard `export default async function
//     handler(request, context) { ... return new Response(...) }`, not the
//     legacy Node `(req, res)` signature. Two reasons: (1) this module
//     depends on node:crypto's timingSafeEqual for constant-time token
//     compare (via proxy-core.mjs), which isn't available on Vercel's Edge
//     runtime — staying on the fetch-style signature keeps us on the
//     Node.js runtime (the default here; `export const config = { runtime:
//     "nodejs" }` below makes that explicit rather than relying on the
//     default). (2) returning a `Response` whose body is a ReadableStream is
//     Vercel's documented, GA path for streaming a Node.js function's
//     output — SSE passthrough is just handing the upstream's own
//     ReadableStream (teed for metering) to `new Response()`, with none of
//     the manual res.write()/flush bookkeeping the legacy signature would
//     need to get the same byte-for-byte behavior.
//   - `context.waitUntil`, when Vercel provides it, keeps the fire-and-forget
//     DB write alive after the response ships (see proxy-core.mjs's
//     meterDbWrite doc); when it's absent this handler awaits the write
//     directly before returning, trading a little latency for durability
//     instead of risking a silently dropped usage row.
//   - maxDuration is set in ../../vercel.json, the documented mechanism for
//     a non-Next.js ("other framework") Vercel project — not an in-file
//     export (see that file's own comment).
//
// Env — same names as the node server (src/cli/ai-proxy.mjs); see that
// file's header for full docs of each. Differences for this deployment:
//   ROLESTER_METER_DB_URL / ROLESTER_METER_DB_KEY   required here (no JSONL
//                                                    fallback to fall back to).
//   ROLESTER_METER_DB_TABLE                          default "usage_events".
// Everything else (ROLESTER_PROXY_TOKEN(S), ROLESTER_UPSTREAM_KEY/_URL/
// _HEADERS/_REPORTING, ROLESTER_PROXY_USER_CAP_USD/_CAPS) behaves the same.

import { extractSSEEvents } from "../../../../src/core/ai/call-ai.mjs";
import { canonicalizeUsageEvent } from "../../../../src/core/ai/usage-log.mjs";
import { createDbMeter } from "../../../../src/cli/meter-db.mjs";
import {
  applyNonStreamUsage,
  applySSEUsageEvent,
  authenticate,
  buildCapExceededBody,
  buildResponseHeaders,
  buildTokenEntries,
  buildUpstreamHeaders,
  buildUsageRow,
  forwardToUpstream,
  meterDbWrite,
  newUsageAccumulator,
  normalizeHeaders,
  normalizeUpstreamBase,
  parseProxyTokensEnv,
  parseUpstreamHeadersEnv,
  parseUserCapsEnv,
  parseUserCapUsdEnv,
  reportingUserId,
  resolveUpstreamHost,
  resolveUserCap,
  shouldMeterRequest,
} from "../../../../src/cli/proxy-core.mjs";

// supportsResponseStreaming: without it, the legacy (req, res) invocation
// path below buffers the whole response before sending — which would silently
// break SSE passthrough (the entire stream would arrive as one flush).
export const config = { runtime: "nodejs", supportsResponseStreaming: true };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Never interpolate request/response bodies here — see the privacy invariant
// above. Vercel captures stderr/stdout as Runtime Logs, same as the node
// server's log() writes to its own process's stderr.
function warn(msg) {
  console.error(`[proxy-vercel] ${msg}`);
}

// Deployed behavior (observed 2026-07-14, Vercel CLI 55 / @vercel/node): this
// project's functions are invoked with the LEGACY Node (req, res) signature
// even with the fetch-style export — `req.url` arrives as a relative path, so
// `new URL(request.url)` threw before auth ever ran. The default export is now
// a dispatcher: web-signature calls (tests, future runtimes) pass through
// untouched; a Node ServerResponse second arg gets bridged to the web handler.
export default async function handler(requestOrReq, contextOrRes) {
  const isNodeRes =
    typeof contextOrRes?.setHeader === "function" && typeof contextOrRes?.end === "function";
  if (!isNodeRes) return webHandler(requestOrReq, contextOrRes);

  const req = requestOrReq;
  const res = contextOrRes;
  const host = req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "https";

  // Vercel's legacy helpers may have already consumed the body stream into
  // req.body (Buffer, string, or parsed JSON); fall back to reading the
  // stream ourselves when they haven't. content-length is dropped so fetch
  // recomputes it — a re-serialized parsed body can differ byte-for-byte.
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.body !== undefined && req.body !== null) {
      body = Buffer.isBuffer(req.body)
        ? req.body
        : typeof req.body === "string"
          ? Buffer.from(req.body)
          : Buffer.from(JSON.stringify(req.body));
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }
  }

  const headerPairs = [];
  for (const [name, value] of Object.entries(req.headers)) {
    if (name === "content-length") continue;
    if (typeof value === "string") headerPairs.push([name, value]);
  }

  const request = new Request(`${proto}://${host}${req.url}`, {
    method: req.method,
    headers: headerPairs,
    body,
  });

  // No context.waitUntil on this path — webHandler already awaits the meter
  // write before closing the stream when waitUntil is absent.
  const response = await webHandler(request, null);

  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  const { Readable } = await import("node:stream");
  Readable.fromWeb(response.body).pipe(res);
}

async function webHandler(request, context) {
  const env = process.env;
  const method = request.method;
  const url = new URL(request.url);
  // Vercel's file-system routing mounts this function under /api, but the
  // proxy pipeline (metering match, upstream forward) and every client speak
  // the node server's root-relative paths (/v1/messages) — shave the platform
  // prefix off before either sees it. ../../vercel.json rewrites /v1/* to
  // /api/v1/* so callers can use the bare deployment domain as the base URL.
  const path = url.pathname.replace(/^\/api(?=\/|$)/, "");
  const headers = normalizeHeaders(request.headers);

  // Config is read fresh on every invocation rather than module-level-cached
  // — cheap (a handful of env reads + small JSON.parse calls), and it keeps
  // this handler's only persistent state the platform's own env vars, never
  // anything this process accumulates itself.
  const proxyToken = env.ROLESTER_PROXY_TOKEN;
  const proxyTokens = parseProxyTokensEnv(env.ROLESTER_PROXY_TOKENS, {
    onError: () => warn("ROLESTER_PROXY_TOKENS is not valid JSON — ignoring"),
  });
  const tokenEntries = buildTokenEntries(proxyToken, proxyTokens);
  const upstreamKey = env.ROLESTER_UPSTREAM_KEY;
  const upstreamUrl = env.ROLESTER_UPSTREAM_URL || "https://api.anthropic.com";
  const upstreamHeadersExtra = parseUpstreamHeadersEnv(env.ROLESTER_UPSTREAM_HEADERS, {
    onError: () => warn("ROLESTER_UPSTREAM_HEADERS is not valid JSON — ignoring"),
  });
  const globalUserCap = parseUserCapUsdEnv(env.ROLESTER_PROXY_USER_CAP_USD);
  const userCaps = parseUserCapsEnv(env.ROLESTER_PROXY_USER_CAPS, {
    onError: () => warn("ROLESTER_PROXY_USER_CAPS is not valid JSON — ignoring"),
  });
  const meterDbUrl = env.ROLESTER_METER_DB_URL || null;
  const meterDbKey = env.ROLESTER_METER_DB_KEY || null;
  const meterDbTable = env.ROLESTER_METER_DB_TABLE || "usage_events";

  if (tokenEntries.length === 0 || !String(upstreamKey || "").trim()) {
    warn("misconfigured: proxy token(s) and ROLESTER_UPSTREAM_KEY are required");
    return jsonResponse(500, { error: "proxy_misconfigured" });
  }
  if (!meterDbUrl || !meterDbKey) {
    warn(
      "misconfigured: ROLESTER_METER_DB_URL and ROLESTER_METER_DB_KEY are required in serverless mode (no local disk to fall back to)"
    );
    return jsonResponse(500, { error: "proxy_misconfigured" });
  }

  const auth = authenticate(headers, tokenEntries);
  if (!auth) return jsonResponse(401, { error: "unauthorized" });

  const dbMeter = createDbMeter({ url: meterDbUrl, serviceKey: meterDbKey, table: meterDbTable });
  const base = normalizeUpstreamBase(upstreamUrl);
  const upstreamHost = resolveUpstreamHost(base);
  const userId = reportingUserId(auth.token);
  const userLabel = auth.label;
  const shouldMeter = shouldMeterRequest(path, method);
  const waitUntil =
    typeof context?.waitUntil === "function" ? context.waitUntil.bind(context) : null;

  // Per-tester spend cap — see this file's header on why this is a
  // per-request DB sum here instead of the node server's in-memory
  // accumulator. Checked before forwarding, same as the node server.
  if (shouldMeter) {
    const cap = resolveUserCap({ label: userLabel, globalUserCap, userCaps });
    if (cap !== null) {
      const spent = await dbMeter.userCost(userId).catch(() => 0);
      if (spent >= cap) return jsonResponse(402, buildCapExceededBody());
    }
  }

  const bodyBuffer =
    method !== "GET" && method !== "HEAD"
      ? Buffer.from(await request.arrayBuffer())
      : Buffer.alloc(0);

  const outboundHeaders = buildUpstreamHeaders(headers, upstreamKey, upstreamHeadersExtra, {
    env,
  });

  let upstreamRes;
  try {
    upstreamRes = await forwardToUpstream({
      base,
      path,
      search: url.search,
      method,
      headers: outboundHeaders,
      body: bodyBuffer,
    });
  } catch (err) {
    // err.message may echo the target URL but never body content — safe to log.
    warn(`upstream unreachable: ${err.message}`);
    return jsonResponse(502, { error: "upstream_unreachable" });
  }

  const resHeaders = buildResponseHeaders(upstreamRes.headers);

  if (!upstreamRes.body) {
    return new Response(null, { status: upstreamRes.status, headers: resHeaders });
  }

  if (!shouldMeter) {
    // Pure passthrough — hand the upstream body straight through, no tee.
    return new Response(upstreamRes.body, { status: upstreamRes.status, headers: resHeaders });
  }

  const contentType = upstreamRes.headers.get("content-type") || "";
  const isSSE = contentType.includes("text/event-stream");
  const acc = newUsageAccumulator();
  const decoder = isSSE ? new TextDecoder() : null;
  let sseBuffer = "";
  const jsonChunks = isSSE ? null : [];
  const upstreamReader = upstreamRes.body.getReader();

  async function meterAfter() {
    if (!isSSE) {
      try {
        const parsed = JSON.parse(Buffer.concat(jsonChunks).toString("utf8"));
        applyNonStreamUsage(acc, parsed);
      } catch {
        // malformed/non-JSON upstream body — nothing to meter, never logged
      }
    }
    if (!acc.sawUsage) return;

    const row = buildUsageRow({
      model: acc.modelSeen,
      feature: headers["x-rolester-feature"],
      skill: headers["x-rolester-skill"],
      action: headers["x-rolester-action"],
      operation: headers["x-rolester-operation"],
      usage: acc.usage,
      user: userId,
      userLabel,
      upstreamHost,
    });
    const event = canonicalizeUsageEvent(row, { env });

    await meterDbWrite({
      dbMeter,
      event,
      waitUntil,
      onFailure: (error, reason) => {
        // No local disk here — see this file's header. Metadata-only: the
        // canonicalized row is the same shape that would otherwise have
        // gone to the DB (counts, a model id, skill/action labels, the
        // 12-hex user hash) — never a body or a raw token.
        warn(`meter db write ${reason} (${error}) — usage row lost: ${JSON.stringify(event)}`);
      },
    });
  }

  // Pull-based tee: every chunk read from upstream is enqueued to the client
  // stream FIRST (byte-faithful passthrough, exactly what's forwarded is
  // never mutated), then parsed from a copy for metering. On stream end,
  // meterAfter() runs before controller.close() so an unawaited caller (no
  // waitUntil available) still has its DB write attempted before the
  // Response body finishes — see meterDbWrite()'s own await-vs-waitUntil doc.
  const clientStream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await upstreamReader.read();
      if (done) {
        await meterAfter();
        controller.close();
        return;
      }
      controller.enqueue(value);
      if (isSSE) {
        sseBuffer += decoder.decode(value, { stream: true });
        const { events, remainder } = extractSSEEvents(sseBuffer);
        sseBuffer = remainder;
        for (const event of events) applySSEUsageEvent(acc, event);
      } else {
        jsonChunks.push(value);
      }
    },
    cancel(reason) {
      upstreamReader.cancel(reason).catch(() => {});
    },
  });

  return new Response(clientStream, { status: upstreamRes.status, headers: resHeaders });
}
