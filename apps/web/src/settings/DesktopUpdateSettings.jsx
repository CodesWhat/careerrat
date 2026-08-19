import { useSyncExternalStore } from "react";
import { Card } from "../components/Card.jsx";
import { Field, Toggle } from "../components/form.jsx";

// Desktop-only, same bridge UpdateAvailableDock.jsx reads (see
// apps/desktop/preload/update-check-preload.cjs), undefined in the plain
// browser dev app and in the npm CLI, so this whole card renders nothing
// there. Not wired through handleSectionSave's schema-backed candidate
// config: this toggle controls Electron main-process state persisted under
// CAREERRAT_HOME, not a candidate config file.
const bridge = globalThis.careerratDesktopUpdate;

const EMPTY_STATE = Object.freeze({ enabled: true, saving: false, error: null });

// Module-level store, not per-instance useState. Same reasoning as
// UpdateAvailableDock.jsx's useDesktopUpdateNotice: this also makes the
// initial getState() fetch run once at module evaluation instead of inside a
// useEffect, which never fires under this repo's renderToStaticMarkup-based
// tests, so the race conditions below are actually exercisable in a test.
const listeners = new Set();
let state = EMPTY_STATE;
// Once the user has touched the toggle, their choice always wins: a late
// getState() response must never overwrite it with the stale value it was
// fetched with.
let userInteracted = false;

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

// Reads the current setting once. Module-scope, same as
// UpdateAvailableDock.jsx's own getState() call. Runs exactly once per
// module evaluation, not per render or per mounted instance. A no-op in the
// plain browser dev app, where `bridge` is undefined.
if (bridge) {
  bridge
    .getState()
    .then((result) => {
      if (userInteracted) return;
      if (result && typeof result.enabled === "boolean") setState({ enabled: result.enabled });
    })
    .catch(() => {
      // Main process not reachable yet. The toggle keeps its default until it is.
    });
}

function setEnabled(next) {
  userInteracted = true;
  const previous = state.enabled;
  setState({ enabled: next, error: null });
  // Bail before touching `saving`: bridge can be undefined in the plain
  // browser dev app, where this is unreachable through DesktopUpdateSettings
  // anyway, but useDesktopUpdateSetting is exported on its own.
  if (!bridge) return;
  setState({ saving: true });
  // Promise.resolve() wrapping settles the .finally() below even if a real
  // bridge implementation ever returns a plain value instead of a promise.
  Promise.resolve(bridge.setEnabled(next))
    .catch(() => {
      // main.mjs never persisted this: roll the toggle back rather than
      // leaving it showing a choice that didn't actually take.
      setState({ enabled: previous, error: "Could not save that. Try again." });
    })
    .finally(() => setState({ saving: false }));
}

export function useDesktopUpdateSetting() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    available: Boolean(bridge),
    enabled: snapshot.enabled,
    saving: snapshot.saving,
    error: snapshot.error,
    setEnabled,
  };
}

export function DesktopUpdateSettings() {
  const { available, enabled, saving, error, setEnabled } = useDesktopUpdateSetting();
  if (!available) return null;

  return (
    <Card title="Desktop app">
      <Field label="Check for updates" htmlFor="desktop-update-check-enabled" error={error}>
        <Toggle
          id="desktop-update-check-enabled"
          checked={enabled}
          disabled={saving}
          onChange={setEnabled}
          label={enabled ? "Checking GitHub for a newer version" : "Update checks are off"}
        />
      </Field>
      <p className="field__hint" style={{ margin: 0 }}>
        CareerRat looks at GitHub's public release list once a day and shows a notice here when a
        newer version is out. It never downloads or installs anything on its own, and the check
        never sends any of your candidate data.
      </p>
    </Card>
  );
}
