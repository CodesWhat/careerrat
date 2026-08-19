/**
 * form-questions.mjs — question-fetch without a browser (POC apply-packet step)
 *
 * Pure logic + one fetch call. No browser automation, no LLM calls. Given a
 * job posting URL, fetches that provider's real application-form questions
 * deterministically and normalizes them into one shared shape so the packet
 * builder can draft answers before the agent ever opens the ATS page.
 *
 * ---------------------------------------------------------------------------
 * Verified endpoint shapes (WebFetch of official docs + live curl, 2026-07-02)
 * ---------------------------------------------------------------------------
 *
 * GREENHOUSE — documented, public, unauthenticated Job Board API.
 *   GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}?questions=true
 *   Confirmed live against a real posting (boards-api.greenhouse.io/v1/boards/anthropic/jobs/5192805008):
 *     {
 *       questions: [
 *         { label, required, description,
 *           fields: [ { name, type, values: [{ label, value }] } ] }
 *       ],
 *       location_questions: [ ...same shape as questions[]... ],
 *       compliance: [ { type: "eeoc", questions: [...], description } ],
 *       demographic_questions: null | object   // Greenhouse Inclusion, when enabled
 *     }
 *   field.type values observed/documented: input_text, input_file, input_hidden,
 *   textarea, multi_value_single_select, multi_value_multi_select.
 *   `compliance` (EEOC) and `demographic_questions` (Inclusion) are the
 *   demographic/compliance sections — excluded from questions[], flagged via
 *   demographicSectionPresent. `location_questions` are real applicant-facing
 *   questions (same shape as `questions[]`) and get folded in.
 *
 * ASHBY — NO public unauthenticated endpoint returns the application form.
 *   Verified by testing both documented candidates:
 *     - GET https://api.ashbyhq.com/posting-api/job-board/{orgSlug} (used by
 *       sourced-scanner.mjs for listings) → confirmed live it does NOT include
 *       form/question data, by design (Ashby's own public-job-posting-api docs
 *       list the full response shape and form fields are absent from it).
 *     - POST https://api.ashbyhq.com/jobPosting.info (the documented endpoint
 *       that DOES return `applicationFormDefinition`) requires an org API key
 *       (Bearer auth) — confirmed 401 Unauthorized on an unauthenticated GET to
 *       the sibling posting-api path with a job id appended.
 *   The only zero-auth, zero-browser source for the real form is the public,
 *   server-rendered careers page itself: GET https://jobs.ashbyhq.com/{orgSlug}/{uuid}
 *   embeds a `window.__appData = {...}` JSON blob (confirmed live) containing
 *   `posting.applicationForm.fieldEntries[]` (the real form) and
 *   `posting.surveyForms[]` (EEOC/demographic surveys — a genuinely SEPARATE
 *   array, not mixed into applicationForm). This is undocumented HTML-embedded
 *   JSON, not a stable API contract — extraction is isolated in
 *   extractAshbyAppData() and fails closed (clear error → paste fallback) if
 *   the page layout ever changes. Still "without a browser": one plain fetch
 *   + JSON.parse, no automation engine.
 *   fieldEntries[] shape: { field: { path, title, humanReadablePath, type,
 *     selectableValues?: [{ label, value }] }, isRequired }. field.type values
 *   observed/documented: String, Email, Phone, SocialLink, Date, LongText,
 *   File, ValueSelect, MultiValueSelect, Boolean, Number, Score, and Location
 *   (undocumented — observed live on a real posting's "which country do you
 *   intend to work from" field; mapped to "text", a free-text city/country answer).
 *
 * Normalized shape (shared across all sources):
 *   {
 *     source: "greenhouse" | "ashby" | "manual",
 *     url, fetchedAt,
 *     questions: [ { id, label, type, required, options } ],
 *     demographicSectionPresent?: boolean   // greenhouse/ashby only; omitted for manual
 *   }
 *   type is one of: "text" | "textarea" | "select" | "multiselect" | "boolean" |
 *   "file" | "number" | "unknown". A select with exactly {Yes, No} options is
 *   normalized to "boolean" (options: null) — both providers express yes/no
 *   questions as a two-option select, not a native boolean, except Ashby's
 *   Boolean field type which maps directly.
 *
 * NOTE: Greenhouse's `label` is sometimes a generic heading ("(Optional)
 * Personal Preferences") while the real prompt lives in `description` HTML.
 * This normalizer intentionally keeps `label` as Greenhouse's raw label to
 * match the 5-field normalized shape exactly — folding description text in
 * is a reasonable future enrichment, not done here to avoid guessing which
 * labels are "generic enough" to need it.
 */

