/**
 * form-fill.mjs — M9 apply-assistant form-fill core
 *
 * Pure logic: field mapping + safety decisions.
 * No browser automation. No runtime dependencies.
 * Produces recipes/plans the agent executes.
 */

// ---------------------------------------------------------------------------
// CANONICAL_FIELDS
// ---------------------------------------------------------------------------

export const CANONICAL_FIELDS = [
  "full_name",
  "first_name",
  "last_name",
  "email",
  "phone",
  "location",
  "linkedin",
  "github",
  "portfolio",
  "work_authorization",
  "requires_sponsorship",
  "source",
  "current_employer",
  "current_title",
  "expected_base",
  "eeo",
];

// ---------------------------------------------------------------------------
// PORTAL_RECIPES
// ---------------------------------------------------------------------------

export const PORTAL_RECIPES = {
  greenhouse: {
    labelMap: {
      "first name": "first_name",
      "last name": "last_name",
      "full name": "full_name",
      email: "email",
      "email address": "email",
      phone: "phone",
      "phone number": "phone",
      location: "location",
      city: "location",
      "linkedin profile": "linkedin",
      "linkedin url": "linkedin",
      linkedin: "linkedin",
      github: "github",
      "github profile": "github",
      "github url": "github",
      portfolio: "portfolio",
      website: "portfolio",
      "personal website": "portfolio",
      "are you authorized to work": "work_authorization",
      "work authorization": "work_authorization",
      "authorized to work": "work_authorization",
      "will you now or in the future require sponsorship": "requires_sponsorship",
      "require sponsorship": "requires_sponsorship",
      sponsorship: "requires_sponsorship",
      "how did you hear about us": "source",
      source: "source",
      "current employer": "current_employer",
      "current company": "current_employer",
      employer: "current_employer",
      "current title": "current_title",
      "current job title": "current_title",
      title: "current_title",
      "expected salary": "expected_base",
      "expected compensation": "expected_base",
      "desired salary": "expected_base",
      "salary expectations": "expected_base",
    },
    notes: "Greenhouse uses label text matching; EEO section is a separate form block.",
  },
  lever: {
    labelMap: {
      name: "full_name",
      "full name": "full_name",
      "first name": "first_name",
      "last name": "last_name",
      email: "email",
      "email address": "email",
      phone: "phone",
      "phone number": "phone",
      location: "location",
      "current location": "location",
      linkedin: "linkedin",
      "linkedin profile": "linkedin",
      "linkedin url": "linkedin",
      github: "github",
      "github profile": "github",
      portfolio: "portfolio",
      website: "portfolio",
      "work authorization": "work_authorization",
      "are you authorized": "work_authorization",
      sponsorship: "requires_sponsorship",
      "require sponsorship": "requires_sponsorship",
      source: "source",
      "how did you hear": "source",
      "current company": "current_employer",
      "current employer": "current_employer",
      "current title": "current_title",
      "expected salary": "expected_base",
      "desired salary": "expected_base",
      compensation: "expected_base",
    },
    notes: "Lever uses name/placeholder matching; check for custom questions.",
  },
  ashby: {
    labelMap: {
      "first name": "first_name",
      "last name": "last_name",
      "full name": "full_name",
      email: "email",
      "email address": "email",
      phone: "phone",
      "phone number": "phone",
      location: "location",
      linkedin: "linkedin",
      "linkedin profile": "linkedin",
      github: "github",
      "github url": "github",
      portfolio: "portfolio",
      website: "portfolio",
      "work authorization": "work_authorization",
      "authorized to work in": "work_authorization",
      "visa sponsorship": "requires_sponsorship",
      "require sponsorship": "requires_sponsorship",
      "how did you hear about this role": "source",
      source: "source",
      "current employer": "current_employer",
      "current company": "current_employer",
      "current title": "current_title",
      "current job title": "current_title",
      "desired compensation": "expected_base",
      "expected salary": "expected_base",
      "salary expectation": "expected_base",
      eeo: "eeo",
      gender: "eeo",
      race: "eeo",
      ethnicity: "eeo",
      "veteran status": "eeo",
      "disability status": "eeo",
    },
    quirks: [
      "Yes/No toggle buttons and custom radios: the SELECTED state lives in the `_active` CSS class plus a filled background color, NOT in aria-pressed/aria-checked (both null). The accessibility-tree `[active]` marker is FOCUS, not selection, so it lies about which option is chosen. Verify each choice by reading className / computed background, not the snapshot.",
      "When a ref-click does not flip a toggle to `_active`, fall back to a native element.click() (via script-evaluate) on the indexed button; React's onClick fires and the state updates.",
      "Phone field can false-negative on a programmatic fill (validation refuses it at submit even though the value shows). Fix: focus, select-all, delete, then re-type slowly / sequentially.",
      "Some Ashby forms embed a managed Cloudflare Turnstile that auto-issues its token and submits with NO checkbox interaction. Do not pre-click Submit before the token exists or it jams on 'Submitting...'. This is not a captcha to solve and not a blocker.",
      "Resume upload is the explicit Resume* field's Upload File button (modal-first). Skip the top 'Autofill from resume' dropzone.",
    ],
    notes: "Ashby uses structured form sections; EEO may be a separate survey.",
  },
  workable: {
    labelMap: {
      "first name": "first_name",
      "last name": "last_name",
      "full name": "full_name",
      name: "full_name",
      email: "email",
      "email address": "email",
      phone: "phone",
      "phone number": "phone",
      location: "location",
      city: "location",
      linkedin: "linkedin",
      "linkedin profile url": "linkedin",
      github: "github",
      portfolio: "portfolio",
      "personal website": "portfolio",
      "work authorization": "work_authorization",
      "are you legally authorized": "work_authorization",
      "require visa sponsorship": "requires_sponsorship",
      "sponsorship required": "requires_sponsorship",
      source: "source",
      "how did you find this job": "source",
      "current company": "current_employer",
      "current employer": "current_employer",
      "job title": "current_title",
      "current title": "current_title",
      "expected salary": "expected_base",
      salary: "expected_base",
      "desired salary": "expected_base",
    },
    quirks: [
      "Many Workable forms gate submit behind a managed Cloudflare Turnstile that auto-issues its token with NO checkbox interaction. Do not pre-click Submit before the token resolves or it jams on 'Submitting...'. The page settles to a `?success` URL on completion. This is not a captcha to solve and not a blocker.",
      "Modal form; custom employer questions vary. Submitting often emails the candidate a copy of the application.",
    ],
    notes: "Workable uses a modal form; custom questions vary by employer.",
  },
  // [#22] SmartRecruiters ATS recipe
  smartrecruiters: {
    labelMap: {
      "first name": "first_name",
      "last name": "last_name",
      "full name": "full_name",
      email: "email",
      "email address": "email",
      phone: "phone",
      "phone number": "phone",
      location: "location",
      "linkedin profile url": "linkedin",
      linkedin: "linkedin",
      resume: "resume",
      "attach resume": "resume",
      "resume cv": "resume",
      "work authorization": "work_authorization",
      "are you authorized to work": "work_authorization",
      "authorized to work": "work_authorization",
      "require visa sponsorship": "requires_sponsorship",
      sponsorship: "requires_sponsorship",
      "require sponsorship": "requires_sponsorship",
      source: "source",
      "how did you hear about us": "source",
      "current employer": "current_employer",
      "current company": "current_employer",
      "current title": "current_title",
      "current job title": "current_title",
      "expected salary": "expected_base",
      "desired salary": "expected_base",
      "salary expectations": "expected_base",
    },
    notes: "SmartRecruiters uses a stepped wizard; resume upload is a distinct step.",
  },
  // [#M12] LinkedIn Easy Apply modal recipe
  linkedin: {
    labelMap: {
      "first name": "first_name",
      "last name": "last_name",
      "full name": "full_name",
      email: "email",
      "email address": "email",
      phone: "phone",
      "phone number": "phone",
      "mobile phone number": "phone",
      location: "location",
      city: "location",
      linkedin: "linkedin",
      "linkedin profile": "linkedin",
      github: "github",
      portfolio: "portfolio",
      website: "portfolio",
      "are you legally authorized to work": "work_authorization",
      "authorized to work": "work_authorization",
      "will you now or in the future require sponsorship": "requires_sponsorship",
      "require sponsorship": "requires_sponsorship",
      "visa sponsorship": "requires_sponsorship",
      "how did you hear": "source",
      "current company": "current_employer",
      "current employer": "current_employer",
      "current title": "current_title",
      "current job title": "current_title",
      "expected salary": "expected_base",
      "desired salary": "expected_base",
      "salary expectations": "expected_base",
      gender: "eeo",
      race: "eeo",
      ethnicity: "eeo",
      veteran: "eeo",
      disability: "eeo",
    },
    notes:
      "LinkedIn Easy Apply is a MULTI-STEP MODAL (Contact info → Resume → Additional questions → Review → Submit application), not a single page. Fields appear progressively per modal step.",
  },
  // NOTE: Workday, iCIMS, and Rippling have no recipe here — they are
  // known-unsupported portals (non-standard DOM / server-side rendering).
  // This gap is deliberate. Add a recipe when a reliable label-map is confirmed.
};

