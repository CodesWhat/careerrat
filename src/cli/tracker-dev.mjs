#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
// Rolester tracker dev server — promoted (Productization Phase 0, P0-2) from a
// live-reloading dashboard preview into the embedded app server: /app is the
// product shell, while generated dashboard/tracker feeds remain debug/export
// compatibility utilities.
//
// Usage:
//   rolester tracker-dev                 Serve http://localhost:7777 with live reload
//   rolester tracker-dev --port 8080  Pick a port (or ROLESTER_DEV_PORT=8080)
//   rolester tracker-dev --open       Best-effort open the page in your browser
//   rolester tracker-dev --help
//
// (`npm run serve` is an alias for the same entry point — the process is being
// promoted to the app server; `tracker:dev` stays for the dashboard-preview name.)
//
// Zero runtime deps: node:http + node:fs.watch + Server-Sent Events. Watches
//   - workspace/tracker.json        (edit the data → page refreshes + tracker-update SSE)
//   - workspace/activity.jsonl      (edit the feed → activity-update SSE)
//   - src/core/tracker/*            (edit the dashboard code → page refreshes)
// and on a tracker.json/activity.jsonl change re-renders via the canonical
// `tracker.mjs` CLI in a child process (so the preview can never drift from
// `rolester tracker`, and every render picks up fresh modules), then pushes a
// reload to the open page.
//
// The pure, risk-bearing helpers (asset traversal guard, MIME, snippet
// injection, port parsing) live in src/core/tracker/dev-server.mjs and are
// unit-tested there. This file is the I/O glue (http, watch, child render).
//
// createDevServer() below is a pure factory — no listen, no initial render, no
// fs.watch — so tests (and the embedded-runtime work in P0-4, which mounts new
// routes via the returned `addRoute`) can construct one against an isolated
// repoRoot and drive it directly. main() is the only caller that also renders,
// watches, and listens, and only runs when this file is the entry script.
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLocalAiEnv } from "../core/ai/ai-env.mjs";
import { ANSWER_PAGE_HTML } from "../core/ai/answer-page.mjs";
import { createChatRuntime } from "../core/ai/chat-runtime.mjs";
import { EVALUATE_PAGE_HTML } from "../core/ai/evaluate-page.mjs";
import { runSkillStream as defaultRunSkillStream } from "../core/ai/skill-runtime.mjs";
import { reconcileOrphanedLaneCIntakeItems } from "../core/db/verbs.mjs";
import { CHAT_PAGE_HTML } from "../core/onboarding/chat-page.mjs";
import { ONBOARD_PAGE_HTML } from "../core/onboarding/onboard-page.mjs";
import { PACKET_PAGE_HTML } from "../core/onboarding/packet-page.mjs";
import { SEARCH_PAGE_HTML } from "../core/onboarding/search-page.mjs";
import { displayPath, resolveUserPaths, userPath } from "../core/paths/workspace.mjs";
import { defaultAdapter } from "../core/storage/storage-adapter.mjs";
import {
  injectLiveReload,
  LIVERELOAD_SNIPPET,
  mimeFor,
  resolvePort,
  safeAssetPath,
} from "../core/tracker/dev-server.mjs";
import { mountAssistRoutes } from "./assist-route.mjs";
import { mountBoardsRoutes } from "./boards-route.mjs";
import { mountChatRoute } from "./chat-route.mjs";
import { mountDashboardRoutes } from "./dashboard-route.mjs";
import { mountDataRoutes } from "./data-route.mjs";
import { mountDiscoveryRoutes } from "./discovery-route.mjs";
import { mountIntakeRoutes } from "./intake-route.mjs";
import { mountLogoRoutes } from "./logo-route.mjs";
import { mountOnboardRoutes } from "./onboard-route.mjs";
import { mountPacketRoutes } from "./packet-route.mjs";
import { mountSearchRoutes } from "./search-route.mjs";
import { mountSkillRunRoute } from "./skill-run-route.mjs";

const DEFAULT_ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));

// The running package's own version is a property of the CODE, not of whichever
// workspace/data root a given createDevServer() instance points at — read it
// once from the install location, not per-instance.
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(DEFAULT_ROOT, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
})();

