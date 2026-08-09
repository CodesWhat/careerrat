// apps/desktop/main.mjs — thin Electron shell over the existing CareerRat
// local server (M5 of the paid-POC journey). This process NEVER forks a
// skill itself; it boots the same createDevServer() the browser-only
// `careerrat tracker-dev` uses (see src/cli/tracker-dev.mjs) and wraps it in a
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

import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, shell } from "electron";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chooseDesktopRoute } from "./desktop-routing.mjs";
import {
  choosePreferredPort,
  decideExternalOpen,
  resolveDesktopRuntimePaths,
  startDesktopPdfRenderer,
} from "./desktop-runtime.mjs";
import { verifySmokeHttpSurface, verifySmokePdfExport } from "./desktop-smoke.mjs";
import { buildBrowserWindowOptions } from "./window-options.mjs";

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

// Runtime name. The dev launcher brands Electron.app's Info.plist so the macOS
// dock/Cmd-Tab identity is CareerRat; this keeps Electron's own runtime app name
// aligned for menus, about panel, notifications, and window metadata. Must run
// before app is ready, i.e. before any default menu is built.
app.setName("CareerRat");
app.setAboutPanelOptions({ applicationName: "CareerRat" });

// Google's OAuth consent screen rejects UAs it doesn't recognize with
// disallowed_useragent. Electron's default fallback UA tacks our own
// " CareerRat/<version> Electron/<version>" tokens on after the Chrome/Safari
// tokens Google's allowlist actually checks — strip just those two tokens so
// the request reads as a plain Chromium browser. Must run before any
// BrowserWindow is created; the UA is fixed at window construction.
app.userAgentFallback = app.userAgentFallback.replace(/\s(CareerRat|Electron)\/[\d.]+/g, "");

// --- Trap 3 -------------------------------------------------------------
// Data root. A packaged app's Resources/ tree is read-only (code-signed) —
// point ROLESTER_HOME at Electron's per-user data dir instead, and do it
// BEFORE importing any rolester module: resolveUserPaths() reads
// process.env.ROLESTER_HOME the moment it's called (src/core/paths/
// workspace.mjs), so this must land before boot()'s dynamic imports below.
// Dev keeps the legacy in-checkout layout (no ROLESTER_HOME) so it shares
// data with `npm run tracker:dev` on the same checkout.
const runtimePaths = resolveDesktopRuntimePaths({
  isPackaged: app.isPackaged,
  appDir: __dirname,
  userDataPath: app.isPackaged ? app.getPath("userData") : undefined,
  resourcesPath: process.resourcesPath,
});
if (runtimePaths.rolesterHome) {
  process.env.ROLESTER_HOME = runtimePaths.rolesterHome;
}
let repoRoot = runtimePaths.repoRoot;

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

