import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join, normalize, relative, sep } from "node:path";
import { exportArtifact as documentExportArtifact } from "../documents/export.mjs";
import { requireDb } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import { appRegisterPacketArtifacts as registerPacketArtifacts } from "../db/verbs.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";

function cleanText(value) {
  return String(value || "").trim();
}

function workspaceDisplayPath(workspaceDir, absPath) {
  return `workspace/${relative(workspaceDir, absPath).replaceAll(sep, "/")}`;
}

function stripWorkspacePrefix(value) {
  return value.startsWith("workspace/") ? value.slice("workspace/".length) : value;
}

function resolveWorkspacePath(workspaceDir, storedPath) {
  const raw = cleanText(storedPath);
  if (!raw || raw.includes("\0")) return null;
  const rel = normalize(stripWorkspacePrefix(raw));
  if (!rel || rel === "." || rel.startsWith("..")) return null;
  const full = join(workspaceDir, rel);
  if (full !== workspaceDir && !full.startsWith(`${workspaceDir}${sep}`)) return null;
  return full;
}

function sourceKind(sourceKey) {
  if (sourceKey === "coverLetterSource") return "coverLetter";
  if (sourceKey === "answersSource") return "answers";
  return "resume";
}

function outputKey(kind, format) {
  if (kind === "coverLetter") return format === "pdf" ? "coverLetterPdf" : "coverLetterDocx";
  return `${kind}${format === "pdf" ? "Pdf" : "Docx"}`;
}

function titleFor(app, kind) {
  const label = kind === "coverLetter" ? "Cover Letter" : kind === "answers" ? "Answers" : "Resume";
  return [app.company, app.role, label].filter(Boolean).join(" - ") || label;
}

function requestedFormats({ request = {}, uploadRequirements = [] } = {}) {
  const formats = new Set(["pdf"]);
  const requested = Array.isArray(request.formats) ? request.formats : [];
  if (requested.includes("docx")) formats.add("docx");
  for (const requirement of uploadRequirements || []) {
    const reqFormats = Array.isArray(requirement?.formats) ? requirement.formats : [];
    if (requirement?.required && reqFormats.includes("docx")) formats.add("docx");
  }
  return [...formats];
}

function findApplication({ repoRoot, env, appId }) {
  const db = requireDb({ repoRoot, env });
  const tracker = assembleTrackerObject(db);
  const app = (tracker.applications || []).find((row) => String(row?.id) === String(appId));
  if (!app) {
    const err = new Error(`no application with id "${appId}"`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return app;
}

function packetSourcesFromApp(app) {
  const artifacts = app.artifacts || {};
  return {
    resumeSource: artifacts.resumeSource,
    coverLetterSource: artifacts.coverLetterSource,
    answersSource: artifacts.answersSource,
    packetManifest: artifacts.packetManifest,
  };
}

function sourceEntries(packetSources = {}) {
  return Object.entries(packetSources).filter(
    ([key, value]) => key.endsWith("Source") && typeof value === "string" && value.trim()
  );
}

export async function appRegisterPacketArtifacts({
  repoRoot,
  env,
  appId,
  applicationId,
  artifacts = {},
  manifest,
  now = () => new Date(),
} = {}) {
  const id = cleanText(applicationId || appId);
  if (!id) throw new Error("appRegisterPacketArtifacts: appId is required");
  const generatedAt = now().toISOString();
  const packetManifest = manifest || {
    applicationId: id,
    generatedAt,
    artifacts,
    uploadReady: false,
    gapCount: 0,
    status: "exported",
  };
  return registerPacketArtifacts({
    repoRoot,
    env,
    id,
    artifacts,
    manifest: packetManifest,
    note: "packet exports registered",
  });
}

export async function exportPacketArtifacts({
  repoRoot,
  env = process.env,
  appId,
  applicationId,
  packetSources,
  request = {},
  formats,
  uploadRequirements = [],
  exportArtifact = documentExportArtifact,
  now = () => new Date(),
} = {}) {
  const id = cleanText(applicationId || appId);
  if (!id) {
    const err = new Error("exportPacketArtifacts: appId is required");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const app = findApplication({ repoRoot, env, appId: id });
  const sources = packetSources || packetSourcesFromApp(app);
  const selectedFormats = requestedFormats({
    request: { ...request, formats: formats || request.formats },
    uploadRequirements,
  });
  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  const artifacts = {};
  const userFacing = { resume: [], coverLetter: [], answers: [] };

  for (const [sourceKey, storedPath] of sourceEntries(sources)) {
    const full = resolveWorkspacePath(workspaceDir, storedPath);
    if (!full || !existsSync(full)) {
      const err = new Error(`packet source artifact is missing: ${sourceKey}`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const markdown = readFileSync(full, "utf8");
    const kind = sourceKind(sourceKey);
    const outBase = full.slice(0, -extname(full).length);
    const result = await exportArtifact({
      markdown,
      outBase,
      formats: selectedFormats,
      title: titleFor(app, kind),
      ats: true,
    });

    artifacts[sourceKey] = storedPath;
    for (const format of ["pdf", "docx"]) {
      const absPath = result[format];
      if (!absPath) continue;
      const key = outputKey(kind, format);
      artifacts[key] = workspaceDisplayPath(workspaceDir, absPath);
      userFacing[kind].push({
        format,
        path: artifacts[key],
        name: basename(absPath),
      });
    }
  }

  if (sources.packetManifest) artifacts.packetManifest = sources.packetManifest;

  const registered = await appRegisterPacketArtifacts({
    repoRoot,
    env,
    appId: id,
    artifacts,
    now,
    manifest: {
      applicationId: id,
      generatedAt: now().toISOString(),
      uploadReady: true,
      status: "exported",
      gapCount: 0,
      artifacts,
    },
  });

  return {
    appId: id,
    applicationId: id,
    formats: selectedFormats,
    artifacts,
    userFacing,
    registered,
  };
}
