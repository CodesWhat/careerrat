import { useState } from "react";
import modesSchema from "../../../../../config/modes.schema.json";
import { Button } from "../../components/Button.jsx";
import { Card } from "../../components/Card.jsx";
import { Field, NumberField, Select, TextField, Toggle } from "../../components/form.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import { saveCandidateFile } from "../../lib/api.js";

const USAGE_MODE_OPTIONS = modesSchema.properties.usage_mode.enum.map((v) => ({
  value: v,
  label: v,
}));
const APPLICATION_MODE_OPTIONS = modesSchema.properties.application_mode.enum.map((v) => ({
  value: v,
  label: v,
}));

// Step 6 — Prefs / modes. Mirrors SettingsPage.jsx's Modes + Form Defaults
// cards field-for-field (same schema-driven enums, same candidate setup docs) —
// small, low-cognitive-load settings, not novel data entry, per the M8
// design doc's own framing for why these two live together here.
export function PrefsStep({ state, goNext, goBack, showToast }) {
  const modesData = state?.data?.modes ?? {};
  const formDefaultsData = state?.data?.["form-defaults"] ?? {};

  const [modes, setModes] = useState({
    usage_mode: modesData.usage_mode ?? "standard",
    application_mode: modesData.application_mode ?? "balanced",
  });
  const [formDefaults, setFormDefaults] = useState({
    auto_submit: !!formDefaultsData.auto_submit,
    expected_base: formDefaultsData.expected_base ?? null,
    current_employer: formDefaultsData.current_employer ?? "",
    current_title: formDefaultsData.current_title ?? "",
    eeo_default: formDefaultsData.eeo_default ?? "",
    linkedin: formDefaultsData.linkedin ?? "",
    github: formDefaultsData.github ?? "",
    portfolio: formDefaultsData.portfolio ?? "",
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSaveAndNext() {
    setSaving(true);
    setError(null);
    try {
      await saveCandidateFile("modes", modes);
      await saveCandidateFile("form-defaults", formDefaults);
      showToast("Saved.");
      goNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error ? <InlineAlert message={error} /> : null}

      <Card title="Modes">
        <div className="field-row">
          <Field label="Usage mode" htmlFor="prefs-usage_mode">
            <Select
              id="prefs-usage_mode"
              value={modes.usage_mode}
              onChange={(v) => setModes((f) => ({ ...f, usage_mode: v }))}
              options={USAGE_MODE_OPTIONS}
            />
          </Field>
          <Field label="Application mode" htmlFor="prefs-application_mode">
            <Select
              id="prefs-application_mode"
              value={modes.application_mode}
              onChange={(v) => setModes((f) => ({ ...f, application_mode: v }))}
              options={APPLICATION_MODE_OPTIONS}
            />
          </Field>
        </div>
      </Card>

      <Card title="Form defaults">
        <Field label="Auto-submit" htmlFor="prefs-auto_submit">
          <Toggle
            id="prefs-auto_submit"
            checked={formDefaults.auto_submit}
            onChange={(v) => setFormDefaults((f) => ({ ...f, auto_submit: v }))}
            label={
              formDefaults.auto_submit ? "Submit automatically" : "Confirm before every submit"
            }
          />
        </Field>
        <div className="field-row">
          <Field label="Expected base" htmlFor="prefs-expected_base">
            <NumberField
              id="prefs-expected_base"
              value={formDefaults.expected_base}
              onChange={(v) => setFormDefaults((f) => ({ ...f, expected_base: v }))}
            />
          </Field>
          <Field label="Current employer" htmlFor="prefs-current_employer">
            <TextField
              id="prefs-current_employer"
              value={formDefaults.current_employer}
              onChange={(v) => setFormDefaults((f) => ({ ...f, current_employer: v }))}
            />
          </Field>
          <Field label="Current title" htmlFor="prefs-current_title">
            <TextField
              id="prefs-current_title"
              value={formDefaults.current_title}
              onChange={(v) => setFormDefaults((f) => ({ ...f, current_title: v }))}
            />
          </Field>
        </div>
        <div className="field-row">
          <Field label="EEO default" htmlFor="prefs-eeo_default">
            <TextField
              id="prefs-eeo_default"
              value={formDefaults.eeo_default}
              onChange={(v) => setFormDefaults((f) => ({ ...f, eeo_default: v }))}
            />
          </Field>
          <Field label="LinkedIn" htmlFor="prefs-linkedin">
            <TextField
              id="prefs-linkedin"
              value={formDefaults.linkedin}
              onChange={(v) => setFormDefaults((f) => ({ ...f, linkedin: v }))}
            />
          </Field>
          <Field label="GitHub" htmlFor="prefs-github">
            <TextField
              id="prefs-github"
              value={formDefaults.github}
              onChange={(v) => setFormDefaults((f) => ({ ...f, github: v }))}
            />
          </Field>
          <Field label="Portfolio" htmlFor="prefs-portfolio">
            <TextField
              id="prefs-portfolio"
              value={formDefaults.portfolio}
              onChange={(v) => setFormDefaults((f) => ({ ...f, portfolio: v }))}
            />
          </Field>
        </div>
      </Card>

      <div className="wizard-actions">
        <Button variant="secondary" onClick={goBack}>
          Back
        </Button>
        <Button onClick={handleSaveAndNext} disabled={saving}>
          {saving ? "Saving…" : "Save & continue"}
        </Button>
      </div>
    </div>
  );
}
