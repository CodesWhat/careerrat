// ats-parseability.mjs - score a tailored resume/CV markdown for ATS
// parseability. Deterministic, read-only, zero runtime dependencies. Ported
// from career-ops's verify-ats.mjs (structural checks a text-based CV needs)
// and adapted to CareerRat's markdown pipeline: validateAtsSafe already
// blocks tables, images, HTML tags, tabs, and box-drawing glyphs at build
// time (tailor.mjs), so this module reuses that result as the "block" tier
// instead of re-detecting the same constructs, and adds the checks
// validateAtsSafe does not cover: real text volume, recognizable section
// headings, and reachable contact info.
//
// Advisory only: never blocks generation or export, and the score is never
// written into an outbound artifact (resume, cover letter, or DOCX/PDF).

import { validateAtsSafe } from "./tailor.mjs";

const TEXT_MIN_CHARS = 300; // below this, the resume likely reads as sparse or incomplete

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// Phone-shaped run, bounded so the regex can't backtrack pathologically. The
// >= 9-digit rule (below) is what separates a real number from a date range
// like "2019 - 2024" (8 digits), not the pattern itself.
const PHONE_CANDIDATE_RE = /\+?\(?\d[\d\s().-]{6,23}\d/g;
const PHONE_MIN_DIGITS = 9;

const EXPERIENCE_HEADING_RE = /experience|work history|employment|highlights/i;
const SKILLS_HEADING_RE = /skills|competenc|proficienc/i;
const HEADING_LINE_RE = /^#{1,6}\s+(.*)$/gm;

// Maps a validateAtsSafe issue string to a stable finding id, plain-language
// message, and concrete fix. Order matches validateAtsSafe's own check order.
const BLOCK_ISSUE_MAP = [
  {
    id: "markdown-table",
    match: (issue) => issue.includes("markdown table"),
    message:
      "Your resume has a table, and applicant tracking systems often scramble table contents into the wrong reading order.",
    fix: "Replace the table with plain headings and bullet points.",
  },
  {
    id: "markdown-image",
    match: (issue) => issue.includes("markdown image"),
    message:
      "Your resume includes an image, and applicant tracking systems cannot read text inside images.",
    fix: "Remove the image, or make sure the same information also exists as plain text.",
  },
  {
    id: "html-tag",
    match: (issue) => issue.includes("HTML tag"),
    message: "Your resume contains raw HTML tags, which can confuse an ATS text parser.",
    fix: "Remove the HTML and use plain markdown formatting instead.",
  },
  {
    id: "tab-character",
    match: (issue) => issue.includes("tab character"),
    message: "Your resume has tab characters, which some ATS parsers misread as extra columns.",
    fix: "Replace the tabs with spaces or line breaks.",
  },
  {
    id: "box-drawing-glyph",
    match: (issue) => issue.includes("box-drawing glyph"),
    message:
      "Your resume has box-drawing characters, which usually come from a multi-column layout an ATS can't follow.",
    fix: "Remove the box-drawing characters and keep the resume in a single-column plain-text layout.",
  },
];

/**
 * Collapse markdown syntax (headings, bullets, emphasis, links) to plain
 * text, roughly approximating what an ATS text extractor is left with.
 *
 * @param {string} markdown
 * @returns {string}
 */
function extractPlainText(markdown) {
  return String(markdown ?? "")
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/^[-*]\s+/gm, "") // bullet markers
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/\*([^*]+)\*/g, "$1") // italic
    .replace(/_([^_]+)_/g, "$1") // italic
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether `text` contains a real phone number: a bounded phone-shaped run
 * carrying at least PHONE_MIN_DIGITS digits. Short numeric spans such as the
 * date range "2019 - 2024" (8 digits) are rejected.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasPhoneNumber(text) {
  const candidates = text.match(PHONE_CANDIDATE_RE);
  if (!candidates) return false;
  return candidates.some((candidate) => (candidate.match(/\d/g) || []).length >= PHONE_MIN_DIGITS);
}

/**
 * Collect every markdown heading line (`#`..`######`), lowercased, joined
 * into a single blob for keyword matching.
 *
 * @param {string} markdown
 * @returns {string}
 */
function extractHeadingBlob(markdown) {
  const headings = [...String(markdown ?? "").matchAll(HEADING_LINE_RE)].map((m) => m[1]);
  return headings.join(" | ").toLowerCase();
}

/**
 * Score a tailored resume/CV markdown string for ATS parseability.
 *
 * `opts.ats` lets a caller that already ran `validateAtsSafe` (tailor.mjs's
 * build gate, packet/generate.mjs's assertAtsSafe) pass that result in so it
 * is not recomputed; when omitted, this function computes it itself.
 *
 * @param {string} markdown
 * @param {{ ats?: { ok: boolean, issues: string[] } }} [opts]
 * @returns {{ score: number, findings: Array<{ id: string, severity: "block"|"warn"|"info", message: string, fix: string }> }}
 */
export function scoreAtsParseability(markdown, opts = {}) {
  const text = String(markdown ?? "");
  const ats = opts.ats || validateAtsSafe(text);
  const findings = [];
  let score = 100;

  // Block tier: reuse validateAtsSafe's own findings rather than
  // re-detecting the same constructs.
  for (const issue of ats.issues || []) {
    const known = BLOCK_ISSUE_MAP.find((entry) => entry.match(issue));
    findings.push(
      known
        ? { id: known.id, severity: "block", message: known.message, fix: known.fix }
        : {
            id: "ats-unsafe",
            severity: "block",
            message: `Your resume failed an ATS-safety check: ${issue}`,
            fix: "Remove the flagged construct and re-export.",
          }
    );
    score -= 25;
  }

  const plainText = extractPlainText(text);

  // Real, selectable text volume.
  if (plainText.length < TEXT_MIN_CHARS) {
    findings.push({
      id: "low-text-content",
      severity: "warn",
      message: `Your resume has very little text (${plainText.length} characters), so it may read as incomplete to an ATS.`,
      fix: "Add more detail to your experience and skills so there's enough text for the parser to read.",
    });
    score -= 15;
  }

  // Standard, recognizable section headings.
  const headingBlob = extractHeadingBlob(text);
  if (!EXPERIENCE_HEADING_RE.test(headingBlob)) {
    findings.push({
      id: "missing-experience-section",
      severity: "warn",
      message: "Your resume has no Experience (or Highlights) heading that an ATS can recognize.",
      fix: 'Add a heading like "Experience" or "Work Experience" above your job history.',
    });
    score -= 15;
  }
  if (!SKILLS_HEADING_RE.test(headingBlob)) {
    findings.push({
      id: "missing-skills-section",
      severity: "warn",
      message: "Your resume has no Skills heading that an ATS can recognize.",
      fix: 'Add a "Skills" heading listing your key skills as plain text.',
    });
    score -= 10;
  }

  // Contact info reachable in the body.
  if (!EMAIL_RE.test(plainText)) {
    findings.push({
      id: "missing-email",
      severity: "warn",
      message: "Your resume has no email address, so an ATS or recruiter has no way to reach you.",
      fix: "Add your email address to the contact line near the top of the resume.",
    });
    score -= 15;
  }
  if (!hasPhoneNumber(plainText)) {
    findings.push({
      id: "missing-phone",
      severity: "info",
      message: "Your resume has no phone number, which some ATS intake forms expect.",
      fix: "Add a phone number to the contact line near the top of the resume, if you're comfortable sharing one.",
    });
    score -= 5;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, findings };
}