// ---------------------------------------------------------------------------
// hostnameToPortal
// ---------------------------------------------------------------------------

/**
 * Map a live ATS URL's hostname to the matching PORTAL_RECIPES key.
 * Patterns mirror inferProvider() in sourced-scanner.mjs.
 * Returns null when the host is unknown; callers should fall back to genericMatch.
 * Handles malformed URLs without throwing.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function hostnameToPortal(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const h = parsed.hostname;
  if (/jobs\.ashbyhq\.com$/.test(h)) return "ashby";
  if (/job-boards(?:\.eu)?\.greenhouse\.io$|boards\.greenhouse\.io$/.test(h)) return "greenhouse";
  if (/jobs(?:\.eu)?\.lever\.co$/.test(h)) return "lever";
  if (/apply\.workable\.com$/.test(h)) return "workable";
  if (/(?:careers|jobs)\.smartrecruiters\.com$/.test(h)) return "smartrecruiters";
  if (/(?:^|\.)linkedin\.com$/.test(h)) return "linkedin";
  return null;
}

// ---------------------------------------------------------------------------
// portalQuirks
// ---------------------------------------------------------------------------

/**
 * Domain-keyed gotchas for hosts that have no PORTAL_RECIPE (Workday, etc.) plus
 * aggregator hosts that FRONT a real ATS rather than being the apply form.
 * Pattern → quirks. Kept separate from PORTAL_RECIPES so non-recipe hosts can
 * still carry known-issue guidance.
 */