// Binds `server` to `port` on loopback and resolves with the port actually
// bound (relevant when `port` is 0, i.e. "pick any free ephemeral port").
// Rejects with the raw listen error (e.g. EADDRINUSE) instead of swallowing
// it — the caller decides whether a retry is warranted.
function listenOnPort(server, port) {
  return new Promise((resolve, reject) => {
    function onError(err) {
      server.removeListener("listening", onListening);
      reject(err);
    }
    function onListening() {
      server.removeListener("error", onError);
      resolve(server.address().port);
    }
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
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
let pdfRenderer = null;
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
  // Desktop flag for the SPA's system-browser Google OAuth handoff (see
  // src/cli/desktop-auth-route.mjs and GET /api/runtime/config's
  // desktop.authAvailable field in src/cli/skill-run-route.mjs). Set before
  // createDevServer() — same placement style as the ROLESTER_HOME injection
  // above, which also must land before any engine module reads process.env.
  process.env.ROLESTER_DESKTOP_SHELL = "1";

  // ISSUE-028: the packaged staged engine deliberately does not carry
  // Playwright or a second Chromium download. Start a token-authenticated,
  // loopback-only bridge to Electron's already-bundled Chromium before the
  // engine mounts packet/export routes, then let documents/export.mjs route
  // PDF work through it. No renderer token is written to disk or logged.
  pdfRenderer = await startDesktopPdfRenderer({ BrowserWindow });
  process.env.ROLESTER_DESKTOP_PDF_RENDER_URL = pdfRenderer.url;
  process.env.ROLESTER_DESKTOP_PDF_RENDER_TOKEN = pdfRenderer.token;

  const { createDevServer } = await loadEngineModule("src/cli/tracker-dev.mjs");
  const { resolveUserPaths, userPath } = await loadEngineModule("src/core/paths/workspace.mjs");
  const { dbExists } = await loadEngineModule("src/core/db/connection.mjs");
  const { candidateConfigGet } = await loadEngineModule("src/core/db/verbs.mjs");
  const { readOnboardingDraft } = await loadEngineModule("src/cli/onboard-route.mjs");

  dev = createDevServer({ repoRoot });

  // Tolerate a fresh data root (no tracker.json yet) — an empty workspace
  // can legitimately fail to render; log and keep booting so a first-run
  // candidate still reaches /onboard instead of a crashed app.
  const rendered = await dev.renderOnce();
  if (!rendered.ok) {
    log(`initial render skipped: ${rendered.error}`);
  }

  dev.startWatching();

  // Packaged mode listens on a stable, configurable port instead of an
  // ephemeral one: Clerk's dev-browser sign-in state is keyed by origin
  // (host+port), so a port that changes on every relaunch would silently
  // sign the candidate back out each time they reopen the app. Dev/smoke
  // keep the ephemeral port (0) unchanged. If the preferred port is already
  // taken, fall back to an ephemeral one rather than failing to boot.
  const preferredPort = choosePreferredPort({ isPackaged: app.isPackaged, env: process.env });
  let port;
  try {
    port = await listenOnPort(dev.server, preferredPort);
  } catch (err) {
    if (err?.code === "EADDRINUSE" && preferredPort !== 0) {
      log(`port ${preferredPort} in use, retrying with an ephemeral port: ${err.message}`);
      port = await listenOnPort(dev.server, 0);
    } else {
      throw err;
    }
  }

  const url = `http://127.0.0.1:${port}`;
  log(`serving ${url}`);

  // First-run routing: a candidate with none of legacy candidate/profile.yml,
  // a deliberately finished onboarding wizard, or an apply-ready DB-backed
  // setup goes to onboarding instead of an empty dashboard. Use the engine's
  // own path resolver — the same one createDevServer() itself used above —
  // rather than hand-rolling a join, so this always agrees with where the
  // server actually looked for user data. First-run goes to the M8 SPA wizard
  // (/app/onboarding — PDF/image resume drop, AI extraction), NOT the legacy
  // /onboard page (txt/md only). The Electron window has no address bar, so
  // landing on the wrong wizard strands the user there.
  const pathCtx = { repoRoot };
  resolveUserPaths(pathCtx);
  const route = chooseDesktopRoute({
    routeOverride: process.env.ROLESTER_DESKTOP_ROUTE,
    forceOnboarding: !app.isPackaged,
    hasCandidateSetup:
      existsSync(userPath(pathCtx, "candidate/profile.yml")) ||
      hasOnboardingFinished({ pathCtx, readOnboardingDraft }) ||
      hasDbCandidateSetup({ pathCtx, dbExists, candidateConfigGet }),
  });

  return { url, route };
}

function hasOnboardingFinished({ pathCtx, readOnboardingDraft }) {
  try {
    return typeof readOnboardingDraft(pathCtx).finishedAt === "string";
  } catch {
    return false;
  }
}

function hasDbCandidateSetup({ pathCtx, dbExists, candidateConfigGet }) {
  if (!dbExists(pathCtx)) return false;
  try {
    const config = candidateConfigGet(pathCtx);
    return config.setup?.readiness?.apply_ready === true;
  } catch {
    return false;
  }
}

async function shutdown() {
  const active = dev;
  dev = null;
  if (active) {
    active.stopWatching();
    active.closeClients();
    // M2's chat runtime — closes every live Agent SDK session and stops the
    // idle-sweep timer so quitting the app never leaves an orphaned `claude`
    // CLI child running in the background.
    await active.chatRuntime.shutdown();
    await new Promise((resolve) => active.server.close(() => resolve()));
  }

  const activePdfRenderer = pdfRenderer;
  pdfRenderer = null;
  delete process.env.ROLESTER_DESKTOP_PDF_RENDER_URL;
  delete process.env.ROLESTER_DESKTOP_PDF_RENDER_TOKEN;
  if (activePdfRenderer) await activePdfRenderer.close();
}

function openExternalIfAllowed(target, baseUrl) {
  const decision = decideExternalOpen({ target, baseUrl, env: process.env });
  if (decision.action === "open-external") {
    shell.openExternal(decision.url).catch((err) => {
      log(`external open failed: ${err.message}`);
    });
  } else if (decision.action === "deny") {
    log(`external open denied: ${decision.reason}`);
  }
  return decision;
}

function createWindow(url, route, { load = true } = {}) {
  win = new BrowserWindow({
    ...buildBrowserWindowOptions({ dark: nativeTheme.shouldUseDarkColors }),
    // No preload, no explicit webPreferences overrides — the UI is
    // server-rendered HTML loaded over loopback HTTP, so Electron's secure
    // remote-page defaults (nodeIntegration off, contextIsolation on) are
    // exactly what we want as-is.
  });

  // External links (target=_blank) and any navigation away from our own
  // loopback origin open in the OS browser instead of inside the app window
  // — including the Google OAuth chain now: decideExternalOpen's
  // DESKTOP_SIGN_IN_PATH carve-out (apps/desktop/desktop-runtime.mjs) routes
  // the desktop sign-in page itself out to the OS browser, where the whole
  // Google/Clerk redirect chain runs and hands the finished session back
  // through src/cli/desktop-auth-route.mjs instead of this webContents.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternalIfAllowed(target, url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    const decision = decideExternalOpen({ target, baseUrl: url, env: process.env });
    if (decision.action === "ignore") return;

    event.preventDefault();
    openExternalIfAllowed(target, url);
  });

  if (load) {
    win.loadURL(`${url}${route}`);
  }
  return win;
}

