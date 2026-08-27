// apps/desktop/main.mjs — thin Electron shell over the existing CareerRat
// local server (M5 of the paid-POC journey). This process NEVER forks a
// skill itself; it boots the same createDevServer() the browser-only
// `careerrat tracker-dev` uses (see src/cli/tracker-dev.mjs) and wraps it in a
// native window. Packaged AI work runs through the user's selected installed
// CLI. The proprietary Agent SDK is not shipped in the app bundle.
//
// Two run modes:
//   dev  (`npm run desktop` from repo root) — unpackaged window over the live
//        checkout; shares data with `npm run tracker:dev`.
//   dist (`npm run desktop:dist`) — signed .dmg via electron-builder, running
//        against a staged copy of the engine (see scripts/stage.mjs) with its
//        own per-user data root.
//
// `--smoke`: boot the server, GET /api/health from inside this process,
// then actually create the window and require its real route to finish
// loading (see waitForLoad below — health-only isn't enough, see the trap-1
// comment), render a PDF, and launch the configured browser adapter — print
// "SMOKE OK <url>" and exit 0 (no interaction) once all checks pass. The
// scripted verification path for `npx electron . --smoke`.

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
} from "electron";
import electronUpdater from "electron-updater";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileAtomic } from "./atomic-write.mjs";
import { shutdownDesktopRuntime } from "./desktop-lifecycle.mjs";
import {
  chooseDesktopRoute,
  normalizeDesktopRoute,
  rendererRouteFromDesktopRoute,
} from "./desktop-routing.mjs";
import { configureCareerRatAppIdentity } from "./desktop-identity.mjs";
import { buildCareerRatMenuTemplate, runMenuUpdateCheck } from "./menu-template.mjs";
import {
  beginNativeUpdateAcceptance,
  completeNativeUpdateAcceptance,
  NATIVE_UPDATE_ACCEPTANCE_ARG,
  resolveNativeUpdateAcceptance,
} from "./native-update-acceptance.mjs";
import {
  choosePreferredPort,
  decideExternalOpen,
  resolveDesktopRuntimePaths,
  resolveDesktopSmokeEngineRoot,
  startDesktopPdfRenderer,
} from "./desktop-runtime.mjs";
import {
  verifySmokeBrowserAutomation,
  verifySmokeHttpSurface,
  verifySmokePdfExport,
} from "./desktop-smoke.mjs";
import {
  CHECK_INTERVAL_MS as UPDATE_CHECK_INTERVAL_MS,
  createDesktopUpdateController,
  DEFAULT_STATE as DEFAULT_UPDATE_STATE,
  nextUpdateCheckDelay,
} from "./update-check.mjs";
import { buildBrowserWindowOptions } from "./window-options.mjs";

// --- Trap 1 -----------------------------------------------------------------
// Inside Electron, `process.execPath` is the Electron binary, not a plain
// `node`. The Agent SDK's CLI child spawn would try to launch a new Electron
// GUI instance instead of running headless. FIXED AT THE SOURCE, not here:
// setting
// `process.env.ELECTRON_RUN_AS_NODE = "1"` globally in this main process was
// tried first and was wrong — Chromium's OWN helper processes (GPU, network,
// renderer, utility) inherit process.env too, so they ALSO booted as plain
// node instead of Chromium helpers and rejected every one of their own
// `--type=…` flags ("bad option: --type=gpu-process" etc.), which silently
// killed rendering (a real window never painted) while still letting
// `--smoke` pass (it renders nothing, so nothing exposed the breakage). The
// env var is now set per-spawn by
// src/core/ai/skill-runtime.mjs's buildChildEnv() — never on this process's
// own env, which Chromium's helpers inherit from.
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const isSmoke = process.argv.includes("--smoke");
const nativeUpdateAcceptanceRequested = process.argv.some((arg) =>
  String(arg).startsWith(NATIVE_UPDATE_ACCEPTANCE_ARG)
);
const { autoUpdater } = electronUpdater;

// The dev launcher brands Electron.app's Info.plist so macOS owns the right
// Dock/Cmd-Tab identity. Runtime configuration aligns menus, About, window
// metadata, and the Windows taskbar/notification identity before app readiness.
configureCareerRatAppIdentity({ app, platform: process.platform });