export const DOMAIN_QUIRKS = [
  {
    match: /\.myworkdayjobs\.com$|\.myworkday\.com$|workday/i,
    portal: "workday",
    quirks: [
      'Workday rejects RTF uploads and the characters < > [ ] " { } \\ in text fields. Upload DOCX (not RTF) and strip those characters from pasted answers.',
      "Workday almost always requires creating a candidate account (email + password) before applying. Account creation / password entry is a human-only step — halt and write status manual-apply with the apply URL, never create the account.",
      "Server-rendered, multi-step wizard with non-standard DOM. Confirm each step's fields rendered (read body text) before advancing.",
    ],
  },
  {
    // Job-board AGGREGATORS: the page is not the apply form. Find the outbound
    // "Apply on <ATS>" / "Apply now" link and route to the real ATS instead.
    match: /hiring\.cafe$|builtin\.com$|wellfound\.com$|ycombinator\.com$|jobboardly/i,
    portal: "aggregator",
    quirks: [
      "This host is a job-board AGGREGATOR, not the employer's ATS. The apply form lives behind an outbound 'Apply on Ashby' / 'Apply now' link. Extract that href (often Ashby/Greenhouse/Lever/Workday), navigate to it, and run the matching recipe — do not try to submit on the aggregator page.",
    ],
  },
];

/**
 * Resolve the known automation quirks for an apply URL. Combines the matched
 * PORTAL_RECIPE's `quirks` with any DOMAIN_QUIRKS for the host. Returns a stable
 * shape so callers (apply-job) can surface and apply them before filling.
 *
 * @param {string} url
 * @returns {{ portal: string|null, quirks: string[] }}
 */
export function portalQuirks(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }

  const out = [];
  let portal = hostnameToPortal(url);

  if (portal && PORTAL_RECIPES[portal] && Array.isArray(PORTAL_RECIPES[portal].quirks)) {
    out.push(...PORTAL_RECIPES[portal].quirks);
  }

  for (const entry of DOMAIN_QUIRKS) {
    if (host && entry.match.test(host)) {
      if (!portal) portal = entry.portal;
      out.push(...entry.quirks);
    }
  }

  return { portal, quirks: out };
}

// ---------------------------------------------------------------------------
// isEasyApply
// ---------------------------------------------------------------------------

