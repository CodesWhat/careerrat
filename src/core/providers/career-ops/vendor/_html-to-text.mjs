// @ts-check
// Shared HTML → plain-text pipeline for providers whose payloads embed
// description markup. Greenhouse's contentToText was the first instance;
// this is the extracted form so later providers cannot grow a divergent
// copy — same rationale that produced _html-entities when entity decoders
// drifted across four files (#1555/#1639/#2623).
import { decodeEntities } from './_html-entities.mjs';

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
  const html = decodeEntities(content);
  const noMedia = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const text = decodeEntities(noMedia.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return capDescriptionText(text);
}
