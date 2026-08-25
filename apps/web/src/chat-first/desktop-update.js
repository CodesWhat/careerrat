import { useSyncExternalStore } from "react";

const bridge = globalThis.careerratDesktopUpdate;
const EMPTY_STATE = Object.freeze({
  notify: false,
  enabled: true,
  version: null,
  releaseUrl: null,
  dmgUrl: null,
  lastCheckedAt: null,
  manualResult: null,
  saving: false,
  checking: false,
  error: null,
});

const listeners = new Set();
let state = EMPTY_STATE;
let receivedPush = false;
let userChangedPreference = false;

function setState(next) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return state;
}

function mergeBridgeState(next) {
  if (!next || typeof next !== "object") return;
  const merged = { ...next };
  if (userChangedPreference) delete merged.enabled;
  setState(merged);
}

if (bridge) {
  bridge.onUpdate((next) => {
    receivedPush = true;
    mergeBridgeState(next);
  });
  bridge
    .getState()
    .then((next) => {
      if (!receivedPush) mergeBridgeState(next);
    })
    .catch(() => undefined);
}

function statusCopy(snapshot) {
  if (snapshot.error) return snapshot.error;
  if (snapshot.checking) return "Checking GitHub for the latest release…";
  if (snapshot.manualResult === "failed") return "CareerRat could not reach GitHub. Try again.";
  if (snapshot.manualResult === "current") return "CareerRat is up to date.";
  if ((snapshot.notify || snapshot.manualResult === "available") && snapshot.version) {
    return snapshot.releaseUrl
      ? `CareerRat ${snapshot.version} is ready.`
      : `CareerRat ${snapshot.version} is available, but its release link is unavailable. Check again.`;
  }
  return null;
}

async function setEnabled(enabled) {
  if (!bridge) return;
  const previous = state.enabled;
  userChangedPreference = true;
  setState({ enabled: Boolean(enabled), saving: true, error: null });
  try {
    const next = await bridge.setEnabled(Boolean(enabled));
    if (next && typeof next === "object") setState(next);
  } catch {
    setState({ enabled: previous, error: "Could not save that update setting." });
  } finally {
    userChangedPreference = false;
    setState({ saving: false });
  }
}

async function checkNow() {
  if (!bridge) return;
  setState({ checking: true, error: null, manualResult: null });
  try {
    const next = await bridge.checkNow();
    mergeBridgeState(next);
  } catch {
    setState({ manualResult: "failed" });
  } finally {
    setState({ checking: false });
  }
}

async function dismissNotice() {
  const version = state.version;
  const shouldSkip = state.notify && version;
  setState({ notify: false, manualResult: null });
  if (!bridge || !shouldSkip) return;
  try {
    const next = await bridge.skipVersion(version);
    mergeBridgeState(next);
  } catch {
    // The notice is already dismissed for this session. A failed persistence
    // can only make it reappear after relaunch.
  }
}

async function openRelease() {
  if (!bridge) return;
  try {
    await bridge.openRelease();
  } catch {
    setState({ error: "CareerRat could not open the release page." });
  }
}

export function useDesktopUpdate() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const status = statusCopy(snapshot);
  const availableNotice =
    snapshot.version && (snapshot.notify || snapshot.manualResult === "available");
  const manualNotice = ["current", "failed"].includes(snapshot.manualResult);
  return {
    available: Boolean(bridge),
    enabled: snapshot.enabled,
    saving: snapshot.saving,
    checking: snapshot.checking,
    status,
    setEnabled,
    checkNow,
    notice: {
      visible: Boolean(bridge) && Boolean(availableNotice || manualNotice),
      kind: availableNotice ? "available" : snapshot.manualResult || "current",
      version: snapshot.version,
      canOpenRelease: Boolean(snapshot.releaseUrl),
      message: status,
      onOpenRelease: openRelease,
      onDismiss: dismissNotice,
    },
  };
}
