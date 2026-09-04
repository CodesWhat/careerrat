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

function acceptsInstallAuthority(next) {
  // The "installing" phase is authoritative and terminal from any source
  // (a push, or a direct setEnabled/checkNow/restartAndInstall response):
  // only a genuine failure may leave it, so a stale ready/checking/
  // downloading response can't revive the Restart and install button
  // mid-install.
  if (state.phase === "installing" && next.phase !== "installing" && next.phase !== "error") {
    return false;
  }
  // Applying any other phase (including a genuine failure) releases the
  // local latch so the user can retry.
  if (next.phase && next.phase !== "installing") installing = false;
  return true;
}

function mergeBridgeState(next) {
  if (!next || typeof next !== "object") return;
  if (!acceptsInstallAuthority(next)) return;
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
  // An accepted install is authoritative: the toggle is inert while it's in
  // flight rather than racing the bridge with a stale request.
  if (!bridge || installing || state.phase === "installing") return;
  const previous = state.enabled;
  userChangedPreference = true;
  setState({ enabled: Boolean(enabled), saving: true });
  try {
    const next = await bridge.setEnabled(Boolean(enabled));
    // Applied directly (not through mergeBridgeState) so this call's own
    // response isn't filtered by the userChangedPreference guard, which
    // exists only to protect this optimistic update from an unrelated
    // external push racing it. A stale installing phase is still guarded.
    if (next && typeof next === "object" && acceptsInstallAuthority(next)) setState(next);
  } catch {
    if (state.phase !== "installing") {
      setState({
        enabled: previous,
        phase: "error",
        message: "CareerRat couldn't save that update setting. Try again.",
      });
    }
  } finally {
    userChangedPreference = false;
    setState({ saving: false });
  }
}

async function checkNow() {
  // An accepted install is authoritative: "check now" is inert while it's
  // in flight rather than racing the bridge with a stale request.
  if (!bridge || state.supported === false || installing || state.phase === "installing") return;
  setState({ phase: "checking", manual: true, message: null, errorKind: null });
  try {
    const next = await bridge.checkNow();
    mergeBridgeState(next);
  } catch {
    if (state.phase !== "installing") {
      setState({
        phase: "error",
        manual: true,
        errorKind: "network",
        message: "CareerRat couldn't check for an update. Check your connection and try again.",
      });
    }
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
  if (!bridge || installing || state.phase !== "ready") return;
  // Latch synchronously, before the bridge call resolves: a second
  // activation before this one settles must see the latch already applied
  // and no-op, not fire a second IPC request.
  installing = true;
  setState({ phase: "installing", message: "Restarting to install…" });
  try {
    const result = await bridge.restartAndInstall();
    if (result?.accepted === false) {
      installing = false;
      setState({
        phase: "error",
        message: "That update isn't ready to install yet. Check for updates again.",
      });
    }
  } catch {
    installing = false;
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
