import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { scanPublicRepoSource } from "./repo-scanner.mjs";
import { fetchDeepIngestUrl } from "./source-fetch.mjs";
import {
  chunkText,
  laneForTargetShape,
  looksLoginGated,
  makeDeepIngestId,
  normalizeDeepIngestSource,
  normalizeLimits,
} from "./source-normalize.mjs";

const TEXT_FILE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".yml",
  ".yaml",
  ".csv",
]);

export async function scanDeepIngestSource({
  input,
  fetchImpl = fetch,
  resolveHost,
  limits = {},
  signal,
} = {}) {
  const normalized = normalizeDeepIngestSource(input);
  const normalizedLimits = normalizeLimits(limits);

  try {
    switch (normalized.sourceKind) {
      case "paste":
      case "text":
      case "note":
      case "recruiter_context":
      case "job_context":
        return buildTextResult({
          input: normalized,
          text: normalized.text,
          limits: normalizedLimits,
        });
      case "url":
      case "linkedin":
      case "portfolio":
      case "project_link":
        return scanUrlSource({
          input: normalized,
          fetchImpl,
          resolveHost,
          limits: normalizedLimits,
          signal,
        });
      case "repo":
        return scanRepoSource({ input: normalized, limits: normalizedLimits });
      case "local_path":
        return scanLocalPathSource({ input: normalized, limits: normalizedLimits });
      case "file":
        return scanFileSource({ input: normalized, limits: normalizedLimits });
      default:
        return buildOutcome({
          input: normalized,
          status: "not_available",
          reason: `unsupported source kind ${normalized.sourceKind}`,
        });
    }
  } catch (err) {
    return buildOutcome({
      input: normalized,
      status: "failed",
      reason: err?.message || String(err),
    });
  }
}

async function scanUrlSource({ input, fetchImpl, resolveHost, limits, signal }) {
  let fetched;
  try {
    fetched = await fetchDeepIngestUrl(input.url, {
      fetchImpl,
      resolveHost,
      timeoutMs: limits.fetchTimeoutMs,
      maxBytes: limits.maxFetchBytes,
      signal,
    });
  } catch (err) {
    return buildOutcome({ input, status: "failed", reason: err?.message || String(err) });
  }

  if (!fetched.ok) {
    return buildOutcome({
      input,
      status: fetched.status === "gap" ? "gap" : "not_available",
      reason: fetched.reason,
      truncated: fetched.truncated === true,
      metadata: { url: input.url, finalUrl: fetched.finalUrl || null },
    });
  }

  if (looksLoginGated(fetched.text)) {
    return buildOutcome({
      input,
      status: "deferred",
      reason: "login or sign in wall detected",
      metadata: {
        url: input.url,
        finalUrl: fetched.finalUrl || null,
        contentType: fetched.contentType,
      },
    });
  }

  if (fetched.truncated || fetched.text.length > limits.maxSourceChars) {
    return buildTextResult({
      input,
      text: fetched.text.slice(0, limits.maxSourceChars),
      status: "gap",
      reason: fetched.reason || "source text was truncated because it is too large",
      truncated: true,
      metadata: {
        url: input.url,
        finalUrl: fetched.finalUrl || null,
        contentType: fetched.contentType,
      },
      limits,
    });
  }

  return buildTextResult({
    input,
    text: fetched.text,
    metadata: {
      url: input.url,
      finalUrl: fetched.finalUrl || null,
      contentType: fetched.contentType,
    },
    limits,
  });
}

function scanRepoSource({ input, limits }) {
  if (input.url && !input.repoPath) {
    return buildOutcome({
      input,
      status: "deferred",
      reason: "remote repo scanning requires a local repo path in this slice",
      metadata: { url: input.url },
    });
  }

  const scanned = scanPublicRepoSource(input.repoPath, {
    maxFiles: limits.maxRepoFiles,
    maxBytes: limits.maxRepoBytes,
  });
  if (!scanned.ok) {
    return buildOutcome({ input, status: "gap", reason: scanned.reason, files: scanned.files });
  }

  return buildTextResult({
    input,
    text: scanned.text,
    files: scanned.files.map(({ relativePath, bytes }) => ({ relativePath, bytes })),
    metadata: { repoPath: input.repoPath },
    truncated: scanned.truncated,
    limits,
  });
}