let nativeUpdateAcceptance = null;
let nativeUpdateAcceptanceError = null;
try {
  nativeUpdateAcceptance = resolveNativeUpdateAcceptance({
    argv: process.argv,
    isPackaged: app.isPackaged,
    platform: process.platform,
    currentVersion: app.getVersion(),
    userDataDir: app.getPath("userData"),
  });
} catch (error) {
  nativeUpdateAcceptanceError = error;
}

// Google's OAuth consent screen rejects UAs it doesn't recognize with
// disallowed_useragent. Electron's default fallback UA tacks our own
// " CareerRat/<version> Electron/<version>" tokens on after the Chrome/Safari
// tokens Google's allowlist actually checks — strip just those two tokens so
// the request reads as a plain Chromium browser. Must run before any
// BrowserWindow is created; the UA is fixed at window construction.
app.userAgentFallback = app.userAgentFallback.replace(/\s(CareerRat|Electron)\/[\d.]+/g, "");

// --- Trap 3 -------------------------------------------------------------
// Data root. A packaged app's Resources/ tree is read-only (code-signed) —
// point CAREERRAT_HOME at Electron's per-user data dir instead, and do it
// BEFORE importing any careerrat module: resolveUserPaths() reads
// process.env.CAREERRAT_HOME the moment it's called (src/core/paths/
// workspace.mjs), so this must land before boot()'s dynamic imports below.
// Dev keeps the in-checkout layout so it shares data with `npm run tracker:dev`.
const runtimePaths = resolveDesktopRuntimePaths({
  isPackaged: app.isPackaged,
  appDir: __dirname,
  userDataPath: app.isPackaged ? app.getPath("userData") : undefined,
  resourcesPath: process.resourcesPath,
  careerratHomeOverride:
    nativeUpdateAcceptance?.homeDir ||
    (app.isPackaged && isSmoke ? process.env.CAREERRAT_HOME : undefined),
});
if (runtimePaths.careerratHome) {
  process.env.CAREERRAT_HOME = runtimePaths.careerratHome;
}
if (runtimePaths.isPackaged || isSmoke) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
}
if (runtimePaths.isPackaged) {
  process.env.CAREERRAT_PACKAGED_DESKTOP = "1";
  process.env.CAREERRAT_DESKTOP_CLI_ONLY = "1";
}
let repoRoot = runtimePaths.repoRoot;
const smokeEngineRoot = resolveDesktopSmokeEngineRoot({
  isPackaged: runtimePaths.isPackaged,
  repoRoot,
  desktopDir: __dirname,
});

// --- Trap 4 -------------------------------------------------------------
// One helper resolves both the dev and packaged import path. In dev,
// repoRoot already points at the live checkout, so `repoRoot/src/cli/
// tracker-dev.mjs` is the same file a static `../../src/cli/tracker-dev.mjs`
// import would resolve to. In a packaged app, repoRoot points at the staged
// `resources/careerrat` copy instead. Either way, a dynamic import off the
// already-resolved repoRoot is correct — no dev/packaged branch needed here.
function loadEngineModule(relPath) {
  return import(pathToFileURL(join(repoRoot, relPath)).href);
}

function loadSmokeEngineModule(relPath) {
  return import(pathToFileURL(join(smokeEngineRoot, relPath)).href);
}

function log(msg) {
  process.stdout.write(`[desktop] ${msg}\n`);
}

