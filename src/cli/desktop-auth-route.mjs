// desktop-auth-route.mjs — the system-browser Google OAuth handoff for the
// Electron desktop shell (see apps/desktop/desktop-runtime.mjs's
// DESKTOP_SIGN_IN_PATH carve-out and apps/web/src/auth/DesktopSignInPage.jsx).
// Google rejects OAuth performed inside Electron's embedded Chromium (JS
// engine fingerprinting), so the whole Clerk Google sign-in dance now runs in
// the user's default browser instead: the SPA opens
// /app/desktop-sign-in?nonce=... via shell.openExternal, the system browser
// completes Clerk's Google sign-in there (a fresh browser context, so Clerk
// provisions its own dev-browser client), and the finished dev-instance
// session (Clerk's own __clerk_db_jwt cross-origin dev-browser transport) is
// handed back to the waiting Electron window through this short-lived,
// in-memory nonce ledger.
//
// mountDesktopAuthRoutes({ addRoute, repoRoot, env }) registers:
//
//   POST /api/desktop-auth/start    mint a nonce + signInUrl, state=pending
//   GET  /api/desktop-auth/status   poll ?nonce= -> {status: pending|fulfilled|claimed|failed|expired|unknown}
//   POST /api/desktop-auth/cancel   {nonce} — pending -> failed (user-cancelled)
//   GET  /api/desktop-auth/handoff  Clerk's post-auth redirect target (raw HTML, not JSON)
//   POST /api/desktop-auth/complete {nonce, jwt} — fallback path for when
//                                    __clerk_db_jwt didn't arrive on the
//                                    handoff query string
//   POST /api/desktop-auth/claim    {nonce} — fulfilled -> claimed, returns
//                                    {ok, jwt} EXACTLY ONCE
//
// State machine: pending -> fulfilled -> claimed (terminal); pending ->
// failed (terminal, via cancel); pending/fulfilled -> expired via a lazy TTL
// sweep run on every store access (pending TTL 10min from start; fulfilled
// TTL 2min — a completed sign-in nobody claims self-destructs quickly since
// it's holding a live session JWT). claimed/failed/expired are all terminal
// and never transition further.
//
// The nonce -> record ledger is a plain in-memory Map, scoped to one
// mountDesktopAuthRoutes() call (same lifetime as the createDevServer()
// instance that owns it) — never logged, never written to disk or the
// SQLite db. A dev-server restart drops every in-flight desktop sign-in,
// which is correct: there is nothing durable worth recovering here.

import { randomUUID } from "node:crypto";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 16 * 1024; // small fixed-shape {nonce, jwt?} bodies only
const PENDING_TTL_MS = 10 * 60 * 1000;
const FULFILLED_TTL_MS = 2 * 60 * 1000;

// Every nonce this module ever issues is a randomUUID(). The handoff route
// echoes the nonce back into an inline <script> (fallbackCompleteHtmlPage),
// so it MUST be shape-validated before any HTML is built from it —
// JSON.stringify alone does not escape "<", which would let a crafted
// ?nonce=</script><script>… link run script on the loopback origin.
const NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Pure state machine — exported so a future test suite can drive transitions
// directly without going through HTTP, the same way onboard-route.mjs
// exports its own pure helpers (deepMerge, sanitizeUploadFilename, ...).
// ---------------------------------------------------------------------------

