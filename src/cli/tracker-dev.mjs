#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
// Rolester tracker dev server — a live-reloading dashboard for iterating on the
// tracker data or the dashboard UI itself.
//
// Usage:
//   careerrat tracker-dev                 Serve http://localhost:7777 with live reload
//   careerrat tracker-dev --port 8080  Pick a port (or ROLESTER_DEV_PORT=8080)
//   careerrat tracker-dev --open       Best-effort open the page in your browser
//   careerrat tracker-dev --help
//
// Zero runtime deps: node:http + node:fs.watch + Server-Sent Events. Watches
//   - workspace/tracker.json        (edit the data → page refreshes)
//   - src/core/tracker/*            (edit the dashboard code → page refreshes)
// and on any change re-renders via the canonical `tracker.mjs` CLI in a child
// process (so the preview can never drift from `careerrat tracker`, and every
// render picks up fresh modules), then pushes a reload to the open page.
//
// The pure, risk-bearing helpers (asset traversal guard, MIME, snippet
// injection, port parsing) live in src/core/tracker/dev-server.mjs and are
// unit-tested there. This file is the I/O glue (http, watch, child render).
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { displayPath, resolveUserPaths, userPath } from "../core/paths/workspace.mjs";
import {
  injectLiveReload,
  LIVERELOAD_SNIPPET,
  mimeFor,
  resolvePort,
  safeAssetPath,
} from "../core/tracker/dev-server.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const pathCtx = { repoRoot: root };
const userPaths = resolveUserPaths(pathCtx);
const TRACKER_CLI = join(root, "src/cli/tracker.mjs");
const TRACKER_JSON = userPath(pathCtx, "workspace/tracker.json");
const OUT_HTML = userPath(pathCtx, "workspace/tracker.html");
const OUT_DATA = userPath(pathCtx, "workspace/dashboard-data.js");
const OUT_MODES = userPath(pathCtx, "workspace/modes.json");
const OUT_SETTINGS = userPath(pathCtx, "workspace/settings.json");
const OUT_LIBRARY = userPath(pathCtx, "workspace/library.json");
const ACTIVITY_JSONL = userPath(pathCtx, "workspace/activity.jsonl");
const WORKSPACE_DIR = userPaths.workspaceDir;
const CANDIDATE_DIR = userPaths.candidateDir;
const TRACKER_SRC_DIR = join(root, "src/core/tracker");
const ASSETS_DIR = join(root, "assets");
const FONTS_DIR = join(root, "fonts");

// SSE clients subscribed to reload events.
const clients = new Set();

// ---------------------------------------------------------------------------
// Render: shell out to the canonical CLI so the dev preview is byte-identical
// to `careerrat tracker` and always loads fresh modules.

let rendering = false;
let renderQueued = false;

function renderOnce() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TRACKER_CLI], { cwd: root });
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
    log(`rendered (${reason}) → reloading ${clients.size} client${clients.size === 1 ? "" : "s"}`);
    broadcastReload();
  } else {
    log(`render failed (${reason}): ${result.error}`);
  }
  if (renderQueued) {
    renderQueued = false;
    rerenderAndReload("coalesced");
  }
}