// Loads the smoke window after its failure listeners are attached, waits for
// navigation to finish, then proves the SPA actually mounted into #root.
// This would have caught both a dead Chromium renderer and a JS bundle that
// loads but throws before React can mount.
function loadAndVerifySmokeWindow(browserWindow, targetUrl, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const wc = browserWindow.webContents;
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error(`renderer did not finish loading within ${timeoutMs}ms`));
    }, timeoutMs);

    function finish() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    async function onFinish() {
      try {
        await waitForClientMount(wc);
        finish();
      } catch (err) {
        fail(err);
      }
    }
    function onFail(_event, errorCode, errorDescription, _validatedUrl, isMainFrame) {
      if (!isMainFrame) return; // sub-frame/subresource failures aren't fatal here
      fail(new Error(`did-fail-load: ${errorDescription} (${errorCode})`));
    }
    function onGone(_event, details) {
      fail(new Error(`render-process-gone: ${details?.reason ?? "unknown"}`));
    }
    function onUnresponsive() {
      fail(new Error("renderer became unresponsive"));
    }
    function onConsoleMessage(event, level, message, line, sourceId) {
      const actualLevel = typeof level === "number" ? level : event?.level;
      if (actualLevel !== 3 && actualLevel !== "error") return;

      const actualMessage = typeof message === "string" ? message : event?.message;
      const actualLine = typeof line === "number" ? line : event?.lineNumber;
      const actualSource = typeof sourceId === "string" ? sourceId : event?.sourceId;
      const firstLine = String(actualMessage || "unknown error").split("\n")[0];
      const hasLine = Number.isFinite(actualLine);
      const location = actualSource
        ? ` (${actualSource}${hasLine ? `:${actualLine}` : ""})`
        : "";
      fail(new Error(`renderer console error: ${firstLine}${location}`));
    }
    function cleanup() {
      clearTimeout(timer);
      wc.removeListener("did-finish-load", onFinish);
      wc.removeListener("did-fail-load", onFail);
      wc.removeListener("render-process-gone", onGone);
      wc.removeListener("console-message", onConsoleMessage);
      wc.removeListener("unresponsive", onUnresponsive);
      browserWindow.removeListener("unresponsive", onUnresponsive);
    }

    wc.once("did-finish-load", onFinish);
    wc.on("did-fail-load", onFail);
    wc.on("render-process-gone", onGone);
    wc.on("console-message", onConsoleMessage);
    wc.on("unresponsive", onUnresponsive);
    browserWindow.on("unresponsive", onUnresponsive);

    browserWindow.loadURL(targetUrl).catch((err) => {
      fail(new Error(`loadURL failed: ${err.message}`));
    });
  });
}

