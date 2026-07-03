// apps/desktop/main.mjs — thin Electron shell over the existing Rolester
// local server (M5 of the paid-POC journey). This process NEVER forks a
// skill itself; it boots the same createDevServer() the browser-only
// `rolester tracker-dev` uses (see src/cli/tracker-dev.mjs) and wraps it in a
// native window. Every skill still runs through that one embedded Agent SDK
// runtime — open-core discipline stays intact.
//
// Two run modes:
//   dev  (`npm run desktop` from repo root) — unpackaged window over the live
//        checkout; shares data with `npm run tracker:dev` (legacy in-checkout
//        layout, no ROLESTER_HOME). The primary POC deliverable.
//   dist (`npm run desktop:dist`) — signed .dmg via electron-builder, running
//        against a staged copy of the engine (see scripts/stage.mjs) with its
//        own per-user data root.
//
// `--smoke`: boot the server, GET /api/health from inside this process,
// then actually create the window and require its real route to finish
// loading (see waitForLoad below — health-only isn't enough, see the trap-1
// comment) — print "SMOKE OK <url>" and exit 0 (no interaction) once both
// pass. The scripted verification path for `npx electron . --smoke`.

import { app, BrowserWindow, shell } from "electron";
import { existsSync } from "node:fs";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// --- Trap 1 -----------------------------------------------------------------
// Inside Electron, `process.execPath` is the Electron binary, not a plain
// `node`. tracker-dev's renderOnce() spawns `process.execPath [tracker.mjs]`,
// and the Agent SDK's own CLI child spawn works the same way — unpatched,
// either child would try to launch a *new* Electron GUI instance instead of
// running headless. FIXED AT THE SOURCE, not here: setting
// `process.env.ELECTRON_RUN_AS_NODE = "1"` globally in this main process was
// tried first and was wrong — Chromium's OWN helper processes (GPU, network,
// renderer, utility) inherit process.env too, so they ALSO booted as plain
// node instead of Chromium helpers and rejected every one of their own
// `--type=…` flags ("bad option: --type=gpu-process" etc.), which silently
// killed rendering (a real window never painted) while still letting
// `--smoke` pass (it renders nothing, so nothing exposed the breakage). The
// env var is now set per-spawn, scoped to exactly the two child processes
// that need it (see src/cli/tracker-dev.mjs's renderOnce() and
// src/core/ai/skill-runtime.mjs's buildChildEnv()) — never on this process's
// own env, which Chromium's helpers inherit from.
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const isSmoke = process.argv.includes("--smoke");

// --- Trap 3 -------------------------------------------------------------
// Data root. A packaged app's Resources/ tree is read-only (code-signed) —
// point ROLESTER_HOME at Electron's per-user data dir instead, and do it
// BEFORE importing any rolester module: resolveUserPaths() reads
// process.env.ROLESTER_HOME the moment it's called (src/core/paths/
// workspace.mjs), so this must land before boot()'s dynamic imports below.
// Dev keeps the legacy in-checkout layout (no ROLESTER_HOME) so it shares
// data with `npm run tracker:dev` on the same checkout.
let repoRoot;
if (app.isPackaged) {
  process.env.ROLESTER_HOME = join(app.getPath("userData"), "data");
  repoRoot = join(process.resourcesPath, "rolester");
} else {
  repoRoot = join(__dirname, "../..");
}

// --- Trap 4 -------------------------------------------------------------
// One helper resolves both the dev and packaged import path. In dev,
// repoRoot already points at the live checkout, so `repoRoot/src/cli/
// tracker-dev.mjs` is the same file a static `../../src/cli/tracker-dev.mjs`
// import would resolve to. In a packaged app, repoRoot points at the staged
// `resources/rolester` copy instead. Either way, a dynamic import off the
// already-resolved repoRoot is correct — no dev/packaged branch needed here.
function loadEngineModule(relPath) {
  return import(pathToFileURL(join(repoRoot, relPath)).href);
}

function log(msg) {
  process.stdout.write(`[desktop] ${msg}\n`);
}

// Plain node:http instead of Electron's main-process `fetch()` (which is
// backed by Chromium's network service, i.e. another helper-process spawn)
// — the smoke check only needs to hit our own loopback server, and libuv's
// own client has no helper-process dependency at all.
function httpGetOk(url) {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} → ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
  });
}

let dev = null;
let win = null;
let shuttingDown = false;

// --smoke never renders anything — it's a scripted server-only check (boot,
// GET /api/health, print, exit). Skipping GPU process bring-up entirely (as
// opposed to just passing a `--disable-gpu` chromium flag, which still
// spins the process up before deciding not to use it) keeps the smoke path
// robust on machines where third-party endpoint-security software intercepts
// helper-process exec() and breaks Chromium's GPU/network process bootstrap
// — a real-world failure mode this shell has actually hit in testing, not a
// hypothetical. Must be called before app.whenReady().
if (isSmoke) {
  app.disableHardwareAcceleration();
}

