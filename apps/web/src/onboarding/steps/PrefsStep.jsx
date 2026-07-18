import { useState } from "react";
import { ChipInput, Field, NumberField, TextField } from "../../components/form.jsx";
import { GitHubIcon, GlobeIcon, LinkedInIcon } from "../../components/icons.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import { saveCandidateFile } from "../../lib/api.js";
import { OnboardingNavButton, OnboardingShell } from "../OnboardingShell.jsx";

// Location gate (search-shaping): work mode is a multi-select (a candidate
// can be open to more than one) but only the "remote" pick is a real signal
// downstream — src/core/profile/generate-search-sources.mjs's location_filter
// only reads profile.location.{remote,home,relocation}; hybrid vs. onsite
// makes no difference to search generation today, so it stays local UI state
// rather than a persisted field (no parallel shape invented on profile.location).
const WORK_MODE_OPTIONS = [
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
  { value: "onsite", label: "On-site" },
];

const DEFAULT_MODES = {
  usage_mode: "standard",
  application_mode: "balanced",
  agent_voice: "standard",
};

const LINK_FIELDS = ["linkedin", "github", "portfolio"];
const ADDITIONAL_LINK_PREFIX = "https://";
let additionalLinkDraftSequence = 0;
export const LINK_PREFIXES = {
  linkedin: "https://linkedin.com/in/",
  github: "https://github.com/",
  portfolio: "https://",
};

const LINK_PLACEHOLDERS = {
  linkedin: "your-slug",
  github: "username",
  portfolio: "your-site.com",
};

const LINK_FIELD_META = [
  {
    field: "linkedin",
    label: "LinkedIn",
    iconClass: "linkedin",
    Icon: LinkedInIcon,
  },
  {
    field: "github",
    label: "GitHub",
    iconClass: "github",
    Icon: GitHubIcon,
  },
  {
    field: "portfolio",
    label: "Website",
    iconClass: "website",
    Icon: GlobeIcon,
  },
];

function cleanPrimaryLinkFields(values = {}) {
  return Object.fromEntries(
    LINK_FIELDS.map((field) => [field, String(values[field] ?? "").trim()])
  );
}

export function cleanAdditionalLinks(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((link) => ({
      label: String(link?.label || "").trim() || "Link",
      url: String(link?.url || "").trim(),
    }))
    .filter((link) => link.url);
}

function cleanLinkFields(values = {}) {
  return {
    ...cleanPrimaryLinkFields(values),
    additional_links: cleanAdditionalLinks(values.additional_links),
  };
}

function createAdditionalLinkDraft(link = {}) {
  additionalLinkDraftSequence += 1;
  return {
    id: link.id || `quick-facts-extra-${additionalLinkDraftSequence}`,
    label: String(link.label ?? ""),
    url: String(link.url ?? ""),
  };
}

function withAdditionalLinkDrafts(values = {}) {
  return {
    ...values,
    additional_links: (Array.isArray(values.additional_links) ? values.additional_links : []).map(
      createAdditionalLinkDraft
    ),
  };
}

export function prefixedLinkFocusValue(value, prefix) {
  return String(value || "").trim() ? value : prefix;
}

export function prefixedLinkBackspaceValue({ value, prefix, selectionStart, selectionEnd } = {}) {
  const text = String(value || "");
  if (
    text === prefix &&
    selectionStart === selectionEnd &&
    Number(selectionStart) <= prefix.length
  ) {
    return "";
  }
  return null;
}

export function prefixedLinkPasteValue(value, prefix) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (text.toLowerCase().startsWith(prefix.toLowerCase())) return text;
  return `${prefix}${text.replace(/^\/+/, "")}`;
}

export function seedQuickFactsLinks(data = {}) {
  const candidate = data.profile?.candidate ?? {};
  const formDefaults = data["form-defaults"] ?? {};
  return cleanLinkFields({
    linkedin: candidate.linkedin ?? formDefaults.linkedin,
    github: candidate.github ?? formDefaults.github,
    portfolio: candidate.portfolio ?? formDefaults.portfolio,
    additional_links: candidate.additional_links ?? formDefaults.additional_links,
  });
}

function compensationPatch(minimumBase) {
  return typeof minimumBase === "number" && Number.isFinite(minimumBase) && minimumBase > 0
    ? { compensation: { minimum_base: minimumBase } }
    : {};
}

function authorizationPatch(authChoice) {
  if (authChoice === "authorized") {
    return { authorization: { work_authorized: true, requires_sponsorship: false } };
  }
  if (authChoice === "sponsorship") {
    return { authorization: { work_authorized: false, requires_sponsorship: true } };
  }
  return {};
}

