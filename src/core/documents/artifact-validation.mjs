import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const PDF_HEADER = Buffer.from("%PDF-");
const PDF_TRAILER = Buffer.from("%%EOF");
const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_END = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

function hasBytes(buffer, bytes) {
  return buffer.indexOf(bytes) >= 0;
}

function isPdf(buffer) {
  if (buffer.length < 16 || !buffer.subarray(0, PDF_HEADER.length).equals(PDF_HEADER)) return false;
  return hasBytes(buffer.subarray(Math.max(0, buffer.length - 2048)), PDF_TRAILER);
}

function isDocx(buffer) {
  if (buffer.length < 64 || !buffer.subarray(0, ZIP_HEADER.length).equals(ZIP_HEADER)) return false;
  const tail = buffer.subarray(Math.max(0, buffer.length - 65_557));
  if (!hasBytes(tail, ZIP_END)) return false;
  return (
    hasBytes(buffer, Buffer.from("[Content_Types].xml")) &&
    hasBytes(buffer, Buffer.from("word/document.xml"))
  );
}

// Reused across calls; `fatal: true` makes decode() throw instead of
// silently substituting U+FFFD for invalid byte sequences.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

// A plain-text export is "valid" when it's non-empty UTF-8 with no null
// bytes (the one byte sequence that never appears in real text and reliably
// flags a truncated or binary write) and decodes cleanly as UTF-8. A
// malformed sequence (an invalid lead byte, or a multibyte sequence
// truncated mid-character) is corrupt output masquerading as text.
function isPlainText(buffer) {
  if (buffer.length === 0 || buffer.includes(0)) return false;
  try {
    utf8Decoder.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export function validDocumentArtifact(path) {
  const extension = extname(String(path || "")).toLowerCase();
  if (!new Set([".pdf", ".docx", ".txt"]).has(extension) || !existsSync(path)) return false;
  try {
    if (!statSync(path).isFile()) return false;
    const buffer = readFileSync(path);
    if (extension === ".pdf") return isPdf(buffer);
    if (extension === ".docx") return isDocx(buffer);
    return isPlainText(buffer);
  } catch {
    return false;
  }
}

// validDocumentArtifact accepts .txt so a plain-text export can be
// registered and served, but the apply-driver's automatic-upload candidate
// list falls back to artifacts.resume/coverLetter — the raw stored source,
// which is frequently a .txt Markdown file — whenever no PDF or DOCX
// exists. That source is meant for rendering, not for handing to an ATS
// upload control. Restrict automatic-upload validation to the formats an
// ATS actually accepts.
export function validUploadArtifact(path) {
  const extension = extname(String(path || "")).toLowerCase();
  if (extension !== ".pdf" && extension !== ".docx") return false;
  return validDocumentArtifact(path);
}