export const DEBUG_EXPORT_ROUTES = Object.freeze([
  { path: "/", kind: "legacy-dashboard-html", label: "legacy generated dashboard HTML" },
  { path: "/index.html", kind: "legacy-dashboard-html", label: "legacy generated dashboard HTML" },
  { path: "/tracker", kind: "legacy-dashboard-html", label: "legacy generated dashboard HTML" },
  {
    path: "/tracker.html",
    kind: "legacy-dashboard-html",
    label: "legacy generated dashboard HTML",
  },
  {
    path: "/dashboard-data.js",
    kind: "generated-dashboard-module",
    label: "dashboard data export",
  },
  {
    path: "/workspace/dashboard-data.js",
    kind: "generated-dashboard-module",
    label: "dashboard data export",
  },
  { path: "/workspace/tracker.json", kind: "raw-tracker-export", label: "raw tracker export" },
  { path: "/workspace/activity.jsonl", kind: "raw-activity-export", label: "raw activity export" },
  { path: "/workspace/modes.json", kind: "workspace-json-export", label: "modes export" },
  { path: "/workspace/settings.json", kind: "workspace-json-export", label: "settings export" },
  { path: "/workspace/library.json", kind: "workspace-json-export", label: "library export" },
  { path: "/api/tracker", kind: "storage-adapter-tracker", label: "raw tracker adapter feed" },
  { path: "/api/activity", kind: "storage-adapter-activity", label: "raw activity adapter feed" },
]);

const DEBUG_EXPORT_ROUTE_BY_PATH = new Map(DEBUG_EXPORT_ROUTES.map((route) => [route.path, route]));

export function isDebugExportRoute(url) {
  return DEBUG_EXPORT_ROUTE_BY_PATH.has(url);
}

function getDebugExportRoute(url) {
  return DEBUG_EXPORT_ROUTE_BY_PATH.get(url) || null;
}

