import { useEffect, useMemo, useState } from "react";
import modesSchema from "../../../../config/modes.schema.json";
import profileSchema from "../../../../config/profile.schema.json";
import { Button } from "../components/Button.jsx";
import { Card } from "../components/Card.jsx";
import {
  ChipInput,
  Field,
  NumberField,
  Select,
  TextArea,
  TextField,
  Toggle,
} from "../components/form.jsx";
import { PageScaffold } from "../components/PageScaffold.jsx";
import { InlineAlert, Toast } from "../components/Toast.jsx";
import {
  ApiError,
  getAiSettings,
  getAutomationSettings,
  getInstalledAiRuntimes,
  getOnboardState,
  getUsageSummary,
  openInstalledAiRuntimeTerminal,
  probeInstalledAiRuntime,
  saveCandidateFile,
  selectInstalledAiRuntime,
  validateAndSaveAiKey,
} from "../lib/api.js";
import { resolveErrorCopy } from "../lib/errorCopy.js";
// buildQuickFactsSavePayload is the only export consumed here — the
// individual pure helpers it composes (compensationPatch, authorizationPatch,
// locationPatch, candidateLocationPatch, cleanLinkFields) are module-private
// to lib/quickFacts.js. Calling the composite and reading its `.profile`
// slice reuses the exact same tested shaping logic without re-deriving it or
// widening quickFacts.js's export surface.
import { buildQuickFactsSavePayload } from "../lib/quickFacts.js";
import {
  GUARDRAIL_PRESETS,
  GUARDRAIL_SUGGESTIONS,
  isGuardrailSelected,
  normalizeSignals,
  toggleGuardrailSignal,
} from "../onboarding/steps/GuardrailsStep.jsx";
import { normalizeRoleBuckets, RoleLaneFields } from "../onboarding/steps/RoleLaneEditor.jsx";
import {
  AutomationConsentMatrix,
  AutomationModeChooser,
  buildAutomationModePatch,
} from "./AutomationControls.jsx";
import { mapErrors } from "./error-map.js";
import { InstalledRuntimeChoices } from "./InstalledRuntimeChoices.jsx";
import { SourceMaintenance } from "./SourceMaintenance.jsx";
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
const AGENT_VOICE_OPTIONS = modesSchema.properties.agent_voice.enum.map((v) => ({
  value: v,
  label: v,
}));

// Work mode choices for the Profile card's location fields. Not schema-driven
// (profile.schema.json's location object has no enum here) — mirrors
// PrefsStep.jsx's own WORK_MODE_OPTIONS constant, which isn't exported.
// Every mode round-trips to the qualification gate; hybrid/on-site additionally
// use the candidate's commute radius below.
const WORK_MODE_OPTIONS = [
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
  { value: "onsite", label: "On-site" },
];

const AI_ROUTE_LABEL = {
  installed: "Connected (installed CLI)",
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
  agent_voice: "modes-agent_voice",
};
const PROFILE_FIELD_MAP = {
  "candidate.domain": "profile-domain",
  "candidate.toolchain": "profile-toolchain",
  "candidate.linkedin": "profile-linkedin",
  "candidate.github": "profile-github",
  "candidate.portfolio": "profile-portfolio",
  "compensation.expected_base": "profile-expected_base",
  "compensation.oe_min_base": "profile-oe_min_base",
  "compensation.oe_max_base": "profile-oe_max_base",
  "compensation.relo_package_needs": "profile-relo_package_needs",
  "authorization.work_authorized": "profile-authorization",
  "authorization.requires_sponsorship": "profile-authorization",
  "location.remote": "profile-work_mode",
  "location.home": "profile-home_base",
  "location.commute_radius_miles": "profile-commute_radius",
  "location.relocation": "profile-relocation",
};

let roleLaneClientKey = 0;

function nextRoleLaneClientKey() {
  roleLaneClientKey += 1;
  return `settings-role-lane-${roleLaneClientKey}`;
}

function withRoleLaneClientKeys(buckets) {
  return buckets.map((bucket) => ({
    ...bucket,
    clientKey: bucket.clientKey || nextRoleLaneClientKey(),
  }));
}
const TARGETING_FIELD_MAP = {
  "fit_bands.high_min": "targeting-high_min",
  "fit_bands.med_min": "targeting-med_min",
  "reevaluation.rejection_total": "targeting-rejection_total",
  "reevaluation.rejection_per_family": "targeting-rejection_per_family",
  cut_signals: "targeting-cut_signals",
  keep_signals: "targeting-keep_signals",
  excluded_companies: "targeting-excluded_companies",
  tracked_companies: "targeting-tracked_companies",
};
const HONESTY_FIELD_MAP = {
  "education.highest_degree": "honesty-highest_degree",
  "education.add_education_section": "honesty-add_education_section",
  "tools.confirmed": "honesty-tools_confirmed",
  "tools.adjacent": "honesty-tools_adjacent",
  "tools.do_not_claim": "honesty-tools_do_not_claim",
  "claims.do_not_fabricate": "honesty-do_not_fabricate",
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

function presentNumbers(values) {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([, value]) => typeof value === "number" && Number.isFinite(value)
    )
  );
}

