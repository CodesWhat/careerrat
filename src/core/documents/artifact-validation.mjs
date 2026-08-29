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

export function validDocumentArtifact(path) {
  const extension = extname(String(path || "")).toLowerCase();
  if (!new Set([".pdf", ".docx"]).has(extension) || !existsSync(path)) return false;
  try {
    if (!statSync(path).isFile()) return false;
    const buffer = readFileSync(path);
    return extension === ".pdf" ? isPdf(buffer) : isDocx(buffer);
  } catch {
    return false;
  }
}