async function waitForClientMount(wc, timeoutMs = 5000, intervalMs = 100) {
  const script = [
    "(() => {",
    "  const root = document.getElementById('root');",
    "  return !!root && root.children.length > 0;",
    "})()",
  ].join("\n");
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      if (await wc.executeJavaScript(script, true)) return;
    } catch (err) {
      lastError = err;
    }

    const waitMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const suffix = lastError ? ` (last check: ${lastError.message})` : "";
  throw new Error(`client app did not mount in #root within ${timeoutMs}ms${suffix}`);
}

app.whenReady().then(async () => {
  // Dev dock icon (macOS). The packaged app gets its icon from the baked
  // .icns (electron-builder mac.icon), but an unpackaged `electron .` run shows
  // the default Electron icon unless we set it here. build/ isn't bundled into
  // the package, so this only ever fires in dev. Guarded so a missing file or a
  // non-macOS platform never throws.
  if (!app.isPackaged && process.platform === "darwin" && app.dock) {
    const iconPath = join(__dirname, "build", "icon.png");
    if (existsSync(iconPath)) {
      const dockIcon = nativeImage.createFromPath(iconPath);
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
    }
  }

  // Rebuild the standard macOS menu so the bold app-menu label follows
  // app.name ("CareerRat") instead of "Electron" in dev; role-based items keep
  // the expected copy/paste/quit/devtools/window behavior.
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]),
    );
  }

  const { url, route } = await boot();

  if (isSmoke) {
    try {
      await verifySmokeHttpSurface({ baseUrl: url, route, getOk: httpGetOk });

      // Health alone already passed before the ELECTRON_RUN_AS_NODE incident
      // too — the server was fine, only the window never painted. Actually
      // create it and require the real load to succeed before declaring OK.
      const smokeWin = createWindow(url, route, { load: false });
      await loadAndVerifySmokeWindow(smokeWin, `${url}${route}`);

      // Prove the exact staged documents/export.mjs path can reach Electron's
      // bundled renderer and produce PDF bytes. This comes after the primary
      // app window mounts: destroying a temporary renderer as Electron's only
      // window would otherwise emit window-all-closed and stop the server.
      const { renderPdf } = await loadEngineModule("src/core/documents/export.mjs");
      const smokePdfPath = join(app.getPath("temp"), `rolester-export-smoke-${process.pid}.pdf`);
      await verifySmokePdfExport({
        outPath: smokePdfPath,
        renderPdf,
        readFile: readFileSync,
        removeFile: (path) => rmSync(path, { force: true }),
      });

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
}).catch((err) => {
  // A boot() failure (e.g. a module missing from the staged engine) used to
  // surface only as an UnhandledPromiseRejectionWarning — no window, no exit,
  // a process that just sat there (--smoke hung forever instead of failing).
  // Fail loudly instead: log, show a dialog in GUI mode, exit nonzero.
  log(`BOOT FAILED: ${err?.stack || err?.message || err}`);
  if (!isSmoke) {
    try {
      dialog.showErrorBox("CareerRat failed to start", String(err?.message || err));
    } catch {
      // dialog unavailable (very early failure) — the log line above stands.
    }
  }
  app.exit(1);
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
