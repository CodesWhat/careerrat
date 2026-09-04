export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Retry spacing for a scheduler tick that lands while a check or download is
// still in flight.
export const IN_FLIGHT_RETRY_MS = 10 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SHARED_UPDATE_STAGING_ID = "00000000-0000-5000-8000-000000000000";
const WINDOWS_STATUS_URL = "https://github.com/CodesWhat/careerrat/blob/main/docs/WINDOWS.md";

export const DEFAULT_STATE = Object.freeze({
  enabled: true,
  lastCheckedAt: null,
  skippedVersion: null,
  operation: null,
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
  phase = null,
} = {}) {
  if (!enabled) return null;
  // A downloaded update is staged until it is installed. checkNow is a no-op
  // in that state and leaves lastCheckedAt alone, so re-arming from an
  // expired timestamp would spin the timer at zero delay.
  if (phase === "ready") return null;
  // A check or download still in flight past its deadline (long sleep, a
  // stalled transfer) also coalesces without touching lastCheckedAt. Re-arm
  // with a retry delay instead of zero so the scheduler cannot spin.
  const inFlight = phase === "checking" || phase === "downloading";
  if (
    lastCheckedAt === null ||
    lastCheckedAt === undefined ||
    lastCheckedAt === ""
  ) {
    return Math.min(maxDelayMs, Math.max(0, initialDelayMs));
  }
  const checkedAt = new Date(lastCheckedAt).getTime();
  if (!Number.isFinite(checkedAt)) return inFlight ? IN_FLIGHT_RETRY_MS : 0;
  const due = Math.max(0, checkedAt + intervalMs - now);
  return Math.min(maxDelayMs, inFlight ? Math.max(due, IN_FLIGHT_RETRY_MS) : due);
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

function savedOperation(value) {
  if (!value || typeof value !== "object") return null;
  const phase = String(value.phase || "");
  if (!new Set(["checking", "downloading", "ready"]).has(phase)) return null;
  const version = typeof value.version === "string" ? value.version.trim() : "";
  return { phase, ...(version ? { version } : {}) };
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
  let installAccepted = false;
  let saved = {
    enabled: persisted.enabled ?? DEFAULT_STATE.enabled,
    lastCheckedAt: persisted.lastCheckedAt ?? DEFAULT_STATE.lastCheckedAt,
    skippedVersion: persisted.skippedVersion ?? DEFAULT_STATE.skippedVersion,
    operation: savedOperation(persisted.operation),
  };
  const recoveredOperation = saved.operation;
  let startupCheckPending = supported && recoveredOperation?.phase === "ready";
  const interrupted =
    supported &&
    (recoveredOperation?.phase === "checking" || recoveredOperation?.phase === "downloading");
  let runtime = supported
    ? startupCheckPending
      ? {
          ...IDLE_RUNTIME,
          phase: "checking",
          version: recoveredOperation.version || null,
          message: "Checking the downloaded update…",
        }
      : interrupted
        ? {
            ...IDLE_RUNTIME,
            phase: "error",
            version: recoveredOperation.version || null,
            errorKind: "interrupted",
            message: "The update stopped when CareerRat closed. Try again when you're ready.",
          }
        : { ...IDLE_RUNTIME }
    : {
        ...IDLE_RUNTIME,
        phase: "unsupported",
        message:
          platform === "win32"
            ? "CareerRat can't install updates inside the Windows app yet because a signed Windows installer isn't publicly available yet. See Windows release status for availability."
            : "In-app updates are available in the installed CareerRat app.",
        downloadUrl: platform === "win32" ? WINDOWS_STATUS_URL : null,
      };

  if (interrupted) {
    saved = { ...saved, operation: null };
    persist(saved);
  }

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  // The install handoff in main.mjs waits for Electron's before-quit-for-update,
  // which the native updater only emits on this path when it relaunches the
  // app itself. Pin it rather than relying on the library default.
  updater.autoRunAppAfterInstall = true;
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
    const nextOperation = savedOperation(runtime);
    if (JSON.stringify(nextOperation) !== JSON.stringify(saved.operation)) {
      saved = { ...saved, operation: nextOperation };
      persist(saved);
    }
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

  const boundHandlers = {};
  for (const [event, handler] of Object.entries(handlers)) {
    boundHandlers[event] = (...args) => {
      if (installAccepted) {
        log(event);
        return undefined;
      }
      return handler(...args);
    };
    updater.on(event, boundHandlers[event]);
  }

  async function checkNow({ manual = false, force = false } = {}) {
    if (!supported) return setRuntime({ manual: Boolean(manual) });
    if (!manual && !force && !saved.enabled) return getState();
    if (installAccepted) return getState();
    // A downloaded update stays staged until it is installed. A routine
    // check (timer, menu) must not replace it with a fresh check that can
    // fail offline and leave the staged download uninstallable.
    if (!force && runtime.phase === "ready") return getState();
    if (
      !force &&
      (runtime.phase === "checking" || runtime.phase === "downloading")
    ) {
      // Coalesce onto the check already running. A manual request still has
      // to see the outcome, so promote the in-flight operation to manual
      // instead of starting a second native check.
      return manual && !runtime.manual ? setRuntime({ manual: true }) : getState();
    }

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

  function needsStartupCheck() {
    return startupCheckPending;
  }

  async function reconcileStartup() {
    if (!startupCheckPending) return getState();
    startupCheckPending = false;
    // force bypasses saved.enabled, which exists so a manual check still
    // runs while checks are off. Startup reconciliation is not manual: a
    // candidate who downloaded an update and then turned checks off must
    // not get a network call to GitHub on the very next launch.
    if (!saved.enabled) return getState();
    return checkNow({ force: true });
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

  function acceptInstall() {
    // One-shot: the first acceptance owns the quit-and-install sequence. A
    // repeat request during teardown must not trigger a second app quit.
    if (!supported || installAccepted || runtime.phase !== "ready") return false;
    installAccepted = true;
    return true;
  }

  function install() {
    if (!supported || runtime.phase !== "ready") return false;
    updater.quitAndInstall(false, true);
    return true;
  }

  function destroy() {
    for (const [event, handler] of Object.entries(boundHandlers))
      updater.removeListener(event, handler);
  }

  return {
    acceptInstall,
    checkNow,
    destroy,
    getState,
    install,
    needsStartupCheck,
    reconcileStartup,
    setEnabled,
    skipVersion,
  };
}