/**
 * Returns true when the URL is a LinkedIn Easy Apply job/apply view.
 * Host-gated: must be linkedin.com. Handles malformed URLs without throwing.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isEasyApply(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/(?:^|\.)linkedin\.com$/.test(parsed.hostname)) return false;
  const path = parsed.pathname;
  return (
    path.includes("/jobs/") ||
    path.includes("/jobs/view/") ||
    path.includes("/job-apply/") ||
    parsed.searchParams.has("easyApplyModal") ||
    parsed.searchParams.has("apply")
  );
}

// ---------------------------------------------------------------------------
// EASY_APPLY_ADVANCE_LABELS
// ---------------------------------------------------------------------------

/** Button-text substrings (lowercase) that advance the Easy Apply modal to the next step. */
export const EASY_APPLY_ADVANCE_LABELS = [
  "next",
  "continue",
  "review",
  "review your application",
  "continue applying",
  "save and continue",
];

// ---------------------------------------------------------------------------
// EASY_APPLY_SUBMIT_LABELS
// ---------------------------------------------------------------------------

/** Button-text substrings (lowercase) for the FINAL submit action in Easy Apply. */
export const EASY_APPLY_SUBMIT_LABELS = ["submit application"];

// ---------------------------------------------------------------------------
// EASY_APPLY_STEPS
// ---------------------------------------------------------------------------

