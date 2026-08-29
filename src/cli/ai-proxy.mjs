#!/usr/bin/env node
// CareerRat managed-AI proxy — the one cloud surface in Shape 2 (see
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
//   The same invariant covers per-tester attribution below: the log and this
//   process's own logging ever hold only the 12-hex reportingUserId hash and
//   the operator-chosen label — never a raw token, in any form, anywhere.
//
// The upstream slot is generic on purpose (a base URL + a headers bag), not
// hardcoded to Anthropic's first-party API, so a later drop-in — e.g. Portkey,
// via CAREERRAT_UPSTREAM_URL + CAREERRAT_UPSTREAM_HEADERS carrying
// x-portkey-config — needs no code change here.
//
// The per-request pipeline (auth, upstream header injection/stripping, SSE
// usage parsing, the metering row shape) lives in src/cli/proxy-core.mjs,
// shared with the Vercel serverless front end at apps/proxy-vercel/. This
// file owns everything specific to being a long-lived node:http process: the
// in-memory per-user spend accumulator (hydrated from the meter at boot so a
// restart doesn't reset caps), the JSONL fallback sink, and main()'s env
// parsing + socket binding.
//
// Usage:
//   CAREERRAT_PROXY_TOKEN=devtoken CAREERRAT_UPSTREAM_KEY=sk-ant-... npm run ai-proxy
//
//   curl -s http://127.0.0.1:7788/v1/messages \
//     -H "authorization: Bearer devtoken" -H "content-type: application/json" \
//     -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
//
//   # multiple beta testers, one process, per-tester spend caps:
//   CAREERRAT_PROXY_TOKENS='{"alice":"tok_alice","bob":"tok_bob"}' \
//   CAREERRAT_PROXY_USER_CAP_USD=10 CAREERRAT_PROXY_USER_CAPS='{"alice":25}' \
//   CAREERRAT_UPSTREAM_KEY=sk-ant-... npm run ai-proxy
//
// Env:
//   CAREERRAT_PROXY_TOKEN     the Bearer/x-api-key token a single tester presents
//                            (dev-stub auth). Optional when CAREERRAT_PROXY_TOKENS is
//                            set — at least one of the two is required. Attributed to
//                            userLabel "default" in the usage log.
//   CAREERRAT_PROXY_TOKENS    optional JSON object of label -> token for multiple beta
//                            testers, e.g. {"alice":"tok_...","bob":"tok_..."}. Both
//                            this and CAREERRAT_PROXY_TOKEN may be set at once — the
//                            valid token set is their union. A token's label is an
//                            operator convenience recorded as userLabel in the usage
//                            log; it is never sent upstream.
//   CAREERRAT_UPSTREAM_KEY    required — the real provider key injected into upstream calls.
//   CAREERRAT_UPSTREAM_URL    default https://api.anthropic.com — the gateway slot.
//   CAREERRAT_UPSTREAM_HEADERS  optional JSON object of extra headers to inject upstream
//                              (e.g. {"x-portkey-config":"..."} when fronting Portkey).
//   CAREERRAT_UPSTREAM_REPORTING  optional "1" to inject Vercel AI Gateway attribution
//                                headers on every outbound request: ai-reporting-user
//                                (a stable pseudonymous id, sha256 of the caller's own
//                                proxy token — never the raw token) and ai-reporting-tags
//                                (skill:.../action:... from x-careerrat-skill/-action when
//                                present). Off by default; harmless to other upstreams.
//   CAREERRAT_PROXY_USER_CAP_USD  optional float — per-tester spend cap in USD, checked
//                                against that tester's own cumulative metered cost_usd
//                                before every /v1/messages call. Absent or 0 = no cap.
//   CAREERRAT_PROXY_USER_CAPS  optional JSON object of label -> cap USD, overriding
//                              CAREERRAT_PROXY_USER_CAP_USD for specific testers, e.g.
//                              {"alice": 25}. A tester at or over their cap gets HTTP 402
//                              {"type":"error","error":{"type":"cap_exceeded",...}}
//                              without the request ever reaching upstream.
//   CAREERRAT_PROXY_PORT      default 7788.
//   CAREERRAT_PROXY_METER_ROOT  default process.cwd() — root the usage log is written under.
//   CAREERRAT_METER_DB_URL    optional Supabase project URL (e.g. https://xyz.supabase.co).
//                             When set together with CAREERRAT_METER_DB_KEY, usage events
//                             are POSTed to that project's PostgREST API instead of the
//                             local JSONL file — see src/cli/meter-db.mjs and
//                             scripts/meter-db-schema.sql — so a proxy deployment needs no
//                             persistent disk. The local JSONL ledger is still used as a
//                             fallback for any individual event the DB write fails for
//                             (never both, and never silently dropped). Metadata-only, same
//                             privacy invariant as above: no request/response body or raw
//                             token ever reaches this column set.
//   CAREERRAT_METER_DB_KEY    the Supabase service-role key for CAREERRAT_METER_DB_URL.
//                             Required alongside it; a service-role key is required (not an
//                             anon key) since the schema has RLS enabled with no policies.
//   CAREERRAT_METER_DB_TABLE  default "usage_events" — the PostgREST table name.
//
// createProxyServer() below is a pure factory — no listen — so tests can construct
// one against an isolated meter root and mock upstream and drive it directly.
// main() is the only caller that reads env, validates it, and binds a socket, and
// only runs when this file is the entry script (see the import.meta.url guard).

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { extractSSEEvents } from "../core/ai/call-ai.mjs";
import {
  appendUsageEvent,
  canonicalizeUsageEvent,
  computeCost,
  readUsageEvents,
} from "../core/ai/usage-log.mjs";
import { createDbMeter } from "./meter-db.mjs";
import {
  applyNonStreamUsage,
  applySSEUsageEvent,
  authenticate,
  buildCapExceededBody,
  buildResponseHeaders,
  buildTokenEntries,
  buildUnpricedModelBody,
  buildUpstreamHeaders,
  buildUsageRow,
  fireAndForgetDbWrite,
  isAllowedProxyRequest,
  newUsageAccumulator,
  normalizeUpstreamBase,
  parseProxyTokensEnv,
  parseUpstreamHeadersEnv,
  parseUserCapsEnv,
  parseUserCapUsdEnv,
  reportingUserId,
  resolveUpstreamHost,
  resolveUserCap,
  shouldMeterRequest,
} from "./proxy-core.mjs";