// Binds `server` to `port` on loopback and resolves with the port actually
// bound (relevant when `port` is 0, i.e. "pick any free ephemeral port").
// Rejects with the raw listen error (e.g. EADDRINUSE) instead of swallowing
// it — the caller decides whether a retry is warranted.
function listenOnPort(runtime, port) {
  return runtime.listen({ port, host: "127.0.0.1" });
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
let installUpdateAfterShutdown = false;

// Desktop update state. The native updater lives in the main process; the
// renderer only receives typed progress and actions through the preload.
let updateStateDir = null;
let updateState = { ...DEFAULT_UPDATE_STATE };
let updateController = null;
let updateCheckTimer = null;
let desktopBaseUrl = null;
let desktopRoute = "/";

// Smoke creates and verifies a real app window, but none of its acceptance
// checks require hardware acceleration. Skipping GPU process bring-up entirely
// (as opposed to just passing a `--disable-gpu` Chromium flag, which still
// spins the process up before deciding not to use it) keeps the scripted path
// robust on machines where third-party endpoint-security software intercepts
// helper-process exec() and breaks Chromium's GPU process bootstrap. Must be
// called before app.whenReady().
if (isSmoke) {
  app.disableHardwareAcceleration();
}

async function boot() {
  // Desktop flag the engine reads to enable installed-runtime AI routing
  // (see src/core/ai/call-ai.mjs's resolveAIRoute()). Set before
  // createDevServer() — same placement style as the CAREERRAT_HOME injection
  // above, which also must land before any engine module reads process.env.
  process.env.CAREERRAT_DESKTOP_SHELL = "1";

  // ISSUE-028: PDF export uses Electron's already-bundled Chromium rather
  // than the separate Playwright Chromium staged for supervised browser
  // automation. Start that token-authenticated, loopback-only PDF bridge
  // before the engine mounts packet/export routes. No renderer credential is
  // written to disk or logged.
  pdfRenderer = await startDesktopPdfRenderer({ BrowserWindow });
  process.env.CAREERRAT_DESKTOP_PDF_RENDER_URL = pdfRenderer.url;
  process.env.CAREERRAT_DESKTOP_PDF_RENDER_TOKEN = pdfRenderer.token;

  const { createDevServer } = await loadEngineModule("src/cli/tracker-dev.mjs");
  dev = createDevServer({ repoRoot });

  dev.startWatching();

  // Packaged mode listens on a stable, configurable port instead of an
  // ephemeral one: any future session state is keyed by origin (host+port),
  // so a port that changes on every relaunch would silently sign the
  // candidate back out each time they reopen the app. Dev/smoke keep the
  // ephemeral port (0) unchanged. If the preferred port is already taken,
  // fall back to an ephemeral one rather than failing to boot.
  const preferredPort = choosePreferredPort({ isPackaged: app.isPackaged, env: process.env });
  let port;
  try {
    port = await listenOnPort(dev, preferredPort);
  } catch (err) {
    if (err?.code === "EADDRINUSE" && preferredPort !== 0) {
      log(`port ${preferredPort} in use, retrying with an ephemeral port: ${err.message}`);
      port = await listenOnPort(dev, 0);
    } else {
      throw err;
    }
  }

  const url = `http://127.0.0.1:${port}`;
  log(`serving ${url}`);

  // First-run and returning candidates share the same chat-first route. The
  // React app reads canonical setup state and renders first-run in that shell.
  const route = chooseDesktopRoute({
    routeOverride: process.env.CAREERRAT_DESKTOP_ROUTE,
  });

  return { url, route };
}

async function shutdown() {
  const active = dev;
  dev = null;
  if (active) await shutdownDesktopRuntime(active);

  const activePdfRenderer = pdfRenderer;
  pdfRenderer = null;
  delete process.env.CAREERRAT_DESKTOP_PDF_RENDER_URL;
  delete process.env.CAREERRAT_DESKTOP_PDF_RENDER_TOKEN;
  if (activePdfRenderer) await activePdfRenderer.close();

  if (updateCheckTimer) {
    clearTimeout(updateCheckTimer);
    updateCheckTimer = null;
  }
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

// --- Desktop updates --------------------------------------------------------
// Packaged macOS builds use electron-updater for one first-class path: check,
// download, then restart and install. The renderer never fetches a release or
// sees a native exception. Windows stays disabled until its installed binary
// and final installer share a complete signed update feed.
const UPDATE_CHECK_PRELOAD_PATH = join(__dirname, "preload", "update-check-preload.cjs");
const UPDATE_STATE_FILE = "desktop-update-check.json";
// Let boot settle (server up, window painted) before the first network call.
const UPDATE_CHECK_INITIAL_DELAY_MS = 5000;
const UPDATE_IPC = Object.freeze({
  getState: "careerrat:update-check:get-state",
  skipVersion: "careerrat:update-check:skip-version",
  setEnabled: "careerrat:update-check:set-enabled",
  checkNow: "careerrat:update-check:check-now",
  restartAndInstall: "careerrat:update-check:restart-and-install",
  result: "careerrat:update-check:result",
});
const DESKTOP_IPC = Object.freeze({
  navigate: "careerrat:desktop:navigate",
});

function updateStateFilePath() {
  return join(updateStateDir, UPDATE_STATE_FILE);
}

// DEFAULT_UPDATE_STATE.enabled is true, so a missing or unreadable state
// file reads as "checks on". persistUpdateState() below writes atomically
// specifically so this file only ever ends up missing/corrupt from something
// outside this app's own write path (disk full mid-rename, the data root
// deleted out from under it, etc.), never from this app's own write being
// interrupted. That residual case still opts the user back in; there is no
// state to recover an explicit "off" from once the file itself is gone.
function loadUpdateState() {
  try {
    const raw = JSON.parse(readFileSync(updateStateFilePath(), "utf8"));
    return { ...DEFAULT_UPDATE_STATE, ...raw };
  } catch {
    return { ...DEFAULT_UPDATE_STATE };
  }
}

// Best-effort: a write failure here (e.g. a read-only data root) must never
// crash the app or surface to the user. Worst case, the next launch simply
// re-checks sooner than the 24h interval intends. Uses writeFileAtomic
// (temp file + rename) rather than a direct writeFileSync, which truncates
// the target before writing: a process death mid-write would otherwise leave
// a corrupt or empty file, and loadUpdateState()'s catch above falls back to
// DEFAULT_UPDATE_STATE (enabled: true), silently opting a user back into
// checks after they had turned them off.
function persistUpdateState(state) {
  try {
    writeFileAtomic(updateStateFilePath(), `${JSON.stringify(state)}\n`);
  } catch (err) {
    log(`update-check state write failed: ${err.message}`);
  }
}

function currentUpdateNoticePayload() {
  return (
    updateController?.getState() || {
      supported: false,
      enabled: updateState.enabled,
      lastCheckedAt: updateState.lastCheckedAt,
      phase: "idle",
      version: null,
      progress: null,
      errorKind: null,
      message: null,
      manual: false,
      notify: false,
    }
  );
}

function pushUpdateNoticeToRenderer(payload = currentUpdateNoticePayload()) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(UPDATE_IPC.result, payload);
  }
}

