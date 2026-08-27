// apps/desktop/preload/update-check-preload.cjs: isolated bridges between the
// Electron main process and the renderer for desktop-only update state and
// native-menu navigation.
// CommonJS on purpose (a `.cjs` extension forces CJS regardless of this
// package's "type": "module"). Electron preload scripts run in an isolated
// world alongside contextIsolation, and CJS + require("electron") is the one
// loading style that's unconditionally supported there.
//
// This is deliberately the only way the renderer learns about an available
// update. No shared HTTP route was added to the embedded engine server for
// this, so the plain browser dev app (`npm run tracker:dev`, no Electron)
// never sees `window.careerratDesktopUpdate` at all and never shows the
// notice. The npm CLI's own update-notifier (src/core/update/update-core.mjs)
// is untouched by any of this.
const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL_GET_STATE = "careerrat:update-check:get-state";
const CHANNEL_SKIP_VERSION = "careerrat:update-check:skip-version";
const CHANNEL_SET_ENABLED = "careerrat:update-check:set-enabled";
const CHANNEL_CHECK_NOW = "careerrat:update-check:check-now";
const CHANNEL_RESTART_AND_INSTALL = "careerrat:update-check:restart-and-install";
const EVENT_RESULT = "careerrat:update-check:result";
const EVENT_NAVIGATE = "careerrat:desktop:navigate";

contextBridge.exposeInMainWorld("careerratDesktopUpdate", {
  // Resolves typed updater state. Native errors and release internals never
  // cross into the renderer.
  getState: () => ipcRenderer.invoke(CHANNEL_GET_STATE),

  // Persists "don't notify me about this version again". main.mjs writes it
  // to disk under CAREERRAT_HOME so the dismissal survives a relaunch.
  skipVersion: (version) => ipcRenderer.invoke(CHANNEL_SKIP_VERSION, version),

  // The Settings toggle. Disabling stops all future network checks; it does
  // not clear an already-resolved notice from the current session's memory,
  // only the next scheduled check is skipped.
  setEnabled: (enabled) => ipcRenderer.invoke(CHANNEL_SET_ENABLED, enabled),

  // Runs one user-requested check immediately. This bypasses the automatic
  // cadence and opt-out for this call only; it never changes the saved
  // automatic-check preference.
  checkNow: () => ipcRenderer.invoke(CHANNEL_CHECK_NOW),

  // Requests the explicit post-download restart. The main process finishes
  // CareerRat's service shutdown before handing off to the native updater.
  restartAndInstall: () => ipcRenderer.invoke(CHANNEL_RESTART_AND_INSTALL),

  // Subscribes to pushed updates (main.mjs sends one after every completed
  // check). Returns an unsubscribe function.
  onUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(EVENT_RESULT, listener);
    return () => ipcRenderer.removeListener(EVENT_RESULT, listener);
  },
});

contextBridge.exposeInMainWorld("careerratDesktopApp", {
  onNavigate: (callback) => {
    const listener = (_event, route) => callback(route);
    ipcRenderer.on(EVENT_NAVIGATE, listener);
    return () => ipcRenderer.removeListener(EVENT_NAVIGATE, listener);
  },
});
