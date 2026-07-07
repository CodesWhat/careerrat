import { useEffect, useMemo, useState } from "react";
import modesSchema from "../../../../config/modes.schema.json";
import profileSchema from "../../../../config/profile.schema.json";
import { Button } from "../components/Button.jsx";
import { Card } from "../components/Card.jsx";
import { Field, NumberField, Select, TextArea, TextField, Toggle } from "../components/form.jsx";
import { PageScaffold } from "../components/PageScaffold.jsx";
import { InlineAlert, Toast } from "../components/Toast.jsx";
import {
  ApiError,
  getAiSettings,
  getOnboardState,
  getUsageSummary,
  saveAiKey,
  saveCandidateFile,
} from "../lib/api.js";
import { mapErrors } from "./error-map.js";
import {
  formatTokenCount,
  formatUsd,
  topUsageFeatures,
  usageFeatureLabel,
} from "./usage-summary.js";

// Schema-driven enums — read at build time from the shipped JSON Schemas
// (config/*.schema.json, already in package.json#files) rather than
// hardcoded, so a schema change doesn't silently drift from the UI. These
// are non-secret shape files; bundling them is not a candidate-data leak
// (see tests/release-safety.test.mjs's scope: it guards candidate/workspace
// data, not shipped schemas).
const USAGE_MODE_OPTIONS = modesSchema.properties.usage_mode.enum.map((v) => ({
  value: v,
  label: v,
}));
const APPLICATION_MODE_OPTIONS = modesSchema.properties.application_mode.enum.map((v) => ({
  value: v,
  label: v,
}));
const TOOLCHAIN_OPTIONS = profileSchema.properties.candidate.properties.toolchain.enum.map((v) => ({
  value: v,
  label: v,
}));

const AI_ROUTE_LABEL = {
  byok: "Connected (BYOK)",
  proxy: "Connected (managed proxy)",
  none: "Not connected",
};
const EMPTY_USAGE_SUMMARY = {
  totals: {
    requests: 0,
    tokens_in: 0,
    tokens_out: 0,
    total_tokens: 0,
    cost_usd: 0,
  },
  byFeature: [],
};

// One fieldMap per candidate file — schema path (dot notation, see
// src/core/profile/schema-validator.mjs's joinPath()) → this page's field id.
const MODES_FIELD_MAP = {
  usage_mode: "modes-usage_mode",
  application_mode: "modes-application_mode",
};
const PROFILE_FIELD_MAP = {
  "candidate.domain": "profile-domain",
  "candidate.toolchain": "profile-toolchain",
  "compensation.expected_base": "profile-expected_base",
  "compensation.oe_min_base": "profile-oe_min_base",
  "compensation.oe_max_base": "profile-oe_max_base",
  "compensation.relo_package_needs": "profile-relo_package_needs",
};
const TARGETING_FIELD_MAP = {
  "fit_bands.high_min": "targeting-high_min",
  "fit_bands.med_min": "targeting-med_min",
  "reevaluation.rejection_total": "targeting-rejection_total",
  "reevaluation.rejection_per_family": "targeting-rejection_per_family",
};
const FORM_DEFAULTS_FIELD_MAP = {
  auto_submit: "form-defaults-auto_submit",
  expected_base: "form-defaults-expected_base",
  current_employer: "form-defaults-current_employer",
  current_title: "form-defaults-current_title",
  eeo_default: "form-defaults-eeo_default",
  linkedin: "form-defaults-linkedin",
  github: "form-defaults-github",
  portfolio: "form-defaults-portfolio",
};

function get(obj, path, fallback) {
  return (
    path
      .split(".")
      .reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), obj) ??
    fallback
  );
}