function scanLocalPathSource({ input, limits }) {
  if (!input.explicit) {
    return buildOutcome({
      input,
      status: "not_available",
      reason: "explicit local path consent is required",
      metadata: { path: input.path },
    });
  }
  if (!existsSync(input.path)) {
    return buildOutcome({
      input,
      status: "gap",
      reason: "local path is unreadable or missing",
      metadata: { path: input.path },
    });
  }
  const stat = statSync(input.path);
  if (!stat.isFile()) {
    return buildOutcome({
      input,
      status: "gap",
      reason: "local path is unsupported because it is not a text file",
      metadata: { path: input.path },
    });
  }
  if (!TEXT_FILE_EXTENSIONS.has(extname(input.path).toLowerCase())) {
    return buildOutcome({
      input,
      status: "not_available",
      reason: "unsupported local file type",
      metadata: { path: input.path },
    });
  }
  const text = readFileSync(input.path, "utf8");
  return buildTextResult({ input, text, metadata: { path: input.path }, limits });
}

function scanFileSource({ input, limits }) {
  const ext = extname(input.fileName || "").toLowerCase();
  if (input.fileName && !TEXT_FILE_EXTENSIONS.has(ext)) {
    return buildOutcome({
      input,
      status: "not_available",
      reason: "unsupported file type",
      metadata: { fileName: input.fileName, artifactPath: input.artifactPath || null },
    });
  }

  let text = input.text;
  if (text == null && input.bytes) text = Buffer.from(input.bytes).toString("utf8");
  if (!String(text || "").trim()) {
    return buildOutcome({
      input,
      status: "gap",
      reason: "file did not contain readable text",
      metadata: { fileName: input.fileName, artifactPath: input.artifactPath || null },
    });
  }
  return buildTextResult({
    input,
    text,
    metadata: { fileName: input.fileName, artifactPath: input.artifactPath || null },
    limits,
  });
}

function buildTextResult({
  input,
  text,
  status = "proposal_ready",
  reason = null,
  metadata = {},
  files = null,
  truncated = false,
  limits,
}) {
  const sourceId = makeDeepIngestId("deep_src", [
    input.targetShape,
    input.sourceKind,
    input.url || input.path || input.repoPath || input.fileName || "",
    text,
  ]);
  const safeText = String(text || "");
  const resultStatus = status === "proposal_ready" && !safeText.trim() ? "gap" : status;
  const chunks = safeText.trim()
    ? chunkText({ sourceId, text: safeText, maxChars: limits.maxSourceChars })
    : [];
  const finalReason =
    reason || (resultStatus === "gap" ? "source did not contain readable text" : null);
  return buildOutcome({
    input,
    sourceId,
    status: resultStatus,
    reason: finalReason,
    metadata,
    chunks,
    files,
    truncated,
    textLength: safeText.length,
  });
}

function buildOutcome({
  input,
  sourceId = null,
  status,
  reason = null,
  metadata = {},
  chunks = [],
  files = null,
  truncated = false,
  textLength = 0,
}) {
  const id =
    sourceId ||
    makeDeepIngestId("deep_src", [
      input.targetShape,
      input.sourceKind,
      input.url || input.path || input.repoPath || input.fileName || input.text || "",
      status,
      reason || "",
    ]);
  const source = {
    id,
    kind: input.sourceKind,
    sourceKind: input.sourceKind,
    targetShape: input.targetShape,
    status,
    label: input.label || labelForSource(input),
    artifactPath: input.artifactPath || metadata.artifactPath || null,
    metadata,
    textLength,
  };
  const outcome = {
    id: `outcome_${id}`,
    sourceId: id,
    status,
    targetShape: input.targetShape,
    visible: true,
    reason,
  };
  const result = {
    status,
    source,
    outcome,
    chunks,
    files: files || undefined,
    truncated,
    reason,
  };

  if (status === "proposal_ready") {
    result.proposal = {
      id: `proposal_${id}`,
      sourceId: id,
      targetShape: input.targetShape,
      lane: laneForTargetShape(input.targetShape),
      status: "review_needed",
      summary: "Source scanned and ready for review.",
      chunkIds: chunks.map((chunk) => chunk.id),
      validation: { status: "source_scanned" },
    };
  } else if (status === "manual_fallback") {
    result.manualFallback = visibleState("manual_fallback", reason);
  } else if (status === "gap") {
    result.gap = visibleState("gap", reason);
  } else if (status === "deferred") {
    result.deferred = visibleState("deferred", reason);
  } else if (status === "not_available") {
    result.notAvailable = visibleState("not_available", reason);
  } else {
    result.error = visibleState("failed", reason);
  }
  return result;
}

function visibleState(status, reason) {
  return { status, reason: reason || status.replaceAll("_", " ") };
}

function labelForSource(input) {
  if (input.label) return input.label;
  if (input.fileName) return input.fileName;
  if (input.url) return input.url;
  if (input.path) return input.path;
  if (input.repoPath) return input.repoPath;
  return "Deep ingest source";
}