// profile.location shape mirrors EXACTLY what generate-search-sources.mjs
// reads (loc.remote / loc.home / loc.relocation, ~lines 115-127 there) — no
// extra fields. Lenient like compensationPatch/authorizationPatch above: any
// signal (a work mode pick, a home base, or a relocation city) is enough to
// write the object; all-empty means nothing to say yet, so skip the patch
// rather than stomping a previously-saved value with zeros.
function locationPatch({ workModes = [], homeBase = "", relocationList = [] } = {}) {
  const remote = Array.isArray(workModes) && workModes.includes("remote");
  const home = String(homeBase || "").trim();
  const relocation = (Array.isArray(relocationList) ? relocationList : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!remote && !home && !relocation.length) return {};
  return { location: { remote, home, relocation } };
}

// The resume-header location string (candidate.location) only gets filled in
// from the onboarding home-base field when it's genuinely empty — never
// overwritten once the resume (or a prior save) already set it.
function candidateLocationPatch({ homeBase = "", existingCandidateLocation = "" } = {}) {
  const home = String(homeBase || "").trim();
  const existing = String(existingCandidateLocation || "").trim();
  if (!home || existing) return {};
  return { location: home };
}

export function buildQuickFactsSavePayload({
  links = {},
  modesData = {},
  formDefaultsData = {},
  minimumBase = null,
  authChoice = null,
  workModes = [],
  homeBase = "",
  relocationList = [],
  existingCandidateLocation = "",
} = {}) {
  const cleanedLinks = cleanLinkFields(links);
  return {
    profile: {
      candidate: {
        ...cleanedLinks,
        ...candidateLocationPatch({ homeBase, existingCandidateLocation }),
      },
      ...compensationPatch(minimumBase),
      ...authorizationPatch(authChoice),
      ...locationPatch({ workModes, homeBase, relocationList }),
    },
    modes: {
      usage_mode: modesData.usage_mode ?? DEFAULT_MODES.usage_mode,
      application_mode: modesData.application_mode ?? DEFAULT_MODES.application_mode,
      agent_voice: modesData.agent_voice ?? DEFAULT_MODES.agent_voice,
    },
    formDefaults: {
      auto_submit: false,
      eeo_default: String(formDefaultsData.eeo_default || "").trim() || "Prefer not to answer",
      ...cleanedLinks,
    },
  };
}

function PrefixedLinkField({ id, value, onChange, prefix, placeholder }) {
  function placeCaretAfterPrefix(input) {
    const caret = prefix.length;
    globalThis.setTimeout?.(() => {
      try {
        input.setSelectionRange(caret, caret);
      } catch {
        // Some input types/environments do not expose selection APIs.
      }
    }, 0);
  }

  return (
    <TextField
      id={id}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      data-link-prefix={prefix}
      onFocus={(event) => {
        const next = prefixedLinkFocusValue(value, prefix);
        if (next !== value) {
          onChange(next);
          placeCaretAfterPrefix(event.currentTarget);
        } else if (next === prefix) {
          placeCaretAfterPrefix(event.currentTarget);
        }
      }}
      onBlur={(event) => {
        if (event.currentTarget.value === prefix) onChange("");
      }}
      onKeyDown={(event) => {
        if (event.key !== "Backspace") return;
        const next = prefixedLinkBackspaceValue({
          value,
          prefix,
          selectionStart: event.currentTarget.selectionStart,
          selectionEnd: event.currentTarget.selectionEnd,
        });
        if (next === null) return;
        event.preventDefault();
        onChange(next);
      }}
      onPaste={(event) => {
        const pasted = event.clipboardData?.getData("text");
        if (!pasted) return;
        event.preventDefault();
        onChange(prefixedLinkPasteValue(pasted, prefix));
      }}
    />
  );
}

function ProfileLinkRow({ field, label, iconClass, Icon, value, onChange }) {
  const id = `quick-facts-${field}`;

  return (
    <div className={`onboarding-quick-facts__link-row onboarding-quick-facts__link-row--${field}`}>
      <span
        className={`onboarding-quick-facts__link-icon onboarding-quick-facts__link-icon--${iconClass}`}
        aria-hidden="true"
      >
        <Icon />
      </span>
      <Field label={label} htmlFor={id} className="onboarding-quick-facts__link-field">
        <PrefixedLinkField
          id={id}
          value={value}
          onChange={onChange}
          prefix={LINK_PREFIXES[field]}
          placeholder={LINK_PLACEHOLDERS[field]}
        />
      </Field>
    </div>
  );
}

