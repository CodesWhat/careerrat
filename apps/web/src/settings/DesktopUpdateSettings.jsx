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
    setSaving(true);
    bridge
      ?.setEnabled(next)
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