// ---------------------------------------------------------------------------
// inferQuestionProvider
// ---------------------------------------------------------------------------

/**
 * Map a job posting URL's hostname to the provider whose question-fetch we
 * support. Consistent with hostnameToPortal() in form-fill.mjs / inferProvider()
 * in sourced-scanner.mjs, extended to also accept the raw boards-api.greenhouse.io
 * host (a saved job's `source` frontmatter could already point at the API).
 * Returns null for anything else (Lever/Workday/etc — the manual-paste path).
 *
 * @param {string} jobUrl
 * @returns {"greenhouse"|"ashby"|null}
 */
export function inferQuestionProvider(jobUrl) {
  let host = "";
  try {
    host = new URL(jobUrl).hostname;
  } catch {
    return null;
  }
  if (/(?:^|\.)jobs\.ashbyhq\.com$/.test(host)) return "ashby";
  if (
    /^job-boards(?:\.eu)?\.greenhouse\.io$|^boards\.greenhouse\.io$|^boards-api\.greenhouse\.io$/.test(
      host
    )
  ) {
    return "greenhouse";
  }
  return null;
}

// ---------------------------------------------------------------------------
// buildQuestionsRequest
// ---------------------------------------------------------------------------

/**
 * Derive the per-job questions endpoint (Greenhouse) or the SSR posting page
 * to extract from (Ashby) for a job posting URL. Returns null when the host
 * is unsupported or the URL doesn't carry the ids this provider needs.
 *
 * @param {string} jobUrl
 * @returns {{ provider: "greenhouse"|"ashby", url: string, responseType: "json"|"html" }|null}
 */
export function buildQuestionsRequest(jobUrl) {
  const provider = inferQuestionProvider(jobUrl);
  if (provider === "greenhouse") {
    const ids = parseGreenhouseIds(jobUrl);
    if (!ids) return null;
    return {
      provider,
      url: `https://boards-api.greenhouse.io/v1/boards/${ids.token}/jobs/${ids.id}?questions=true`,
      responseType: "json",
    };
  }
  if (provider === "ashby") {
    const ids = parseAshbyIds(jobUrl);
    if (!ids) return null;
    return {
      provider,
      url: `https://jobs.ashbyhq.com/${ids.org}/${ids.uuid}`,
      responseType: "html",
    };
  }
  return null;
}

