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

// Bounded so the search can never degrade to the quadratic worst case a
// naive `/.../.test(longStringWithNoAt)` hits: EMAIL_WINDOW_RE only ever runs
// against a small window around an already-located "@", never the full text.
const EMAIL_LOCAL_MAX_CHARS = 64; // RFC 5321 local-part limit
const EMAIL_DOMAIN_MAX_CHARS = 253; // RFC 1035 domain-name limit
const EMAIL_WINDOW_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// Phone-shaped run, bounded so the regex can't backtrack pathologically. The
// >= 9-digit rule (below) is what separates a real number from a date range
// like "2019 - 2024" (8 digits), not the pattern itself.
const PHONE_CANDIDATE_RE = /\+?\(?\d[\d\s().-]{6,23}\d/g;
const PHONE_MIN_DIGITS = 9;

const EXPERIENCE_HEADING_RE = /experience|work history|employment|highlights/i;
const SKILLS_HEADING_RE = /skills|competenc|proficienc/i;

// Heading syntax, kept separate from vocabulary (EXPERIENCE_HEADING_RE /
// SKILLS_HEADING_RE above): an ATS text extractor doesn't see markdown, it
// sees whatever visual convention the resume used to set a line apart as a
// section label. All four are common in resumes CareerRat's tailoring never
// produces itself (pasted-in or hand-edited content) but still has to score.
const ATX_HEADING_RE = /^ {0,3}#{1,6}\s+(.*)$/; // up to 3-space indent, per CommonMark
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)\s*$/;
const BOLD_ONLY_LINE_RE = /^\s*(?:\*\*([^*]+)\*\*|__([^_]+)__)\s*:?\s*$/;
// Standalone ALL-CAPS line, short enough to read as a label rather than a
// shouted sentence. Requires at least one letter so a bare number/punctuation
// run doesn't count.
const ALL_CAPS_LINE_RE = /^[A-Z][A-Z0-9 &/'-]{1,39}$/;

// Human-readable label per artifact kind, for the messages below; a cover
// letter or packet scored by --ats should never be told "your resume" has a
// problem.
const KIND_LABELS = { resume: "resume", "cover-letter": "cover letter", packet: "packet" };

// Maps a validateAtsSafe issue string to a stable finding id, a message
// builder (kindLabel -> plain-language message), and a concrete fix. Order
// matches validateAtsSafe's own check order.
const BLOCK_ISSUE_MAP = [
  {
    id: "markdown-table",
    match: (issue) => issue.includes("markdown table"),
    message: (k) =>
      `Your ${k} has a table, and applicant tracking systems often scramble table contents into the wrong reading order.`,
    fix: "Replace the table with plain headings and bullet points.",
  },
  {
    id: "markdown-image",
    match: (issue) => issue.includes("markdown image"),
    message: (k) =>
      `Your ${k} includes an image, and applicant tracking systems cannot read text inside images.`,
    fix: "Remove the image, or make sure the same information also exists as plain text.",
  },
  {
    id: "html-tag",
    match: (issue) => issue.includes("HTML tag"),
    message: (k) => `Your ${k} contains raw HTML tags, which can confuse an ATS text parser.`,
    fix: "Remove the HTML and use plain markdown formatting instead.",
  },
  {
    id: "tab-character",
    match: (issue) => issue.includes("tab character"),
    message: (k) =>
      `Your ${k} has tab characters, which some ATS parsers misread as extra columns.`,
    fix: "Replace the tabs with spaces or line breaks.",
  },
  {
    id: "box-drawing-glyph",
    match: (issue) => issue.includes("box-drawing glyph"),
    message: (k) =>
      `Your ${k} has box-drawing characters, which usually come from a multi-column layout an ATS can't follow.`,
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
 * Whether `text` contains a reachable email address. Locates each `@` first
 * (a single linear scan) and validates only a bounded window around it (the
 * local-part and domain length limits), rather than running an unanchored
 * regex over the full string, so a long run of "@"-free filler text (no
 * candidate at all) can never trigger backtracking blowup.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasEmailAddress(text) {
  let searchFrom = 0;
  while (true) {
    const at = text.indexOf("@", searchFrom);
    if (at === -1) return false;
    const windowStart = Math.max(0, at - EMAIL_LOCAL_MAX_CHARS);
    const windowEnd = Math.min(text.length, at + 1 + EMAIL_DOMAIN_MAX_CHARS);
    if (EMAIL_WINDOW_RE.test(text.slice(windowStart, windowEnd))) return true;
    searchFrom = at + 1;
  }
}

/**
 * Collect every recognizable section-heading line, lowercased, joined into a
 * single blob for keyword matching. Recognizes four heading syntaxes an ATS
 * resume plausibly uses: ATX (`#`..`######`, up to 3-space indent), Setext
 * (text underlined with `===`/`---`), a bold-only line (`**Experience**`),
 * and a standalone ALL-CAPS short line (`PROFESSIONAL EXPERIENCE`); then
 * leaves vocabulary matching (EXPERIENCE_HEADING_RE / SKILLS_HEADING_RE) to
 * the caller. Vocabulary stays English-only; see applying.mdx.
 *
 * @param {string} markdown
 * @returns {string}
 */
function extractHeadingBlob(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const headings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    const atx = line.match(ATX_HEADING_RE);
    if (atx) {
      headings.push(atx[1]);
      continue;
    }

    const bold = line.match(BOLD_ONLY_LINE_RE);
    if (bold) {
      headings.push(bold[1] ?? bold[2]);
      continue;
    }

    // Setext: this line is heading text when the next line is a bare
    // === / --- underline and this line starts a paragraph (previous line
    // blank or start of document), otherwise "---" is far more likely a
    // horizontal rule or an unrelated table delimiter.
    const next = lines[i + 1];
    const startsParagraph = i === 0 || lines[i - 1].trim() === "";
    if (next !== undefined && startsParagraph && SETEXT_UNDERLINE_RE.test(next)) {
      headings.push(line.trim());
      i++; // consume the underline
      continue;
    }

    const trimmed = line.trim();
    if (ALL_CAPS_LINE_RE.test(trimmed)) {
      headings.push(trimmed);
    }
  }

  return headings.join(" | ").toLowerCase();
}

/**
 * Derive the artifact kind CareerRat's own tailoring/export conventions
 * already encode in a file's path: `workspace/interview-prep/*.md` for
 * interview packets (per interview-prep's SKILL.md and this CLI's own
 * `--help` example), a `cover letter`/`cover-letter` stem for cover letters
 * (per tailor-application's Downloads naming, `<Company> - Cover Letter.pdf`),
 * and everything else, including `workspace/tailored/*.md`, as a resume.
 *
 * @param {string} filePath
 * @returns {"resume" | "cover-letter" | "packet"}
 */
export function detectArtifactKind(filePath) {
  const path = String(filePath ?? "").toLowerCase();
  const base = path.split(/[\\/]/).pop() ?? "";
  if (/interview-prep|interview[-_ ]?packet/.test(path)) return "packet";
  if (/cover[-_ ]?letter/.test(base)) return "cover-letter";
  return "resume";
}

/**
 * Score a tailored resume/CV/cover-letter/packet markdown string for ATS
 * parseability.
 *
 * `opts.ats` lets a caller that already ran `validateAtsSafe` (tailor.mjs's
 * build gate, packet/generate.mjs's assertAtsSafe) pass that result in so it
 * is not recomputed; when omitted, this function computes it itself.
 *
 * `opts.kind` gates the resume-specific section checks (Experience, Skills):
 * they only apply to `"resume"` (the default). A cover letter or interview
 * packet still gets the block tier, text-volume, and contact-info checks,
 * but is never told to add an Experience or Skills heading it was never
 * going to have. Use `detectArtifactKind(filePath)` to derive this from the
 * artifact's own file path.
 *
 * @param {string} markdown
 * @param {{ ats?: { ok: boolean, issues: string[] }, kind?: "resume" | "cover-letter" | "packet" }} [opts]
 * @returns {{ score: number, findings: Array<{ id: string, severity: "block"|"warn"|"info", message: string, fix: string }> }}
 */
export function scoreAtsParseability(markdown, opts = {}) {
  const text = String(markdown ?? "");
  const ats = opts.ats || validateAtsSafe(text);
  const kind = opts.kind || "resume";
  const kindLabel = KIND_LABELS[kind] || KIND_LABELS.resume;
  const findings = [];
  let score = 100;

  // Block tier: reuse validateAtsSafe's own findings rather than
  // re-detecting the same constructs.
  for (const issue of ats.issues || []) {
    const known = BLOCK_ISSUE_MAP.find((entry) => entry.match(issue));
    findings.push(
      known
        ? { id: known.id, severity: "block", message: known.message(kindLabel), fix: known.fix }
        : {
            id: "ats-unsafe",
            severity: "block",
            message: `Your ${kindLabel} failed an ATS-safety check: ${issue}`,
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
      message: `Your ${kindLabel} has very little text (${plainText.length} characters), so it may read as incomplete to an ATS.`,
      fix: "Add more detail so there's enough text for the parser to read.",
    });
    score -= 15;
  }

  // Standard, recognizable section headings, resumes only. A cover letter
  // or interview packet was never going to have an Experience/Skills
  // heading, so flagging one there is a false positive, not a real gap.
  if (kind === "resume") {
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
  }

  // Contact info reachable in the body.
  if (!hasEmailAddress(plainText)) {
    findings.push({
      id: "missing-email",
      severity: "warn",
      message: `Your ${kindLabel} has no email address, so an ATS or recruiter has no way to reach you.`,
      fix: `Add your email address to the contact line near the top of the ${kindLabel}.`,
    });
    score -= 15;
  }
  if (!hasPhoneNumber(plainText)) {
    findings.push({
      id: "missing-phone",
      severity: "info",
      message: `Your ${kindLabel} has no phone number, which some ATS intake forms expect.`,
      fix: `Add a phone number to the contact line near the top of the ${kindLabel}, if you're comfortable sharing one.`,
    });
    score -= 5;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, findings };
}