// A monotonic-ish stamp for SSE payloads without Date.now() determinism worries.
let tick = 0;
function stamp() {
  return `${++tick}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function log(msg) {
  process.stdout.write(`[tracker:dev] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Server creation

export function createDevServer({
  repoRoot = DEFAULT_ROOT,
  env = process.env,
  runSkillStream = defaultRunSkillStream,
  // M2 — the conversational chat runtime (see src/core/ai/chat-runtime.mjs).
  // Dependency-injected the same way `runSkillStream` is above, so tests can
  // hand in a runtime built against a fake `loadSdk` without touching the
  // real @anthropic-ai/claude-agent-sdk devDependency. Defaulting its
  // construction here (rather than requiring every caller to build one)
  // keeps `createDevServer({ repoRoot })` alone still fully functional, same
  // as before M2.
  chatRuntime = createChatRuntime({ repoRoot, env }),
} = {}) {
  // Boot-load any stored BYOK key from .internal/ai.env (see ai-env.mjs)
  // before any route captures `env` — a key saved by the onboarding wizard's
  // AI-key step (POST /api/settings/ai-key) then survives a server restart
  // without the user re-sourcing it into their shell. env always wins over
  // the stored file (see loadLocalAiEnv's own doc comment).
  loadLocalAiEnv({ repoRoot, env });

  const pathCtx = { repoRoot };
  const userPaths = resolveUserPaths(pathCtx);
  const TRACKER_CLI = join(repoRoot, "src/cli/tracker.mjs");
  const TRACKER_JSON = userPath(pathCtx, "workspace/tracker.json");
  const OUT_HTML = userPath(pathCtx, "workspace/tracker.html");
  const OUT_DATA = userPath(pathCtx, "workspace/dashboard-data.js");
  const OUT_MODES = userPath(pathCtx, "workspace/modes.json");
  const OUT_SETTINGS = userPath(pathCtx, "workspace/settings.json");
  const OUT_LIBRARY = userPath(pathCtx, "workspace/library.json");
  const ACTIVITY_JSONL = userPath(pathCtx, "workspace/activity.jsonl");
  const WORKSPACE_DIR = userPaths.workspaceDir;
  const CANDIDATE_DIR = userPaths.candidateDir;
  const TRACKER_SRC_DIR = join(repoRoot, "src/core/tracker");
  const ASSETS_DIR = join(repoRoot, "assets");
  const FONTS_DIR = join(repoRoot, "fonts");
  // M7 — the Vite + React app shell's built output (see apps/web/). Gitignored,
  // built via `npm run app:build` (or the root `prepack` script before
  // npm pack/publish), shipped via package.json#files["apps/web/dist"].
  const APP_DIST_DIR = join(repoRoot, "apps/web/dist");
  const APP_INDEX_HTML = join(APP_DIST_DIR, "index.html");
  const adapter = defaultAdapter(repoRoot);

  // SSE clients subscribed to reload/tracker-update/activity-update events.
  const clients = new Set();
  const watchers = [];

  // -------------------------------------------------------------------------
  // Render: shell out to the canonical CLI so the dev preview is byte-identical
  // to `rolester tracker` and always loads fresh modules.

  let rendering = false;
  let renderQueued = false;

  function renderOnce() {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [TRACKER_CLI], {
        cwd: repoRoot,
        // No-op under plain node (there's no such env var to worry about).
        // Under an Electron host (see apps/desktop/main.mjs), process.execPath
        // IS the Electron binary — this makes THIS ONE child run as headless
        // node instead of booting a second GUI instance. Scoped to this one
        // spawn's env, not the host process's own env: Chromium's own helper
        // processes (GPU/network/renderer) inherit the host's env too, and
        // booting THEM as node instead of Chromium helpers breaks rendering
        // (see the trap-1 comment in apps/desktop/main.mjs for the incident).
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => resolve({ ok: false, error: err.message }));
      child.on("close", (code) =>
        resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `exit ${code}` })
      );
    });
  }

  // Re-render, coalescing overlapping requests: if a change lands mid-render we
  // run exactly one more pass afterward rather than piling up child processes.
  async function rerenderAndReload(reason) {
    if (rendering) {
      renderQueued = true;
      return;
    }
    rendering = true;
    const result = await renderOnce();
    rendering = false;
    if (result.ok) {
      log(
        `rendered (${reason}) → reloading ${clients.size} client${clients.size === 1 ? "" : "s"}`
      );
      broadcastEvent("reload");
    } else {
      log(`render failed (${reason}): ${result.error}`);
    }
    if (renderQueued) {
      renderQueued = false;
      rerenderAndReload("coalesced");
    }
  }

  // Named SSE event broadcast. "reload" (post re-render) is what the injected
  // livereload snippet listens for; "tracker-update"/"activity-update" fire
  // immediately on the raw watch trigger, independent of render, for API
  // consumers (e.g. the embedded runtime) that care about data changes rather
  // than the HTML preview.
  function broadcastEvent(name) {
    const payload = stamp();
    for (const res of clients) {
      try {
        res.write(`event: ${name}\ndata: ${payload}\n\n`);
      } catch {
        clients.delete(res);
      }
    }
  }

  // -------------------------------------------------------------------------
  // JSON API — exact method+path routes, checked before the static/HTML url
  // branching below. `addRoute` is returned on the server object so a later
  // phase can register new routes (e.g. POST /api/skill/run) without reaching
  // back into this module.
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }

  addRoute("GET", "/api/health", (_req, res) => {
    sendJson(res, 200, { ok: true, version: PACKAGE_VERSION });
  });

  // P0-4 — the embedded AI skill runtime. See src/cli/skill-run-route.mjs for
  // the SSE/abort/status-code mechanics and src/core/ai/skill-runtime.mjs for
  // the Agent SDK driver itself. `runSkillStream` is dependency-injected above
  // so tests can stub it without needing the real SDK devDependency installed.
  // Also registers GET /api/runtime/config (the allowlist evaluate-page.mjs
  // polls to decide whether its decision buttons can run).
  mountSkillRunRoute({ addRoute, repoRoot, runSkillStream, env });

  // P0-5 — the headline paste → evaluate-job → live verdict slice's UI. A
  // byte-static page (see src/core/ai/evaluate-page.mjs); it calls the two
  // routes above from client-side JS.
  addRoute("GET", "/evaluate", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(EVALUATE_PAGE_HTML);
  });

  // Interactive Q&A slice (POC apply-packet item 3) — a byte-static page (see
  // src/core/ai/answer-page.mjs); it calls the two routes above from
  // client-side JS, same as /evaluate.
  addRoute("GET", "/answer", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(ANSWER_PAGE_HTML);
  });

  // M1 of the paid-POC journey — the non-AI onboarding wizard. Its HTTP
  // surface (candidate file seeding, resume parsing, BYOK key storage) is
  // src/cli/onboard-route.mjs; its byte-static page is
  // src/core/onboarding/onboard-page.mjs. Deliberately mounted after
  // mountSkillRunRoute rather than before: unlike /evaluate and /answer, this
  // page never calls POST /api/skill/run — it exists precisely so a
  // candidate's workspace is legible before any paid AI usage starts.
  mountOnboardRoutes({ addRoute, repoRoot, env });

  addRoute("GET", "/onboard", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(ONBOARD_PAGE_HTML);
  });

  // M8 — the /app/onboarding SPA wizard's AI-assist surface: server-side
  // prompt templates for the Targeting step's "Roland-suggest" chips
  // (src/cli/assist-route.mjs) and the Companies step's logo.dev proxy +
  // cache (src/cli/logo-route.mjs). No page mounted here — apps/web's SPA
  // (out of this backend build's scope) is the only client.
  mountAssistRoutes({ addRoute, repoRoot, env });
  mountLogoRoutes({ addRoute, repoRoot, env });
  // M8 additive (Builder B, wizard UI) — src/cli/boards-route.mjs's own
  // header comment explains why this route didn't already exist: the
  // Targeting step's board-URL preview and the Finish step's "add LinkedIn
  // saved search" affordance have no server surface without it.
  mountBoardsRoutes({ addRoute, repoRoot, env });

  // M2 of the paid-POC journey — the conversational (multi-turn) skill
  // runtime's HTTP surface (src/cli/chat-route.mjs) and its byte-static page
  // (src/core/onboarding/chat-page.mjs), mounted at GET /chat. This is what
  // runs ingest-profile's interview from the browser instead of a terminal
  // session — see chat-runtime.mjs's header comment for the long-lived
  // query()-with-streaming-input design decision.
  mountChatRoute({ addRoute, repoRoot, chatRuntime, env });
  // App-facing supervised discovery pipeline. Shares the same chatRuntime as
  // /api/chat/* so Quick Start / Continue Discovery can start or reconnect to
  // exactly one visible research-boards/discover-companies/search-jobs session.
  mountDiscoveryRoutes({ addRoute, repoRoot, env, chatRuntime });

  addRoute("GET", "/chat", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(CHAT_PAGE_HTML);
  });

  // M3 of the paid-POC journey — the /search surface over the existing
  // deterministic (non-AI) ATS-board sweep. Its HTTP surface (run/read the
  // sweep) is src/cli/search-route.mjs; its byte-static page is
  // src/core/onboarding/search-page.mjs. Each result row's "Evaluate" link
  // hands the posting URL to /evaluate?url=… (see evaluate-page.mjs's
  // prefillFromQuery()) — the two pages are deliberately linked, not merged,
  // so a scan can be re-run/browsed without re-running evaluate-job.
  mountSearchRoutes({ addRoute, repoRoot, env });

  addRoute("GET", "/search", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(SEARCH_PAGE_HTML);
  });

  // M4 of the paid-POC journey — the /packet view: review a gated
  // application's tailored resume/cover letter/answers, or generate them live
  // via tailor-application. Its HTTP surface (list + single-packet resolution,
  // path-safety-checked artifact reads) is src/cli/packet-route.mjs; its
  // byte-static page is src/core/onboarding/packet-page.mjs. The "Generate
  // packet" button POSTs the same /api/skill/run mountSkillRunRoute already
  // registered above, so no new skill-run mechanics are needed here.
  mountPacketRoutes({ addRoute, repoRoot, env });

  addRoute("GET", "/packet", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(PACKET_PAGE_HTML);
  });

  // M6 — the sqlite-backed data layer's JSON API (src/cli/data-route.mjs).
  // Fail-closed per decision 7: every route 409s with a clear "no database
  // yet" error until `rolester data init`/`import` creates one; there is no
  // page mounted here (no /data view), just the API surface CLI verbs mirror.
  mountDataRoutes({ addRoute, repoRoot, env });

  // M10 — the server-derived dashboard view model (src/cli/dashboard-route.mjs):
  // one GET that reuses dashboard-data.js's buildDashboardViewModel UNMODIFIED
  // against DB-native inputs, so the /app SPA's Home/Jobs/Calendar surfaces
  // (and the legacy dashboard) never disagree on CTA/focus/calendar derivation.
  // Same fail-closed-409-no-db posture as mountDataRoutes above.
  mountDashboardRoutes({ addRoute, repoRoot, env });

  // M9 — Universal Intake's HTTP surface (src/cli/intake-route.mjs): the
  // paste/URL drop zone (POST /api/intake), its confirm-first gate
  // (POST /api/intake/confirm), and the read/dismiss/re-classify routes
  // alongside it. Shares this SAME chatRuntime instance with mountChatRoute
  // above (not a second registry) so Lane C's findBySkill/postMessage reuse
  // an already-live ingest-profile/discover-companies-style session exactly
  // as /api/chat/* would see it.
  mountIntakeRoutes({ addRoute, repoRoot, env, chatRuntime });

  // M10 — boot-time Lane-C orphan reconciliation (see
  // src/core/db/verbs/intake.mjs's reconcileOrphanedLaneCIntakeItems doc
  // comment): chat-runtime sessions are in-memory only, so any intake item
  // left "running" with a Lane C dispatch from a PREVIOUS process lifetime can
  // never resolve on its own — its onClose() callback would need a session
  // that no longer exists. Runs once, here, before the server starts
  // accepting traffic. Best-effort: a workspace with no db yet (NO_DATABASE)
  // or any other read/write hiccup here must never block server boot — the
  // very next confirm/reconcile pass still has the same recovery available.
  try {
    reconcileOrphanedLaneCIntakeItems({ repoRoot, env });
  } catch {
    // best-effort only — see comment above
  }

  // Idle/closed-session eviction — see chatRuntime.sweepOnce()'s own doc
  // comment. Started here (not gated behind main()'s CLI boot) so every
  // createDevServer() instance, including ones tests construct directly,
  // reaps orphaned sessions; stopped in main()'s shutdown() below, and by
  // whichever teardown path a test uses on its own chatRuntime.
  chatRuntime.startSweep();

  // -------------------------------------------------------------------------
  // HTTP server

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];

    const route = routes.get(`${req.method} ${url}`);
    if (route) {
      route(req, res);
      return;
    }

    if (url === "/__livereload") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: hello\ndata: connected\n\n`);
      clients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(`: ping\n\n`);
        } catch {
          clearInterval(ping);
        }
      }, 25000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (isDebugExportRoute(url)) {
      serveDebugExportRoute(url, res);
      return;
    }

    // Static assets the dashboard references relatively (../assets/logo.png,
    // ../assets/logos/*). The page lives at /, so those resolve to /assets/*.
    if (url.startsWith("/assets/")) {
      serveAsset(url, res);
      return;
    }

    if (url.startsWith("/fonts/")) {
      serveFont(url, res);
      return;
    }

    // M7 — the canonical Vite + React app shell. SPA-fallback contract: a
    // request under /app/* that names a real built file (has an extension —
    // hashed assets like /app/assets/index-abc123.js) is served from
    // apps/web/dist as a static file; anything else (client-side routes like
    // /app/settings) falls back to the built index.html, same pattern as any
    // SPA host.
    if (url === "/app" || url.startsWith("/app/")) {
      serveApp(url, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(buildNotFoundText());
  });

  function serveDebugExportRoute(url, res) {
    const route = getDebugExportRoute(url);
    if (!route) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Debug/export route not found");
      return;
    }

    switch (route.kind) {
      case "legacy-dashboard-html":
        serveLegacyDashboardHtml(res);
        return;
      case "generated-dashboard-module":
        serveFile(OUT_DATA, res, "text/javascript; charset=utf-8");
        return;
      case "raw-tracker-export":
        serveFile(TRACKER_JSON, res, "application/json; charset=utf-8");
        return;
      case "raw-activity-export":
        serveActivityExport(res);
        return;
      case "workspace-json-export":
        if (route.path.endsWith("modes.json")) {
          serveFile(OUT_MODES, res, "application/json; charset=utf-8");
        } else if (route.path.endsWith("settings.json")) {
          serveFile(OUT_SETTINGS, res, "application/json; charset=utf-8");
        } else {
          serveFile(OUT_LIBRARY, res, "application/json; charset=utf-8");
        }
        return;
      case "storage-adapter-tracker":
        serveStorageAdapterTracker(res);
        return;
      case "storage-adapter-activity":
        serveStorageAdapterActivity(res);
        return;
      default:
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Unhandled debug/export route: ${route.kind}`);
    }
  }

  function serveLegacyDashboardHtml(res) {
    if (!existsSync(OUT_HTML)) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        placeholderPage(
          "Debug/export dashboard not rendered",
          "The generated dashboard export is not available yet. The product app remains at <code>/app</code>."
        )
      );
      return;
    }
    let html;
    try {
      html = readFileSync(OUT_HTML, "utf8");
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Could not read workspace/tracker.html: ${err.message}`);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(injectLiveReload(html));
  }

  function serveActivityExport(res) {
    if (!existsSync(ACTIVITY_JSONL)) {
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end("");
      return;
    }
    serveFile(ACTIVITY_JSONL, res, "application/x-ndjson; charset=utf-8");
  }

  function serveStorageAdapterTracker(res) {
    let data;
    try {
      data = adapter.readTracker();
    } catch (err) {
      const status = /no tracker\.json/.test(err.message) ? 404 : 500;
      sendJson(res, status, { error: err.message });
      return;
    }
    sendJson(res, 200, data);
  }

  function serveStorageAdapterActivity(res) {
    try {
      sendJson(res, 200, adapter.readActivity());
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  }

  function buildNotFoundText() {
    const debugExportPaths = DEBUG_EXPORT_ROUTES.map((route) => route.path).join(", ");
    return (
      "Not found. Product app route: /app, /app/*.\n" +
      `Debug/export compatibility routes: ${debugExportPaths}.\n` +
      "App APIs and utility pages include /api/health, /api/runtime/config, /api/skill/run, " +
      "/evaluate, /answer, /onboard, /chat, /search, /packet, /api/onboard/state, " +
      "/api/onboard/resume, /api/onboard/profile, /api/onboard/targeting, " +
      "/api/onboard/form-defaults, /api/onboard/evidence, /api/onboard/ai-key, " +
      "/api/onboard/finish, /api/onboard/*, " +
      "/api/discovery/*, /api/settings/*, /api/chat/start, /api/chat/events, " +
      "/api/chat/message, /api/chat/interrupt, /api/chat/close, /api/chat/by-skill, " +
      "/api/chat/list, /api/chat/*, /api/search/*, /api/packet*, " +
      "/api/search/scan, /api/search/results, /api/search/sources, " +
      "/api/packet/list, /api/packet?id=:id, " +
      "/api/data/*, /api/intake*, /assets/*, /fonts/*, and /__livereload."
    );
  }

  function serveFile(path, res, contentType) {
    let body;
    try {
      body = readFileSync(path);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("File not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    res.end(body);
  }

  function serveAsset(url, res) {
    const resolved = safeAssetPath(ASSETS_DIR, url);
    if (!resolved.ok) {
      res.writeHead(resolved.status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(resolved.status === 400 ? "Bad request" : "Forbidden");
      return;
    }
    let body;
    try {
      if (!statSync(resolved.full).isFile()) throw new Error("not a file");
      body = readFileSync(resolved.full);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Asset not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeFor(resolved.full), "Cache-Control": "no-cache" });
    res.end(body);
  }

  function serveFont(url, res) {
    const resolved = safeAssetPath(FONTS_DIR, url, "/fonts/");
    if (!resolved.ok) {
      res.writeHead(resolved.status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(resolved.status === 400 ? "Bad request" : "Forbidden");
      return;
    }
    let body;
    try {
      if (!statSync(resolved.full).isFile()) throw new Error("not a file");
      body = readFileSync(resolved.full);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Font not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeFor(resolved.full), "Cache-Control": "no-cache" });
    res.end(body);
  }

  // M7 — serve apps/web/dist at /app/*, reusing the exact safeAssetPath()
  // traversal guard serveAsset()/serveFont() already use above, parameterized
  // with the "/app/" prefix. A URL segment with a file extension (hashed
  // assets: /app/assets/index-abc123.js) is resolved as a real static file;
  // anything else (client-side routes: /app/settings) falls back to the
  // built index.html — the standard SPA-fallback contract.
  function serveApp(url, res) {
    if (!existsSync(APP_INDEX_HTML)) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        placeholderPage(
          "App not built",
          "apps/web hasn't been built yet. Run <code>npm run app:build</code> " +
            "(or <code>npm run build --workspace apps/web</code>), then reload."
        )
      );
      return;
    }

    const lastSegment = url.split("/").pop() || "";
    const hasExtension = lastSegment.includes(".");

    if (hasExtension) {
      const resolved = safeAssetPath(APP_DIST_DIR, url, "/app/");
      if (!resolved.ok) {
        res.writeHead(resolved.status, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(resolved.status === 400 ? "Bad request" : "Forbidden");
        return;
      }
      let body;
      try {
        if (!statSync(resolved.full).isFile()) throw new Error("not a file");
        body = readFileSync(resolved.full);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      // Hashed asset filenames (Vite content-hashes everything under
      // assets/) are safe to cache forever; index.html itself is not (it
      // changes across builds/versions without a new URL).
      const isIndexHtml = resolved.full === APP_INDEX_HTML;
      res.writeHead(200, {
        "Content-Type": mimeFor(resolved.full),
        "Cache-Control": isIndexHtml ? "no-store" : "public, max-age=31536000, immutable",
      });
      res.end(body);
      return;
    }

    // Extension-less path under /app — a client-side route. Fall back to the
    // built index.html (react-router then resolves the route in the browser).
    let body;
    try {
      body = readFileSync(APP_INDEX_HTML);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Could not read apps/web/dist/index.html: ${err.message}`);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  }

  function placeholderPage(title, body) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font:15px system-ui;padding:3rem;color:#333">
