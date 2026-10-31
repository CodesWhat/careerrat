import { extractDocxResumeText, normalizeDocxResumeText } from "../onboarding/resume-docx.mjs";

const DOCX_EXTRACT_MAX_BYTES = 5 * 1024 * 1024;

export function isUsableExtractedText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  const replacementCount = (trimmed.match(/�/g) || []).length;
  return replacementCount / trimmed.length <= 0.01;
}

function parseHeaderBlock(block) {
  const headers = {};
  let lastKey = null;
  for (const line of block.split("\n")) {
    if (/^[ \t]/.test(line) && lastKey) {
      headers[lastKey] += ` ${line.trim()}`;
      continue;
    }
    const m = line.match(/^([\w-]+):\s?(.*)$/);
    if (m) {
      lastKey = m[1].toLowerCase();
      headers[lastKey] = m[2];
    }
  }
  return headers;
}

// RFC 2045 quoted-printable: "=XX" hex-escapes a byte, "=" at end-of-line is
// a soft line break to be removed. Decoded byte-by-byte then re-decoded as
// utf8 so multi-byte characters (encoded as consecutive =XX escapes) survive
// intact.
function decodeQuotedPrintable(text) {
  const joined = String(text || "").replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    const hex = joined.slice(i + 1, i + 3);
    if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeEmailBodyPart(bodyText, transferEncoding) {
  const enc = String(transferEncoding || "")
    .toLowerCase()
    .trim();
  if (enc === "quoted-printable") return decodeQuotedPrintable(bodyText);
  if (enc === "base64") {
    try {
      return Buffer.from(String(bodyText || "").replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return bodyText;
}

function parseEmlBytes(bytes) {
  const raw = bytes.toString("utf8").replace(/\r\n/g, "\n");
  const blankIdx = raw.indexOf("\n\n");
  if (blankIdx === -1) return { ok: false, reason: "eml-no-header-body-split" };
  const headers = parseHeaderBlock(raw.slice(0, blankIdx));
  const bodyBlock = raw.slice(blankIdx + 2);

  const contentType = headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
  let plainBody = null;

  if (/multipart\//i.test(contentType) && boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = bodyBlock.split(`--${boundary}`).slice(1, -1);
    for (const part of parts) {
      const partBlankIdx = part.indexOf("\n\n");
      if (partBlankIdx === -1) continue;
      const partHeaders = parseHeaderBlock(part.slice(0, partBlankIdx).trim());
      const partBody = part.slice(partBlankIdx + 2);
      const partType = (partHeaders["content-type"] || "text/plain").toLowerCase();
      if (partType.startsWith("text/plain")) {
        plainBody = decodeEmailBodyPart(partBody, partHeaders["content-transfer-encoding"]);
        break;
      }
    }
    if (plainBody === null) return { ok: false, reason: "eml-no-plain-text-part" };
  } else {
    plainBody = decodeEmailBodyPart(bodyBlock, headers["content-transfer-encoding"]);
  }

  const lines = [];
  if (headers.from) lines.push(`From: ${headers.from}`);
  if (headers.subject) lines.push(`Subject: ${headers.subject}`);
  if (lines.length) lines.push("");
  lines.push(String(plainBody || "").trim());
  const text = normalizeDocxResumeText(lines.join("\n"));
  if (!isUsableExtractedText(text)) return { ok: false, reason: "eml-empty-body" };
  return { ok: true, text };
}

export async function extractLocalIntakeText({ ext, bytes }) {
  if (ext === ".txt" || ext === ".md") {
    const text = normalizeDocxResumeText(bytes.toString("utf8"));
    if (!isUsableExtractedText(text)) return { ok: false, reason: "empty-file" };
    return { ok: true, text, extraction: "local" };
  }

  if (ext === ".docx") {
    if (bytes.length > DOCX_EXTRACT_MAX_BYTES) {
      return { ok: false, reason: "too-large-for-extraction" };
    }
    let text;
    try {
      text = await extractDocxResumeText(bytes);
    } catch {
      return { ok: false, reason: "docx-extraction-failed" };
    }
    if (!isUsableExtractedText(text)) return { ok: false, reason: "docx-extraction-failed" };
    return { ok: true, text, extraction: "local" };
  }

  if (ext === ".eml") {
    const parsed = parseEmlBytes(bytes);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    return { ok: true, text: parsed.text, extraction: "local" };
  }

  return { ok: false, reason: "unsupported-type" };
}
