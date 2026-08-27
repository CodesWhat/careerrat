export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SHARED_UPDATE_STAGING_ID = "00000000-0000-5000-8000-000000000000";
const WINDOWS_STATUS_URL = "https://github.com/CodesWhat/careerrat/blob/main/docs/WINDOWS.md";

export const DEFAULT_STATE = Object.freeze({
  enabled: true,
  lastCheckedAt: null,
  skippedVersion: null,
});

const IDLE_RUNTIME = Object.freeze({
  phase: "idle",
  version: null,
  progress: null,
  errorKind: null,
  message: null,
  manual: false,
  downloadUrl: null,
});

export function nextUpdateCheckDelay({
  enabled = true,
  lastCheckedAt = null,
  now = Date.now(),
  initialDelayMs = 0,
  intervalMs = CHECK_INTERVAL_MS,
  maxDelayMs = MAX_TIMER_DELAY_MS,
} = {}) {
  if (!enabled) return null;
  if (
    lastCheckedAt === null ||
    lastCheckedAt === undefined ||
    lastCheckedAt === ""
  ) {
    return Math.min(maxDelayMs, Math.max(0, initialDelayMs));
  }
  const checkedAt = new Date(lastCheckedAt).getTime();
  if (!Number.isFinite(checkedAt)) return 0;
  return Math.min(maxDelayMs, Math.max(0, checkedAt + intervalMs - now));
}

export function updaterErrorCopy(error) {
  const raw = String(error?.message || error || "");
  if (/read[- ]only|volume.*(?:locked|writable)|translocat/i.test(raw)) {
    return {
      kind: "move-to-applications",
      message:
        "Move CareerRat to Applications, reopen it, and try the update again.",
    };
  }
  if (/checksum|sha-?512|signature|verification|publisher/i.test(raw)) {
    return {
      kind: "verification",
      message:
        "CareerRat couldn't verify that update, so it wasn't installed. Try again later.",
    };
  }
  if (
    /network|connection|ECONN|ERR_(?:CONNECTION|NETWORK)|ENOTFOUND|offline|timed? out/i.test(
      raw,
    )
  ) {
    return {
      kind: "network",
      message:
        "CareerRat couldn't download the update. Check your connection and try again.",
    };
  }
  return {
    kind: "unknown",
    message:
      "CareerRat couldn't finish the update. Try again. Your current version still works.",
  };
}

function safeVersion(info, fallback = null) {
  const value = typeof info?.version === "string" ? info.version.trim() : "";
  return value || fallback;
}

function safePercent(progress) {
  const value = Number(progress?.percent);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function createDesktopUpdateController({
  updater,
  platform,
  selfUpdateSupported = platform === "darwin",
  currentVersion,
  persisted = DEFAULT_STATE,
  now = Date.now,
  persist = () => {},
  push = () => {},
  log = () => {},
} = {}) {
  if (!updater?.on || typeof updater.checkForUpdates !== "function") {
    throw new TypeError("A native updater is required.");
  }

  const supported = Boolean(selfUpdateSupported);
  let saved = { ...DEFAULT_STATE, ...persisted };
  let runtime = supported
    ? { ...IDLE_RUNTIME }
    : {
        ...IDLE_RUNTIME,
        phase: "unsupported",
        message:
          platform === "win32"
            ? "CareerRat can't install updates inside the Windows app yet because a signed Windows installer isn't publicly available yet. See Windows release status for availability."
            : "In-app updates are available in the installed CareerRat app.",
        downloadUrl: platform === "win32" ? WINDOWS_STATUS_URL : null,
      };

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  // electron-updater 6.8.9 applies requestHeaders after its generated staging
  // header. Override only that header so checks never send its per-install UUID.
  updater.requestHeaders = {
    ...(updater.requestHeaders || {}),
    "x-user-staging-id": SHARED_UPDATE_STAGING_ID,
  };

  function getState() {
    return {
      supported,
      enabled: saved.enabled,
      lastCheckedAt: saved.lastCheckedAt,
      phase: runtime.phase,
      version: runtime.version,
      progress: runtime.progress,
      errorKind: runtime.errorKind,
      message: runtime.message,
      manual: runtime.manual,
      downloadUrl: runtime.downloadUrl,
      notify:
        supported &&
        runtime.phase === "ready" &&
        Boolean(runtime.version) &&
        runtime.version !== saved.skippedVersion,
    };
  }

  function emit() {
    const state = getState();
    push(state);
    return state;
  }

  function setRuntime(next) {
    runtime = { ...runtime, ...next };
    return emit();
  }

  function save(next) {
    saved = { ...saved, ...next };
    persist(saved);
    return emit();
  }

  function fail(error) {
    log(String(error?.message || error || "unknown updater failure"));
    const copy = updaterErrorCopy(error);
    return setRuntime({
      phase: "error",
      progress: null,
      errorKind: copy.kind,
      message: copy.message,
    });
  }

  const handlers = {
    "checking-for-update": () =>
      setRuntime({
        phase: "checking",
        progress: null,
        errorKind: null,
        message: null,
      }),
    "update-available": (info) =>
      setRuntime({
        phase: "downloading",
        version: safeVersion(info, runtime.version),
        progress: 0,
        errorKind: null,
        message: null,
      }),
    "download-progress": (progress) =>
      setRuntime({ phase: "downloading", progress: safePercent(progress) }),
    "update-downloaded": (info) =>
      setRuntime({
        phase: "ready",
        version: safeVersion(info, runtime.version),
        progress: 100,
        errorKind: null,
        message: null,
      }),
    "update-not-available": (info) =>
      setRuntime({
        phase: "current",
        version: safeVersion(info, currentVersion),
        progress: null,
        errorKind: null,
        message: null,
      }),
    "update-cancelled": () =>
      setRuntime({
        phase: "error",
        progress: null,
        errorKind: "cancelled",
        message:
          "The update stopped before it finished. Try again when you're ready.",
      }),
    error: fail,
  };

  for (const [event, handler] of Object.entries(handlers))
    updater.on(event, handler);

  async function checkNow({ manual = false } = {}) {
    if (!supported) return setRuntime({ manual: Boolean(manual) });
    if (!manual && !saved.enabled) return getState();

    saved = { ...saved, lastCheckedAt: now() };
    persist(saved);
    setRuntime({
      phase: "checking",
      progress: null,
      errorKind: null,
      message: null,
      manual: Boolean(manual),
    });
    try {
      await updater.checkForUpdates();
    } catch (error) {
      fail(error);
    }
    return getState();
  }

  function setEnabled(enabled) {
    return save({ enabled: Boolean(enabled) });
  }

  function skipVersion(version) {
    runtime = { ...runtime, manual: false };
    return save({
      skippedVersion: typeof version === "string" && version ? version : null,
    });
  }

  function install() {
    if (!supported || runtime.phase !== "ready") return false;
    updater.quitAndInstall(false, true);
    return true;
  }

  function destroy() {
    for (const [event, handler] of Object.entries(handlers))
      updater.removeListener(event, handler);
  }

  return {
    checkNow,
    destroy,
    getState,
    install,
    setEnabled,
    skipVersion,
  };
}