// Registers the IPC handlers preload/update-check-preload.cjs calls into and
// primes in-memory state from disk. Deliberately separate from
// scheduling: the renderer calls getState() as soon as its bundle
// evaluates, including under `--smoke`, which never schedules anything. When
// these two lived in one function, a passing smoke run still logged "No
// handler registered for careerrat:update-check:get-state" twice, and a green
// run that prints errors is how people learn to stop reading them. Runs
// exactly once, not per-window.
function registerUpdateCheckHandlers() {
  updateStateDir = runtimePaths.careerratHome || app.getPath("userData");
  updateState = loadUpdateState();
  updateController = createDesktopUpdateController({
    updater: autoUpdater,
    platform: process.platform,
    selfUpdateSupported: app.isPackaged && process.platform === "darwin" && !isSmoke,
    currentVersion: app.getVersion(),
    persisted: updateState,
    persist(next) {
      updateState = next;
      persistUpdateState(next);
    },
    push: pushUpdateNoticeToRenderer,
    log,
  });

  ipcMain.handle(UPDATE_IPC.getState, () => currentUpdateNoticePayload());

  ipcMain.handle(UPDATE_IPC.skipVersion, (_event, version) => {
    return updateController.skipVersion(typeof version === "string" ? version : null);
  });

  ipcMain.handle(UPDATE_IPC.setEnabled, (_event, enabled) => {
    const payload = updateController.setEnabled(Boolean(enabled));
    scheduleNextUpdateCheck();
    return payload;
  });

  ipcMain.handle(UPDATE_IPC.checkNow, () => runManualUpdateCheck());

  ipcMain.handle(UPDATE_IPC.restartAndInstall, () => {
    if (updateController.getState().phase !== "ready") return { accepted: false };
    installUpdateAfterShutdown = true;
    app.quit();
    return { accepted: true };
  });
}

