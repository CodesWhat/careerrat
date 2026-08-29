import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, normalize, relative, sep } from "node:path";
import { requireDb } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import { appRegisterPacketArtifacts as registerPacketArtifacts } from "../db/verbs.mjs";
import { validDocumentArtifact } from "../documents/artifact-validation.mjs";
import { exportArtifact as documentExportArtifact } from "../documents/export.mjs";
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

// tailor-application SKILL.md STEP 11b: every rendered resume/cover-letter
// PDF also gets a convenience copy under the real OS home, organized by
// company — never a workspace-relative location. CAREERRAT_DOWNLOADS_DIR lets
// tests redirect this away from the real home (mirroring the CAREERRAT_HOME
// override in paths/workspace.mjs); production always resolves the real
// os.homedir().
function downloadsRoot(env) {
  const override = String(env.CAREERRAT_DOWNLOADS_DIR || "").trim();
  if (override) return override;
  return join(homedir(), "Downloads", "careerrat");
}

// Only resume/coverLetter get the Downloads convenience copy per SKILL.md
// STEP 11b ("After every PDF renders (resume and cover letter)...") —
// answers artifacts are not part of that convention.
function downloadsLabelFor(kind) {
  if (kind === "resume") return "Resume";
  if (kind === "coverLetter") return "Cover Letter";
  return null;
}

function safePathSegment(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[/\\\0]/g, "-")
    .trim();
  return cleaned || fallback;
}

// A same-named file left by a prior round is displaced into archive/ first,
// so the company root only ever shows what's live (SKILL.md STEP 11b).
function archivePriorDownloadsCopy(companyDir, fileName) {
  const existing = join(companyDir, fileName);
  if (!existsSync(existing)) return;
  const archiveDir = join(companyDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  renameSync(existing, join(archiveDir, fileName));
}

// Non-fatal by design: a Downloads-copy failure must never fail the export
// itself, so every error is swallowed and returned for the caller to record
// rather than thrown.
function copyPdfToDownloads({ env, company, kind, absPath }) {
  const label = downloadsLabelFor(kind);
  if (!label) return null;
  try {
    const companyName = safePathSegment(company, "unknown");
    const companyDir = join(downloadsRoot(env), companyName);
    mkdirSync(companyDir, { recursive: true });
    const fileName = `${companyName} - ${label}.pdf`;
    archivePriorDownloadsCopy(companyDir, fileName);
    const dest = join(companyDir, fileName);
    copyFileSync(absPath, dest);
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
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

function readStoredManifest(workspaceDir, storedPath) {
  const full = resolveWorkspacePath(workspaceDir, storedPath);
  if (!full || !existsSync(full)) return null;
  try {
    const parsed = JSON.parse(readFileSync(full, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
  const storedManifest = readStoredManifest(workspaceDir, sources.packetManifest);
  const priorManifest =
    app.packetManifest && Object.keys(app.packetManifest).length
      ? app.packetManifest
      : storedManifest || {};
  const priorManifestForDb = { ...priorManifest };
  if (Array.isArray(priorManifestForDb.questions)) {
    if (priorManifestForDb.questionCaptureSource) {
      priorManifestForDb.questions = {
        source: priorManifestForDb.questionCaptureSource,
        capturedAt: priorManifestForDb.generatedAt || new Date().toISOString(),
        answerableCount: priorManifestForDb.questions.length,
        excludedCount: Array.isArray(priorManifestForDb.excludedQuestions)
          ? priorManifestForDb.excludedQuestions.length
          : 0,
        answerableIds: priorManifestForDb.questions.map((question) => String(question?.id || "")),
        excludedIds: Array.isArray(priorManifestForDb.excludedQuestions)
          ? priorManifestForDb.excludedQuestions.map((question) => String(question?.id || ""))
          : [],
        demographicSectionPresent: false,
      };
    } else {
      delete priorManifestForDb.questions;
    }
  }
  const artifacts = {};
  const userFacing = { resume: [], coverLetter: [], answers: [] };
  const downloadsErrors = [];
  const exportGaps = [];
  const generatedAt = now().toISOString();

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
    // BUG: the read path (GET /api/packet, isGatedIn) keys off the plain
    // artifacts.<kind> field, not this finer-grained <kind>Source key — stamp
    // it too, pointed at the same source markdown, so an export run
    // standalone (without generatePacket) still leaves the packet readable.
    artifacts[kind] = storedPath;
    artifacts[`${kind}GeneratedAt`] = generatedAt;
    for (const format of ["pdf", "docx"]) {
      const absPath = result[format];
      if (!selectedFormats.includes(format)) continue;
      if (!absPath || !validDocumentArtifact(absPath)) {
        exportGaps.push({
          kind,
          code: "ARTIFACT_EXPORT_FAILED",
          message: `${titleFor(app, kind)} did not produce a valid ${format.toUpperCase()} file.`,
        });
        continue;
      }
      const key = outputKey(kind, format);
      artifacts[key] = workspaceDisplayPath(workspaceDir, absPath);
      const entry = { format, path: artifacts[key], name: basename(absPath) };
      if (format === "pdf") {
        const copy = copyPdfToDownloads({ env, company: app.company, kind, absPath });
        if (copy?.ok) entry.downloadsPath = copy.path;
        else if (copy && !copy.ok) downloadsErrors.push({ kind, format, message: copy.error });
      }
      userFacing[kind].push(entry);
    }
  }

  if (sources.packetManifest) artifacts.packetManifest = sources.packetManifest;

  const priorGaps = Array.isArray(priorManifestForDb.gaps) ? priorManifestForDb.gaps : [];
  const priorExportFailed = priorGaps.some((gap) => gap?.code === "ARTIFACT_EXPORT_FAILED");
  const contentGaps = priorGaps.filter((gap) => gap?.code !== "ARTIFACT_EXPORT_FAILED");
  const generationReady =
    priorManifestForDb.uploadReady === true || (priorExportFailed && contentGaps.length === 0);
  const gaps = [...contentGaps, ...exportGaps];
  const uploadReady = generationReady && exportGaps.length === 0;

  const nextManifest = {
    ...priorManifestForDb,
    applicationId: id,
    generatedAt: priorManifestForDb.generatedAt || generatedAt,
    exportedAt: generatedAt,
    uploadReady,
    status: uploadReady ? "upload-ready" : "reviewable",
    gapCount: gaps.length,
    gaps,
    artifacts: { ...(priorManifestForDb.artifacts || {}), ...artifacts },
  };
  const manifestPath = resolveWorkspacePath(workspaceDir, sources.packetManifest);
  if (manifestPath)
    writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");

  const registered = await appRegisterPacketArtifacts({
    repoRoot,
    env,
    appId: id,
    artifacts,
    now,
    manifest: nextManifest,
  });

  return {
    appId: id,
    applicationId: id,
    formats: selectedFormats,
    artifacts,
    userFacing,
    ...(downloadsErrors.length ? { downloadsErrors } : {}),
    registered,
  };
}
