import { useState } from "react";
import { ChipInput, Field, filterChipSuggestions } from "../../components/form.jsx";
import { InfoIcon } from "../../components/icons.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import { saveCandidateFile } from "../../lib/api.js";
import { OnboardingNavButton, OnboardingShell } from "../OnboardingShell.jsx";

export const GUARDRAIL_PRESETS = [
  { emoji: "🧳", label: "Heavy travel", value: "Heavy travel", source: "job_text" },
  { emoji: "🏢", label: "Onsite-only", value: "Onsite-only", source: "job_text" },
  { emoji: "🧭", label: "Low autonomy", value: "Low autonomy", source: "interview_signal" },
  { emoji: "⏰", label: "Long hours", value: "Long hours", source: "interview_signal" },
  {
    emoji: "🔥",
    label: "Constant fire drills",
    value: "Constant fire drills",
    source: "interview_signal",
  },
  { emoji: "💸", label: "Below comp floor", value: "Below comp floor", source: "job_text" },
  { emoji: "🪜", label: "No growth path", value: "No growth path", source: "interview_signal" },
  { emoji: "🧱", label: "Legacy-only work", value: "Legacy-only work", source: "job_text" },
  { emoji: "🗣️", label: "Meeting-heavy", value: "Meeting-heavy", source: "job_text" },
  { emoji: "📉", label: "Layoff risk", value: "Layoff risk", source: "company_scan" },
  { emoji: "🧪", label: "Vague product", value: "Vague product", source: "company_scan" },
  { emoji: "🧾", label: "Unclear title scope", value: "Unclear title scope", source: "job_text" },
];