export function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [toast, setToast] = useState(null);

  const [aiStatus, setAiStatus] = useState({ route: "none", keyPresent: false });
  const [aiKeyInput, setAiKeyInput] = useState("");
  const [usageSummary, setUsageSummary] = useState(EMPTY_USAGE_SUMMARY);

  const [modesForm, setModesForm] = useState({
    usage_mode: "standard",
    application_mode: "balanced",
  });
  const [profileForm, setProfileForm] = useState({
    domain: "",
    toolchain: "",
    expected_base: null,
    oe_min_base: null,
    oe_max_base: null,
    relo_package_needs: "",
  });
  const [targetingForm, setTargetingForm] = useState({
    high_min: null,
    med_min: null,
    rejection_total: null,
    rejection_per_family: null,
  });
  const [formDefaultsForm, setFormDefaultsForm] = useState({
    auto_submit: false,
    expected_base: null,
    current_employer: "",
    current_title: "",
    eeo_default: "",
    linkedin: "",
    github: "",
    portfolio: "",
  });

  const [saving, setSaving] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [sectionBanner, setSectionBanner] = useState({});

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const [state, ai, usage] = await Promise.all([
        getOnboardState(),
        getAiSettings(),
        getUsageSummary(),
      ]);
      setAiStatus(ai);
      setUsageSummary(usage?.summary ?? EMPTY_USAGE_SUMMARY);

      const modes = state.data?.modes ?? {};
      setModesForm({
        usage_mode: modes.usage_mode ?? "standard",
        application_mode: modes.application_mode ?? "balanced",
      });

      const profile = state.data?.profile ?? {};
      setProfileForm({
        domain: get(profile, "candidate.domain", ""),
        toolchain: get(profile, "candidate.toolchain", ""),
        expected_base: get(profile, "compensation.expected_base", null),
        oe_min_base: get(profile, "compensation.oe_min_base", null),
        oe_max_base: get(profile, "compensation.oe_max_base", null),
        relo_package_needs: get(profile, "compensation.relo_package_needs", ""),
      });

      const targeting = state.data?.targeting ?? {};
      setTargetingForm({
        high_min: get(targeting, "fit_bands.high_min", null),
        med_min: get(targeting, "fit_bands.med_min", null),
        rejection_total: get(targeting, "reevaluation.rejection_total", null),
        rejection_per_family: get(targeting, "reevaluation.rejection_per_family", null),
      });

      const formDefaults = state.data?.["form-defaults"] ?? {};
      setFormDefaultsForm({
        auto_submit: !!formDefaults.auto_submit,
        expected_base: formDefaults.expected_base ?? null,
        current_employer: formDefaults.current_employer ?? "",
        current_title: formDefaults.current_title ?? "",
        eeo_default: formDefaults.eeo_default ?? "",
        linkedin: formDefaults.linkedin ?? "",
        github: formDefaults.github ?? "",
        portfolio: formDefaults.portfolio ?? "",
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }

  // Intentional mount-only load — `load` closes over state setters only, not
  // values that should re-trigger a refetch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only load
  useEffect(() => {
    load();
  }, []);

  function showToast(message, tone = "success") {
    setToast({ message, tone });
    setTimeout(() => setToast(null), 4000);
  }

  async function handleSectionSave(section, patch, fieldMap) {
    setSaving((s) => ({ ...s, [section]: true }));
    setSectionBanner((b) => ({ ...b, [section]: null }));
    setFieldErrors((e) => ({ ...e, [section]: {} }));
    try {
      await saveCandidateFile(section, patch);
      showToast("Saved.");
      await load();
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.body?.errors)) {
        const { byField, unmapped } = mapErrors(err.body.errors, fieldMap);
        setFieldErrors((e) => ({ ...e, [section]: byField }));
        if (unmapped.length) {
          setSectionBanner((b) => ({
            ...b,
            [section]: unmapped.map((u) => u.message).join("; "),
          }));
        }
      } else {
        setSectionBanner((b) => ({
          ...b,
          [section]: err instanceof Error ? err.message : "Save failed",
        }));
      }
    } finally {
      setSaving((s) => ({ ...s, [section]: false }));
    }
  }

  async function handleSaveAiKey() {
    if (!aiKeyInput.trim()) return;
    setSaving((s) => ({ ...s, ai: true }));
    setSectionBanner((b) => ({ ...b, ai: null }));
    try {
      await saveAiKey(aiKeyInput.trim());
      setAiKeyInput("");
      showToast("AI key saved.");
      const ai = await getAiSettings();
      setAiStatus(ai);
    } catch (err) {
      setSectionBanner((b) => ({ ...b, ai: err instanceof Error ? err.message : "Save failed" }));
    } finally {
      setSaving((s) => ({ ...s, ai: false }));
    }
  }

  const errorsFor = (section) => fieldErrors[section] ?? {};

  const aiBadgeLabel = useMemo(() => AI_ROUTE_LABEL[aiStatus.route] ?? "Unknown", [aiStatus.route]);
  const aiBadgeTone =
    aiStatus.keyPresent || aiStatus.route !== "none" ? "badge--ok" : "badge--muted";
  const topFeatures = useMemo(
    () => topUsageFeatures(usageSummary.byFeature ?? [], 5),
    [usageSummary.byFeature]
  );
  const usageTotals = usageSummary.totals ?? EMPTY_USAGE_SUMMARY.totals;

  if (loading) {
    return (
      <PageScaffold title="Settings">
        <p>Loading…</p>
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      title="Settings"
      subtitle="Reads and writes the same SQLite-backed candidate setup used by onboarding."
      actions={
        toast ? (
          <Toast message={toast.message} tone={toast.tone} onDismiss={() => setToast(null)} />
        ) : null
      }
    >
      {loadError ? <InlineAlert message={loadError} /> : null}

      {/* AI connection ------------------------------------------------- */}
      <Card
        title="AI connection"
        actions={<span className={`badge ${aiBadgeTone}`}>{aiBadgeLabel}</span>}
      >
        {sectionBanner.ai ? <InlineAlert message={sectionBanner.ai} /> : null}
        <p className="field__hint" style={{ margin: 0 }}>
          The key is never echoed back after saving. With ROLESTER_HOME it lives under
          internal/ai.env; legacy repo-root workspaces use .internal/ai.env.
        </p>
        <div className="field-row">
          <Field label="Anthropic API key" htmlFor="ai-key">
            <TextField
              id="ai-key"
              type="password"
              value={aiKeyInput}
              onChange={setAiKeyInput}
              placeholder="sk-ant-…"
              autoComplete="off"
            />
          </Field>
        </div>
        <div>
          <Button onClick={handleSaveAiKey} disabled={saving.ai || !aiKeyInput.trim()}>
            {saving.ai ? "Saving…" : "Save key"}
          </Button>
        </div>
      </Card>

      {/* AI spend ------------------------------------------------- */}
      <Card title="AI spend">
        <p className="field__hint" style={{ margin: 0 }}>
          Token and cost telemetry from the local usage ledger. Prompts, resumes, and job
          descriptions are not stored in these rows.
        </p>
        <div className="settings-usage-grid">
          <div className="settings-usage-stat">
            <span>Estimated cost</span>
            <strong>{formatUsd(usageTotals.cost_usd)}</strong>
          </div>
          <div className="settings-usage-stat">
            <span>AI calls</span>
            <strong>{formatTokenCount(usageTotals.requests)}</strong>
          </div>
          <div className="settings-usage-stat">
            <span>Total tokens</span>
            <strong>{formatTokenCount(usageTotals.total_tokens)}</strong>
          </div>
        </div>
        {topFeatures.length ? (
          <ul className="settings-usage-list" aria-label="AI spend by feature">
            {topFeatures.map((feature) => {
              const tokens =
                Number(feature.total_tokens) ||
                (Number(feature.tokens_in) || 0) + (Number(feature.tokens_out) || 0);
              return (
                <li className="settings-usage-row" key={feature.feature}>
                  <div>
                    <strong>{usageFeatureLabel(feature.feature)}</strong>
                    <span className="settings-usage-row__meta">
                      {formatTokenCount(feature.requests)} calls · {formatTokenCount(tokens)} tokens
                    </span>
                  </div>
                  <span className="settings-usage-row__cost">{formatUsd(feature.cost_usd)}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="field__hint" style={{ margin: 0 }}>
            No metered AI calls yet.
          </p>
        )}
      </Card>

      {/* Modes ----------------------------------------------------------- */}
      <Card title="Modes">
        {sectionBanner.modes ? <InlineAlert message={sectionBanner.modes} /> : null}
        <div className="field-row">
          <Field
            label="Usage mode"
            htmlFor="modes-usage_mode"
            error={errorsFor("modes")["modes-usage_mode"]}
          >
            <Select
              id="modes-usage_mode"
              value={modesForm.usage_mode}
              onChange={(v) => setModesForm((f) => ({ ...f, usage_mode: v }))}
              options={USAGE_MODE_OPTIONS}
            />
          </Field>
          <Field
            label="Application mode"
            htmlFor="modes-application_mode"
            error={errorsFor("modes")["modes-application_mode"]}
          >
            <Select
              id="modes-application_mode"
              value={modesForm.application_mode}
              onChange={(v) => setModesForm((f) => ({ ...f, application_mode: v }))}
              options={APPLICATION_MODE_OPTIONS}
            />
          </Field>
        </div>
        <div>
          <Button
            disabled={saving.modes}
            onClick={() =>
              handleSectionSave(
                "modes",
                { usage_mode: modesForm.usage_mode, application_mode: modesForm.application_mode },
                MODES_FIELD_MAP
              )
            }
          >
            {saving.modes ? "Saving…" : "Save modes"}
          </Button>
        </div>
      </Card>

      {/* Profile ----------------------------------------------------------- */}
      <Card title="Profile">
        {sectionBanner.profile ? <InlineAlert message={sectionBanner.profile} /> : null}
        <div className="field-row">
          <Field
            label="Domain"
            htmlFor="profile-domain"
            error={errorsFor("profile")["profile-domain"]}
          >
            <TextField
              id="profile-domain"
              value={profileForm.domain}
              onChange={(v) => setProfileForm((f) => ({ ...f, domain: v }))}
            />
          </Field>
          <Field
            label="Toolchain"
            htmlFor="profile-toolchain"
            error={errorsFor("profile")["profile-toolchain"]}
          >
            <Select
              id="profile-toolchain"
              value={profileForm.toolchain}
              onChange={(v) => setProfileForm((f) => ({ ...f, toolchain: v }))}
              options={TOOLCHAIN_OPTIONS}
            />
          </Field>
        </div>
        <div className="field-row">
          <Field
            label="Expected base"
            htmlFor="profile-expected_base"
            error={errorsFor("profile")["profile-expected_base"]}
          >
            <NumberField
              id="profile-expected_base"
              value={profileForm.expected_base}
              onChange={(v) => setProfileForm((f) => ({ ...f, expected_base: v }))}
            />
          </Field>
          <Field
            label="OE min base"
            htmlFor="profile-oe_min_base"
            error={errorsFor("profile")["profile-oe_min_base"]}
          >
            <NumberField
              id="profile-oe_min_base"
              value={profileForm.oe_min_base}
              onChange={(v) => setProfileForm((f) => ({ ...f, oe_min_base: v }))}
            />
          </Field>
          <Field
            label="OE max base"
            htmlFor="profile-oe_max_base"
            error={errorsFor("profile")["profile-oe_max_base"]}
          >
            <NumberField
              id="profile-oe_max_base"
              value={profileForm.oe_max_base}
              onChange={(v) => setProfileForm((f) => ({ ...f, oe_max_base: v }))}
            />
          </Field>
        </div>
        <Field
          label="Relocation package needs"
          htmlFor="profile-relo_package_needs"
          error={errorsFor("profile")["profile-relo_package_needs"]}
        >
          <TextArea
            id="profile-relo_package_needs"
            value={profileForm.relo_package_needs}
            onChange={(v) => setProfileForm((f) => ({ ...f, relo_package_needs: v }))}
          />
        </Field>
        <div>
          <Button
            disabled={saving.profile}
            onClick={() =>
              handleSectionSave(
                "profile",
                {
                  candidate: { domain: profileForm.domain, toolchain: profileForm.toolchain },
                  compensation: {
                    expected_base: profileForm.expected_base,
                    oe_min_base: profileForm.oe_min_base,
                    oe_max_base: profileForm.oe_max_base,
                    relo_package_needs: profileForm.relo_package_needs,
                  },
                },
                PROFILE_FIELD_MAP
              )
            }
          >
            {saving.profile ? "Saving…" : "Save profile"}
          </Button>
        </div>
      </Card>

      {/* Targeting ----------------------------------------------------------- */}
      <Card title="Targeting">
        {sectionBanner.targeting ? <InlineAlert message={sectionBanner.targeting} /> : null}
        <div className="field-row">
          <Field
            label="Fit band — high min"
            htmlFor="targeting-high_min"
            error={errorsFor("targeting")["targeting-high_min"]}
          >
            <NumberField
              id="targeting-high_min"
              value={targetingForm.high_min}
              onChange={(v) => setTargetingForm((f) => ({ ...f, high_min: v }))}
            />
          </Field>
          <Field
            label="Fit band — med min"
            htmlFor="targeting-med_min"
            error={errorsFor("targeting")["targeting-med_min"]}
          >
            <NumberField
              id="targeting-med_min"
              value={targetingForm.med_min}
              onChange={(v) => setTargetingForm((f) => ({ ...f, med_min: v }))}
            />
          </Field>
        </div>
        <div className="field-row">
          <Field
            label="Reevaluate after N rejections (total)"
            htmlFor="targeting-rejection_total"
            error={errorsFor("targeting")["targeting-rejection_total"]}
          >
            <NumberField
              id="targeting-rejection_total"
              value={targetingForm.rejection_total}
              onChange={(v) => setTargetingForm((f) => ({ ...f, rejection_total: v }))}
            />
          </Field>
          <Field
            label="Reevaluate after N rejections (per family)"
            htmlFor="targeting-rejection_per_family"
            error={errorsFor("targeting")["targeting-rejection_per_family"]}
          >
            <NumberField
              id="targeting-rejection_per_family"
              value={targetingForm.rejection_per_family}
              onChange={(v) => setTargetingForm((f) => ({ ...f, rejection_per_family: v }))}
            />
          </Field>
        </div>
        <div>
          <Button
            disabled={saving.targeting}
            onClick={() =>
              handleSectionSave(
                "targeting",
                {
                  fit_bands: { high_min: targetingForm.high_min, med_min: targetingForm.med_min },
                  reevaluation: {
                    rejection_total: targetingForm.rejection_total,
                    rejection_per_family: targetingForm.rejection_per_family,
                  },
                },
                TARGETING_FIELD_MAP
              )
            }
          >
            {saving.targeting ? "Saving…" : "Save targeting"}
          </Button>
        </div>
      </Card>

      {/* Form defaults ----------------------------------------------------------- */}
      <Card title="Form defaults">
        {sectionBanner["form-defaults"] ? (
          <InlineAlert message={sectionBanner["form-defaults"]} />
        ) : null}
        <Field label="Auto-submit" htmlFor="form-defaults-auto_submit">
          <Toggle
            id="form-defaults-auto_submit"
            checked={formDefaultsForm.auto_submit}
            onChange={(v) => setFormDefaultsForm((f) => ({ ...f, auto_submit: v }))}
            label={
              formDefaultsForm.auto_submit ? "Submit automatically" : "Confirm before every submit"
            }
          />
        </Field>
        <div className="field-row">
          <Field
            label="Expected base"
            htmlFor="form-defaults-expected_base"
            error={errorsFor("form-defaults")["form-defaults-expected_base"]}
          >
            <NumberField
              id="form-defaults-expected_base"
              value={formDefaultsForm.expected_base}
              onChange={(v) => setFormDefaultsForm((f) => ({ ...f, expected_base: v }))}
            />
          </Field>
          <Field
            label="Current employer"
            htmlFor="form-defaults-current_employer"
            error={errorsFor("form-defaults")["form-defaults-current_employer"]}
          >
            <TextField
              id="form-defaults-current_employer"
              value={formDefaultsForm.current_employer}
              onChange={(v) => setFormDefaultsForm((f) => ({ ...f, current_employer: v }))}
            />
          </Field>
          <Field
            label="Current title"
            htmlFor="form-defaults-current_title"
            error={errorsFor("form-defaults")["form-defaults-current_title"]}
          >
            <TextField
              id="form-defaults-current_title"
              value={formDefaultsForm.current_title}
              onChange={(v) => setFormDefaultsForm((f) => ({ ...f, current_title: v }))}
            />
          </Field>
        </div>
        <div className="field-row">
          <Field
            label="EEO default"
            htmlFor="form-defaults-eeo_default"
            error={errorsFor("form-defaults")["form-defaults-eeo_default"]}
          >
            <TextField
              id="form-defaults-eeo_default"
              value={formDefaultsForm.eeo_default}
              onChange={(v) => setFormDefaultsForm((f) => ({ ...f, eeo_default: v }))}
            />
          </Field>
          <Field
            label="LinkedIn"
            htmlFor="form-defaults-linkedin"
            error={errorsFor("form-defaults")["form-defaults-linkedin"]}
          >
            <TextField
              id="form-defaults-linkedin"
              value={formDefaultsForm.linkedin}
              onChange={(v) => setFormDefaultsForm((f) => ({ ...f, linkedin: v }))}
            />
          </Field>
          <Field
            label="GitHub"
            htmlFor="form-defaults-github"
            error={errorsFor("form-defaults")["form-defaults-github"]}
          >
            <TextField
              id="form-defaults-github"
              value={formDefaultsForm.github}
              onChange={(v) => setFormDefaultsForm((f) => ({ ...f, github: v }))}
            />
          </Field>
          <Field
            label="Portfolio"
            htmlFor="form-defaults-portfolio"
            error={errorsFor("form-defaults")["form-defaults-portfolio"]}
          >
            <TextField
              id="form-defaults-portfolio"
              value={formDefaultsForm.portfolio}
              onChange={(v) => setFormDefaultsForm((f) => ({ ...f, portfolio: v }))}
            />
          </Field>
        </div>
        <div>
          <Button
            disabled={saving["form-defaults"]}
            onClick={() =>
              handleSectionSave("form-defaults", { ...formDefaultsForm }, FORM_DEFAULTS_FIELD_MAP)
            }
          >
            {saving["form-defaults"] ? "Saving…" : "Save form defaults"}
          </Button>
        </div>
      </Card>
    </PageScaffold>
  );
}