function openDesktopRoute(route) {
  if (!desktopBaseUrl) return;
  const nextRoute = normalizeDesktopRoute(route || desktopRoute) || desktopRoute;
  if (!win || win.isDestroyed()) {
    return createWindow(desktopBaseUrl, nextRoute);
  }
  win.webContents.send(DESKTOP_IPC.navigate, rendererRouteFromDesktopRoute(nextRoute));
  win.show();
  win.focus();
  return win;
}

function waitForRendererReady(browserWindow, timeoutMs = 20000) {
  if (!browserWindow?.webContents?.isLoadingMainFrame?.()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const wc = browserWindow.webContents;
    const timer = setTimeout(() => finish(new Error("app window did not finish loading")), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      wc.removeListener("did-finish-load", onLoad);
      wc.removeListener("did-fail-load", onFailure);
    }
    function finish(error) {
      cleanup();
      if (error) reject(error);
      else resolve();
    }
    function onLoad() {
      finish();
    }
    function onFailure(_event, code, description, _url, isMainFrame) {
      if (isMainFrame === false) return;
      finish(new Error(`app window failed to load: ${description} (${code})`));
    }
    wc.once("did-finish-load", onLoad);
    wc.on("did-fail-load", onFailure);
  });
}

async function ensureDesktopWindow() {
  const browserWindow = !win || win.isDestroyed() ? openDesktopRoute(desktopRoute) : win;
  await waitForRendererReady(browserWindow);
  browserWindow?.show();
  browserWindow?.focus();
  return browserWindow;
}

