import { useEffect, useState } from "react";
import { Button } from "../../components/Button.jsx";
import { Card } from "../../components/Card.jsx";
import { Field, TextField } from "../../components/form.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import { getAiSettings, saveAiKey } from "../../lib/api.js";

const AI_ROUTE_LABEL = {
  byok: "Connected (BYOK)",
  proxy: "Connected (managed proxy)",
  none: "Not connected",
};

// Step 2 — BYOK key. Mirrors SettingsPage.jsx's "AI connection" card exactly
// (same TextField/Button, same "never echoed back" copy). Continue is never
// disabled here — every AI assist later in the wizard (resume extraction,
// title/keyword suggestions, Roland's company search) is optional and
// degrades to a manual path without a key; this step is skippable by design.
export function KeyStep({ reload, goNext, goBack, showToast }) {
  const [status, setStatus] = useState({ route: "none", keyPresent: false });
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    getAiSettings()
      .then(setStatus)
      .catch(() => {
        /* best-effort — the badge just stays "Not connected" */
      });
  }, []);

  async function handleSave() {
    if (!keyInput.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await saveAiKey(keyInput.trim());
      setKeyInput("");
      showToast("AI key saved.");
      setStatus(await getAiSettings());
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const badgeLabel = AI_ROUTE_LABEL[status.route] ?? "Unknown";
  const badgeTone = status.keyPresent || status.route !== "none" ? "badge--ok" : "badge--muted";

  return (
    <Card
      title="Connect an AI key (optional)"
      actions={<span className={`badge ${badgeTone}`}>{badgeLabel}</span>}
    >
      <p className="field__hint" style={{ margin: 0 }}>
        Unlocks resume extraction from a PDF/image, title and keyword suggestion chips, and Roland's
        company search later in this wizard. The key is stored locally and never echoed back after
        saving — you can add it later from Settings instead.
      </p>
      {error ? <InlineAlert message={error} /> : null}
      <div className="field-row">
        <Field label="Anthropic API key" htmlFor="onboarding-ai-key">
          <TextField
            id="onboarding-ai-key"
            type="password"
            value={keyInput}
            onChange={setKeyInput}
            placeholder="sk-ant-…"
            autoComplete="off"
          />
        </Field>
      </div>
      <div className="wizard-actions">
        <Button variant="secondary" onClick={goBack}>
          Back
        </Button>
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="secondary" onClick={handleSave} disabled={saving || !keyInput.trim()}>
            {saving ? "Saving…" : "Save key"}
          </Button>
          <Button onClick={goNext}>Continue</Button>
        </div>
      </div>
    </Card>
  );
}