<h1>${title}</h1><p>${body}</p>${LIVERELOAD_SNIPPET}</body></html>`;
  }

  // -------------------------------------------------------------------------
  // File watching → debounced re-render, plus immediate named SSE events

  let debounce = null;
  function scheduleRerender(reason) {
    clearTimeout(debounce);
    debounce = setTimeout(() => rerenderAndReload(reason), 120);
  }

  function startWatching() {
    // Watch the data file by watching its directory and filtering the filename —
    // editors rename-on-save, which a direct file watch can miss. Ignore our own
    // tracker.html writes so re-rendering never triggers another re-render.
    if (existsSync(WORKSPACE_DIR)) {
      watchers.push(
        watch(WORKSPACE_DIR, (_event, filename) => {
          if (filename === "tracker.json") {
            broadcastEvent("tracker-update");
            scheduleRerender(filename);
          } else if (filename === "activity.jsonl") {
            broadcastEvent("activity-update");
            scheduleRerender(filename);
          }
        })
      );
    }
    // Watch the dashboard source so editing the UI hot-reloads too.
    if (existsSync(TRACKER_SRC_DIR)) {
      watchers.push(
        watch(TRACKER_SRC_DIR, { recursive: true }, (_event, filename) => {
          if (/\.(mjs|js|html|css)$/.test(filename || "")) {
            scheduleRerender(`src/core/tracker/${filename}`);
          }
        })
      );
    }
    if (existsSync(CANDIDATE_DIR)) {
      watchers.push(
        watch(CANDIDATE_DIR, (_event, filename) => {
          if (filename === "modes.yml") scheduleRerender("candidate/modes.yml");
        })
      );
    }
  }

  // Close every fs.watch handle — test/embedded-runtime teardown, so a repeated
  // createDevServer() in the same process doesn't leak watchers.
  function stopWatching() {
    for (const w of watchers.splice(0)) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    clearTimeout(debounce);
  }

  // End every open SSE connection — used on shutdown and in test teardown.
  function closeClients() {
    for (const res of clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
  }

  return {
    server,
    pathCtx,
    addRoute,
    renderOnce,
    startWatching,
    stopWatching,
    closeClients,
    clients,
    chatRuntime,
  };
}

// ---------------------------------------------------------------------------
// Boot (CLI entry point only — see the import.meta.url guard at the bottom)

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const wantOpen = args.includes("--open");
  const port = resolvePort(args, process.env);

  const dev = createDevServer({ repoRoot: DEFAULT_ROOT });
  const pathCtx = dev.pathCtx;

  if (existsSync(userPath(pathCtx, "workspace/tracker.json"))) {
    log("initial debug/export render…");
    const first = await dev.renderOnce();
    if (!first.ok) {
      log(`initial debug/export render failed: ${first.error}`);
    }
  } else {
    log(
      `No ${displayPath(pathCtx, "workspace/tracker.json")} yet; skipping debug/export render. /app and DB APIs will still serve.`
    );
  }

  dev.startWatching();

  // Loopback-only by default: this server executes skills (Bash and all, via
  // /api/skill/run) and accepts local credential writes (/api/settings/ai-key)
  // — it must never be reachable from the LAN unless the operator explicitly
  // opts in with ROLESTER_TRACKER_HOST (e.g. for a trusted-network preview).
  const host = process.env.ROLESTER_TRACKER_HOST || "127.0.0.1";
  dev.server.listen(port, host, () => {
    const url = `http://localhost:${port}`;
    log(`serving ${url}`);
    log(
      `watching ${displayPath(pathCtx, "workspace/tracker.json")}, ${displayPath(pathCtx, "candidate/modes.yml")}, and src/core/tracker/.`
    );
    log("Ctrl-C to stop.");
    if (wantOpen) openBrowser(url);
  });
  dev.server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log(`port ${port} is in use. Pick another: rolester tracker-dev --port ${port + 1}`);
    } else {
      log(`server error: ${err.message}`);
    }
    process.exit(1);
  });

  function shutdown() {
    dev.closeClients();
    dev.stopWatching();
    // M2 — closes every live chat session (query.close() + abort) and stops
    // the idle-sweep timer so a Ctrl-C never leaves an orphaned Agent SDK
    // child process running.
    dev.chatRuntime.shutdown();
    dev.server.close(() => process.exit(0));
    // Don't hang on a lingering socket.
    setTimeout(() => process.exit(0), 200).unref();
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Helpers

function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    }).unref();
  } catch {
    /* best-effort */
  }
}