function broadcastReload() {
  for (const res of clients) {
    try {
      res.write(`event: reload\ndata: ${stamp()}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP server

const server = createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];

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

  if (url === "/" || url === "/index.html" || url === "/tracker.html") {
    if (!existsSync(OUT_HTML)) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        placeholderPage(
          "Rendering…",
          "The dashboard is still rendering. This page will refresh automatically."
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
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(injectLiveReload(html));
    return;
  }

  if (url === "/dashboard-data.js") {
    serveFile(OUT_DATA, res, "text/javascript; charset=utf-8");
    return;
  }

  if (url === "/workspace/tracker.json") {
    serveFile(TRACKER_JSON, res, "application/json; charset=utf-8");
    return;
  }

  if (url === "/workspace/modes.json") {
    serveFile(OUT_MODES, res, "application/json; charset=utf-8");
    return;
  }

  if (url === "/workspace/settings.json") {
    serveFile(OUT_SETTINGS, res, "application/json; charset=utf-8");
    return;
  }

  if (url === "/workspace/library.json") {
    serveFile(OUT_LIBRARY, res, "application/json; charset=utf-8");
    return;
  }

  // The Activity Pulse feed. Optional — serve an empty body (not 404) before any
  // skill has written an event, so the client degrades to the empty-state cleanly.
  if (url === "/workspace/activity.jsonl") {
    if (!existsSync(ACTIVITY_JSONL)) {
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end("");
      return;
    }
    serveFile(ACTIVITY_JSONL, res, "application/x-ndjson; charset=utf-8");
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

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(
    "Not found. The dev server serves /, /dashboard-data.js, /workspace/tracker.json, /workspace/modes.json, /workspace/settings.json, /workspace/library.json, /workspace/activity.jsonl, /assets/*, /fonts/*, and /__livereload."
  );
});

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

function placeholderPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font:15px system-ui;padding:3rem;color:#333">
<h1>${title}</h1><p>${body}</p>${LIVERELOAD_SNIPPET}</body></html>`;
}

// ---------------------------------------------------------------------------
// File watching → debounced re-render

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
    watch(WORKSPACE_DIR, (_event, filename) => {
      if (filename === "tracker.json" || filename === "activity.jsonl") {
        scheduleRerender(filename);
      }
    });
  }
  // Watch the dashboard source so editing the UI hot-reloads too.
  if (existsSync(TRACKER_SRC_DIR)) {
    watch(TRACKER_SRC_DIR, { recursive: true }, (_event, filename) => {
      if (/\.(mjs|js|html|css)$/.test(filename || "")) {
        scheduleRerender(`src/core/tracker/${filename}`);
      }
    });
  }
  if (existsSync(CANDIDATE_DIR)) {
    watch(CANDIDATE_DIR, (_event, filename) => {
      if (filename === "modes.yml") scheduleRerender("candidate/modes.yml");
    });
  }
}

// ---------------------------------------------------------------------------
// Boot

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const wantOpen = args.includes("--open");
  const port = resolvePort(args, process.env);

  if (!existsSync(TRACKER_JSON)) {
    log(
      `No ${displayPath(pathCtx, "workspace/tracker.json")} yet. Seed one from templates/tracker.json.`
    );
    process.exit(1);
  }

  log("initial render…");
  const first = await renderOnce();
  if (!first.ok) {
    log(`initial render failed: ${first.error}`);
    process.exit(1);
  }

  startWatching();

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    log(`serving ${url}`);
    log(
      `watching ${displayPath(pathCtx, "workspace/tracker.json")}, ${displayPath(pathCtx, "candidate/modes.yml")}, and src/core/tracker/.`
    );
    log("Ctrl-C to stop.");
    if (wantOpen) openBrowser(url);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log(`port ${port} is in use. Pick another: careerrat tracker-dev --port ${port + 1}`);
    } else {
      log(`server error: ${err.message}`);
    }
    process.exit(1);
  });
}

function shutdown() {
  for (const res of clients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  // Don't hang on a lingering socket.
  setTimeout(() => process.exit(0), 200).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

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

// A monotonic-ish stamp for SSE payloads without Date.now() determinism worries.
let tick = 0;
function stamp() {
  return `${++tick}`;
}

function log(msg) {
  process.stdout.write(`[tracker:dev] ${msg}\n`);
}

function printHelp() {
  process.stdout.write(`careerrat tracker-dev — live-reloading dashboard

Usage:
  careerrat tracker-dev                 Serve http://localhost:7777 with live reload
  careerrat tracker-dev --port 8080  Pick a port (or set ROLESTER_DEV_PORT)
  careerrat tracker-dev --open       Open the page in your browser on start

Watches workspace/tracker.json, candidate/modes.yml, and src/core/tracker/*.mjs;
re-renders via the canonical tracker CLI and pushes a reload over Server-Sent Events.
Zero deps.
`);
}

main();
