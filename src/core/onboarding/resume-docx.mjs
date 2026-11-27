import JSZip from "jszip";
import mammoth from "mammoth";
import { htmlToMarkdownText } from "../text/html-text.mjs";

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

// Archive limits shared by both Mammoth entrypoints. The upload cap bounds the
// compressed bytes only; a tiny DOCX can inflate to far more. Entry sizes in
// the zip directory are attacker-controlled, so the limits are enforced against
// bytes actually produced by decompression, which stops as soon as one is hit.
export const DOCX_MAX_ENTRIES = 500;
export const DOCX_MAX_ENTRY_BYTES = 6 * 1024 * 1024;
const DOCX_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function inflateEntryBounded(entry, maxBytes) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const stream = entry.internalStream("uint8array");
    stream
      .on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          stream.pause();
          reject(new Error("DOCX entry expands beyond the allowed size"));
        }
      })
      .on("error", reject)
      .on("end", () => resolve(bytes))
      .resume();
  });
}

async function assertDocxArchiveWithinLimits(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (Object.keys(zip.files).length > DOCX_MAX_ENTRIES) {
    throw new Error("DOCX has too many entries");
  }
  let total = 0;
  for (const entry of entries) {
    total += await inflateEntryBounded(
      entry,
      Math.min(DOCX_MAX_ENTRY_BYTES, DOCX_MAX_TOTAL_BYTES - total)
    );
    if (total > DOCX_MAX_TOTAL_BYTES) throw new Error("DOCX expands beyond the allowed size");
  }
}

export async function extractDocxResumeText(buffer) {
  await assertDocxArchiveWithinLimits(buffer);
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
  await assertDocxArchiveWithinLimits(buffer);
  const markdown =
    typeof mammoth.convertToMarkdown === "function"
      ? (await mammoth.convertToMarkdown({ buffer }))?.value || ""
      : htmlAnchorsToMarkdownLinks((await mammoth.convertToHtml({ buffer }))?.value || "");
  return normalizeDocxResumeText(markdown);
}

function htmlAnchorsToMarkdownLinks(html) {
  return htmlToMarkdownText(html);
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
