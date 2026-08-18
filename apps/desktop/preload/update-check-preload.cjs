// apps/desktop/preload/update-check-preload.cjs: the ONLY bridge between the
// Electron main process and the renderer for the update-check feature.
// CommonJS on purpose (a `.cjs` extension forces CJS regardless of this
// package's "type": "module"). Electron preload scripts run in an isolated
// world alongside contextIsolation, and CJS + require("electron") is the one
// loading style that's unconditionally supported there.
//
// This is deliberately the ONLY way the renderer learns about an available
// update: no shared HTTP route was added to the embedded engine server for
// this, so the plain browser dev app (`npm run tracker:dev`, no Electron)
// never sees `window.careerratDesktopUpdate` at all and never shows the
// notice. The npm CLI's own update-notifier (src/core/update/update-core.mjs)
// is untouched by any of this.
const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL_GET_STATE = "careerrat:update-check:get-state";
const CHANNEL_SKIP_VERSION = "careerrat:update-check:skip-version";
const CHANNEL_SET_ENABLED = "careerrat:update-check:set-enabled";
const CHANNEL_OPEN_RELEASE = "careerrat:update-check:open-release";
const EVENT_RESULT = "careerrat:update-check:result";

contextBridge.exposeInMainWorld("careerratDesktopUpdate", {
  // Resolves the current notice payload: { notify, enabled, version,
  // releaseUrl, dmgUrl }. Safe to call any time: main.mjs answers from its
  // in-memory state even before the first scheduled check has run.
  getState: () => ipcRenderer.invoke(CHANNEL_GET_STATE),

  // Persists "don't notify me about this version again". main.mjs writes it
  // to disk under CAREERRAT_HOME so the dismissal survives a relaunch.
  skipVersion: (version) => ipcRenderer.invoke(CHANNEL_SKIP_VERSION, version),

  // The Settings toggle. Disabling stops all future network checks; it does
  // not clear an already-resolved notice from the current session's memory,
  // only the next scheduled check is skipped.
  setEnabled: (enabled) => ipcRenderer.invoke(CHANNEL_SET_ENABLED, enabled),

  // Opens the GitHub release page in the OS browser via main.mjs's existing
  // openExternalIfAllowed, no second "open a URL" path.
  openRelease: () => ipcRenderer.invoke(CHANNEL_OPEN_RELEASE),

  // Subscribes to pushed updates (main.mjs sends one after every completed
  // check). Returns an unsubscribe function.
  onUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(EVENT_RESULT, listener);
    return () => ipcRenderer.removeListener(EVENT_RESULT, listener);
  },
});