async function boot() {
  const { createDevServer } = await loadEngineModule("src/cli/tracker-dev.mjs");
  const { resolveUserPaths, userPath } = await loadEngineModule("src/core/paths/workspace.mjs");

  dev = createDevServer({ repoRoot });

  // Tolerate a fresh data root (no tracker.json yet) — an empty workspace
  // can legitimately fail to render; log and keep booting so a first-run
  // candidate still reaches /onboard instead of a crashed app.
  const rendered = await dev.renderOnce();
  if (!rendered.ok) {
    log(`initial render skipped: ${rendered.error}`);
  }

  dev.startWatching();

  const port = await new Promise((resolve, reject) => {
    dev.server.once("error", reject);
    dev.server.listen(0, "127.0.0.1", () => resolve(dev.server.address().port));
  });

  const url = `http://127.0.0.1:${port}`;
  log(`serving ${url}`);

  // First-run routing: a candidate with no seeded candidate/profile.yml goes
  // to the onboarding wizard instead of an empty dashboard. Use the engine's
  // own path resolver — the same one createDevServer() itself used above —
  // rather than hand-rolling a join, so this always agrees with where the
  // server actually looked for candidate/workspace files.
  const pathCtx = { repoRoot };
  resolveUserPaths(pathCtx);
  const route = existsSync(userPath(pathCtx, "candidate/profile.yml")) ? "/tracker" : "/onboard";

  return { url, route };
}

async function shutdown() {
  if (!dev) return;
  const active = dev;
  dev = null;
  active.stopWatching();
  active.closeClients();
  // M2's chat runtime — closes every live Agent SDK session and stops the
  // idle-sweep timer so quitting the app never leaves an orphaned `claude`
  // CLI child running in the background.
  await active.chatRuntime.shutdown();
  await new Promise((resolve) => active.server.close(() => resolve()));
}

function createWindow(url, route) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Rolester",
    // No preload, no explicit webPreferences overrides — the UI is
    // server-rendered HTML loaded over loopback HTTP, so Electron's secure
    // remote-page defaults (nodeIntegration off, contextIsolation on) are
    // exactly what we want as-is.
  });

  // External links (target=_blank) and any navigation away from our own
  // loopback origin open in the OS browser instead of inside the app window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  win.loadURL(`${url}${route}`);
  return win;
}

// Waits for `browserWindow` to actually finish loading — not just that the
// server answered a health check, but that the renderer painted the real
// page. This is the check that would have caught the ELECTRON_RUN_AS_NODE
// incident (see the trap-1 comment above): the server was healthy the whole
// time, only the window never rendered. Rejects on a failed/aborted main-
// frame load, a crashed renderer process, or a timeout — any of which means
// --smoke must fail, not just "the HTTP server is up".
function waitForLoad(browserWindow, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const wc = browserWindow.webContents;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`renderer did not finish loading within ${timeoutMs}ms`));
    }, timeoutMs);

    function onFinish() {
      cleanup();
      resolve();
    }
    function onFail(_event, errorCode, errorDescription, _validatedUrl, isMainFrame) {
      if (!isMainFrame) return; // sub-frame/subresource failures aren't fatal here
      cleanup();
      reject(new Error(`did-fail-load: ${errorDescription} (${errorCode})`));
    }
    function onGone(_event, details) {
      cleanup();
      reject(new Error(`render-process-gone: ${details?.reason ?? "unknown"}`));
    }
    function cleanup() {
      clearTimeout(timer);
      wc.removeListener("did-finish-load", onFinish);
      wc.removeListener("did-fail-load", onFail);
      wc.removeListener("render-process-gone", onGone);
    }

    wc.once("did-finish-load", onFinish);
    wc.on("did-fail-load", onFail);
    wc.on("render-process-gone", onGone);
  });
}

app.whenReady().then(async () => {
  const { url, route } = await boot();

  if (isSmoke) {
    try {
      const body = await httpGetOk(`${url}/api/health`);
      JSON.parse(body); // shape-check only — throws if the route ever regresses

      // Health alone already passed before the ELECTRON_RUN_AS_NODE incident
      // too — the server was fine, only the window never painted. Actually
      // create it and require the real load to succeed before declaring OK.
      const smokeWin = createWindow(url, route);
      await waitForLoad(smokeWin);

      log(`SMOKE OK ${url}`);
      await shutdown();
      app.exit(0);
    } catch (err) {
      log(`SMOKE FAILED: ${err.message}`);
      await shutdown();
      app.exit(1);
    }
    return;
  }

  createWindow(url, route);

  // macOS convention: clicking the dock icon with no open windows reopens
  // one instead of doing nothing.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(url, route);
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

// Shutdown: both window-all-closed (via app.quit() above) and any other quit
// trigger (Cmd+Q, etc.) funnel through this one before-quit handler so
// stopWatching()/closeClients()/chatRuntime.shutdown()/server.close() always
// run exactly once before the process actually exits — no orphaned `claude`
// CLI children left behind.
app.on("before-quit", (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  shutdown().finally(() => app.exit(0));
});