const EXTRA_GUARDRAIL_SUGGESTIONS = [
  {
    emoji: "🏠",
    label: "Remote unavailable",
    value: "Remote unavailable",
    source: "job_text",
    aliases: ["remote", "wfh", "work from home"],
  },
  {
    emoji: "🚗",
    label: "Commute too long",
    value: "Commute too long",
    source: "job_text",
    aliases: ["commute", "drive"],
  },
  {
    emoji: "↩️",
    label: "Return-to-office risk",
    value: "Return-to-office risk",
    source: "company_scan",
    aliases: ["rto", "office mandate"],
  },
  {
    emoji: "🛂",
    label: "Visa sponsorship unavailable",
    value: "Visa sponsorship unavailable",
    source: "job_text",
    aliases: ["visa", "sponsorship", "work authorization"],
  },
  {
    emoji: "📄",
    label: "Contract-only",
    value: "Contract-only",
    source: "job_text",
    aliases: ["contract", "1099"],
  },
  {
    emoji: "🔁",
    label: "Contract-to-hire",
    value: "Contract-to-hire",
    source: "job_text",
    aliases: ["c2h", "contract to hire"],
  },
  {
    emoji: "💵",
    label: "No salary range",
    value: "No salary range",
    source: "job_text",
    aliases: ["salary", "comp", "pay range"],
  },
  {
    emoji: "🧮",
    label: "Equity-heavy comp",
    value: "Equity-heavy comp",
    source: "job_text",
    aliases: ["equity", "stock"],
  },
  {
    emoji: "☎️",
    label: "On-call heavy",
    value: "On-call heavy",
    source: "job_text",
    aliases: ["pager", "on call", "support rotation"],
  },
  {
    emoji: "🌙",
    label: "Nights or weekends",
    value: "Nights or weekends",
    source: "job_text",
    aliases: ["weekend", "night", "after hours"],
  },
  {
    emoji: "👥",
    label: "People management required",
    value: "People management required",
    source: "job_text",
    aliases: ["manager", "management"],
  },
  {
    emoji: "🧍",
    label: "IC path unavailable",
    value: "IC path unavailable",
    source: "interview_signal",
    aliases: ["individual contributor", "ic"],
  },
  {
    emoji: "🧑‍💼",
    label: "Manager path unavailable",
    value: "Manager path unavailable",
    source: "interview_signal",
    aliases: ["manager", "leadership"],
  },
  {
    emoji: "🎭",
    label: "Title inflation",
    value: "Title inflation",
    source: "job_text",
    aliases: ["title", "seniority"],
  },
  {
    emoji: "🧩",
    label: "Unclear success metrics",
    value: "Unclear success metrics",
    source: "interview_signal",
    aliases: ["success", "metrics", "expectations"],
  },
  {
    emoji: "🎲",
    label: "Unclear roadmap",
    value: "Unclear roadmap",
    source: "interview_signal",
    aliases: ["roadmap", "strategy"],
  },
  {
    emoji: "🧊",
    label: "Low product velocity",
    value: "Low product velocity",
    source: "company_scan",
    aliases: ["slow", "velocity"],
  },
  {
    emoji: "🧨",
    label: "High incident load",
    value: "High incident load",
    source: "interview_signal",
    aliases: ["incidents", "firefighting"],
  },
  {
    emoji: "📞",
    label: "Support rotation",
    value: "Support rotation",
    source: "job_text",
    aliases: ["customer support", "support"],
  },
  {
    emoji: "🛠️",
    label: "Tooling debt",
    value: "Tooling debt",
    source: "interview_signal",
    aliases: ["tools", "devex", "debt"],
  },
  {
    emoji: "🧰",
    label: "Maintenance-only role",
    value: "Maintenance-only role",
    source: "job_text",
    aliases: ["maintenance", "keep the lights on"],
  },
  {
    emoji: "🧑‍🚒",
    label: "Firefighter role",
    value: "Firefighter role",
    source: "job_text",
    aliases: ["firefighter", "urgent fixes"],
  },
  {
    emoji: "🤹",
    label: "Too many hats",
    value: "Too many hats",
    source: "job_text",
    aliases: ["many hats", "spread thin"],
  },
  {
    emoji: "🧱",
    label: "No ownership",
    value: "No ownership",
    source: "interview_signal",
    aliases: ["ownership", "agency"],
  },
  {
    emoji: "🧑‍⚖️",
    label: "Approval-heavy culture",
    value: "Approval-heavy culture",
    source: "interview_signal",
    aliases: ["approval", "bureaucracy"],
  },
  {
    emoji: "🌀",
    label: "Interview chaos",
    value: "Interview chaos",
    source: "interview_signal",
    aliases: ["interview process", "process chaos"],
  },
  {
    emoji: "🚩",
    label: "Recruiter red flags",
    value: "Recruiter red flags",
    source: "interview_signal",
    aliases: ["recruiter", "red flags"],
  },
  {
    emoji: "🕳️",
    label: "Ghosting risk",
    value: "Ghosting risk",
    source: "interview_signal",
    aliases: ["ghost", "unresponsive"],
  },
  {
    emoji: "🪫",
    label: "Low team energy",
    value: "Low team energy",
    source: "interview_signal",
    aliases: ["energy", "burnout"],
  },
  {
    emoji: "🔄",
    label: "High turnover",
    value: "High turnover",
    source: "company_scan",
    aliases: ["turnover", "attrition"],
  },
  {
    emoji: "💣",
    label: "Funding risk",
    value: "Funding risk",
    source: "company_scan",
    aliases: ["runway", "funding"],
  },
  {
    emoji: "📰",
    label: "Bad public sentiment",
    value: "Bad public sentiment",
    source: "company_scan",
    aliases: ["sentiment", "news", "press"],
  },
  {
    emoji: "⚖️",
    label: "Legal or regulatory risk",
    value: "Legal or regulatory risk",
    source: "company_scan",
    aliases: ["legal", "regulatory"],
  },
  {
    emoji: "📦",
    label: "Tiny team",
    value: "Tiny team",
    source: "job_text",
    aliases: ["startup", "small team"],
  },
  {
    emoji: "🏭",
    label: "Enterprise-only work",
    value: "Enterprise-only work",
    source: "job_text",
    aliases: ["enterprise"],
  },
  {
    emoji: "🧲",
    label: "Sales-led roadmap",
    value: "Sales-led roadmap",
    source: "interview_signal",
    aliases: ["sales-led", "sales driven"],
  },
  {
    emoji: "🙈",
    label: "Weak manager signal",
    value: "Weak manager signal",
    source: "interview_signal",
    aliases: ["manager", "boss"],
  },
  {
    emoji: "🧵",
    label: "Fragmented responsibilities",
    value: "Fragmented responsibilities",
    source: "job_text",
    aliases: ["fragmented", "scattered"],
  },
  {
    emoji: "🔐",
    label: "Clearance required",
    value: "Clearance required",
    source: "job_text",
    aliases: ["clearance", "security clearance"],
  },
  {
    emoji: "🌍",
    label: "Timezone mismatch",
    value: "Timezone mismatch",
    source: "job_text",
    aliases: ["timezone", "time zone"],
  },
  {
    emoji: "🪙",
    label: "Commission-heavy",
    value: "Commission-heavy",
    source: "job_text",
    aliases: ["commission", "bonus-heavy"],
  },
  {
    emoji: "📍",
    label: "Relocation required",
    value: "Relocation required",
    source: "job_text",
    aliases: ["relocate", "relocation"],
  },
  {
    emoji: "🛫",
    label: "Travel over 25%",
    value: "Travel over 25%",
    source: "job_text",
    aliases: ["25% travel", "travel required"],
  },
  {
    emoji: "📝",
    label: "Large unpaid take-home",
    value: "Large unpaid take-home",
    source: "interview_signal",
    aliases: ["take home", "take-home", "homework", "assignment"],
  },
  {
    emoji: "🕰️",
    label: "Slow hiring process",
    value: "Slow hiring process",
    source: "interview_signal",
    aliases: ["slow process", "delays", "timeline"],
  },
  {
    emoji: "🎯",
    label: "No clear priorities",
    value: "No clear priorities",
    source: "interview_signal",
    aliases: ["priorities", "focus"],
  },
  {
    emoji: "🧭",
    label: "Strategy churn",
    value: "Strategy churn",
    source: "company_scan",
    aliases: ["pivot", "churn", "strategy changes"],
  },
  {
    emoji: "🧯",
    label: "Burnout culture",
    value: "Burnout culture",
    source: "interview_signal",
    aliases: ["burnout", "stress"],
  },
  {
    emoji: "🧑‍🏫",
    label: "No mentorship",
    value: "No mentorship",
    source: "interview_signal",
    aliases: ["mentorship", "coaching"],
  },
  {
    emoji: "🧑‍🔬",
    label: "Research-only work",
    value: "Research-only work",
    source: "job_text",
    aliases: ["research only", "pure research"],
  },
  {
    emoji: "🚪",
    label: "Backfill after attrition",
    value: "Backfill after attrition",
    source: "interview_signal",
    aliases: ["backfill", "attrition"],
  },
  {
    emoji: "🧷",
    label: "Undefined role",
    value: "Undefined role",
    source: "job_text",
    aliases: ["undefined", "ambiguous role"],
  },
  {
    emoji: "📊",
    label: "Metrics theater",
    value: "Metrics theater",
    source: "interview_signal",
    aliases: ["metrics theater", "vanity metrics"],
  },
  {
    emoji: "🧑‍💻",
    label: "Little hands-on coding",
    value: "Little hands-on coding",
    source: "job_text",
    aliases: ["no coding", "hands-on"],
  },
  {
    emoji: "🔇",
    label: "Poor communication",
    value: "Poor communication",
    source: "interview_signal",
    aliases: ["communication", "unclear updates"],
  },
  {
    emoji: "🧱",
    label: "Blocked by dependencies",
    value: "Blocked by dependencies",
    source: "interview_signal",
    aliases: ["dependencies", "blocked"],
  },
];