// Board token + numeric job id, from any of the URL forms extractReqId()
// handles (job-boards.greenhouse.io / boards.greenhouse.io / the .eu mirror)
// plus the raw boards-api form (already the API host).
function parseGreenhouseIds(rawUrl = "") {
  let hostAndPath;
  try {
    hostAndPath = new URL(rawUrl);
  } catch {
    return null;
  }
  const path = hostAndPath.pathname;

  const boardsMatch = path.match(/^\/([^/?#]+)\/jobs\/(\d+)/);
  if (
    boardsMatch &&
    /^job-boards(?:\.eu)?\.greenhouse\.io$|^boards\.greenhouse\.io$/.test(hostAndPath.hostname)
  ) {
    return { token: boardsMatch[1], id: boardsMatch[2] };
  }

  const apiMatch = path.match(/^\/v1\/boards\/([^/?#]+)\/jobs\/(\d+)/);
  if (apiMatch && hostAndPath.hostname === "boards-api.greenhouse.io") {
    return { token: apiMatch[1], id: apiMatch[2] };
  }

  return null;
}

// Org slug + posting uuid from a jobs.ashbyhq.com URL. Mirrors extractReqId()'s
// uuid pattern in sourced-scanner.mjs.
function parseAshbyIds(rawUrl = "") {
  const match = String(rawUrl).match(
    /jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i
  );
  return match ? { org: match[1], uuid: match[2].toLowerCase() } : null;
}

// ---------------------------------------------------------------------------
// shared type-normalization helpers
// ---------------------------------------------------------------------------

// A two-option select whose options are exactly {Yes, No} is a boolean
// question in disguise — both providers model yes/no as a select, not a
// native boolean type (Ashby's own Boolean type is mapped directly elsewhere).
function maybeBooleanize(type, options) {
  if (type === "select" && Array.isArray(options) && options.length === 2) {
    const set = new Set(options.map((o) => String(o).trim().toLowerCase()));
    if (set.has("yes") && set.has("no")) return { type: "boolean", options: null };
  }
  return { type, options };
}

function optionLabels(values) {
  if (!Array.isArray(values)) return null;
  const labels = values.map((v) => String(v?.label ?? v?.value ?? "").trim()).filter(Boolean);
  return labels.length > 0 ? labels : null;
}

// ---------------------------------------------------------------------------
// normalizeGreenhouseQuestions
// ---------------------------------------------------------------------------

const GREENHOUSE_TYPE_MAP = {
  input_text: "text",
  textarea: "textarea",
  input_file: "file",
  multi_value_single_select: "select",
  multi_value_multi_select: "multiselect",
};

/**
 * Normalize a Greenhouse `?questions=true` job response into the shared shape.
 * `location_questions` are folded into questions[] (real applicant-facing
 * fields, same shape as `questions[]`). `compliance` (EEOC) and
 * `demographic_questions` (Inclusion) are excluded and only flagged via
 * demographicSectionPresent. input_hidden-only fields are dropped (not
 * shown to the applicant).
 *
 * @param {object} json — parsed response body
 * @param {{ url?: string, fetchedAt?: string }} [meta]
 * @returns {{ source: "greenhouse", url: string, fetchedAt: string, questions: object[], demographicSectionPresent: boolean }}
 */
export function normalizeGreenhouseQuestions(json, { url = "", fetchedAt } = {}) {
  const j = json && typeof json === "object" ? json : {};
  const blocks = [
    ...(Array.isArray(j.questions) ? j.questions : []),
    ...(Array.isArray(j.location_questions) ? j.location_questions : []),
  ];
  const questions = blocks.map(normalizeGreenhouseBlock).filter(Boolean);

  const complianceHasQuestions =
    Array.isArray(j.compliance) &&
    j.compliance.some((block) => Array.isArray(block?.questions) && block.questions.length > 0);
  const demographic = j.demographic_questions;
  const demographicHasContent = Array.isArray(demographic)
    ? demographic.length > 0
    : demographic != null && typeof demographic === "object"
      ? Object.keys(demographic).length > 0
      : Boolean(demographic);

  return {
    source: "greenhouse",
    url: url || String(j.absolute_url || ""),
    fetchedAt: fetchedAt || new Date().toISOString(),
    questions,
    demographicSectionPresent: complianceHasQuestions || demographicHasContent,
  };
}

function normalizeGreenhouseBlock(q) {
  const rawFields = Array.isArray(q?.fields) ? q.fields : [];
  const fields = rawFields.filter((f) => f && f.type !== "input_hidden");
  if (fields.length === 0) return null; // hidden-only or empty — nothing applicant-facing

  const label = String(q?.label || "").trim();
  if (!label) return null;

  // A resume/cover-letter block often carries both an input_file AND a text
  // fallback field; the upload is the meaningful artifact slot.
  const fileField = fields.find((f) => f.type === "input_file");
  const field = fileField || fields[0];

  const baseType = GREENHOUSE_TYPE_MAP[field.type] || "unknown";
  const rawOptions =
    baseType === "select" || baseType === "multiselect" ? optionLabels(field.values) : null;
  const { type, options } = maybeBooleanize(baseType, rawOptions);

  return {
    id: field.name || label,
    label,
    type,
    required: q?.required === true,
    options,
  };
}

// ---------------------------------------------------------------------------
// extractAshbyAppData
// ---------------------------------------------------------------------------

/**
 * Pull the `posting` object out of a jobs.ashbyhq.com page's embedded
 * `window.__appData = {...}` JSON blob. Brace-matches (string/escape aware)
 * rather than regex-capturing to the next `}` since the payload is large,
 * minified, and contains nested objects/arrays. Returns null (never throws)
 * when the marker or a parseable object isn't found, so callers can fail
 * closed with a "paste instead" hint.
 *
 * @param {string} html
 * @returns {object|null}
 */
export function extractAshbyAppData(html) {
  const text = String(html || "");
  const markerIdx = text.indexOf("window.__appData");
  if (markerIdx === -1) return null;
  const eqIdx = text.indexOf("=", markerIdx);
  if (eqIdx === -1) return null;

  let start = eqIdx + 1;
  while (start < text.length && /\s/.test(text[start])) start++;
  if (text[start] !== "{") return null;

  const end = findJsonObjectEnd(text, start);
  if (end === -1) return null;

  try {
    const data = JSON.parse(text.slice(start, end));
    return data && typeof data === "object" && data.posting ? data.posting : null;
  } catch {
    return null;
  }
}

// String/escape-aware brace matcher — a naive `indexOf("}")` would stop at
// the first `}` inside a nested object or a string value.
function findJsonObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// normalizeAshbyForm
// ---------------------------------------------------------------------------

const ASHBY_TYPE_MAP = {
  String: "text",
  Email: "text",
  Phone: "text",
  SocialLink: "text",
  Date: "text",
  Location: "text",
  LongText: "textarea",
  File: "file",
  ValueSelect: "select",
  MultiValueSelect: "multiselect",
  Boolean: "boolean",
  Number: "number",
  Score: "number",
};

/**
 * Normalize an Ashby `posting` object (as returned by extractAshbyAppData(),
 * or an equivalent invented fixture) into the shared shape.
 * `posting.applicationForm.fieldEntries[]` → questions[]. `posting.surveyForms[]`
 * (EEOC/demographic surveys, a genuinely separate array) is excluded and only
 * flagged via demographicSectionPresent. Deactivated fields are dropped (not
 * shown to the applicant).
 *
 * @param {object} posting
 * @param {{ url?: string, fetchedAt?: string }} [meta]
 * @returns {{ source: "ashby", url: string, fetchedAt: string, questions: object[], demographicSectionPresent: boolean }}
 */
export function normalizeAshbyForm(posting, { url = "", fetchedAt } = {}) {
  const p = posting && typeof posting === "object" ? posting : {};
  const fieldEntries = Array.isArray(p.applicationForm?.fieldEntries)
    ? p.applicationForm.fieldEntries
    : [];

  const questions = fieldEntries.map(normalizeAshbyEntry).filter(Boolean);

  const surveyForms = Array.isArray(p.surveyForms) ? p.surveyForms : [];
  const demographicSectionPresent =
    surveyForms.some((f) => Array.isArray(f?.fieldEntries) && f.fieldEntries.length > 0) ||
    (Array.isArray(p.surveyFormDefinitionIds) && p.surveyFormDefinitionIds.length > 0);

  return {
    source: "ashby",
    url,
    fetchedAt: fetchedAt || new Date().toISOString(),
    questions,
    demographicSectionPresent,
  };
}

function normalizeAshbyEntry(entry) {
  const field = entry?.field;
  if (!field || field.isDeactivated) return null;

  const label = String(field.title || field.humanReadablePath || "").trim();
  if (!label) return null;

  const baseType = ASHBY_TYPE_MAP[field.type] || "unknown";
  const rawOptions =
    baseType === "select" || baseType === "multiselect"
      ? optionLabels(field.selectableValues)
      : null;
  const { type, options } = maybeBooleanize(baseType, rawOptions);

  return {
    id: field.path || field.id || label,
    label,
    type,
    required: entry.isRequired === true,
    options,
  };
}

// ---------------------------------------------------------------------------
// parseManualQuestions
// ---------------------------------------------------------------------------

// Numbered ("1.", "1)"), bulleted ("-", "*", "•"), or bare lines. A bare line
// counts as a question when it ends in "?", OR when it reads as an
// interrogative/imperative prompt: starts with a question stem (describe,
// tell, why, what, please, ...), ends with ".", "?", or ":", and is 4-40
// words long — this catches pasted imperative prompts like "Describe a
// technical system you owned end-to-end and the impact it had." without
// chopping a pasted JD paragraph into false-positive "questions" line by
// line (JD paragraphs rarely open on a bare question stem, and the word-count
// band keeps out both short paragraph fragments and long paragraph runs).
const LIST_MARKER = /^\s*(?:\d+[.)]|[-*•])\s+/;
const QUESTION_STEM =
  /^(?:describe|tell|explain|share|walk|list|provide|outline|summarize|give|detail|why|what|how|when|where|which|who|do|does|are|is|have|has|will|would|can|could|please)\b/i;

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Tolerant parse of a pasted question list (the Lever/Workday/other
 * ATS-without-an-API fallback, and the CLI --paste path). Required is always
 * unknown → true (safer to over-flag than silently skip a required field).
 *
 * @param {string} text
 * @param {{ url?: string, fetchedAt?: string }} [meta]
 * @returns {{ source: "manual", url: string, fetchedAt: string, questions: object[] }}
 */
export function parseManualQuestions(text, { url = "", fetchedAt } = {}) {
  const lines = String(text || "").split(/\r?\n/);
  const questions = [];
  let n = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const stripped = line.replace(LIST_MARKER, "").trim();
    if (!stripped) continue;

    const wasListMarked = stripped !== line;
    const endsQuestionMark = /\?\s*$/.test(stripped);
    const isImperativePrompt =
      QUESTION_STEM.test(stripped) &&
      /[.?:]\s*$/.test(stripped) &&
      wordCount(stripped) >= 4 &&
      wordCount(stripped) <= 40;
    if (!wasListMarked && !endsQuestionMark && !isImperativePrompt) continue;

    n += 1;
    questions.push({
      id: `q${n}`,
      label: stripped,
      type: "text",
      required: true,
      options: null,
    });
  }

  return {
    source: "manual",
    url,
    fetchedAt: fetchedAt || new Date().toISOString(),
    questions,
  };
}

// ---------------------------------------------------------------------------
// fetchFormQuestions
// ---------------------------------------------------------------------------

/**
 * Fetch + normalize a job posting's real application-form questions.
 * Zero LLM cost, deterministic: one HTTP GET, no browser automation.
 *
 * @param {string} jobUrl
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<object>} the shared normalized shape
 */
export async function fetchFormQuestions(jobUrl, { fetchImpl = fetch } = {}) {
  const req = buildQuestionsRequest(jobUrl);
  if (!req) {
    throw new Error(
      `Unsupported host for question-fetch: ${jobUrl}. Paste the questions instead (careerrat questions --paste).`
    );
  }

  const fetchedAt = new Date().toISOString();
  const response = await fetchImpl(req.url);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Posting not found (404) at ${req.url}. It may have closed. Paste the questions instead (careerrat questions --paste).`
      );
    }
    throw new Error(
      `${req.url} returned HTTP ${response.status}. Paste the questions instead (careerrat questions --paste).`
    );
  }

  if (req.provider === "greenhouse") {
    let json;
    try {
      json = await response.json();
    } catch {
      throw new Error(
        `Non-JSON response from Greenhouse at ${req.url}. Paste the questions instead (careerrat questions --paste).`
      );
    }
    return normalizeGreenhouseQuestions(json, {
      url: String(json?.absolute_url || jobUrl),
      fetchedAt,
    });
  }

  // Ashby: the "questions endpoint" is the SSR careers page itself.
  const html = await response.text();
  const posting = extractAshbyAppData(html);
  if (!posting) {
    throw new Error(
      `Could not find the embedded application form on ${req.url} (Ashby page layout may have changed). Paste the questions instead (careerrat questions --paste).`
    );
  }
  return normalizeAshbyForm(posting, { url: req.url, fetchedAt });
}
