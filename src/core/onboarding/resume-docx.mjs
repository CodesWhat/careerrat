import mammoth from "mammoth";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+?1[\s\-.]?)?(?:\(\d{3}\)|\d{3})[\s\-.]?\d{3}[\s\-.]?\d{4}/;
const URL_RE = /https?:\/\/[^\s,<>"')]+/;
const RESUME_HEADING_RE =
  /^(summary|profile|objective|experience|employment|work history|professional experience|education|skills|technologies|technical skills|projects|selected projects)$/i;
const ACTION_RE =
  /\b(built|led|shipped|owned|created|designed|implemented|launched|automated|integrated|reduced|improved|increased|scaled|drove|delivered)\b/i;
const DATE_RE =
  /\b(?:19|20)\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;

function stripUnsafeControlCharacters(text) {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      continue;
    }
    out += char;
  }
  return out;
}

export async function extractDocxResumeText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return normalizeDocxResumeText(result?.value || "");
}

// mammoth.extractRawText() above keeps only anchor text and drops the href —
// that's why hyperlinked LinkedIn/GitHub contact links vanish from plain-text
// DOCX intake. convertToMarkdown() preserves them as "[text](url)", so the AI
// resume-extract pass (which reads this markdown, never the raw text) can
// still find the URL. Falls back to convertToHtml() + a minimal anchor
// transform if a future mammoth version ever drops convertToMarkdown.
export async function extractDocxResumeMarkdown(buffer) {
  const markdown =
    typeof mammoth.convertToMarkdown === "function"
      ? (await mammoth.convertToMarkdown({ buffer }))?.value || ""
      : htmlAnchorsToMarkdownLinks((await mammoth.convertToHtml({ buffer }))?.value || "");
  return normalizeDocxResumeText(markdown);
}

function htmlAnchorsToMarkdownLinks(html) {
  return String(html || "")
    .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href, inner) => {
      const text = inner.replace(/<[^>]+>/g, "").trim();
      return href ? `${text} (${href})` : text;
    })
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function normalizeDocxResumeText(text) {
  return stripUnsafeControlCharacters(
    String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
  )
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function looksLikeUsableResumeText(text) {
  const normalized = normalizeDocxResumeText(text);
  if (!normalized) return false;

  const replacementCount = (normalized.match(/\uFFFD/g) || []).length;
  if (replacementCount / normalized.length > 0.01) return false;

  const words = normalized.match(/[A-Za-z][A-Za-z0-9'+.-]*/g) || [];
  if (words.length < 8) return false;

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let signals = 0;
  if (EMAIL_RE.test(normalized) || PHONE_RE.test(normalized) || URL_RE.test(normalized))
    signals += 1;
  if (lines.some((line) => RESUME_HEADING_RE.test(line))) signals += 1;
  if (ACTION_RE.test(normalized)) signals += 1;
  if (DATE_RE.test(normalized)) signals += 1;
  if (lines.length >= 5 && words.length >= 20) signals += 1;

  return signals >= 2 || (lines.length >= 6 && words.length >= 35);
}
