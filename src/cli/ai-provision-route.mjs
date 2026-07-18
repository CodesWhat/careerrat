// ai-provision-route.mjs — the desktop app's automatic managed-AI
// provisioning surface. Phase 2 (this file) of a two-phase design; Phase 1
// (the proxy-side token mint) is apps/proxy-vercel/api/auth/exchange.mjs —
// see that file's own header for the exact request/response contract this
// route calls: POST /auth/exchange, Authorization: Bearer <Clerk session
// JWT>, 200 {ok:true, token:"rlp_…", proxyUrl}, errors 401/413/429+Retry-
// After/503.
//
// After Clerk sign-in, the renderer hands its Clerk session JWT to THIS
// local embedded server (never to the proxy directly — see KeyStep.jsx's
// one-shot auto-provision effect). This route exchanges that JWT
// server-to-server for a minted per-user proxy token, persists it via
// writeManagedProxyEnv (src/core/ai/ai-env.mjs) into .internal/ai.env and
// the live process env, and returns only a success/failure flag — never the
// token itself. GET /api/runtime/config's resolveAIRoute(env) call
// (skill-run-route.mjs) re-derives the AI route fresh on every request, so
// the very next poll after a successful connect reports
// runtimeCapabilities.aiAvailable === true with no server restart needed.
//
//   PRIVACY INVARIANT — same discipline as desktop-auth-route.mjs and
//   exchange.mjs itself: the Clerk JWT and the minted proxy token exist only
//   in-flight (request body in, upstream Authorization header out, response
//   token written straight to .internal/ai.env). Neither is ever logged, and
//   the minted token never appears in this route's own JSON response back
//   to the renderer.
//
// mountAiProvisionRoutes({ addRoute, repoRoot, env, fetchImpl }) registers:
//
//   POST /api/settings/ai-managed/connect   {jwt} -> exchange -> persist ->
//                                           {ok:true, route:"proxy"}

import { writeManagedProxyEnv } from "../core/ai/ai-env.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 16 * 1024; // a Clerk session JWT is a few KB at most
const DEFAULT_EXCHANGE_BASE_URL = "https://rolester-proxy.vercel.app";
const MINTED_TOKEN_RE = /^rlp_[0-9a-f]{64}$/;

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// sendJson (skill-run-route.mjs) doesn't carry extra headers — the one case
// here that needs one (429's Retry-After passthrough) gets this tiny local
// variant instead of a second copy of the whole response-writing logic.
function sendJsonWithRetryAfter(res, status, body, retryAfter) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(retryAfter ? { "Retry-After": retryAfter } : {}),
  });
  res.end(JSON.stringify(body));
}

export function mountAiProvisionRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
}) {
  addRoute("POST", "/api/settings/ai-managed/connect", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }

    const jwt = typeof body?.jwt === "string" ? body.jwt.trim() : "";
    if (!jwt) {
      sendJson(res, 400, { ok: false, error: "body.jwt is required" });
      return;
    }

    const base = String(env.ROLESTER_MANAGED_EXCHANGE_URL || DEFAULT_EXCHANGE_BASE_URL).replace(
      /\/+$/,
      ""
    );

    let upstream;
    try {
      upstream = await fetchImpl(`${base}/auth/exchange`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
    } catch {
      // Network/DNS failure reaching the exchange endpoint — never log the
      // error (see this file's privacy invariant); report the same bounded
      // code any other non-200 upstream response gets.
      sendJson(res, 502, { ok: false, error: "exchange_failed" });
      return;
    }

    if (upstream.status === 401) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (upstream.status === 429) {
      sendJsonWithRetryAfter(
        res,
        429,
        { ok: false, error: "rate_limited" },
        upstream.headers.get("retry-after")
      );
      return;
    }
    if (upstream.status !== 200) {
      sendJson(res, 502, { ok: false, error: "exchange_failed" });
      return;
    }

    let payload;
    try {
      payload = await upstream.json();
    } catch {
      sendJson(res, 502, { ok: false, error: "exchange_invalid" });
      return;
    }

    const token = typeof payload?.token === "string" ? payload.token : "";
    const proxyUrl = typeof payload?.proxyUrl === "string" ? payload.proxyUrl : "";
    if (payload?.ok !== true || !MINTED_TOKEN_RE.test(token) || !isHttpUrl(proxyUrl)) {
      sendJson(res, 502, { ok: false, error: "exchange_invalid" });
      return;
    }

    try {
      writeManagedProxyEnv({ repoRoot, proxyUrl, token, env });
    } catch {
      // writeManagedProxyEnv's own validation (https/loopback proxyUrl,
      // non-empty token) should already be satisfied by the checks above —
      // a throw here means the upstream response was well-shaped but the
      // proxyUrl scheme still didn't pass the stricter local write-time
      // check (e.g. a non-loopback http://). Same bounded code as any other
      // malformed exchange response.
      sendJson(res, 502, { ok: false, error: "exchange_invalid" });
      return;
    }

    sendJson(res, 200, { ok: true, route: "proxy" });
  });
}
