import { useSyncExternalStore } from "react";

const bridge = globalThis.careerratDesktopUpdate;
const EMPTY_STATE = Object.freeze({
  supported: false,
  enabled: true,
  phase: "idle",
  version: null,
  progress: null,
  errorKind: null,
  message: null,
  manual: false,
  notify: false,
  saving: false,
  downloadUrl: null,
});

const listeners = new Set();
let state = EMPTY_STATE;
let receivedPush = false;
let userChangedPreference = false;
let installing = false;
let dismissedDownloadVersion = null;

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
    // Once the install has been accepted the renderer's install phase is
    // terminal: a stale external push (the main process is tearing itself
    // down) must not revive the Restart and install button.
    if (installing && next && typeof next === "object") {
      const { phase, ...rest } = next;
      mergeBridgeState(rest);
      return;
    }
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
  if (snapshot.phase === "unsupported") return snapshot.message;
  if (snapshot.phase === "checking") return "Checking for a CareerRat update…";
  if (snapshot.phase === "downloading") {
    const version = snapshot.version ? ` ${snapshot.version}` : "";
    const progress = Number.isFinite(snapshot.progress) ? ` ${snapshot.progress}%` : "";
    return `Downloading CareerRat${version}…${progress}`;
  }
  if (snapshot.phase === "ready") {
    return snapshot.version
      ? `CareerRat ${snapshot.version} is downloaded and ready to install.`
      : "A CareerRat update is downloaded and ready to install.";
  }
  if (snapshot.phase === "current") return "CareerRat is up to date.";
  if (snapshot.phase === "installing") return snapshot.message || "Restarting to install…";
  if (snapshot.phase === "error") {
    return (
      snapshot.message ||
      "CareerRat couldn't finish the update. Try again. Your current version still works."
    );
  }
  return null;
}

async function setEnabled(enabled) {
  if (!bridge) return;
  const previous = state.enabled;
  userChangedPreference = true;
  setState({ enabled: Boolean(enabled), saving: true });
  try {
    const next = await bridge.setEnabled(Boolean(enabled));
    if (next && typeof next === "object") setState(next);
  } catch {
    setState({
      enabled: previous,
      phase: "error",
      message: "CareerRat couldn't save that update setting. Try again.",
    });
  } finally {
    userChangedPreference = false;
    setState({ saving: false });
  }
}

async function checkNow() {
  if (!bridge || state.supported === false) return;
  setState({ phase: "checking", manual: true, message: null, errorKind: null });
  try {
    mergeBridgeState(await bridge.checkNow());
  } catch {
    setState({
      phase: "error",
      manual: true,
      errorKind: "network",
      message: "CareerRat couldn't check for an update. Check your connection and try again.",
    });
  }
}

async function dismissNotice() {
  if (state.phase === "unsupported") {
    setState({ manual: false });
    return;
  }
  const version = state.version;
  const shouldSkip = state.phase === "ready" && version;
  if (state.phase === "downloading" && version) dismissedDownloadVersion = version;
  setState({ phase: "idle", notify: false, manual: false, message: null });
  if (!bridge || !shouldSkip) return;
  try {
    await bridge.skipVersion(version);
  } catch {
    // The downloaded update remains cached. Only this dismissal may not
    // survive a relaunch if the preference write failed.
  }
}

async function restartAndInstall() {
  if (!bridge || state.phase !== "ready") return;
  try {
    const result = await bridge.restartAndInstall();
    if (result?.accepted === false) {
      setState({
        phase: "error",
        message: "That update isn't ready to install yet. Check for updates again.",
      });
    } else if (result?.accepted === true) {
      installing = true;
      setState({ phase: "installing", message: "Restarting to install…" });
    }
  } catch {
    setState({
      phase: "error",
      message:
        "CareerRat couldn't restart for the update. Try again. Your current version still works.",
    });
  }
}

export function useDesktopUpdate() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const status = statusCopy(snapshot);
  const visible =
    snapshot.phase === "unsupported"
      ? Boolean(snapshot.manual && snapshot.downloadUrl)
      : snapshot.phase === "ready"
        ? snapshot.notify || snapshot.manual
        : snapshot.phase === "downloading"
          ? snapshot.version === dismissedDownloadVersion
            ? false
            : Boolean(snapshot.version) || snapshot.manual
          : snapshot.phase === "error"
            ? Boolean(snapshot.version) || snapshot.manual
            : snapshot.phase === "current"
              ? snapshot.manual
              : snapshot.phase === "installing"
                ? true
                : snapshot.phase === "checking" && snapshot.manual;
  const primaryLabel =
    snapshot.phase === "unsupported" && snapshot.downloadUrl
      ? "Windows release status"
      : snapshot.phase === "ready"
        ? "Restart and install"
        : snapshot.phase === "error"
          ? "Try again"
          : null;

  return {
    available: Boolean(bridge),
    supported: snapshot.supported,
    enabled: snapshot.enabled,
    saving: snapshot.saving,
    checking: snapshot.phase === "checking",
    status,
    downloadUrl: snapshot.downloadUrl,
    setEnabled,
    checkNow,
    notice: {
      visible: Boolean(bridge) && Boolean(visible),
      kind: snapshot.phase,
      version: snapshot.version,
      progress: snapshot.progress,
      message: status,
      primaryLabel,
      primaryHref: snapshot.phase === "unsupported" ? snapshot.downloadUrl : null,
      onPrimary:
        snapshot.phase === "ready"
          ? restartAndInstall
          : snapshot.phase === "unsupported" || snapshot.phase === "installing"
            ? undefined
            : checkNow,
      onDismiss: dismissNotice,
    },
  };
}
