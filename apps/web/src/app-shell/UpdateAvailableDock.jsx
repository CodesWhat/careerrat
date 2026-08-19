import { useSyncExternalStore } from "react";
import { Button } from "../components/Button.jsx";

// Desktop-only, notify-only: `careerratDesktopUpdate` is exposed on the
// global object by apps/desktop/preload/update-check-preload.cjs and only
// exists inside the packaged/dev Electron shell (globalThis, not `window`
// directly, so this also works under the Node-environment `renderToStaticMarkup`
// tests, which have no `window`). In the plain browser dev app there is no
// bridge, `available` below is always false, and this component renders
// nothing: no separate "am I desktop" flag needed.
const bridge = globalThis.careerratDesktopUpdate;

const EMPTY_STATE = Object.freeze({
  notify: false,
  enabled: true,
  version: null,
  releaseUrl: null,
  dmgUrl: null,
});

// Module-level store, not per-instance useState. Same reasoning as
// SetupReadinessCard.jsx's useDeepIngestNudge: any component instance that
// mounts this hook needs to observe the same notice the instant a scheduled
// main-process check resolves it, not just whichever instance happened to
// subscribe to the bridge first.
const listeners = new Set();
let state = EMPTY_STATE;

function setState(next) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot() {
  return state;
}

// Subscribes to future pushes first, then reads the current notice once.
// Module-scope, same as SetupReadinessCard.jsx's
// `let dismissedCache = readDismissed();`. Runs exactly once per module
// evaluation, not per render or per mounted instance. A no-op in the plain
// browser dev app, where `bridge` is undefined.
//
// Order matters here: getState() and a scheduled check finishing (which
// pushes through onUpdate) can land in either order. Subscribing to
// onUpdate first means a push that arrives while getState() is still in
// flight is never missed. `receivedPush` then makes sure the getState()
// response, now stale, can't turn around and overwrite that push with the
// older payload it was fetched with.
if (bridge) {
  let receivedPush = false;

  bridge.onUpdate((result) => {
    receivedPush = true;
    setState(result);
  });

  bridge
    .getState()
    .then((result) => {
      if (receivedPush) return;
      if (result) setState(result);
    })
    .catch(() => {
      // No answer from main.mjs yet (very early boot). A later pushed
      // result from onUpdate above still arrives once a check completes.
    });
}

function dismissUpdate() {
  const { version } = state;
  setState({ notify: false });
  if (version) {
    bridge?.skipVersion(version).catch(() => {
      // Best-effort persistence. Worst case the notice just reappears next launch.
    });
  }
}

function openUpdateRelease() {
  bridge?.openRelease().catch(() => {
    // Best-effort, nothing to recover into if the main process is gone.
  });
}

export function useDesktopUpdateNotice() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return {
    available: Boolean(bridge) && snapshot.notify,
    version: snapshot.version,
    dismiss: dismissUpdate,
    openRelease: openUpdateRelease,
  };
}

// UpdateAvailableDock: docked the same way as SetupReadinessCard.jsx's
// DeepIngestDock: the top row of AskBar's `.ask-bar__shell` card, not a
// separate floating surface. Reuses the exact same nudge classes so this
// reads as one visual language, not a second notification style.
export function UpdateAvailableDock() {
  const { available, version, dismiss, openRelease } = useDesktopUpdateNotice();
  if (!available) return null;

  return (
    <div className="ask-bar__nudge" role="status" aria-label="Update available">
      <div className="ask-bar__nudge-body">
        <p className="ask-bar__nudge-title">Update ready</p>
        <p className="ask-bar__nudge-sub">
          CareerRat {version} is out. Download it to get the latest fixes.
        </p>
      </div>
      <Button className="ask-bar__nudge-cta" onClick={openRelease}>
        Download update
      </Button>
      <button
        type="button"
        className="ask-bar__nudge-dismiss"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
