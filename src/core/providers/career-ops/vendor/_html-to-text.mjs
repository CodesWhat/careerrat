// @ts-check
// Shared HTML → plain-text pipeline for providers whose payloads embed
// description markup. Greenhouse's contentToText was the first instance;
// this is the extracted form so later providers cannot grow a divergent
// copy — same rationale that produced _html-entities when entity decoders
// drifted across four files (#1555/#1639/#2623).
import { decodeEntities } from './_html-entities.mjs';

// A tag ends at an unquoted `>`. Attribute values may contain angle brackets,
// so the naive `<[^>]+>` shortcut can stop midway through a tag and expose
// the remaining attributes as description text. Requiring content between
// the brackets preserves a literal `<>`, as the old matcher did.
const HTML_TAG_RE = /<(?:[^>"']|"[^"]*"|'[^']*')+>/g;
const HTML_MEDIA_RE = /<(script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi;

/** @param {string} content */
function stripMarkup(content) {
  return content.replace(HTML_MEDIA_RE, ' ').replace(HTML_TAG_RE, ' ');
}

// Full JDs commonly exceed the old 4,000-character preview cap. Keep a much
// larger per-posting byte bound for pathological provider payloads, and expose
// whether it was reached so no caller can mistake the retained prefix for a
// complete canonical capture.
export const DESCRIPTION_MAX_BYTES = 64 * 1024;

/**
 * @param {string} text
 * @returns {{ text: string, truncated: boolean }}
 */
export function capDescriptionText(text) {
  const normalized = String(text || '');
  const bytes = Buffer.from(normalized, 'utf8');
  if (bytes.byteLength <= DESCRIPTION_MAX_BYTES) {
    return { text: normalized, truncated: false };
  }
  return {
    text: bytes
      .subarray(0, DESCRIPTION_MAX_BYTES)
      .toString('utf8')
      .replace(/\uFFFD$/, '')
      .trimEnd(),
    truncated: true,
  };
}

/**
 * Entity-decoded markup → stripped plain text.
 *
 * Double-decode: the payload often carries entity-escaped tags (`&lt;p&gt;`),
 * so the first pass reveals real tags, and text-level entities (`&amp;`,
 * `&#39;`) only become decodable once those tags are gone. Plain text is what
 * the description-consuming filters match against — substring matching over
 * raw HTML misses keywords split by a tag and pads matches into attribute
 * soup.
 *
 * Exported for tests.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function htmlToText(content) {
  return htmlToTextCapture(content).text;
}

/**
 * @param {unknown} content
 * @returns {{ text: string, truncated: boolean }}
 */
export function htmlToTextCapture(content) {
  if (typeof content !== 'string' || !content) return { text: '', truncated: false };
  // Strip literal markup before decoding: quote entities inside a quoted
  // attribute are data, and decoding them first would turn them into false
  // delimiters. Each decode is followed by a strip so double-encoded active
  // markup cannot become the final plain-text output. A final incomplete tag
  // opener has no closing `>` for stripMarkup() to consume, so drop only its
  // leading angle bracket; this keeps the text visible while making it inert.
  const decoded = decodeEntities(stripMarkup(content));
  const decodedTwice = decodeEntities(stripMarkup(decoded));
  const text = stripMarkup(decodedTwice)
    .replace(/<(?=\/?[a-z!?])/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return capDescriptionText(text);
}