function AdditionalLinkRow({ link, index, onChange, onRemove }) {
  const label = String(link?.label ?? "");
  const url = String(link?.url ?? "");
  const labelId = `quick-facts-custom-${index}-label`;
  const urlId = `quick-facts-custom-${index}-url`;
  const removeLabel = `Remove ${label.trim() || "link"}`;

  return (
    <div className="onboarding-quick-facts__custom-link">
      <span
        className="onboarding-quick-facts__link-icon onboarding-quick-facts__link-icon--custom"
        aria-hidden="true"
      >
        <GlobeIcon />
      </span>
      <div className="onboarding-quick-facts__custom-fields">
        <Field label="Name" htmlFor={labelId} className="onboarding-quick-facts__custom-label">
          <TextField
            id={labelId}
            value={label}
            onChange={(value) => onChange({ ...link, label: value })}
            placeholder="Label"
          />
        </Field>
        <Field label="URL" htmlFor={urlId} className="onboarding-quick-facts__custom-url">
          <PrefixedLinkField
            id={urlId}
            value={url}
            onChange={(value) => onChange({ ...link, url: value })}
            prefix={ADDITIONAL_LINK_PREFIX}
            placeholder="https://example.com"
          />
        </Field>
      </div>
      <button
        type="button"
        className="onboarding-quick-facts__custom-remove"
        aria-label={removeLabel}
        title={removeLabel}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}

// Step 6 — Quick facts. Keep onboarding focused on public profile links; app
// modes, EEO defaults, current role, and compensation live outside this step.
export function PrefsStep({ state, goNext, goBack, onProgressSelect, showToast }) {
  const profileData = state?.data?.profile ?? {};
  const modesData = state?.data?.modes ?? {};
  const formDefaultsData = state?.data?.["form-defaults"] ?? {};

  const [links, setLinks] = useState(() =>
    withAdditionalLinkDrafts(
      seedQuickFactsLinks({ profile: profileData, "form-defaults": formDefaultsData })
    )
  );

  const [minimumBase, setMinimumBase] = useState(() => {
    const value = profileData.compensation?.minimum_base;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  });
  const [authChoice, setAuthChoice] = useState(() => {
    const authorization = profileData.authorization || {};
    if (authorization.work_authorized === true) return "authorized";
    if (authorization.requires_sponsorship === true) return "sponsorship";
    return null;
  });

  // Location gate. Only `remote` round-trips from a saved value (see
  // WORK_MODE_OPTIONS' comment) — hybrid/onsite start unselected on reload.
  // Home base prefers a previously saved profile.location.home, falling back
  // to the resume-extracted candidate.location header field.
  const [workModes, setWorkModes] = useState(() =>
    profileData.location?.remote ? ["remote"] : []
  );
  const [homeBase, setHomeBase] = useState(() =>
    String(profileData.location?.home || profileData.candidate?.location || "").trim()
  );
  const [relocationList, setRelocationList] = useState(() =>
    Array.isArray(profileData.location?.relocation)
      ? profileData.location.relocation.filter(Boolean)
      : []
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  function toggleWorkMode(mode) {
    setWorkModes((current) =>
      current.includes(mode) ? current.filter((value) => value !== mode) : [...current, mode]
    );
  }

  async function handleSaveAndNext() {
    setSaving(true);
    setError(null);
    try {
      const payload = buildQuickFactsSavePayload({
        links,
        modesData,
        formDefaultsData,
        minimumBase,
        authChoice,
        workModes,
        homeBase,
        relocationList,
        existingCandidateLocation: profileData.candidate?.location,
      });
      await saveCandidateFile("profile", payload.profile);
      await saveCandidateFile("modes", payload.modes);
      await saveCandidateFile("form-defaults", payload.formDefaults);
      showToast("Saved.");
      goNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const additionalLinks = Array.isArray(links.additional_links) ? links.additional_links : [];

  function updateAdditionalLink(index, nextLink) {
    setLinks((current) => {
      const currentLinks = Array.isArray(current.additional_links) ? current.additional_links : [];
      return {
        ...current,
        additional_links: currentLinks.map((link, linkIndex) =>
          linkIndex === index ? nextLink : link
        ),
      };
    });
  }

  function removeAdditionalLink(index) {
    setLinks((current) => {
      const currentLinks = Array.isArray(current.additional_links) ? current.additional_links : [];
      return {
        ...current,
        additional_links: currentLinks.filter((_, linkIndex) => linkIndex !== index),
      };
    });
  }

  function addAdditionalLink() {
    setLinks((current) => {
      const currentLinks = Array.isArray(current.additional_links) ? current.additional_links : [];
      return {
        ...current,
        additional_links: [...currentLinks, createAdditionalLinkDraft()],
      };
    });
  }

  return (
    <OnboardingShell
      activeIndex={6}
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
        <div className="onboarding-step-label">Step 6</div>
        <section
          className="onboarding-step-card onboarding-targeting onboarding-quick-facts"
          aria-labelledby="quick-facts-title"
        >
          <section
            className="onboarding-step-card__media onboarding-targeting__media"
            aria-label="Quick facts"
          >
            <div className="onboarding-targeting__mark" aria-hidden="true">
              🪪
            </div>
            <div className="onboarding-targeting__media-copy">
              <h1 id="quick-facts-title">Quick facts</h1>
              <p>Confirm the public links and basics Roland can reuse in packets and forms.</p>
            </div>
          </section>

          <div className="onboarding-step-card__content onboarding-step-card__content--dense onboarding-targeting__content onboarding-quick-facts__content">
            {error ? <InlineAlert message={error} /> : null}

            <section className="onboarding-targeting__signal-panel onboarding-targeting__signal-panel--quiet onboarding-quick-facts__panel">
              {LINK_FIELD_META.map(({ field, label, iconClass, Icon }) => (
                <ProfileLinkRow
                  key={field}
                  field={field}
                  label={label}
                  iconClass={iconClass}
                  Icon={Icon}
                  value={links[field]}
                  onChange={(value) => setLinks((current) => ({ ...current, [field]: value }))}
                />
              ))}

              <div className="onboarding-quick-facts__extra-fields">
                <Field
                  label="Minimum base salary"
                  htmlFor="quick-facts-minimum-base"
                  hint="USD per year. Optional."
                >
                  <NumberField
                    id="quick-facts-minimum-base"
                    value={minimumBase}
                    onChange={setMinimumBase}
                    placeholder="Annual base, USD"
                    min="0"
                    step="1000"
                  />
                </Field>
                <div className="field">
                  <span className="field__label">Work authorization</span>
                  <div
                    className="onboarding-quick-facts__pill-row"
                    role="radiogroup"
                    aria-label="Work authorization"
                  >
                    <button
                      type="button"
                      className={`onboarding-targeting__priority-choice${authChoice === "authorized" ? " onboarding-targeting__priority-choice--active" : ""}`}
                      aria-pressed={authChoice === "authorized"}
                      onClick={() =>
                        setAuthChoice((current) => (current === "authorized" ? null : "authorized"))
                      }
                    >
                      Authorized to work
                    </button>
                    <button
                      type="button"
                      className={`onboarding-targeting__priority-choice${authChoice === "sponsorship" ? " onboarding-targeting__priority-choice--active" : ""}`}
                      aria-pressed={authChoice === "sponsorship"}
                      onClick={() =>
                        setAuthChoice((current) =>
                          current === "sponsorship" ? null : "sponsorship"
                        )
                      }
                    >
                      Need sponsorship
                    </button>
                  </div>
                  <span className="field__hint">Optional.</span>
                </div>
                <div className="field">
                  <span className="field__label">Work mode</span>
                  <fieldset className="onboarding-quick-facts__pill-row" aria-label="Work mode">
                    {WORK_MODE_OPTIONS.map((option) => {
                      const selected = workModes.includes(option.value);
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={`onboarding-targeting__priority-choice${selected ? " onboarding-targeting__priority-choice--active" : ""}`}
                          aria-pressed={selected}
                          onClick={() => toggleWorkMode(option.value)}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </fieldset>
                  <span className="field__hint">Pick every mode you'd take. Optional.</span>
                </div>
                <Field
                  label="Home base"
                  htmlFor="quick-facts-home-base"
                  hint="City, state, or country. Helps match hybrid and on-site roles near you."
                >
                  <TextField
                    id="quick-facts-home-base"
                    value={homeBase}
                    onChange={setHomeBase}
                    placeholder="City, state or country"
                  />
                </Field>
                <Field
                  label="Open to relocating"
                  htmlFor="quick-facts-relocation"
                  hint="Press Enter or comma to add another city."
                  className="onboarding-custom-entry"
                >
                  <ChipInput
                    id="quick-facts-relocation"
                    values={relocationList}
                    onChange={setRelocationList}
                    placeholder="e.g. Austin, TX"
                  />
                </Field>
              </div>

              <div className="onboarding-quick-facts__add-area">
                {additionalLinks.map((link, index) => (
                  <AdditionalLinkRow
                    key={link.id}
                    link={link}
                    index={index}
                    onChange={(nextLink) => updateAdditionalLink(index, nextLink)}
                    onRemove={() => removeAdditionalLink(index)}
                  />
                ))}
                <button
                  type="button"
                  className="onboarding-quick-facts__add-button"
                  onClick={addAdditionalLink}
                >
                  <span aria-hidden="true">+</span>
                  Add more
                </button>
              </div>
            </section>
          </div>
        </section>
      </div>
    </OnboardingShell>
  );
}