export const GUARDRAIL_SUGGESTIONS = [...GUARDRAIL_PRESETS, ...EXTRA_GUARDRAIL_SUGGESTIONS];

const GUARDRAIL_SOURCE_LABELS = {
  job_text: "Job text",
  company_scan: "Company scan",
  interview_signal: "Interview signal",
};

const GUARDRAILS_INFO =
  "Some guardrails are visible in job posts. Company-risk signals require company sentiment scanning; others are uncovered during recruiter screens and interviews.";

export function normalizeSignals(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
}

export function isGuardrailSelected(values, signal) {
  const normalizedSignal = String(signal || "")
    .trim()
    .toLowerCase();
  if (!normalizedSignal) return false;
  return normalizeSignals(values).some((value) => value.toLowerCase() === normalizedSignal);
}

export function toggleGuardrailSignal(values, signal) {
  const normalized = normalizeSignals(values);
  const trimmed = String(signal || "").trim();
  return isGuardrailSelected(normalized, trimmed)
    ? normalized.filter((value) => value.toLowerCase() !== trimmed.toLowerCase())
    : [...normalized, trimmed].filter(Boolean);
}

export function guardrailSuggestionsForDraft(draft, selectedValues = []) {
  return filterChipSuggestions({
    draft,
    values: selectedValues,
    suggestions: GUARDRAIL_SUGGESTIONS,
    limit: 8,
  });
}