export function createDesktopAuthStore({
  pendingTtlMs = PENDING_TTL_MS,
  fulfilledTtlMs = FULFILLED_TTL_MS,
} = {}) {
  const records = new Map();

  // Lazily transitions a single record to "expired" if its current state's
  // TTL window has lapsed. claimed/failed/expired are already terminal and
  // never re-evaluated here. Returns the (possibly just-expired) record, or
  // null if the nonce was never issued.
  function touch(nonce) {
    const rec = records.get(nonce);
    if (!rec) return null;
    if ((rec.state === "pending" || rec.state === "fulfilled") && rec.expiresAt <= Date.now()) {
      rec.state = "expired";
    }
    return rec;
  }

  function start() {
    const nonce = randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + pendingTtlMs;
    records.set(nonce, { nonce, state: "pending", createdAt, expiresAt });
    return { nonce, expiresAt };
  }

  // Report-only — never exposes the jwt.
  function status(nonce) {
    const rec = touch(nonce);
    return rec ? rec.state : "unknown";
  }

  // pending -> failed only (a user-initiated cancel while waiting).
  function cancel(nonce) {
    const rec = touch(nonce);
    if (!rec) return { ok: false, code: "UNKNOWN" };
    if (rec.state !== "pending") return { ok: false, code: "NOT_PENDING", state: rec.state };
    rec.state = "failed";
    return { ok: true };
  }

  // pending -> fulfilled only. Stores the jwt and resets the record's TTL
  // window to the (shorter) fulfilled TTL.
  function fulfill(nonce, jwt) {
    const rec = touch(nonce);
    if (!rec) return { ok: false, code: "UNKNOWN" };
    if (rec.state !== "pending") return { ok: false, code: "NOT_PENDING", state: rec.state };
    const fulfilledAt = Date.now();
    rec.state = "fulfilled";
    rec.jwt = jwt;
    rec.fulfilledAt = fulfilledAt;
    rec.expiresAt = fulfilledAt + fulfilledTtlMs;
    return { ok: true };
  }

  // fulfilled -> claimed only, exactly once: the jwt is read and deleted
  // from the record in the same call, so a repeat claim can never see it
  // again (the record's state has already moved on to "claimed").
  function claim(nonce) {
    const rec = touch(nonce);
    if (!rec) return { ok: false, code: "UNKNOWN" };
    if (rec.state !== "fulfilled") return { ok: false, code: "NOT_FULFILLED", state: rec.state };
    const jwt = rec.jwt;
    rec.state = "claimed";
    delete rec.jwt;
    return { ok: true, jwt };
  }

  return { start, status, cancel, fulfill, claim };
}

// A record exists but isn't in the state the requested action needs
// (already claimed, failed, or expired) -> 410 Gone. A nonce that was never
// issued at all -> 404. Both are terminal from the caller's point of view —
// there is nothing to retry with the same nonce.
function statusForStoreError(result) {
  return result.code === "UNKNOWN" ? 404 : 410;
}

// ---------------------------------------------------------------------------
// Minimal inline HTML — the browser tab this loads in is never the app shell
// (see this file's header comment), so these are plain static pages, not SPA
// routes. The only request-derived value that ever reaches this markup is the
// nonce, and only after NONCE_RE has pinned it to strict UUID shape.
// ---------------------------------------------------------------------------

const PAGE_STYLE = `
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #fbf7f0; color: #1c1a17; display: grid; place-items: center;
    min-height: 100vh; margin: 0; padding: 24px; text-align: center; }
  .card { max-width: 360px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { margin: 0; color: #56504a; }
`;

function htmlShell(title, bodyHtml) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function signedInPage() {
  return htmlShell(
    "Rolester — Signed in",
    `<div class="card">
  <h1>Signed in</h1>
  <p>You can close this tab and return to Rolester.</p>
</div>`
  );
}

function expiredPage() {
  return htmlShell(
    "Rolester — Sign-in link expired",
    `<div class="card">
  <h1>This sign-in link is no longer valid</h1>
  <p>Return to Rolester and try Continue with Google again.</p>
</div>`
  );
}

