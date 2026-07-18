#!/usr/bin/env node
// apps/proxy-vercel/api/auth/exchange.mjs — Clerk session JWT -> minted
// proxy token exchange. A signed-in beta tester's Rolester desktop app
// (Phase 2, not this file) POSTs its Clerk session JWT here; on success it
// gets back a per-user, revocable proxy token it can hand to
// ROLESTER_AI_PROXY_URL's normal /v1/* routes exactly like a static
// ROLESTER_PROXY_TOKEN — see proxy-core.mjs's authenticate() minted-token
// branch and ../v1/[...path].mjs, which wires a token store the same way
// this file does.
//
//   PRIVACY INVARIANT — same one ../v1/[...path].mjs and proxy-core.mjs
//   hold: this handler never logs or persists the Clerk JWT, and never logs
//   the raw minted proxy token it hands back. warn() lines below are short
//   status strings only.
//
// Deployed behavior note (see ../v1/[...path].mjs's own header for the full
// story): this project's functions are invoked with the legacy Node
// (req, res) signature even with a fetch-style export, so the default
// export here is the same dispatcher — a web-signature call (tests, future
// runtimes) passes straight through; a Node ServerResponse second arg gets
// bridged to the web handler.
//
// Env:
//   CLERK_JWT_KEY                      required — Clerk's PEM public key
//                                       (Clerk dashboard -> API keys ->
//                                       Advanced -> JWT public key), used for
//                                       networkless verification via
//                                       @clerk/backend's verifyToken(). No
//                                       network call, no Clerk secret key.
//   ROLESTER_METER_DB_URL / _KEY       required — the same Supabase project
//                                       the proxy's usage ledger uses; the
//                                       minted token's hash is stored in
//                                       that project's proxy_tokens table
//                                       (scripts/meter-db-schema.sql).
//   ROLESTER_EXCHANGE_ALLOWED_ORIGINS  optional JSON array of extra allowed
//                                       `azp` (authorized party) origins,
//                                       beyond the built-in loopback
//                                       allowance (any http(s)://127.0.0.1
//                                       or http(s)://localhost, any port) —
//                                       e.g. a packaged desktop build that
//                                       ships a custom scheme/host.
//   ROLESTER_PUBLIC_PROXY_URL          default "https://rolester-proxy.vercel.app"
//                                       — the base URL handed back to the
//                                       client alongside the minted token.

import { verifyToken } from "@clerk/backend";
import { createTokenStore } from "../../../../src/cli/meter-db.mjs";
import { hashProxyToken, mintProxyToken } from "../../../../src/cli/proxy-core.mjs";

export const config = { runtime: "nodejs" };

const BODY_CAP_BYTES = 16 * 1024;
const COOLDOWN_MS = 30_000;
const LOOPBACK_AZP_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders },
  });
}

// Never interpolate the JWT, the minted token, or a verification error's own
// message here — see the privacy invariant above.
function warn(msg) {
  console.error(`[proxy-vercel:auth] ${msg}`);
}

function parseAllowedOrigins(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.map((v) => String(v || "").trim()).filter(Boolean) : [];
  } catch {
    warn("ROLESTER_EXCHANGE_ALLOWED_ORIGINS is not valid JSON — ignoring");
    return [];
  }
}

// Same legacy-vs-web dispatcher as ../v1/[...path].mjs — see that file's
// header for why (observed Vercel invocation behavior for this project).
export default async function handler(requestOrReq, contextOrRes) {
  const isNodeRes =
    typeof contextOrRes?.setHeader === "function" && typeof contextOrRes?.end === "function";
  if (!isNodeRes) return webHandler(requestOrReq, contextOrRes);

  const req = requestOrReq;
  const res = contextOrRes;
  const host = req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "https";

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

  const response = await webHandler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  const { Readable } = await import("node:stream");
  Readable.fromWeb(response.body).pipe(res);
}

// Drains the request body up to BODY_CAP_BYTES without ever reading it for
// content — the exchange ignores whatever's sent, this is purely an abuse
// guard. Returns true when the body was within cap (or absent), false when
// it exceeded it.
async function drainWithinCap(request) {
  if (!request.body) return true;
  const reader = request.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return true;
    total += value.length;
    if (total > BODY_CAP_BYTES) {
      await reader.cancel().catch(() => {});
      return false;
    }
  }
}

async function webHandler(request, context) {
  if (request.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  const env = process.env;
  const clerkJwtKey = env.CLERK_JWT_KEY;
  const meterDbUrl = env.ROLESTER_METER_DB_URL || null;
  const meterDbKey = env.ROLESTER_METER_DB_KEY || null;

  if (!clerkJwtKey || !meterDbUrl || !meterDbKey) {
    warn("misconfigured: CLERK_JWT_KEY and ROLESTER_METER_DB_URL/_KEY are required");
    return jsonResponse(503, { error: "proxy_misconfigured" });
  }

  if (!(await drainWithinCap(request))) return jsonResponse(413, { error: "payload_too_large" });

  const authHeader = String(request.headers.get("authorization") || "");
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const jwt = match ? match[1] : "";
  if (!jwt) return jsonResponse(401, { error: "unauthorized" });

  let claims;
  try {
    claims = await (context?.verifyToken || verifyToken)(jwt, { jwtKey: clerkJwtKey });
  } catch {
    // Never log the JWT or the verification failure's own message (it may
    // echo the token) — a bad/expired/forged session is just a 401.
    return jsonResponse(401, { error: "unauthorized" });
  }

  const sub = String(claims?.sub || "").trim();
  if (!sub) return jsonResponse(401, { error: "unauthorized" });

  const azp = claims?.azp ? String(claims.azp) : null;
  if (azp && !LOOPBACK_AZP_RE.test(azp)) {
    const allowedOrigins = parseAllowedOrigins(env.ROLESTER_EXCHANGE_ALLOWED_ORIGINS);
    if (!allowedOrigins.includes(azp)) return jsonResponse(401, { error: "unauthorized" });
  }

  const tokenStore = createTokenStore({ url: meterDbUrl, serviceKey: meterDbKey });

  const issueState = await tokenStore.getIssueState(sub);
  if (issueState?.lastIssuedAt) {
    const elapsedMs = Date.now() - new Date(issueState.lastIssuedAt).getTime();
    if (Number.isFinite(elapsedMs) && elapsedMs < COOLDOWN_MS) {
      const retryAfterSec = Math.max(1, Math.ceil((COOLDOWN_MS - elapsedMs) / 1000));
      return jsonResponse(429, { error: "rate_limited" }, { "retry-after": String(retryAfterSec) });
    }
  }

  const token = mintProxyToken();
  const result = await tokenStore.upsertForUser({
    clerkUserId: sub,
    tokenHash: hashProxyToken(token),
    label: "beta",
  });
  if (!result.ok) {
    warn(`token store upsert failed (${result.error})`);
    return jsonResponse(503, { error: "proxy_misconfigured" });
  }

  return jsonResponse(200, {
    ok: true,
    token,
    proxyUrl: env.ROLESTER_PUBLIC_PROXY_URL || "https://rolester-proxy.vercel.app",
  });
}