export function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [toast, setToast] = useState(null);

  const [aiStatus, setAiStatus] = useState({ route: "none", keyPresent: false });
  const [installedAi, setInstalledAi] = useState(null);
  const [automationStatus, setAutomationStatus] = useState(null);
  const [aiKeyInput, setAiKeyInput] = useState("");
  const [usageSummary, setUsageSummary] = useState(EMPTY_USAGE_SUMMARY);

  const [modesForm, setModesForm] = useState({
    usage_mode: "standard",
    application_mode: "balanced",
    agent_voice: "standard",
  });
  const [profileForm, setProfileForm] = useState({
    domain: "",
    toolchain: "",
    expected_base: null,
    oe_min_base: null,
    oe_max_base: null,
    relo_package_needs: "",
    linkedin: "",
    github: "",
    portfolio: "",
    // Not rendered as a field — read-only pass-through so
    // candidateLocationPatch() (via buildQuickFactsSavePayload) never
    // overwrites the resume-header location string with a home-base edit.
    candidateLocation: "",
    authChoice: null,
    workModes: [],
    homeBase: "",
    commuteRadiusMiles: 25,
    relocationList: [],
  });
  const [targetingForm, setTargetingForm] = useState({
    role_buckets: [],
    high_min: null,
    med_min: null,
    rejection_total: null,
    rejection_per_family: null,
    cut_signals: [],
    keep_signals: [],
    excluded_companies: [],
    tracked_companies: [],
  });
  const [honestyForm, setHonestyForm] = useState({
    highest_degree: "",
    add_education_section: false,
    tools_confirmed: [],
    tools_adjacent: [],
    tools_do_not_claim: [],
    do_not_fabricate: [],
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
      const [state, ai, usage, installed, automation] = await Promise.all([
        getOnboardState(),
        getAiSettings(),
        getUsageSummary(),
        getInstalledAiRuntimes(),
        getAutomationSettings(),
      ]);
      setAiStatus(ai);
      setInstalledAi(installed);
      setAutomationStatus(automation);
      setUsageSummary(usage?.summary ?? EMPTY_USAGE_SUMMARY);

      const modes = state.data?.modes ?? {};
      setModesForm({
        usage_mode: modes.usage_mode ?? "standard",
        application_mode: modes.application_mode ?? "balanced",
        agent_voice: modes.agent_voice ?? "standard",
      });

      const profile = state.data?.profile ?? {};
      setProfileForm({
        domain: get(profile, "candidate.domain", ""),
        toolchain: get(profile, "candidate.toolchain", ""),
        expected_base: get(profile, "compensation.expected_base", null),
        oe_min_base: get(profile, "compensation.oe_min_base", null),
        oe_max_base: get(profile, "compensation.oe_max_base", null),
        relo_package_needs: get(profile, "compensation.relo_package_needs", ""),
        linkedin: get(profile, "candidate.linkedin", ""),
        github: get(profile, "candidate.github", ""),
        portfolio: get(profile, "candidate.portfolio", ""),
        candidateLocation: get(profile, "candidate.location", ""),
        authChoice:
          profile.authorization?.work_authorized === true
            ? "authorized"
            : profile.authorization?.requires_sponsorship === true
              ? "sponsorship"
              : null,
        workModes: [
          ...(profile.location?.remote ? ["remote"] : []),
          ...(profile.location?.hybrid ? ["hybrid"] : []),
          ...(profile.location?.onsite ? ["onsite"] : []),
        ],
        homeBase: String(profile.location?.home || profile.candidate?.location || "").trim(),
        commuteRadiusMiles:
          Number(profile.location?.commute_radius_miles) > 0
            ? Number(profile.location.commute_radius_miles)
            : 25,
        relocationList: Array.isArray(profile.location?.relocation)
          ? profile.location.relocation.filter(Boolean)
          : [],
      });

      const targeting = state.data?.targeting ?? {};
      setTargetingForm({
        role_buckets: withRoleLaneClientKeys(normalizeRoleBuckets(targeting.role_buckets)),
        high_min: get(targeting, "fit_bands.high_min", null),
        med_min: get(targeting, "fit_bands.med_min", null),
        rejection_total: get(targeting, "reevaluation.rejection_total", null),
        rejection_per_family: get(targeting, "reevaluation.rejection_per_family", null),
        cut_signals: normalizeSignals(targeting.cut_signals),
        keep_signals: normalizeSignals(targeting.keep_signals),
        excluded_companies: Array.isArray(targeting.excluded_companies)
          ? targeting.excluded_companies
          : [],
        tracked_companies: Array.isArray(targeting.tracked_companies)
          ? targeting.tracked_companies
          : [],
      });

      const honesty = state.data?.honesty ?? {};
      setHonestyForm({
        highest_degree: get(honesty, "education.highest_degree", "") ?? "",
        add_education_section: !!get(honesty, "education.add_education_section", false),
        tools_confirmed: Array.isArray(honesty.tools?.confirmed) ? honesty.tools.confirmed : [],
        tools_adjacent: Array.isArray(honesty.tools?.adjacent) ? honesty.tools.adjacent : [],
        tools_do_not_claim: Array.isArray(honesty.tools?.do_not_claim)
          ? honesty.tools.do_not_claim
          : [],
        do_not_fabricate: Array.isArray(honesty.claims?.do_not_fabricate)
          ? honesty.claims.do_not_fabricate
          : [],
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

  // Composes the Profile card's links/authorization/location fields via
  // PrefsStep.jsx's own buildQuickFactsSavePayload() rather than
  // re-deriving that trimming/omit-if-empty logic, then drops
  // additional_links — this card has no UI for that onboarding-only list,
  // and including it here would replace-wholesale it back to [] on every
  // save (arrays replace, never merge), silently deleting anything the
  // onboarding wizard saved. `current_base` is never read or sent — this
  // patch only ever touches expected_base/oe_min_base/oe_max_base/
  // relo_package_needs, the fields this card already owned.
  function buildProfileSavePatch() {
    const quickFacts = buildQuickFactsSavePayload({
      links: {
        linkedin: profileForm.linkedin,
        github: profileForm.github,
        portfolio: profileForm.portfolio,
      },
      authChoice: profileForm.authChoice,
      workModes: profileForm.workModes,
      homeBase: profileForm.homeBase,
      commuteRadiusMiles: profileForm.commuteRadiusMiles,
      relocationList: profileForm.relocationList,
      existingCandidateLocation: profileForm.candidateLocation,
    }).profile;
    const { additional_links: _additionalLinks, ...linkFields } = quickFacts.candidate;

    return {
      candidate: {
        domain: profileForm.domain,
        toolchain: profileForm.toolchain,
        ...linkFields,
      },
      compensation: {
        expected_base: profileForm.expected_base,
        oe_min_base: profileForm.oe_min_base,
        oe_max_base: profileForm.oe_max_base,
        relo_package_needs: profileForm.relo_package_needs,
      },
      ...(quickFacts.authorization ? { authorization: quickFacts.authorization } : {}),
      ...(quickFacts.location ? { location: quickFacts.location } : {}),
    };
  }

  async function handleSaveAiKey() {
    if (!aiKeyInput.trim()) return;
    setSaving((s) => ({ ...s, ai: true }));
    setSectionBanner((b) => ({ ...b, ai: null }));
    try {
      await validateAndSaveAiKey(aiKeyInput.trim());
      await selectInstalledAiRuntime({ providerFallback: true });
      setAiKeyInput("");
      showToast("AI key saved.");
      const ai = await getAiSettings();
      setAiStatus(ai);
    } catch (err) {
      const resolved = resolveErrorCopy(err);
      setSectionBanner((b) => ({
        ...b,
        ai: resolved.action?.retry
          ? { ...resolved, action: { ...resolved.action, onRetry: handleSaveAiKey } }
          : resolved,
      }));
    } finally {
      setSaving((s) => ({ ...s, ai: false }));
    }
  }

  async function handleSelectInstalledAi(runtimeId) {
    setSaving((state) => ({ ...state, aiRuntime: runtimeId }));
    setSectionBanner((state) => ({ ...state, aiRuntime: null }));
    try {
      await selectInstalledAiRuntime({ runtimeId });
      setInstalledAi(await getInstalledAiRuntimes());
      showToast("Installed AI tool selected.");
    } catch (error) {
      const resolved = resolveErrorCopy(error);
      setSectionBanner((state) => ({
        ...state,
        aiRuntime: resolved.action?.retry
          ? {
              ...resolved,
              action: { ...resolved.action, onRetry: () => handleSelectInstalledAi(runtimeId) },
            }
          : resolved,
      }));
    } finally {
      setSaving((state) => ({ ...state, aiRuntime: null }));
    }
  }

  async function handleProbeInstalledAi(runtimeId) {
    setSaving((state) => ({ ...state, aiRuntime: runtimeId }));
    try {
      await probeInstalledAiRuntime(runtimeId);
      setInstalledAi(await getInstalledAiRuntimes());
    } finally {
      setSaving((state) => ({ ...state, aiRuntime: null }));
    }
  }

  async function handleOpenInstalledAiTerminal(runtimeId) {
    setSaving((state) => ({ ...state, aiRuntime: runtimeId }));
    try {
      const result = await openInstalledAiRuntimeTerminal(runtimeId);
      showToast(
        result?.signInCommand
          ? `Terminal opened. Sign in with: ${result.signInCommand}`
          : "Terminal opened. Sign in, then retry detection."
      );
    } finally {
      setSaving((state) => ({ ...state, aiRuntime: null }));
    }
  }

  async function saveAutomationPatch(patch, successMessage) {
    setSaving((state) => ({ ...state, automation: true }));
    setSectionBanner((state) => ({ ...state, automation: null }));
    try {
      await saveCandidateFile("automation", patch);
      setAutomationStatus(await getAutomationSettings());
      showToast(successMessage);
    } catch (error) {
      const resolved = resolveErrorCopy(error);
      setSectionBanner((state) => ({
        ...state,
        automation: resolved.action?.retry
          ? {
              ...resolved,
              action: {
                ...resolved.action,
                onRetry: () => saveAutomationPatch(patch, successMessage),
              },
            }
          : resolved,
      }));
    } finally {
      setSaving((state) => ({ ...state, automation: false }));
    }
  }

  function handleAutomationMode(mode) {
    if (!automationStatus) return;
    return saveAutomationPatch(
      buildAutomationModePatch(automationStatus, mode),
      mode === "basic"
        ? "Basic mode enabled; every external capability is off."
        : "Advanced controls available; nothing was enabled."
    );
  }

  function handleAutomationCapability(capability, enabled) {
    return saveAutomationPatch(
      { setup_mode: "advanced", capabilities: { [capability]: { enabled } } },
      "Capability permission updated."
    );
  }

  function handleAutomationPlatform(capability, platform, enabled) {
    return saveAutomationPatch(
      {
        setup_mode: "advanced",
        capabilities: { [capability]: { platforms: { [platform]: enabled } } },
      },
      "Platform permission updated."
    );
  }

  function handleAutomationConsent(platform, consent) {
    return saveAutomationPatch(
      { setup_mode: "advanced", consent: { [platform]: consent } },
      consent ? "Platform terms consent recorded." : "Platform terms consent revoked."
    );
  }

  const errorsFor = (section) => fieldErrors[section] ?? {};

  function updateRoleBucket(index, patch) {
    setTargetingForm((form) => ({
      ...form,
      role_buckets: form.role_buckets.map((bucket, bucketIndex) =>
        bucketIndex === index ? { ...bucket, ...patch } : bucket
      ),
    }));
  }

  function addRoleBucket() {
    setTargetingForm((form) => ({
      ...form,
      role_buckets: [
        ...form.role_buckets,
        {
          clientKey: nextRoleLaneClientKey(),
          name: "Another lane",
          priority: form.role_buckets.length ? "secondary" : "primary",
          titles: [],
          notes: "",
          fit_signals: [],
          down_signals: [],
        },
      ],
    }));
  }

  function removeRoleBucket(index) {
    setTargetingForm((form) => ({
      ...form,
      role_buckets: form.role_buckets.filter((_, bucketIndex) => bucketIndex !== index),
    }));
  }

  const roleLanesInvalid =
    targetingForm.role_buckets.length === 0 ||
    targetingForm.role_buckets.some((bucket) => !bucket.titles?.length);

  const displayedAiRoute = installedAi?.selectedId ? "installed" : aiStatus.route;
  const aiBadgeLabel = useMemo(
    () => AI_ROUTE_LABEL[displayedAiRoute] ?? "Unknown",
    [displayedAiRoute]
  );
  const aiBadgeTone =
    installedAi?.selectedId || aiStatus.keyPresent || aiStatus.route !== "none"
      ? "badge--ok"
      : "badge--muted";
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
        {sectionBanner.aiRuntime ? (
          <InlineAlert
            message={sectionBanner.aiRuntime.message}
            action={sectionBanner.aiRuntime.action}
            detail={sectionBanner.aiRuntime.detail}
          />
        ) : null}
        {InstalledRuntimeChoices({
          state: installedAi,
          busyId: saving.aiRuntime,
          onSelect: handleSelectInstalledAi,
          onRetry: handleProbeInstalledAi,
          onOpenTerminal: handleOpenInstalledAiTerminal,
          showAdvancedHint: false,
        })}
        {sectionBanner.ai ? (
          <InlineAlert
            message={sectionBanner.ai.message}
            action={sectionBanner.ai.action}
            detail={sectionBanner.ai.detail}
          />
        ) : null}
        <details
          className="settings-advanced-provider"
          open={installedAi?.providerFallback === true}
        >
          <summary>Advanced · Use a provider API key instead</summary>
          <div className="settings-advanced-provider__body">
            <p className="field__hint" style={{ margin: 0 }}>
              This explicitly switches AI calls away from an installed CLI. The key is never echoed
              back after saving. With CAREERRAT_HOME it lives under internal/ai.env; legacy
              repo-root workspaces use .internal/ai.env.
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
                {saving.ai ? "Saving…" : "Save key and use provider"}
              </Button>
            </div>
          </div>
        </details>
      </Card>

      <Card
        title="Automation permissions"
        actions={
          <span className={`badge ${automationStatus?.liveCount ? "badge--ok" : "badge--muted"}`}>
            {automationStatus?.mode === "advanced" ? "Advanced" : "Basic"}
          </span>
        }
      >
        {sectionBanner.automation ? (
          <InlineAlert
            message={sectionBanner.automation.message}
            action={sectionBanner.automation.action}
            detail={sectionBanner.automation.detail}
          />
        ) : null}
        {AutomationModeChooser({
          status: automationStatus || {
            mode: "basic",
            liveCount: 0,
            consent: {},
            capabilities: [],
          },
          busy: saving.automation,
          onSetMode: handleAutomationMode,
        })}
        {automationStatus?.mode === "advanced"
          ? AutomationConsentMatrix({
              status: automationStatus,
              busy: saving.automation,
              onCapabilityChange: handleAutomationCapability,
              onPlatformChange: handleAutomationPlatform,
              onConsentChange: handleAutomationConsent,
            })
          : null}
      </Card>

      <SourceMaintenance />

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
          <Field
            label="Agent voice"
            htmlFor="modes-agent_voice"
            error={errorsFor("modes")["modes-agent_voice"]}
            hint="Changes how the agent talks to you in chat. It does not change the tone of generated résumés or cover letters (that's Writing voice, in Library)."
          >
            <Select
              id="modes-agent_voice"
              value={modesForm.agent_voice}
              onChange={(v) => setModesForm((f) => ({ ...f, agent_voice: v }))}
              options={AGENT_VOICE_OPTIONS}
            />
          </Field>
        </div>
        <div>
          <Button
            disabled={saving.modes}
            onClick={() =>
              handleSectionSave(
                "modes",
                {
                  usage_mode: modesForm.usage_mode,
                  application_mode: modesForm.application_mode,
                  agent_voice: modesForm.agent_voice,
                },
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
        <div className="field-row">
          <Field
            label="LinkedIn"
            htmlFor="profile-linkedin"
            error={errorsFor("profile")["profile-linkedin"]}
          >
            <TextField
              id="profile-linkedin"
              value={profileForm.linkedin}
              onChange={(v) => setProfileForm((f) => ({ ...f, linkedin: v }))}
              placeholder="https://linkedin.com/in/your-slug"
            />
          </Field>
          <Field
            label="GitHub"
            htmlFor="profile-github"
            error={errorsFor("profile")["profile-github"]}
          >
            <TextField
              id="profile-github"
              value={profileForm.github}
              onChange={(v) => setProfileForm((f) => ({ ...f, github: v }))}
              placeholder="https://github.com/username"
            />
          </Field>
          <Field
            label="Portfolio"
            htmlFor="profile-portfolio"
            error={errorsFor("profile")["profile-portfolio"]}
          >
            <TextField
              id="profile-portfolio"
              value={profileForm.portfolio}
              onChange={(v) => setProfileForm((f) => ({ ...f, portfolio: v }))}
              placeholder="https://your-site.com"
            />
          </Field>
        </div>
        <div className="field">
          <span className="field__label">Work authorization</span>
          <div
            className="onboarding-quick-facts__pill-row"
            role="radiogroup"
            aria-label="Work authorization"
          >
            <button
              type="button"
              className={`onboarding-targeting__priority-choice${profileForm.authChoice === "authorized" ? " onboarding-targeting__priority-choice--active" : ""}`}
              aria-pressed={profileForm.authChoice === "authorized"}
              onClick={() =>
                setProfileForm((f) => ({
                  ...f,
                  authChoice: f.authChoice === "authorized" ? null : "authorized",
                }))
              }
            >
              Authorized to work
            </button>
            <button
              type="button"
              className={`onboarding-targeting__priority-choice${profileForm.authChoice === "sponsorship" ? " onboarding-targeting__priority-choice--active" : ""}`}
              aria-pressed={profileForm.authChoice === "sponsorship"}
              onClick={() =>
                setProfileForm((f) => ({
                  ...f,
                  authChoice: f.authChoice === "sponsorship" ? null : "sponsorship",
                }))
              }
            >
              Need sponsorship
            </button>
          </div>
          {errorsFor("profile")["profile-authorization"] ? (
            <span className="field__error">{errorsFor("profile")["profile-authorization"]}</span>
          ) : (
            <span className="field__hint">Optional.</span>
          )}
        </div>
        <div className="field">
          <span className="field__label">Work mode</span>
          <fieldset className="onboarding-quick-facts__pill-row" aria-label="Work mode">
            {WORK_MODE_OPTIONS.map((option) => {
              const selected = profileForm.workModes.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`onboarding-targeting__priority-choice${selected ? " onboarding-targeting__priority-choice--active" : ""}`}
                  aria-pressed={selected}
                  onClick={() =>
                    setProfileForm((f) => ({
                      ...f,
                      workModes: f.workModes.includes(option.value)
                        ? f.workModes.filter((v) => v !== option.value)
                        : [...f.workModes, option.value],
                    }))
                  }
                >
                  {option.label}
                </button>
              );
            })}
          </fieldset>
          {errorsFor("profile")["profile-work_mode"] ? (
            <span className="field__error">{errorsFor("profile")["profile-work_mode"]}</span>
          ) : (
            <span className="field__hint">
              Pick every mode you'd take. Search matching enforces each one.
            </span>
          )}
        </div>
        <div className="field-row">
          <Field
            label="Home base"
            htmlFor="profile-home_base"
            error={errorsFor("profile")["profile-home_base"]}
            hint="City, state, or country. Helps match hybrid and on-site roles near you."
          >
            <TextField
              id="profile-home_base"
              value={profileForm.homeBase}
              onChange={(v) => setProfileForm((f) => ({ ...f, homeBase: v }))}
              placeholder="City, state or country"
            />
          </Field>
          <Field
            label="Open to relocating"
            htmlFor="profile-relocation"
            error={errorsFor("profile")["profile-relocation"]}
            hint="Press Enter or comma to add another city."
          >
            <ChipInput
              id="profile-relocation"
              values={profileForm.relocationList}
              onChange={(v) => setProfileForm((f) => ({ ...f, relocationList: v }))}
              placeholder="e.g. Austin, TX"
            />
          </Field>
          <Field
            label="Commute radius"
            htmlFor="profile-commute_radius"
            error={errorsFor("profile")["profile-commute_radius"]}
            hint="Miles from home for hybrid and on-site roles."
          >
            <NumberField
              id="profile-commute_radius"
              value={profileForm.commuteRadiusMiles}
              onChange={(v) => setProfileForm((f) => ({ ...f, commuteRadiusMiles: v }))}
              min="1"
              step="1"
              placeholder="25"
            />
          </Field>
        </div>
        <div>
          <Button
            disabled={saving.profile}
            onClick={() => handleSectionSave("profile", buildProfileSavePatch(), PROFILE_FIELD_MAP)}
          >
            {saving.profile ? "Saving…" : "Save profile"}
          </Button>
        </div>
      </Card>

      {/* Targeting ----------------------------------------------------------- */}
      <Card title="Targeting">
        {sectionBanner.targeting ? <InlineAlert message={sectionBanner.targeting} /> : null}
        <h4 style={{ margin: "0 0 4px" }}>Role lanes</h4>
        <p className="field__hint" style={{ margin: 0 }}>
          Role-lane changes apply to future matching. Re-run sourcing or rescore existing jobs to
          apply them to work already in the queue.
        </p>
        <div className="settings-role-lanes">
          {targetingForm.role_buckets.map((bucket, index) => (
            <section
              className="onboarding-targeting__edit-panel settings-role-lane"
              key={bucket.clientKey}
              aria-label={`Edit ${bucket.name || `role lane ${index + 1}`}`}
            >
              {RoleLaneFields({
                bucket,
                index,
                idPrefix: "targeting-role",
                onChange: (patch) => updateRoleBucket(index, patch),
              })}
              <button
                type="button"
                className="onboarding-targeting__remove"
                onClick={() => removeRoleBucket(index)}
              >
                Remove role lane
              </button>
            </section>
          ))}
        </div>
        {roleLanesInvalid ? (
          <InlineAlert message="Add at least one complete role lane with a job title." />
        ) : null}
        <Button variant="secondary" onClick={addRoleBucket}>
          Add role lane
        </Button>
        <div className="field-row">
          <Field
            label="Fit band: high min"
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
            label="Fit band: med min"
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

        <h4 style={{ margin: "12px 0 4px" }}>Guardrails</h4>
        <div className="onboarding-guardrails__presets">
          <div className="onboarding-guardrails__preset-header">
            <span>Pick common guardrails</span>
          </div>
          <section className="onboarding-guardrails__preset-grid" aria-label="Common guardrails">
            {GUARDRAIL_PRESETS.map((preset) => {
              const selected = isGuardrailSelected(targetingForm.cut_signals, preset.value);
              return (
                <button
                  key={preset.value}
                  type="button"
                  className={`onboarding-guardrails__preset ${selected ? "onboarding-guardrails__preset--selected" : ""}`.trim()}
                  aria-pressed={selected}
                  onClick={() =>
                    setTargetingForm((f) => ({
                      ...f,
                      cut_signals: toggleGuardrailSignal(f.cut_signals, preset.value),
                    }))
                  }
                >
                  <span aria-hidden="true">{preset.emoji}</span>
                  {preset.label}
                </button>
              );
            })}
          </section>
        </div>
        <Field
          label="Cut signals"
          htmlFor="targeting-cut_signals"
          error={errorsFor("targeting")["targeting-cut_signals"]}
          hint="Press Enter or comma to add another guardrail. Presets above are suggestions only. Nothing saves until you press Save targeting."
        >
          <ChipInput
            id="targeting-cut_signals"
            values={targetingForm.cut_signals}
            onChange={(v) => setTargetingForm((f) => ({ ...f, cut_signals: v }))}
            placeholder="e.g. heavy travel"
            suggestions={GUARDRAIL_SUGGESTIONS}
            suggestionLimit={8}
          />
        </Field>
        <Field
          label="Keep signals"
          htmlFor="targeting-keep_signals"
          error={errorsFor("targeting")["targeting-keep_signals"]}
          hint="Signals that strengthen a fit. Press Enter or comma to add."
        >
          <ChipInput
            id="targeting-keep_signals"
            values={targetingForm.keep_signals}
            onChange={(v) => setTargetingForm((f) => ({ ...f, keep_signals: v }))}
            placeholder="e.g. developer tools"
          />
        </Field>
        <p className="field__hint" style={{ margin: 0 }}>
          Base keep/cut signals apply to every role. Confirmed Library role signals layer onto
          matching role families automatically.
        </p>

        <h4 style={{ margin: "12px 0 4px" }}>Company lists</h4>
        <Field
          label="Excluded companies"
          htmlFor="targeting-excluded_companies"
          error={errorsFor("targeting")["targeting-excluded_companies"]}
          hint="Companies to never surface. Press Enter or comma to add."
        >
          <ChipInput
            id="targeting-excluded_companies"
            values={targetingForm.excluded_companies}
            onChange={(v) => setTargetingForm((f) => ({ ...f, excluded_companies: v }))}
            placeholder="e.g. Acme Corp"
          />
        </Field>
        <Field
          label="Tracked companies"
          htmlFor="targeting-tracked_companies"
          error={errorsFor("targeting")["targeting-tracked_companies"]}
          hint="Companies to prioritize sourcing from. Press Enter or comma to add."
        >
          <ChipInput
            id="targeting-tracked_companies"
            values={targetingForm.tracked_companies}
            onChange={(v) => setTargetingForm((f) => ({ ...f, tracked_companies: v }))}
            placeholder="e.g. Acme Corp"
          />
        </Field>

        <div>
          <Button
            disabled={saving.targeting || roleLanesInvalid}
            onClick={() =>
              handleSectionSave(
                "targeting",
                {
                  role_buckets: normalizeRoleBuckets(targetingForm.role_buckets),
                  fit_bands: presentNumbers({
                    high_min: targetingForm.high_min,
                    med_min: targetingForm.med_min,
                  }),
                  reevaluation: presentNumbers({
                    rejection_total: targetingForm.rejection_total,
                    rejection_per_family: targetingForm.rejection_per_family,
                  }),
                  cut_signals: targetingForm.cut_signals,
                  keep_signals: targetingForm.keep_signals,
                  excluded_companies: targetingForm.excluded_companies,
                  tracked_companies: targetingForm.tracked_companies,
                },
                TARGETING_FIELD_MAP
              )
            }
          >
            {saving.targeting ? "Saving…" : "Save targeting"}
          </Button>
        </div>
      </Card>

      {/* Honesty boundaries ------------------------------------------------ */}
      <Card title="Honesty boundaries">
        {sectionBanner.honesty ? <InlineAlert message={sectionBanner.honesty} /> : null}
        <p className="field__hint" style={{ margin: 0 }}>
          Enforced on every tailored résumé, cover letter, and answer, together with confirmed
          honesty items in your Library.
        </p>
        <div className="field-row">
          {/* honesty.schema.json's education.highest_degree has no enum
              (type: ["string", "null"], free text) — a plain TextField,
              not a schema-driven Select like the other enum-backed fields
              on this page. */}
          <Field
            label="Highest degree"
            htmlFor="honesty-highest_degree"
            error={errorsFor("honesty")["honesty-highest_degree"]}
          >
            <TextField
              id="honesty-highest_degree"
              value={honestyForm.highest_degree}
              onChange={(v) => setHonestyForm((f) => ({ ...f, highest_degree: v }))}
              placeholder="e.g. B.S. Computer Science"
            />
          </Field>
        </div>
        <Field label="Add education section" htmlFor="honesty-add_education_section">
          <Toggle
            id="honesty-add_education_section"
            checked={honestyForm.add_education_section}
            onChange={(v) => setHonestyForm((f) => ({ ...f, add_education_section: v }))}
            label={
              honestyForm.add_education_section
                ? "Include an education section"
                : "Omit the education section"
            }
          />
        </Field>
        <Field
          label="Confirmed tools"
          htmlFor="honesty-tools_confirmed"
          error={errorsFor("honesty")["honesty-tools_confirmed"]}
          hint="Tools you can honestly claim hands-on experience with. Press Enter or comma to add."
        >
          <ChipInput
            id="honesty-tools_confirmed"
            values={honestyForm.tools_confirmed}
            onChange={(v) => setHonestyForm((f) => ({ ...f, tools_confirmed: v }))}
            placeholder="e.g. PostgreSQL"
          />
        </Field>
        <Field
          label="Adjacent tools"
          htmlFor="honesty-tools_adjacent"
          error={errorsFor("honesty")["honesty-tools_adjacent"]}
          hint="Tools you've been near but shouldn't claim as core skills. Press Enter or comma to add."
        >
          <ChipInput
            id="honesty-tools_adjacent"
            values={honestyForm.tools_adjacent}
            onChange={(v) => setHonestyForm((f) => ({ ...f, tools_adjacent: v }))}
            placeholder="e.g. Kubernetes"
          />
        </Field>
        <Field
          label="Do not claim"
          htmlFor="honesty-tools_do_not_claim"
          error={errorsFor("honesty")["honesty-tools_do_not_claim"]}
          hint="Tools to never claim. Press Enter or comma to add."
        >
          <ChipInput
            id="honesty-tools_do_not_claim"
            values={honestyForm.tools_do_not_claim}
            onChange={(v) => setHonestyForm((f) => ({ ...f, tools_do_not_claim: v }))}
            placeholder="e.g. Rust"
          />
        </Field>
        <Field
          label="Never fabricate"
          htmlFor="honesty-do_not_fabricate"
          error={errorsFor("honesty")["honesty-do_not_fabricate"]}
          hint="Categories of claim that must never be invented. Press Enter or comma to add."
        >
          <ChipInput
            id="honesty-do_not_fabricate"
            values={honestyForm.do_not_fabricate}
            onChange={(v) => setHonestyForm((f) => ({ ...f, do_not_fabricate: v }))}
            placeholder="e.g. security clearances"
          />
        </Field>
        <div>
          <Button
            disabled={saving.honesty}
            onClick={() =>
              handleSectionSave(
                "honesty",
                {
                  education: {
                    highest_degree: honestyForm.highest_degree.trim() || null,
                    add_education_section: honestyForm.add_education_section,
                  },
                  tools: {
                    confirmed: honestyForm.tools_confirmed,
                    adjacent: honestyForm.tools_adjacent,
                    do_not_claim: honestyForm.tools_do_not_claim,
                  },
                  claims: { do_not_fabricate: honestyForm.do_not_fabricate },
                },
                HONESTY_FIELD_MAP
              )
            }
          >
            {saving.honesty ? "Saving…" : "Save honesty boundaries"}
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