// Fallback for the one unverified Clerk behavior: if the post-auth redirect
// didn't carry __clerk_db_jwt on its query string, hand the browser a tiny
// inline-JS page that reads the compatibility cookie itself (same name,
// unsuffixed) and POSTs it to /api/desktop-auth/complete.
function fallbackCompleteHtmlPage(nonce) {
  return htmlShell(
    "Rolester — Signing in…",
    `<div class="card" id="card">
  <h1 id="title">Signing in…</h1>
  <p id="message">Finishing sign-in with Rolester.</p>
</div>
<script>
(function () {
  function readCookie(name) {
    var pattern = new RegExp("(?:^|; )" + name.replace(/[-.$?*|{}()[\\]\\\\/+^]/g, "\\\\$&") + "=([^;]*)");
    var match = document.cookie.match(pattern);
    return match ? decodeURIComponent(match[1]) : null;
  }
  var jwt = readCookie("__clerk_db_jwt");
  var titleEl = document.getElementById("title");
  var messageEl = document.getElementById("message");
  if (!jwt) {
    titleEl.textContent = "Sign-in incomplete";
    messageEl.textContent = "We could not find a signed-in session. Return to Rolester and try again.";
    return;
  }
  fetch("/api/desktop-auth/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: ${JSON.stringify(nonce)}, jwt: jwt }),
  })
    .then(function (res) {
      if (!res.ok) throw new Error("complete failed");
      titleEl.textContent = "Signed in";
      messageEl.textContent = "You can close this tab and return to Rolester.";
    })
    .catch(function () {
      titleEl.textContent = "Sign-in incomplete";
      messageEl.textContent = "Something went wrong finishing sign-in. Return to Rolester and try again.";
    });
})();
</script>`
  );
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

// ---------------------------------------------------------------------------
// mountDesktopAuthRoutes
// ---------------------------------------------------------------------------

// `repoRoot`/`env` are accepted (not just `addRoute`) to match every other
// mount*Routes({ addRoute, repoRoot, env }) factory's call signature in
// tracker-dev.mjs, even though this route never touches the filesystem or
// reads config — see this file's header comment on why (no persistence, no
// desktop-flag gating of its own; that gating lives client-side).
export function mountDesktopAuthRoutes({ addRoute, repoRoot: _repoRoot, env: _env }) {
  const store = createDesktopAuthStore();

  addRoute("POST", "/api/desktop-auth/start", (req, res) => {
    const { nonce, expiresAt } = store.start();
    const host = req.headers.host || "127.0.0.1";
    const signInUrl = `http://${host}/app/desktop-sign-in?nonce=${encodeURIComponent(nonce)}`;
    sendJson(res, 200, { ok: true, nonce, signInUrl, expiresAt });
  });

  addRoute("GET", "/api/desktop-auth/status", (req, res) => {
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    const nonce = (requestUrl.searchParams.get("nonce") || "").trim();
    if (!nonce) {
      sendJson(res, 400, { ok: false, error: "?nonce=<nonce> is required" });
      return;
    }
    sendJson(res, 200, { ok: true, status: store.status(nonce) });
  });

  addRoute("POST", "/api/desktop-auth/cancel", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }
    const nonce = String(body?.nonce || "").trim();
    if (!nonce) {
      sendJson(res, 400, { ok: false, error: "body.nonce is required" });
      return;
    }
    const result = store.cancel(nonce);
    sendJson(res, result.ok ? 200 : statusForStoreError(result), result);
  });

  // Clerk's post-auth redirect target (redirectUrlComplete from
  // DesktopSignInPage.jsx's authenticateWithRedirect call). Parses the RAW
  // query string — a dev instance appends &__clerk_db_jwt=<jwt> to whatever
  // redirectUrlComplete it was given.
  addRoute("GET", "/api/desktop-auth/handoff", (req, res) => {
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    const nonce = (requestUrl.searchParams.get("nonce") || "").trim();
    const jwt = requestUrl.searchParams.get("__clerk_db_jwt");

    if (!NONCE_RE.test(nonce)) {
      sendHtml(res, 410, expiredPage());
      return;
    }

    if (jwt) {
      const result = store.fulfill(nonce, jwt);
      sendHtml(res, result.ok ? 200 : 410, result.ok ? signedInPage() : expiredPage());
      return;
    }

    // Only a nonce this store actually issued (and that is still waiting)
    // earns the cookie-reading fallback page — anything else gets the same
    // terminal answer as an expired link, without its nonce ever being
    // echoed into markup.
    if (store.status(nonce) !== "pending") {
      sendHtml(res, 410, expiredPage());
      return;
    }
    sendHtml(res, 200, fallbackCompleteHtmlPage(nonce));
  });

  // Fallback completion path, used only by fallbackCompleteHtmlPage()'s
  // inline script above when the handoff redirect arrived without
  // __clerk_db_jwt on its query string.
  addRoute("POST", "/api/desktop-auth/complete", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }
    const nonce = String(body?.nonce || "").trim();
    const jwt = String(body?.jwt || "").trim();
    if (!nonce || !jwt) {
      sendJson(res, 400, { ok: false, error: "body.nonce and body.jwt are required" });
      return;
    }
    const result = store.fulfill(nonce, jwt);
    sendJson(res, result.ok ? 200 : statusForStoreError(result), result);
  });

  // The Electron window's poll loop calls this once status() reports
  // "fulfilled". Returns the jwt exactly once — see claim()'s own comment.
  addRoute("POST", "/api/desktop-auth/claim", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }
    const nonce = String(body?.nonce || "").trim();
    if (!nonce) {
      sendJson(res, 400, { ok: false, error: "body.nonce is required" });
      return;
    }
    const result = store.claim(nonce);
    sendJson(res, result.ok ? 200 : statusForStoreError(result), result);
  });
}
