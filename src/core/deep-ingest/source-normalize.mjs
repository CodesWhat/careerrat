import { createHash } from "node:crypto";

export const DEEP_INGEST_JSON_BODY_MAX_BYTES = 1024 * 1024;
export const DEEP_INGEST_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const DEEP_INGEST_SOURCE_TEXT_MAX_CHARS = 12000;
export const DEEP_INGEST_REPO_FILE_LIMIT = 12;
export const DEEP_INGEST_REPO_MAX_BYTES = 128 * 1024;
export const DEEP_INGEST_FETCH_TIMEOUT_MS = 12000;
export const DEEP_INGEST_FETCH_MAX_BYTES = 512 * 1024;

export const DEEP_INGEST_TARGET_SHAPES = Object.freeze([
  "auto",
  "evidence",
  "story",
  "writing_voice",
  "honesty_boundary",
  "role_signal",
  "paste",
  "link",
]);

export const DEEP_INGEST_SOURCE_KINDS = Object.freeze([
  "paste",
  "text",
  "url",
  "file",
  "repo",
  "local_path",
  "linkedin",
  "portfolio",
  "note",
  "recruiter_context",
  "job_context",
  "project_link",
]);

export const TARGET_SHAPE_TO_LANE = Object.freeze({
  auto: "open_gaps",
  evidence: "evidence_claims",
  story: "story_bank",
  writing_voice: "writing_voice",
  honesty_boundary: "honesty_boundaries",
  role_signal: "role_signals",
  paste: "open_gaps",
  link: "open_gaps",
});

const TARGET_SHAPE_SET = new Set(DEEP_INGEST_TARGET_SHAPES);
const SOURCE_KIND_SET = new Set(DEEP_INGEST_SOURCE_KINDS);

export function makeDeepIngestId(prefix, parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(String(part ?? ""));
  return `${prefix}_${hash.digest("hex").slice(0, 16)}`;
}

export function normalizeDeepIngestSource(input = {}) {
  if (!input || typeof input !== "object") {
    throw validationError("Deep ingest source payload is required");
  }

  const targetShape = String(input.targetShape || "").trim();
  if (!TARGET_SHAPE_SET.has(targetShape)) {
    throw validationError(`targetShape must be one of ${DEEP_INGEST_TARGET_SHAPES.join(", ")}`);
  }

  const sourceKind = String(input.sourceKind || "").trim();
  if (!SOURCE_KIND_SET.has(sourceKind)) {
    throw validationError(`sourceKind must be one of ${DEEP_INGEST_SOURCE_KINDS.join(", ")}`);
  }

  const normalized = {
    ...input,
    targetShape,
    sourceKind,
  };

  if (["paste", "text", "note", "recruiter_context", "job_context"].includes(sourceKind)) {
    normalized.text = String(input.text || "");
    if (!normalized.text.trim()) {
      throw validationError("text is required for paste/text Deep ingest sources");
    }
    return normalized;
  }

  if (
    sourceKind === "url" ||
    sourceKind === "linkedin" ||
    sourceKind === "portfolio" ||
    sourceKind === "project_link"
  ) {
    normalized.url = String(input.url || input.text || "").trim();
    if (!normalized.url) throw validationError("url is required for URL Deep ingest sources");
    return normalized;
  }

  if (sourceKind === "repo") {
    normalized.repoPath = input.repoPath ? String(input.repoPath) : null;
    normalized.url = input.url ? String(input.url).trim() : null;
    if (!normalized.repoPath && !normalized.url) {
      throw validationError("repoPath or url is required for repo Deep ingest sources");
    }
    return normalized;
  }

  if (sourceKind === "local_path") {
    normalized.path = String(input.path || input.text || "").trim();
    if (!normalized.path) throw validationError("path is required for local_path sources");
    normalized.explicit = input.explicit === true || input.explicit === "true";
    return normalized;
  }

  if (sourceKind === "file") {
    normalized.fileName = String(input.fileName || input.name || "").trim();
    normalized.bytes = input.bytes || null;
    normalized.text = typeof input.text === "string" ? input.text : null;
    if (!normalized.fileName && !normalized.bytes && !normalized.text) {
      throw validationError("fileName, bytes, or text is required for file sources");
    }
    return normalized;
  }

  return normalized;
}

export function normalizeLimits(limits = {}) {
  return {
    maxSourceChars: positiveInt(limits.maxSourceChars, DEEP_INGEST_SOURCE_TEXT_MAX_CHARS),
    maxFetchBytes: positiveInt(limits.maxFetchBytes, DEEP_INGEST_FETCH_MAX_BYTES),
    fetchTimeoutMs: positiveInt(limits.fetchTimeoutMs, DEEP_INGEST_FETCH_TIMEOUT_MS),
    maxRepoFiles: positiveInt(limits.maxRepoFiles, DEEP_INGEST_REPO_FILE_LIMIT),
    maxRepoBytes: positiveInt(limits.maxRepoBytes, DEEP_INGEST_REPO_MAX_BYTES),
  };
}

export function laneForTargetShape(targetShape) {
  return TARGET_SHAPE_TO_LANE[targetShape] || "open_gaps";
}

export function chunkText({ sourceId, text, maxChars }) {
  const safeText = String(text || "");
  const chunks = [];
  for (let start = 0, index = 0; start < safeText.length; start += maxChars, index += 1) {
    const slice = safeText.slice(start, start + maxChars);
    chunks.push({
      id: `${sourceId}_chunk_${String(index + 1).padStart(3, "0")}`,
      sourceId,
      index,
      chunkKind: "text",
      text: slice,
      charStart: start,
      charEnd: start + slice.length,
      byteStart: Buffer.byteLength(safeText.slice(0, start), "utf8"),
      byteEnd: Buffer.byteLength(safeText.slice(0, start + slice.length), "utf8"),
    });
  }
  return chunks;
}

export function plainTextFromHtml(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function looksLoginGated(text = "") {
  const sample = String(text).slice(0, 4000).toLowerCase();
  return /\b(sign in|log in|login|required to continue|authenticate|authentication required|enable javascript)\b/.test(
    sample
  );
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function validationError(message) {
  const err = new Error(message);
  err.code = "BAD_REQUEST";
  return err;
}