function seedGuardrails({ savedTargeting, draftTargeting }) {
  return savedTargeting.cut_signals?.length
    ? normalizeSignals(savedTargeting.cut_signals)
    : normalizeSignals(draftTargeting.cut_signals);
}

export function GuardrailsStep({ state, draftSeeds, goNext, goBack, onProgressSelect, showToast }) {
  const savedTargeting = state?.data?.targeting ?? {};
  const draftTargeting = draftSeeds?.targeting ?? {};
  const [avoidSignals, setAvoidSignals] = useState(() =>
    seedGuardrails({ savedTargeting, draftTargeting })
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSaveAndNext() {
    setSaving(true);
    setError(null);
    try {
      await saveCandidateFile("targeting", { cut_signals: avoidSignals });
      showToast("Saved.");
      goNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <OnboardingShell
      activeIndex={5}
      className="onboarding-shell--targeting"
      onProgressSelect={onProgressSelect}
      actions={
        <>
          <OnboardingNavButton direction="back" label="Back" onClick={goBack} />
          <OnboardingNavButton
            direction="next"
            label="Continue"
            onClick={handleSaveAndNext}
            disabled={saving}
          />
        </>
      }
    >
      <div className="onboarding-step-stack onboarding-step-stack--targeting">
        <div className="onboarding-step-label">Step 5</div>
        <section
          className="onboarding-step-card onboarding-targeting onboarding-guardrails"
          aria-labelledby="onboarding-guardrails-title"
        >
          <section
            className="onboarding-step-card__media onboarding-targeting__media"
            aria-label="Guardrail setup"
          >
            <div className="onboarding-targeting__mark" aria-hidden="true">
              🚫
            </div>
            <div className="onboarding-targeting__media-copy">
              <h1 id="onboarding-guardrails-title">Guardrails</h1>
              <p className="onboarding-guardrails__side-note">
                These apply across every role lane. Want to mark something role-specific as a bad
                fit? Go back to{" "}
                <button
                  type="button"
                  className="onboarding-inline-link"
                  aria-label="Go back to Roles"
                  data-step-index="3"
                  onClick={() => onProgressSelect?.(3)}
                >
                  Roles
                </button>
                .
              </p>
            </div>
          </section>

          <div className="onboarding-step-card__content onboarding-step-card__content--dense onboarding-targeting__content onboarding-targeting__content--signals">
            {error ? <InlineAlert message={error} /> : null}
            <section className="onboarding-guardrails__panel" aria-label="Guardrail choices">
              <div className="onboarding-guardrails__presets">
                <div className="onboarding-guardrails__preset-header">
                  <span>Pick common guardrails</span>
                  <span className="onboarding-guardrails__info">
                    <button
                      type="button"
                      className="onboarding-guardrails__info-button"
                      aria-label="How CareerRat detects guardrails"
                    >
                      <InfoIcon className="onboarding-guardrails__info-icon" />
                    </button>
                    <span className="onboarding-guardrails__tooltip" role="tooltip">
                      {GUARDRAILS_INFO}
                    </span>
                  </span>
                </div>
                <section
                  className="onboarding-guardrails__preset-grid"
                  aria-label="Common guardrails"
                >
                  {GUARDRAIL_PRESETS.map((preset) => {
                    const selected = isGuardrailSelected(avoidSignals, preset.value);
                    const sourceLabel = GUARDRAIL_SOURCE_LABELS[preset.source] || "CareerRat signal";
                    return (
                      <button
                        key={preset.value}
                        type="button"
                        className={`onboarding-guardrails__preset ${selected ? "onboarding-guardrails__preset--selected" : ""}`.trim()}
                        aria-pressed={selected}
                        title={`Detected from: ${sourceLabel}`}
                        onClick={() =>
                          setAvoidSignals((current) => toggleGuardrailSignal(current, preset.value))
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
                label="Custom guardrails"
                htmlFor="guardrails-avoid-signals"
                hint="Press Enter or comma to add another guardrail."
                className="onboarding-custom-entry onboarding-guardrails__custom-field"
              >
                <ChipInput
                  id="guardrails-avoid-signals"
                  values={avoidSignals}
                  onChange={setAvoidSignals}
                  placeholder="e.g. heavy travel"
                  suggestions={GUARDRAIL_SUGGESTIONS}
                  suggestionLimit={8}
                />
              </Field>
            </section>
          </div>
        </section>
      </div>
    </OnboardingShell>
  );
}
