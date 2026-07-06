import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, normalize, relative, sep } from "node:path";
import { appRegisterArtifact } from "../db/verbs.mjs";
import { requireDb } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";
import { parseSavedJob } from "../evaluate/gate.mjs";

const JOB_BODY_MIN_CHARS = 40;

function cleanText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function slugPart(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "application";
}

function workspaceDisplayPath(relPath) {
  return `workspace/${relPath.replaceAll(sep, "/")}`;
}

function safeWorkspacePath(workspaceDir, storedPath) {
  const raw = String(storedPath || "").trim();
  if (!raw || raw.includes("\0") || isAbsolute(raw)) return null;
  const withoutPrefix = raw.startsWith("workspace/") ? raw.slice("workspace/".length) : raw;
  const normalized = normalize(withoutPrefix);
  if (!normalized || normalized === "." || normalized.startsWith("..")) return null;
  const full = join(workspaceDir, normalized);
  if (full !== workspaceDir && !full.startsWith(`${workspaceDir}${sep}`)) return null;
  return full;
}

function readSavedJobBody(workspaceDir, storedPath) {
  const full = safeWorkspacePath(workspaceDir, storedPath);
  if (!full || !existsSync(full)) return null;
  let text;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    return null;
  }
  const parsed = parseSavedJob(text);
  const body = cleanText(parsed.body || text);
  if (body.length < JOB_BODY_MIN_CHARS) return null;
  return { body, path: storedPath };
}

function withoutCurrentComp(value) {
  if (Array.isArray(value)) return value.map(withoutCurrentComp);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "current_base") continue;
    out[key] = withoutCurrentComp(child);
  }
  return out;
}

function findApplication(tracker, applicationId) {
  const apps = Array.isArray(tracker.applications) ? tracker.applications : [];
  return apps.find((app) => String(app?.id) === String(applicationId)) || null;
}

export function capturePacketJobBody({
  repoRoot,
  env = process.env,
  applicationId,
  body,
  sourceUrl,
} = {}) {
  const normalized = cleanText(body);
  if (normalized.length < JOB_BODY_MIN_CHARS) {
    const err = new Error("readable job body is required");
    err.code = "MISSING_JOB_BODY";
    throw err;
  }

  const db = requireDb({ repoRoot, env });
  const tracker = assembleTrackerObject(db);
  const app = findApplication(tracker, applicationId);
  if (!app) {
    const err = new Error(`no application with id "${applicationId}"`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  const rel = join(
    "jobs",
    `${slugPart(app.company)}-${slugPart(app.role)}-${slugPart(applicationId)}.md`
  );
  const full = join(workspaceDir, rel);
  mkdirSync(join(workspaceDir, "jobs"), { recursive: true });
  const markdown = [
    "---",
    `company: ${JSON.stringify(app.company || "")}`,
    `role: ${JSON.stringify(app.role || "")}`,
    `applicationId: ${JSON.stringify(String(applicationId))}`,
    sourceUrl ? `sourceUrl: ${JSON.stringify(sourceUrl)}` : null,
    "---",
    "",
    "# Job Description",
    "",
    normalized,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
  writeFileSync(full, markdown, "utf8");

  const displayPath = workspaceDisplayPath(relative(workspaceDir, full));
  appRegisterArtifact({
    repoRoot,
    env,
    id: applicationId,
    kind: "jd",
    path: displayPath,
    note: sourceUrl || "captured for packet gate",
  });

  return { body: normalized, path: displayPath };
}

export function buildPacketContext({
  repoRoot,
  env = process.env,
  applicationId,
  capturedJobBody = null,
  capturedJobPath = null,
} = {}) {
  const db = requireDb({ repoRoot, env });
  const tracker = assembleTrackerObject(db);
  const app = findApplication(tracker, applicationId);
  if (!app) {
    const err = new Error(`no application with id "${applicationId}"`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  let jobBody = cleanText(capturedJobBody);
  let jdPath = capturedJobPath || null;
  if (!jobBody) {
    const saved = readSavedJobBody(workspaceDir, app.artifacts?.jd);
    if (saved) {
      jobBody = saved.body;
      jdPath = saved.path;
    }
  }

  return {
    applicationId,
    app: {
      id: app.id,
      company: app.company ?? null,
      role: app.role ?? null,
      status: app.status ?? null,
      artifacts: { ...(app.artifacts || {}) },
      packetManifest: app.packetManifest || null,
    },
    job: {
      body: jobBody,
      path: jdPath,
      frontmatter: {
        company: app.company ?? "",
        role: app.role ?? "",
        location: app.location ?? "",
        mode: app.mode ?? "",
        comp: app.compNote ?? "",
      },
    },
    candidate: withoutCurrentComp(tracker.candidate || tracker.profile || {}),
    targeting: withoutCurrentComp(tracker.targeting || {}),
  };
}

export function hasReadableJobBody(context) {
  return cleanText(context?.job?.body).length >= JOB_BODY_MIN_CHARS;
}

export function packetPromptFromContext(context) {
  return [
    `Company: ${context.app.company || ""}`,
    `Role: ${context.app.role || ""}`,
    "",
    "Job Description:",
    cleanText(context.job.body),
    "",
    "Return a bounded packet gate JSON verdict.",
  ].join("\n");
}