function log(msg) {
  // Never interpolate request/response bodies here — see the privacy invariant above.
  process.stderr.write(`[ai-proxy] ${msg}\n`);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Checks the presented token against every configured (label, token) pair
// (proxy-core's authenticate()) and writes the 401 response on failure — the
// node:http-specific half of auth.
async function requireAuth(req, res, tokenEntries) {
  const auth = await authenticate(req.headers, tokenEntries);
  if (!auth) {
    sendJson(res, 401, { error: "unauthorized" });
    return null;
  }
  return auth;
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => {
      const error = new Error(`request body exceeds ${maxBytes} byte limit`);
      error.status = 413;
      error.code = "REQUEST_TOO_LARGE";
      return error;
    };
    const declared = Number(req.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.on("error", () => {});
      req.resume();
      reject(tooLarge());
      return;
    }

    const chunks = [];
    let size = 0;
    let overflowed = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflowed = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflowed) reject(tooLarge());
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function requestAbortGuard(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortIfUnfinished = () => {
    if (!res.writableEnded) abort();
  };
  if (req.aborted) abort();
  req.once("aborted", abort);
  res.once("close", abortIfUnfinished);
  return {
    signal: controller.signal,
    cleanup() {
      req.off("aborted", abort);
      res.off("close", abortIfUnfinished);
    },
  };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createProxyServer({
  proxyToken,
  proxyTokens = {},
  upstreamKey,
  upstreamUrl = "https://api.anthropic.com",
  upstreamHeaders = {},
  meterRoot = process.cwd(),
  userCapUsd = null,
  userCaps = {},
  meterDbUrl = null,
  meterDbKey = null,
  meterDbTable = "usage_events",
  maxRequestBytes = 1024 * 1024,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const tokenEntries = buildTokenEntries(proxyToken, proxyTokens);
  if (tokenEntries.length === 0)
    throw new Error("ai-proxy: CAREERRAT_PROXY_TOKEN or CAREERRAT_PROXY_TOKENS is required");
  if (!String(upstreamKey || "").trim())
    throw new Error("ai-proxy: CAREERRAT_UPSTREAM_KEY is required");

  // Per-tester spend cap: a global default (CAREERRAT_PROXY_USER_CAP_USD) plus
  // optional per-label overrides (CAREERRAT_PROXY_USER_CAPS). 0/absent = no cap.
  const globalUserCap = Number.isFinite(userCapUsd) && userCapUsd > 0 ? userCapUsd : null;
  const requestByteLimit =
    Number.isSafeInteger(maxRequestBytes) && maxRequestBytes > 0 ? maxRequestBytes : 1024 * 1024;
  function capForUser(label) {
    return resolveUserCap({ label, globalUserCap, userCaps });
  }

  const base = normalizeUpstreamBase(upstreamUrl);
  // Host of the upstream base URL, for the usage log's `upstream` field (cost-
  // drift visibility across providers) — never throws on a malformed URL.
  const upstreamHost = resolveUpstreamHost(base);

  // Optional DB sink — see the CAREERRAT_METER_DB_* env docs above. Both a URL
  // and a key are required to enable it; either alone falls back to
  // JSONL-only, unchanged from today's behavior.
  const dbMeter =
    String(meterDbUrl || "").trim() && String(meterDbKey || "").trim()
      ? createDbMeter({
          url: meterDbUrl,
          serviceKey: meterDbKey,
          table: meterDbTable,
          fetchImpl,
        })
      : null;

  // Since-boot totals, seeded from any prior proxy-sourced rows in the usage
  // log so a restart doesn't reset /meter to zero (see usage-log.mjs's own
  // append-only ledger — this is just a running fold over it).
  const counters = { requests: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, unpriced_requests: 0 };
  // Per-user cumulative spend (priced cost only — an unpriced request counts
  // 0 toward the cap, never a guess), hydrated once here from the durable
  // usage log so a process restart doesn't reset caps to zero, then kept
  // current in recordUsage() as new proxy events are appended. This is an
  // in-memory fold over the log, not a second source of truth: it exists
  // only so the per-request cap check is O(1) instead of re-reading the
  // whole file on every call.
  const userCostByUserId = new Map();
  const userAdmissionTails = new Map();

  async function withUserAdmission(userId, operation) {
    const prior = userAdmissionTails.get(userId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => {}).then(() => gate);
    userAdmissionTails.set(userId, tail);
    await prior.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (userAdmissionTails.get(userId) === tail) userAdmissionTails.delete(userId);
    }
  }
  for (const event of readUsageEvents({ root: meterRoot })) {
    if (event.source !== "proxy") continue;
    counters.requests += 1;
    counters.tokens_in += event.tokens_in || 0;
    counters.tokens_out += event.tokens_out || 0;
    if (event.priced) counters.cost_usd += event.cost_usd || 0;
    else counters.unpriced_requests += 1;
    if (event.user) {
      const prior = userCostByUserId.get(event.user) || 0;
      const add =
        event.priced && Number.isFinite(Number(event.cost_usd)) ? Number(event.cost_usd) : 0;
      userCostByUserId.set(event.user, prior + add);
    }
  }

  // DB-sourced cap hydration. The local JSONL fold above already covers two
  // cases: the JSONL-only deployment (dbMeter is null) and, when dbMeter is
  // set, any events that FAILED to reach the DB and fell back to JSONL (see
  // recordUsage below). Those are disjoint from what's durably in the DB, so
  // summing DB sums + local-JSONL sums here double-counts nothing — as long
  // as a fallback-written JSONL row is never later re-sent to the DB, which
  // this codebase never does. Kept deliberately simple on that assumption
  // rather than deduping by event id across the two stores.
  //
  // This hydration is async (a network call) while createProxyServer() itself
  // stays synchronous, matching the existing factory contract tests rely on
  // (`const { server } = createProxyServer(...)` then `server.listen(...)`).
  // That leaves a brief window right after boot where DB-sourced spend from
  // before this process started isn't yet reflected in the cap check — an
  // acceptable tradeoff for a soft spend cap. main() below awaits
  // `dbHydration` before opening the socket to close that window for the
  // real CLI entry point; callers that don't care can ignore the field.
  let dbHydration = Promise.resolve();
  if (dbMeter) {
    dbHydration = dbMeter
      .hydrateUserCosts()
      .then((dbCosts) => {
        for (const [user, cost] of dbCosts) {
          if (!user || !Number.isFinite(Number(cost))) continue;
          const prior = userCostByUserId.get(user) || 0;
          userCostByUserId.set(user, prior + Number(cost));
        }
      })
      .catch((err) => {
        log(`meter db hydration failed (${err.message}); caps start from local history only`);
      });
  }

  function recordUsage({ model, feature, skill, action, operation, usage, user, userLabel }) {
    const row = buildUsageRow({
      model,
      feature,
      skill,
      action,
      operation,
      usage,
      user,
      userLabel,
      upstreamHost,
    });

    // Canonicalize once regardless of sink — counters/cap accounting update
    // synchronously either way, before we know whether a DB write (async)
    // will even succeed. When there's no DB sink this is exactly today's
    // behavior: appendUsageEvent() both writes the JSONL row and returns the
    // same canonical shape.
    const event = dbMeter
      ? canonicalizeUsageEvent(row, { env })
      : appendUsageEvent(row, { root: meterRoot }).event;

    counters.requests += 1;
    counters.tokens_in += event.tokens_in;
    counters.tokens_out += event.tokens_out;
    if (event.priced) counters.cost_usd += event.cost_usd;
    else counters.unpriced_requests += 1;
    if (event.user) {
      const prior = userCostByUserId.get(event.user) || 0;
      const add =
        event.priced && Number.isFinite(Number(event.cost_usd)) ? Number(event.cost_usd) : 0;
      userCostByUserId.set(event.user, prior + add);
    }

    if (dbMeter) {
      // Fire-and-forget: the proxied request/response above has already been
      // fully handled by the time this settles — never block or fail it on a
      // metering write. On failure, fall back to the local JSONL ledger so
      // the event is never silently lost; only a metadata-only status string
      // is ever logged (see meter-db.mjs's `error` contract).
      fireAndForgetDbWrite({
        dbMeter,
        event,
        onFailure: (error, reason) => {
          log(`meter db write ${reason} (${error}), falling back to local usage log`);
          appendUsageEvent(event, { root: meterRoot });
        },
      });
    }
  }

  async function proxyPass(req, res, auth) {
    const url = new URL(req.url, "http://internal");
    const path = url.pathname;
    const featureLabel = req.headers["x-careerrat-feature"];
    const skillLabel = req.headers["x-careerrat-skill"];
    const actionLabel = req.headers["x-careerrat-action"];
    const operationLabel = req.headers["x-careerrat-operation"];

    const userId = reportingUserId(auth.token);
    const userLabel = auth.label;
    const shouldMeter = shouldMeterRequest(path, req.method);
    const cap = shouldMeter ? capForUser(userLabel) : null;
    const requestAbort = requestAbortGuard(req, res);

    const forward = async () => {
      if (requestAbort.signal.aborted) return;

      // Capped requests for one user enter this section one at a time. The
      // prior request records its completed spend before releasing the next,
      // so concurrent calls cannot all pass against the same old balance.
      if (cap !== null && (userCostByUserId.get(userId) || 0) >= cap) {
        req.resume();
        sendJson(res, 402, buildCapExceededBody());
        return;
      }

      let bodyBuffer = Buffer.alloc(0);
      if (req.method !== "GET" && req.method !== "HEAD") {
        try {
          bodyBuffer = await readRequestBody(req, requestByteLimit);
        } catch (error) {
          if (error?.status === 413 && !requestAbort.signal.aborted) {
            sendJson(res, 413, {
              type: "error",
              error: {
                type: "request_too_large",
                message: `Request body exceeds the ${requestByteLimit} byte limit.`,
              },
            });
            return;
          }
          throw error;
        }
      }
      if (requestAbort.signal.aborted) return;

      if (cap !== null) {
        let requestModel = null;
        try {
          requestModel = JSON.parse(bodyBuffer.toString("utf8"))?.model || null;
        } catch {
          // Invalid JSON is still unpriceable and therefore cannot use a capped credential.
        }
        if (!computeCost(requestModel, {}, { env }).priced) {
          sendJson(res, 402, buildUnpricedModelBody());
          return;
        }
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
          signal: requestAbort.signal,
        });
      } catch (err) {
        if (requestAbort.signal.aborted) return;
        // err.message may echo the target URL but never body content — safe to log.
        log(`upstream unreachable: ${err.message}`);
        sendJson(res, 502, { error: "upstream_unreachable" });
        return;
      }

      const resHeaders = buildResponseHeaders(upstreamRes.headers);
      res.writeHead(upstreamRes.status, resHeaders);

      if (!upstreamRes.body) {
        res.end();
        return;
      }

      const contentType = upstreamRes.headers.get("content-type") || "";
      const isSSE = contentType.includes("text/event-stream");

      const decoder = shouldMeter && isSSE ? new TextDecoder() : null;
      let sseBuffer = "";
      const jsonChunks = shouldMeter && !isSSE ? [] : null;

      const acc = newUsageAccumulator();

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
            for (const event of events) applySSEUsageEvent(acc, event);
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
          applyNonStreamUsage(acc, parsed);
        } catch {
          // malformed/non-JSON upstream body — nothing to meter, never logged
        }
      }

      if (acc.sawUsage) {
        recordUsage({
          model: acc.modelSeen,
          feature: featureLabel,
          skill: skillLabel,
          action: actionLabel,
          operation: operationLabel,
          usage: acc.usage,
          user: userId,
          userLabel,
        });
      }
    };

    try {
      if (cap === null) await forward();
      else await withUserAdmission(userId, forward);
    } catch (error) {
      if (!requestAbort.signal.aborted) throw error;
    } finally {
      requestAbort.cleanup();
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

  async function handleRequest(req, res) {
    const auth = await requireAuth(req, res, tokenEntries);
    if (!auth) return;

    const path = (req.url || "/").split("?")[0];

    if (req.method === "GET" && path === "/meter") {
      handleMeter(req, res);
      return;
    }

    if (isAllowedProxyRequest(path, req.method)) {
      await proxyPass(req, res, auth);
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log(`request handling failed: ${err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "proxy_error" });
      else res.end();
    });
  });

  return { server, counters, meterRoot, dbHydration };
}

// Exported for tests that want to check cost math against the same table the
// proxy uses without re-deriving it.
export { computeCost };

// ---------------------------------------------------------------------------
// Boot (CLI entry point only — see the import.meta.url guard at the bottom)
// ---------------------------------------------------------------------------

// The four env-parsing bodies below live in proxy-core.mjs (shared with the
// Vercel handler); these are thin wrappers that supply this process's own
// log() for the parse-failure message, preserving the exact wording main()
// has always logged.
function parseUpstreamHeaders(raw) {
  return parseUpstreamHeadersEnv(raw, {
    onError: () => log("CAREERRAT_UPSTREAM_HEADERS is not valid JSON, ignoring"),
  });
}

function parseProxyTokens(raw) {
  return parseProxyTokensEnv(raw, {
    onError: () => log("CAREERRAT_PROXY_TOKENS is not valid JSON, ignoring"),
  });
}

function parseUserCapUsd(raw) {
  return parseUserCapUsdEnv(raw);
}

function parseUserCaps(raw) {
  return parseUserCapsEnv(raw, {
    onError: () => log("CAREERRAT_PROXY_USER_CAPS is not valid JSON, ignoring"),
  });
}

async function main() {
  const proxyToken = process.env.CAREERRAT_PROXY_TOKEN;
  const proxyTokens = parseProxyTokens(process.env.CAREERRAT_PROXY_TOKENS);
  const upstreamKey = process.env.CAREERRAT_UPSTREAM_KEY;

  const hasAnyProxyToken = String(proxyToken || "").trim() || Object.keys(proxyTokens).length > 0;
  if (!hasAnyProxyToken || !String(upstreamKey || "").trim()) {
    log(
      "refusing to start: CAREERRAT_PROXY_TOKEN or CAREERRAT_PROXY_TOKENS, and CAREERRAT_UPSTREAM_KEY, are required"
    );
    process.exit(1);
  }

  const port = Number(process.env.CAREERRAT_PROXY_PORT) || 7788;
  const upstreamUrl = process.env.CAREERRAT_UPSTREAM_URL || "https://api.anthropic.com";
  const upstreamHeaders = parseUpstreamHeaders(process.env.CAREERRAT_UPSTREAM_HEADERS);
  const meterRoot = process.env.CAREERRAT_PROXY_METER_ROOT || process.cwd();
  const userCapUsd = parseUserCapUsd(process.env.CAREERRAT_PROXY_USER_CAP_USD);
  const userCaps = parseUserCaps(process.env.CAREERRAT_PROXY_USER_CAPS);
  const meterDbUrl = process.env.CAREERRAT_METER_DB_URL || null;
  const meterDbKey = process.env.CAREERRAT_METER_DB_KEY || null;
  const meterDbTable = process.env.CAREERRAT_METER_DB_TABLE || "usage_events";

  const { server, dbHydration } = createProxyServer({
    proxyToken,
    proxyTokens,
    upstreamKey,
    upstreamUrl,
    upstreamHeaders,
    meterRoot,
    userCapUsd,
    userCaps,
    meterDbUrl,
    meterDbKey,
    meterDbTable,
  });

  // Let DB-sourced cap hydration finish before we start accepting requests —
  // see the long comment on `dbHydration` in createProxyServer(). A no-op
  // when CAREERRAT_METER_DB_URL/-KEY aren't set.
  await dbHydration;

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
  main().catch((err) => {
    log(`fatal: ${err.message}`);
    process.exit(1);
  });
}