/** Ordered modal sections in the LinkedIn Easy Apply flow. */
export const EASY_APPLY_STEPS = [
  {
    key: "contact",
    label: "Contact info",
    note: "Name, email, phone, and location fields.",
  },
  {
    key: "resume",
    label: "Resume",
    note: "Upload or select a resume; modal-first upload pattern.",
  },
  {
    key: "work_auth",
    label: "Work authorization & sponsorship",
    note: "work_authorization and requires_sponsorship questions.",
  },
  {
    key: "questions",
    label: "Additional/screening questions",
    note: "Use configured/profile/honesty context first; ask only for genuinely unsupported answers.",
  },
  {
    key: "review",
    label: "Review your application",
    note: "Use preconfigured current_employer and current_title values unless the page asks for new disclosure.",
  },
  {
    key: "submit",
    label: "Submit application",
    note: "Final submit action; gated by auto_submit.",
  },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a label for fuzzy matching: lowercase + strip non-alphanumeric.
 * @param {string} s
 * @returns {string}
 */
function normalizeLabel(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fieldLabel(field) {
  if (typeof field === "string") return field;
  if (field && typeof field === "object") return field.label || field.name || field.question || "";
  return "";
}

function compactValue(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return value;
}

function yesNo(value) {
  return value === true ? "Yes" : value === false ? "No" : null;
}

function normalizedAnswerEntries(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
  return Object.entries(candidate)
    .map(([key, value]) => [normalizeLabel(key), compactValue(value)])
    .filter(([key, value]) => key && value != null);
}

function configuredScreeningEntries(formDefaults) {
  const fd = formDefaults || {};
  return [
    ...normalizedAnswerEntries(fd.screening_answers),
    ...normalizedAnswerEntries(fd.screeningAnswers),
    ...normalizedAnswerEntries(fd.screening),
  ];
}

function findConfiguredScreeningAnswer(normalized, formDefaults) {
  for (const [key, value] of configuredScreeningEntries(formDefaults)) {
    if (normalized === key || normalized.includes(key)) {
      return value;
    }
  }
  return null;
}

function listValue(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const single = compactValue(value);
  return single == null ? [] : [String(single)];
}

function findNeedle(normalized, values = []) {
  return values.find((value) => {
    const needle = normalizeLabel(value);
    return needle && normalized.includes(needle);
  });
}

function isCurrentCompLabel(normalized) {
  return (
    normalized.includes("current salary") ||
    normalized.includes("current compensation") ||
    normalized.includes("current pay") ||
    normalized.includes("current wage") ||
    normalized.includes("present salary")
  );
}

/**
 * Generic label → canonical field matcher (portal-agnostic fallback).
 * Returns null when no match.
 * @param {string} normalized
 * @returns {string|null}
 */
function genericMatch(normalized) {
  // Salary / compensation — EXPECTED
  if (
    normalized.includes("expected salary") ||
    normalized.includes("expected compensation") ||
    normalized.includes("desired salary") ||
    normalized.includes("salary expectation") ||
    normalized.includes("desired compensation") ||
    normalized.includes("target salary") ||
    normalized.includes("target compensation")
  ) {
    return "expected_base";
  }

  // Salary / compensation — CURRENT (must resolve to null; handled in resolveFieldValue)
  if (
    normalized.includes("current salary") ||
    normalized.includes("current compensation") ||
    normalized.includes("current pay") ||
    normalized.includes("current wage") ||
    normalized.includes("present salary")
  ) {
    return "__current_comp__"; // sentinel — never returned as a real canonical field
  }

  // Bare "salary" or "compensation" alone (ambiguous → treat as expected)
  if (normalized === "salary" || normalized === "compensation") {
    return "expected_base";
  }

  if (normalized.includes("first name")) return "first_name";
  if (normalized.includes("last name")) return "last_name";
  if (normalized.includes("full name") || normalized === "name" || normalized === "your name") {
    return "full_name";
  }
  if (normalized.includes("email")) return "email";
  if (normalized.includes("phone")) return "phone";
  // "relocation" contains the substring "location" but is a screening
  // preference, not the candidate's current city. Leave it for
  // resolveScreeningAnswer instead of filling the home address here.
  if (normalized.includes("relocat")) return null;
  if (/(^| )location( |$)/.test(normalized) || normalized === "city") return "location";
  if (normalized.includes("linkedin")) return "linkedin";
  if (normalized.includes("github")) return "github";
  if (
    normalized.includes("portfolio") ||
    normalized.includes("personal website") ||
    (normalized.includes("website") &&
      !normalized.includes("linkedin") &&
      !normalized.includes("github"))
  ) {
    return "portfolio";
  }
  if (
    normalized.includes("work authorization") ||
    normalized.includes("authorized to work") ||
    normalized.includes("legally authorized") ||
    normalized.includes("work in the us") ||
    normalized.includes("are you authorized")
  ) {
    return "work_authorization";
  }
  if (
    normalized.includes("sponsorship") ||
    normalized.includes("require sponsorship") ||
    normalized.includes("visa sponsorship")
  ) {
    return "requires_sponsorship";
  }
  if (normalized.includes("current employer") || normalized.includes("current company")) {
    return "current_employer";
  }
  if (
    normalized.includes("current title") ||
    normalized.includes("current job title") ||
    normalized === "job title"
  ) {
    return "current_title";
  }
  if (normalized.includes("source") || normalized.includes("how did you hear")) {
    return "source";
  }
  if (
    normalized === "eeo" ||
    normalized.includes("gender") ||
    normalized.includes("race") ||
    normalized.includes("ethnicity") ||
    normalized.includes("veteran") ||
    normalized.includes("disability")
  ) {
    return "eeo";
  }

  return null;
}

// ---------------------------------------------------------------------------
// resolveScreeningAnswer
// ---------------------------------------------------------------------------

/**
 * Resolve routine/custom screening answers from pre-reviewed local context.
 * This intentionally answers only when the value is explicit or safely derived
 * from profile/honesty config; unknowns stay skipped for the agent to inspect.
 *
 * @param {string|object} question
 * @param {{ formDefaults?: object, profile?: object, honesty?: object }} context
 * @returns {{ action: "fill"|"skip", value: string|number|boolean|null, source?: string, reason?: string }}
 */
export function resolveScreeningAnswer(question, { formDefaults, profile, honesty } = {}) {
  const label = fieldLabel(question);
  const normalized = normalizeLabel(label);
  if (!normalized) return { action: "skip", value: null, reason: "empty_question" };

  if (isCurrentCompLabel(normalized)) {
    return { action: "skip", value: null, reason: "private_current_compensation" };
  }

  const configured = findConfiguredScreeningAnswer(normalized, formDefaults);
  if (configured != null) {
    return { action: "fill", value: configured, source: "form-defaults.screening_answers" };
  }

  const location = profile?.location || {};
  const auth = profile?.authorization || {};

  if (
    normalized.includes("notice period") ||
    normalized.includes("when can you start") ||
    normalized.includes("start date") ||
    normalized.includes("available to start")
  ) {
    const notice = compactValue(auth.notice_period);
    if (notice != null)
      return { action: "fill", value: notice, source: "profile.authorization.notice_period" };
  }

  if (normalized.includes("remote")) {
    const answer = yesNo(location.remote);
    if (answer != null) return { action: "fill", value: answer, source: "profile.location.remote" };
  }

  if (normalized.includes("hybrid")) {
    const answer = yesNo(location.hybrid);
    if (answer != null) return { action: "fill", value: answer, source: "profile.location.hybrid" };
  }

  if (normalized.includes("in person") || normalized.includes("inperson")) {
    const percentage = String(label).match(/\b(\d{1,3})\s*(?:%|percent\b)/i);
    const posture = percentage && Number(percentage[1]) < 100 ? location.hybrid : location.onsite;
    const answer = yesNo(posture);
    if (answer != null) {
      return {
        action: "fill",
        value: answer,
        source:
          percentage && Number(percentage[1]) < 100
            ? "profile.location.hybrid"
            : "profile.location.onsite",
      };
    }
  }

  if (
    normalized.includes("onsite") ||
    normalized.includes("on site") ||
    normalized.includes("in office")
  ) {
    const answer = yesNo(location.onsite);
    if (answer != null) return { action: "fill", value: answer, source: "profile.location.onsite" };
  }

  if (normalized.includes("relocat")) {
    const relocation = listValue(location.relocation);
    if (normalized.includes("type relocating") && relocation.length > 0) {
      return {
        action: "fill",
        value: "relocating",
        source: "profile.location.relocation",
      };
    }
    if (
      normalized.includes("where") ||
      /(^| )location( |$)/.test(normalized) ||
      normalized.includes("address")
    ) {
      if (relocation.length > 0) {
        return {
          action: "fill",
          value: relocation.join(", "),
          source: "profile.location.relocation",
        };
      }
    } else {
      return {
        action: "fill",
        value: relocation.length > 0 ? "Yes" : "No",
        source: "profile.location.relocation",
      };
    }
  }

  if (normalized.includes("travel")) {
    const travel = compactValue(location.travel_tolerance);
    if (travel != null) {
      return { action: "fill", value: travel, source: "profile.location.travel_tolerance" };
    }
  }

  const education = honesty?.education || {};
  if (normalized.includes("degree") || normalized.includes("education")) {
    const highestDegree = compactValue(education.highest_degree);
    if (highestDegree != null) {
      return { action: "fill", value: highestDegree, source: "honesty.education.highest_degree" };
    }
    if (education.add_education_section === false) {
      return { action: "fill", value: "No", source: "honesty.education.add_education_section" };
    }
  }

  const tools = honesty?.tools || {};
  const disallowed = findNeedle(normalized, tools.do_not_claim || []);
  if (disallowed) {
    return { action: "fill", value: "No", source: "honesty.tools.do_not_claim" };
  }
  const confirmed = findNeedle(normalized, tools.confirmed || []);
  if (confirmed) {
    return { action: "fill", value: "Yes", source: "honesty.tools.confirmed" };
  }

  return { action: "skip", value: null, reason: "unresolved" };
}

// ---------------------------------------------------------------------------
// mapFormDefaults
// ---------------------------------------------------------------------------

/**
 * Build a canonical-field → value map from profile + formDefaults.
 * NEVER includes current_base.
 *
 * @param {object} formDefaults  — parsed form-defaults.yml content (may be null/undefined)
 * @param {object} profile       — validated profile object
 * @returns {object}             — { [canonicalField]: value } (no null/undefined/empty-string keys)
 */
export function mapFormDefaults(formDefaults, profile) {
  const fd = formDefaults || {};
  const c = profile?.candidate || {};
  const comp = profile?.compensation || {};
  const auth = profile?.authorization || {};

  const result = {};

  // full_name: profile.candidate first, formDefaults may override
  const fullName = fd.full_name || c.full_name || "";
  if (fullName) result.full_name = fullName;

  // first_name / last_name split from full_name
  if (fullName) {
    const parts = fullName.trim().split(/\s+/);
    const firstName = parts[0] || "";
    const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "";
    if (firstName) result.first_name = firstName;
    if (lastName) result.last_name = lastName;
  }

  // Direct candidate fields (formDefaults override when set)
  const directFields = ["email", "phone", "location", "linkedin", "github", "portfolio"];
  for (const field of directFields) {
    const value = fd[field] || c[field] || "";
    if (value) result[field] = value;
  }

  // work_authorization
  const waRaw =
    fd.work_authorization != null
      ? fd.work_authorization
      : auth.work_authorized != null
        ? auth.work_authorized
          ? "Yes"
          : "No"
        : null;
  if (waRaw != null && waRaw !== "") result.work_authorization = String(waRaw);

  // requires_sponsorship
  const rsRaw =
    fd.requires_sponsorship != null
      ? fd.requires_sponsorship
      : auth.requires_sponsorship != null
        ? auth.requires_sponsorship
          ? "Yes"
          : "No"
        : null;
  if (rsRaw != null && rsRaw !== "") result.requires_sponsorship = String(rsRaw);

  // source
  if (fd.source) result.source = fd.source;

  // current_employer / current_title (from formDefaults only; may be blank)
  if (fd.current_employer != null && fd.current_employer !== "") {
    result.current_employer = fd.current_employer;
  }
  if (fd.current_title != null && fd.current_title !== "") {
    result.current_title = fd.current_title;
  }

  // expected_base — NEVER current_base
  // Privacy rule: expected_base comes from formDefaults.expected_base OR
  // profile.compensation.target_base. current_base is NEVER used.
  const expectedBase =
    (fd.expected_base != null && fd.expected_base !== "" ? fd.expected_base : null) ||
    (comp.target_base != null && comp.target_base !== "" ? comp.target_base : null) ||
    "";
  if (expectedBase !== "" && expectedBase != null) result.expected_base = expectedBase;

  // eeo
  if (fd.eeo_default != null && fd.eeo_default !== "") {
    result.eeo = fd.eeo_default;
  }

  return result;
}

// ---------------------------------------------------------------------------
// resolveFieldValue
// ---------------------------------------------------------------------------

/**
 * Resolve the value to fill for a given on-page field label.
 * Returns null when the field is unknown, should be skipped, or is a blocked
 * current-compensation field.
 *
 * @param {string} fieldLabel
 * @param {{ formDefaults?: object, profile?: object, portal?: string }} context
 * @returns {string|number|null}
 */
export function resolveFieldValue(fieldLabel, { formDefaults, profile, portal } = {}) {
  const normalized = normalizeLabel(fieldLabel);

  // Check for current-comp labels first — always null unless shareable
  const comp = profile?.compensation || {};
  if (isCurrentCompLabel(normalized)) {
    // Only share if explicitly opted in AND we only return target_base, never current_base
    if (comp.current_comp_shareable === true) {
      // Even when shareable, we map to target_base (expected) not current_base
      const fd = formDefaults || {};
      const expectedBase =
        (fd.expected_base != null && fd.expected_base !== "" ? fd.expected_base : null) ||
        (comp.target_base != null ? comp.target_base : null);
      return expectedBase != null ? expectedBase : null;
    }
    return null;
  }

  // Try portal-specific label map first
  if (portal && PORTAL_RECIPES[portal]) {
    const labelMap = PORTAL_RECIPES[portal].labelMap;
    const canonicalField = labelMap[normalized] || null;
    if (canonicalField) {
      const values = mapFormDefaults(formDefaults, profile);
      return values[canonicalField] != null ? values[canonicalField] : null;
    }
  }

  // Fall back to generic matcher
  const canonical = genericMatch(normalized);
  if (canonical === null) return null;
  if (canonical === "__current_comp__") return null; // safety: should be caught above

  const values = mapFormDefaults(formDefaults, profile);
  return values[canonical] != null ? values[canonical] : null;
}

// ---------------------------------------------------------------------------
// shouldAutoSubmit
// ---------------------------------------------------------------------------

/**
 * Returns true only when formDefaults explicitly sets auto_submit === true.
 * Default is false (manual submit).
 *
 * @param {object|null|undefined} formDefaults
 * @returns {boolean}
 */
export function shouldAutoSubmit(formDefaults) {
  return !!(formDefaults && formDefaults.auto_submit === true);
}

// ---------------------------------------------------------------------------
// BLOCKER_SIGNALS
// ---------------------------------------------------------------------------

export const BLOCKER_SIGNALS = [
  "captcha",
  "are you a robot",
  "application limit",
  "you have reached",
  "complete the assessment",
  "coding exercise",
  "verify you are human",
  // [#6][#7] Verification-code / OTP gate pages
  "verification code",
  "enter the code",
  "check your email",
  "we sent you a code",
  "one-time code",
  "enter the 6-digit code",
  // [#M12] 2FA / security verification gates
  "two-step verification",
  "two-factor authentication",
  "authenticator app",
  "security verification",
];

// ---------------------------------------------------------------------------
// submitGuard
// ---------------------------------------------------------------------------

/**
 * Safety gate before submit.
 *
 * @param {{ pageText?: string, pageSignals?: object, formDefaults?: object }} opts
 * @returns {{ canSubmit: boolean, mode: "auto"|"manual", blockers: string[] }}
 */
export function submitGuard({ pageText = "", pageSignals = {}, formDefaults } = {}) {
  const lower = String(pageText).toLowerCase();
  const blockers = [];

  // Check BLOCKER_SIGNALS in page text
  for (const signal of BLOCKER_SIGNALS) {
    if (lower.includes(signal)) {
      blockers.push(signal);
    }
  }

  // Check explicit pageSignals booleans
  if (pageSignals.captcha === true && !blockers.includes("captcha")) {
    blockers.push("captcha");
  }
  if (pageSignals.appLimit === true) {
    blockers.push("application limit");
  }
  if (pageSignals.requiredExercise === true) {
    blockers.push("complete the assessment");
  }

  const canSubmit = blockers.length === 0;

  // mode: "auto" only when auto_submit true AND no blockers
  const mode = canSubmit && shouldAutoSubmit(formDefaults) ? "auto" : "manual";

  return { canSubmit, mode, blockers };
}

// ---------------------------------------------------------------------------
// buildFillPlan
// ---------------------------------------------------------------------------

/**
 * Build a step-by-step fill plan for a list of on-page field labels.
 * Action is "fill" when a value resolves, "skip" when null.
 * Never includes a "submit" action.
 *
 * @param {{ fields: Array<string|object>, formDefaults?: object, profile?: object, honesty?: object, portal?: string }} opts
 * @returns {Array<{ label: string, canonicalField: string|null, value: any, action: "fill"|"skip" }>}
 */
export function buildFillPlan({ fields = [], formDefaults, profile, honesty, portal } = {}) {
  return fields.map((field) => {
    const label = fieldLabel(field);
    const normalized = normalizeLabel(label);

    // Determine canonical field for metadata (without resolving value)
    let canonicalField = null;
    if (portal && PORTAL_RECIPES[portal]) {
      canonicalField = PORTAL_RECIPES[portal].labelMap[normalized] || null;
    }
    if (!canonicalField) {
      const g = genericMatch(normalized);
      canonicalField = g && g !== "__current_comp__" ? g : null;
    }

    const value = resolveFieldValue(label, { formDefaults, profile, portal });

    if (value == null) {
      const screening = resolveScreeningAnswer(field, { formDefaults, profile, honesty });
      if (screening.action === "fill") {
        return {
          label,
          canonicalField: null,
          value: screening.value,
          action: "fill",
          source: screening.source,
        };
      }
      return { label, canonicalField: null, value: null, action: "skip" };
    }

    const fd = formDefaults || {};
    const requiresConfirmation =
      (canonicalField === "current_employer" || canonicalField === "current_title") &&
      (fd.confirm_current_role === true || fd.confirm_current_disclosure === true)
        ? true
        : undefined;

    return requiresConfirmation
      ? { label, canonicalField, value, action: "fill", requiresConfirmation }
      : { label, canonicalField, value, action: "fill" };
  });
}

// ---------------------------------------------------------------------------
// confirmationCheck
// ---------------------------------------------------------------------------

const CONFIRMATION_SIGNALS = [
  "thank you for applying",
  "application received",
  "we've received your application",
  "we have received your application",
  "successfully submitted",
  // [#8] Additional confirmation phrases
  "your application has been submitted",
  "application submitted",
  "application complete",
  "thanks for applying",
  // [#M12] LinkedIn Easy Apply confirmation phrases
  "your application was sent",
  "application sent to",
  "application sent",
];

// [#8] URL path segments that indicate a confirmation page
const CONFIRMATION_URL_SEGMENTS = [
  "/confirmation",
  "/thank-you",
  "/thanks",
  "/submitted",
  "/apply/success",
  "/application/complete",
];

/**
 * Detect a post-submit confirmation page.
 *
 * @param {{ pageText?: string, currentUrl?: string }} opts
 * @returns {{ submitted: boolean, signal: string|null }}
 */
export function confirmationCheck({ pageText = "", currentUrl } = {}) {
  // [#8] URL-segment check (optional; callers that don't pass currentUrl are unaffected)
  if (currentUrl) {
    let urlPath = "";
    try {
      urlPath = new URL(currentUrl).pathname.toLowerCase();
    } catch {
      // malformed URL — fall through to text check
    }
    for (const segment of CONFIRMATION_URL_SEGMENTS) {
      if (urlPath.includes(segment)) {
        return { submitted: true, signal: segment };
      }
    }
  }

  const lower = String(pageText).toLowerCase();
  for (const signal of CONFIRMATION_SIGNALS) {
    if (lower.includes(signal)) {
      return { submitted: true, signal };
    }
  }
  return { submitted: false, signal: null };
}