function printHelp() {
  const debugExportRoutes = DEBUG_EXPORT_ROUTES.map((route) => route.path).join(", ");
  process.stdout.write(`rolester tracker-dev — the embedded /app server (React product shell + local APIs)

Usage:
  rolester tracker-dev                 Serve http://localhost:7777 with live reload
  rolester tracker-dev --port 8080  Pick a port (or set ROLESTER_DEV_PORT)
  rolester tracker-dev --open       Open the page in your browser on start

Routes:
  GET  /app, /app/*                     Canonical Vite + React product shell (M7) — build via \`npm run app:build\`

Debug/export compatibility routes:
  GET  ${debugExportRoutes}
                                           Generated dashboard/static exports and raw compatibility feeds

Retained utility pages and APIs:
  GET  /evaluate                        Paste a JD → live evaluate-job verdict (P0-5)
  GET  /answer                          Paste a screening question → live answer-question draft
  GET  /onboard                         Non-AI onboarding wizard (M1) — seed candidate files, BYOK key
  GET  /chat                            Conversational ingest-profile interview, turn-by-turn (M2)
  GET  /search                          Deterministic ATS-board sweep results + "Run sweep" (M3)
  GET  /packet                          Review a gated app's tailored resume/cover letter/answers, or generate live (M4)
  GET  /api/health                      { ok, version }
  GET  /api/runtime/config              { skills: [...] } — the embedded runtime's allowlist
  POST /api/skill/run                   Run a SKILL.md via the embedded Agent SDK runtime (SSE)
  GET  /api/onboard/state               Candidate-file + key + search-config status
  POST /api/onboard/init                Seed candidate/ from templates (never overwrites)
  POST /api/onboard/resume              Parse a pasted/loaded resume (no AI)
  POST /api/onboard/candidate/:name     Merge + validate + write one candidate file
  POST /api/onboard/evidence-seed       Dedupe-merge claims into candidate/evidence.yml
  POST /api/onboard/write-config        Generate config/search-sources.yml + candidate/AGENTS.md
  POST /api/onboard/quick-start         Search-ready DB setup -> source config + discovery handoff
  GET  /api/discovery/state             Current supervised discovery handoff state
  POST /api/discovery/quick-start       Prepare sources and start/reuse first discovery chat
  POST /api/discovery/next              Start/reuse the current next discovery chat
  POST /api/settings/ai-key             Store a BYOK Anthropic key in .internal/ai.env
  GET  /api/settings/ai                 { route, keyPresent } — never the key value
  POST /api/chat/start                  Start (or find the live) ingest-profile chat session (M2)
  GET  /api/chat/events                 SSE transcript stream for a chat session (?id=<chatId>)
  POST /api/chat/message                Send the human's next turn to a chat session
  POST /api/chat/interrupt              Interrupt a running chat session's current turn
  POST /api/chat/close                  End a chat session
  GET  /api/chat/by-skill               Find the live chat session for a skill (?skill=<name>)
  GET  /api/chat/list                   List every tracked chat session
  POST /api/search/scan                 Run the deterministic ATS-board sweep, persist + return the summary (M3)
  GET  /api/search/results              Newest (or ?date=YYYY-MM-DD) persisted sweep summary
  GET  /api/search/sources              Search-source/tracked-company presence counts
  GET  /api/packet/list                 Gated applications + artifact presence + NEEDS YOU counts (M4)
  GET  /api/packet?id=<appId>           One application's resolved resume/coverLetter/answers (M4)
  GET  /api/data/snapshot               sqlite data layer: meta + table counts (M6, 409 if no db yet)
  GET  /api/data/applications           Application rows (?status=, ?company= filters)
  GET  /api/data/applications/one       One application row (?id=)
  GET  /api/data/sourced                Sourced rows
  GET  /api/data/communications         Communication thread rows
  GET  /api/data/activity               Activity events, newest-first (?limit=)
  GET  /api/data/dashboard              Server-derived dashboard view model (M10, 409 if no db yet)
  POST /api/data/app/status             appSetStatus verb
  POST /api/data/app/fields             appSetFields verb
  POST /api/data/app/interview          appScheduleInterview verb
  POST /api/data/app/artifact           appRegisterArtifact verb
  POST /api/data/sourced/promote        sourcedPromote verb
  POST /api/data/comm/message           commAppendMessage verb
  POST /api/data/comm/send              commMarkSent verb (sent-clears-draft)
  POST /api/intake                      Capture a paste/URL into the intake queue + auto-classify (M9)
  GET  /api/intake/list                 Intake queue rows, newest-first (?status=, ?limit=)
  GET  /api/intake/one                  One intake item (?id=)
  POST /api/intake/classify             Re-run classification on an intake item
  POST /api/intake/confirm              Confirm-first gate: executes the item's resolved dispatch lane
  POST /api/intake/dismiss              Dismiss an intake item (never deletes the row)
  GET  /assets/*, /fonts/*              Static assets
  GET  /__livereload                    Server-Sent Events: reload, tracker-update, activity-update

Watches workspace/tracker.json, workspace/activity.jsonl, candidate/modes.yml, and
src/core/tracker/*.mjs; re-renders via the canonical tracker CLI and pushes a reload
over Server-Sent Events. Zero deps.
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