function installApplicationMenu() {
  const open = (target) => openExternalIfAllowed(target, null);
  const template = buildCareerRatMenuTemplate({
    appName: app.name,
    platform: process.platform,
    isDevelopment: !app.isPackaged,
    actions: {
      openSettings: () => openDesktopRoute("/settings"),
      checkForUpdates: () => {
        runMenuUpdateCheck({
          ensureWindow: ensureDesktopWindow,
          checkNow: runManualUpdateCheck,
        }).catch((err) => {
          log(`manual update check failed: ${err.message}`);
        });
      },
      openWebsite: () => open("https://careerrat.com"),
      openDocumentation: () => open("https://github.com/CodesWhat/careerrat#readme"),
      reportIssue: () => open("https://github.com/CodesWhat/careerrat/issues/new/choose"),
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function scheduleNextUpdateCheck() {
  if (updateCheckTimer) clearTimeout(updateCheckTimer);
  updateCheckTimer = null;
  if (!updateController?.getState().supported) return;
  const delay = nextUpdateCheckDelay({
    enabled: updateState.enabled,
    lastCheckedAt: updateState.lastCheckedAt,
    initialDelayMs: UPDATE_CHECK_INITIAL_DELAY_MS,
    intervalMs: UPDATE_CHECK_INTERVAL_MS,
  });
  if (delay === null) return;
  updateCheckTimer = setTimeout(async () => {
    updateCheckTimer = null;
    try {
      await updateController.checkNow();
    } catch (err) {
      log(`update check failed: ${err.message}`);
    } finally {
      scheduleNextUpdateCheck();
    }
  }, delay);
  updateCheckTimer.unref?.();
}

async function runManualUpdateCheck() {
  try {
    return await updateController.checkNow({ manual: true });
  } finally {
    scheduleNextUpdateCheck();
  }
}

function createWindow(url, route, { load = true } = {}) {
  const windowOptions = buildBrowserWindowOptions();
  win = new BrowserWindow({
    ...windowOptions,
    webPreferences: {
      // Spread whatever window-options.mjs set first. It defines no
      // webPreferences today, so this merge changes nothing right now. It is
      // here because the alternative silently discards them: the day someone
      // adds contextIsolation or sandbox over there, a plain replace would
      // drop it with nothing at either site to say so.
      ...windowOptions.webPreferences,
      // The only preload in this app. It exposes desktop update state and
      // native-menu navigation without granting the renderer Node access.
      // Everything else about the UI is served over loopback HTTP, so Electron's
      // secure remote-page defaults (nodeIntegration off, contextIsolation on,
      // sandbox on) are otherwise exactly what we want as-is.
      preload: UPDATE_CHECK_PRELOAD_PATH,
    },
  });

  // External links (target=_blank) and any navigation away from our own
  // loopback origin open in the OS browser instead of inside the app window
  // (see decideExternalOpen in apps/desktop/desktop-runtime.mjs).
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
  if (nativeUpdateAcceptanceError) throw nativeUpdateAcceptanceError;

  if (nativeUpdateAcceptance?.mode === "complete") {
    const result = completeNativeUpdateAcceptance({
      acceptance: nativeUpdateAcceptance,
      currentVersion: app.getVersion(),
    });
    log(
      `NATIVE UPDATE ACCEPTANCE ${result.ok ? "OK" : "FAILED"} ${result.fromVersion} -> ${result.observedVersion}`
    );
    app.exit(result.ok ? 0 : 1);
    return;
  }

  if (nativeUpdateAcceptance?.mode === "start") {
    await beginNativeUpdateAcceptance({
      acceptance: nativeUpdateAcceptance,
      updater: autoUpdater,
      createController: createDesktopUpdateController,
      requestInstall(controller) {
        updateController = controller;
        installUpdateAfterShutdown = true;
        app.quit();
        return true;
      },
    });
    return;
  }

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

  const { url, route } = await boot();
  desktopBaseUrl = url;
  desktopRoute = route;

  // Before any window exists, including the smoke window: the renderer asks
  // for update state as soon as its bundle evaluates.
  registerUpdateCheckHandlers();
  installApplicationMenu();

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
      const smokePdfPath = join(app.getPath("temp"), `careerrat-export-smoke-${process.pid}.pdf`);
      await verifySmokePdfExport({
        outPath: smokePdfPath,
        renderPdf,
        readFile: readFileSync,
        removeFile: (path) => rmSync(path, { force: true }),
      });

      // Exercise the packaged engine's real browser adapter and its hermetic
      // Chromium, then remove the throwaway persistent profile on both success
      // and failure.
      const { createPlaywrightOps } = await loadSmokeEngineModule(
        "src/core/apply/playwright-ops.mjs"
      );
      const smokeBrowserProfile = mkdtempSync(
        join(app.getPath("temp"), "careerrat-browser-smoke-")
      );
      await verifySmokeBrowserAutomation({
        profileDir: smokeBrowserProfile,
        createOps: createPlaywrightOps,
        removeDir: (path) => rmSync(path, { recursive: true, force: true }),
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
  scheduleNextUpdateCheck();

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
  if (!isSmoke && !nativeUpdateAcceptance && !nativeUpdateAcceptanceRequested) {
    try {
      dialog.showErrorBox(
        "CareerRat couldn't start",
        "Quit and reopen CareerRat. If it still won't open, reinstall the latest version."
      );
    } catch {
      // dialog unavailable (very early failure) — the log line above stands.
    }
  }
  app.exit(1);
});

// macOS convention: closing the last window backgrounds the app (it stays
// live in the dock) instead of quitting — the `activate` handler above
// re-creates the window from the dock icon. Every other platform has no
// such convention, so window-all-closed there really does mean quit. Either
// way the actual teardown (stopWatching/closeClients/chatRuntime.shutdown)
// only ever runs from the before-quit handler below, which fires on a real
// quit trigger (Cmd+Q, Dock > Quit, app.quit()) independent of this handler
// — staying alive here changes nothing about that cleanup path.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Shutdown: every real quit trigger (Cmd+Q, Dock > Quit, non-darwin
// window-all-closed's app.quit() above) funnels through this one before-quit
// handler so app-owned searches and intake work settle before browser and
// server teardown. Closing the last window on
// darwin does NOT reach here (see window-all-closed above); the app and its
// server stay alive in the dock until an actual quit.
app.on("before-quit", (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  shutdown().then(
    () => {
      if (!installUpdateAfterShutdown) {
        app.exit(0);
        return;
      }
      try {
        if (!updateController?.install()) app.exit(1);
      } catch (error) {
        log(`update install failed: ${error?.message || error}`);
        app.exit(1);
      }
    },
    (error) => {
      log(`shutdown failed: ${error?.message || error}`);
      app.exit(1);
    }
  );
});
