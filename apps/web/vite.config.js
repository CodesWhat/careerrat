import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { readEnv } from "../../src/core/env-compat.mjs";

// apps/web — source for the M7 SPA shell. Built output (dist/) is served in
// production by src/cli/tracker-dev.mjs at /app/* (see that file's
// serveApp()); base:"/app/" makes every built asset URL resolve correctly
// under that mount prefix regardless of what serves it.
//
// In dev, `vite` runs its own HMR server on its own port and proxies API,
// asset, and font traffic to a SEPARATELY-running `tracker-dev` instance rather than
// re-implementing any of that server's behavior — see apps/web/README.md for
// the two-process loop. This covers both SSE shapes already in this codebase
// (GET EventSource streams and hand-parsed POST streams): Vite's dev proxy
// streams/pipes rather than buffering, so both pass through untouched.
const TRACKER_DEV_TARGET = `http://127.0.0.1:${readEnv("CAREERRAT_DEV_PORT") || 7777}`;
const BASE_PATH = process.env.VITE_BASE_PATH || "/app/";

// tracker-dev's request-security gate derives its expected origin from the
// request Host header and rejects any browser Origin/Referer that doesn't
// match it exactly. changeOrigin rewrites Host to the target, so the browser's
// vite-origin headers must be rewritten to the target origin too or every
// proxied /api call 403s as "cross-origin".
const PROXY = {
  target: TRACKER_DEV_TARGET,
  changeOrigin: true,
  headers: { origin: TRACKER_DEV_TARGET, referer: `${TRACKER_DEV_TARGET}/app/` },
};

// The same gate also demands the HttpOnly capability cookie tracker-dev issues
// on its HTML bootstrap routes. Vite serves the dev HTML itself, so the
// browser never hits a bootstrap route and never receives the cookie — relay
// it here on every HTML navigation. Cookies are host-scoped (ports ignored),
// so a cookie set via the 5173 response is sent back on proxied /api calls
// and validates against the same tracker-dev instance. Re-set on every
// navigation so a tracker-dev restart (fresh random capability) heals on
// reload instead of wedging the app in 401s.
function capabilityCookieRelay() {
  return {
    name: "careerrat-capability-cookie-relay",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const isHtmlNav =
          req.method === "GET" && String(req.headers.accept || "").includes("text/html");
        if (isHtmlNav) {
          try {
            const upstream = await fetch(`${TRACKER_DEV_TARGET}/app`, { redirect: "manual" });
            const setCookie = upstream.headers.get("set-cookie");
            if (setCookie) res.setHeader("set-cookie", setCookie);
          } catch {
            // tracker-dev not up yet — the app will surface its own API errors.
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  base: BASE_PATH,
  plugins: [react(), capabilityCookieRelay()],
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      "/api": PROXY,
      "/assets": PROXY,
      "/fonts": PROXY,
    },
  },
});
