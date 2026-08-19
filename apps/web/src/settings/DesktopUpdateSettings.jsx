import { useEffect, useState } from "react";
import { Card } from "../components/Card.jsx";
import { Field, Toggle } from "../components/form.jsx";

// Desktop-only, same bridge UpdateAvailableDock.jsx reads (see
// apps/desktop/preload/update-check-preload.cjs), undefined in the plain
// browser dev app and in the npm CLI, so this whole card renders nothing
// there. Not wired through handleSectionSave's schema-backed candidate
// config: this toggle controls Electron main-process state persisted under
// CAREERRAT_HOME, not a candidate config file.
const bridge = globalThis.careerratDesktopUpdate;

export function useDesktopUpdateSetting() {
  const [enabled, setEnabledState] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    bridge
      .getState()
      .then((state) => {
        if (state && typeof state.enabled === "boolean") setEnabledState(state.enabled);
      })
      .catch(() => {
        // Main process not reachable yet. The toggle keeps its default until it is.
      });
  }, []);

  function setEnabled(next) {
    setEnabledState(next);
    // Bail before touching `saving`: `useDesktopUpdateSetting` is exported on
    // its own, so a consumer that skips the `available` guard can call this
    // with no bridge present. Wrapping in Promise.resolve() also settles the
    // .finally() below even if a real bridge implementation ever returns a
    // plain value instead of a promise.
    if (!bridge) return;
    setSaving(true);
    Promise.resolve(bridge.setEnabled(next))
      .catch(() => {
        // Best-effort. Worst case the toggle reflects a state main.mjs never persisted.
      })
      .finally(() => setSaving(false));
  }

  return { available: Boolean(bridge), enabled, saving, setEnabled };
}

export function DesktopUpdateSettings() {
  const { available, enabled, saving, setEnabled } = useDesktopUpdateSetting();
  if (!available) return null;

  return (
    <Card title="Desktop app">
      <Field label="Check for updates" htmlFor="desktop-update-check-enabled">
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
