import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";

import { requireDb } from "../db/connection.mjs";
import { markdownToHtml } from "../documents/export.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";
import { splitFrontmatter } from "../research/research-store.mjs";

const SOURCE_TABLES = Object.freeze({ application: "applications", sourced: "sourced" });
const MAX_JOB_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_JOB_FRONTMATTER_BYTES = 64 * 1024;

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanRequest({ source, id }) {
  const recordType = String(source || "").trim();
  const recordId = String(id || "").trim();
  if (!SOURCE_TABLES[recordType] || !recordId) {
    throw makeError("source=application|sourced and id are required", "BAD_REQUEST");
  }
  return { recordType, recordId };
}

function within(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function artifactPathValue(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") return String(value.path || "").trim();
  return "";
}

function resolveSafeJobPath(workspaceDir, storedValue) {
  const storedPath = artifactPathValue(storedValue);
  if (!storedPath) throw makeError("No job description has been captured yet.", "JD_NOT_CAPTURED");
  const stripped = storedPath.startsWith("workspace/")
    ? storedPath.slice("workspace/".length)
    : storedPath;
  const relPath = normalize(stripped);
  const ext = extname(relPath).toLowerCase();
  if (
    !relPath ||
    relPath === "." ||
    relPath.startsWith("..") ||
    isAbsolute(relPath) ||
    relPath.includes("\0") ||
    (!relPath.startsWith(`jobs${sep}`) && !relPath.startsWith("jobs/")) ||
    ![".md", ".markdown", ".txt"].includes(ext)
  ) {
    throw makeError(
      "The saved job description path is outside the job-artifact area.",
      "UNSAFE_ARTIFACT_PATH"
    );
  }

  const jobsRoot = join(workspaceDir, "jobs");
  const full = join(workspaceDir, relPath);
  if (!within(jobsRoot, full)) {
    throw makeError(
      "The saved job description path is outside the job-artifact area.",
      "UNSAFE_ARTIFACT_PATH"
    );
  }
  if (!existsSync(full))
    throw makeError("The captured job description file is missing.", "JD_FILE_MISSING");

  let canonicalRoot;
  let canonicalFile;
  try {
    canonicalRoot = realpathSync(jobsRoot);
    canonicalFile = realpathSync(full);
  } catch {
    throw makeError("The captured job description file is missing.", "JD_FILE_MISSING");
  }
  if (!within(canonicalRoot, canonicalFile)) {
    throw makeError(
      "The saved job description path escapes through a link.",
      "UNSAFE_ARTIFACT_PATH"
    );
  }
  if (statSync(canonicalFile).size > MAX_JOB_ARTIFACT_BYTES) {
    throw makeError("The captured job description is too large to preview.", "JD_TOO_LARGE");
  }
  return { full: canonicalFile, storedPath };
}

function recordFromDb(db, table, id, recordType) {
  const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw makeError(`no ${recordType} job with id "${id}"`, "NOT_FOUND");
  return JSON.parse(row.data);
}

function isPartialCapture(frontmatter, body) {
  if (frontmatter?.partial === true) return true;
  const text = String(body || "").trim();
  return !text || /No job-description body was returned by the capture source\./i.test(text);
}

function readStoredPartialValue(workspaceDir, storedValue) {
  let handle;
  try {
    const { full } = resolveSafeJobPath(workspaceDir, storedValue);
    handle = openSync(full, "r");
    const buffer = Buffer.alloc(MAX_JOB_FRONTMATTER_BYTES);
    const bytesRead = readSync(handle, buffer, 0, buffer.length, 0);
    const { frontmatter } = splitFrontmatter(buffer.subarray(0, bytesRead).toString("utf8"));
    return typeof frontmatter?.partial === "boolean" ? frontmatter.partial : null;
  } catch {
    return null;
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // Read-model hydration must never take down the dashboard.
      }
    }
  }
}

export function hydrateJobDescriptionCompleteness({
  trackerData,
  repoRoot,
  env = process.env,
} = {}) {
  if (!trackerData || !Array.isArray(trackerData.sourced)) return trackerData;
  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  let changed = false;
  const sourced = trackerData.sourced.map((row) => {
    if (typeof row?.scanner?.bodyPartial === "boolean") return row;
    const bodyPartial = readStoredPartialValue(workspaceDir, row?.artifacts?.jd);
    if (bodyPartial === null) return row;
    changed = true;
    const scanner = row?.scanner && typeof row.scanner === "object" ? row.scanner : {};
    return { ...row, scanner: { ...scanner, bodyPartial } };
  });
  return changed ? { ...trackerData, sourced } : trackerData;
}

export function readJobDescriptionArtifact({ repoRoot, env = process.env, source, id } = {}) {
  const { recordType, recordId } = cleanRequest({ source, id });
  const db = requireDb({ repoRoot, env });
  const record = recordFromDb(db, SOURCE_TABLES[recordType], recordId, recordType);
  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  const { full, storedPath } = resolveSafeJobPath(workspaceDir, record.artifacts?.jd);
  const text = readFileSync(full, "utf8");
  const { frontmatter: rawFrontmatter, body: rawBody } = splitFrontmatter(text);
  const frontmatter = rawFrontmatter || {};
  const markdown = String(rawBody || text).trim();
  const partial = isPartialCapture(frontmatter, markdown);

  return {
    id: recordId,
    recordType,
    company: record.company || frontmatter.company || null,
    role: record.role || record.title || frontmatter.role || null,
    artifact: {
      kind: "job_description",
      completeness: partial ? "partial" : "complete",
      capturedAt:
        frontmatter.capturedAt ||
        frontmatter.dateSaved ||
        frontmatter.fetchedAt ||
        record.capturedAt ||
        record.sourcedAt ||
        null,
      sourceName: frontmatter.sourceName || record.sourceMeta?.sourceLabel || record.source || null,
      sourceUrl: frontmatter.source || record.link || record.url || null,
      markdown,
      html: markdownToHtml(markdown),
      bodyChars: markdown.length,
      technical: { path: storedPath },
    },
  };
}
