import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";

import { requireDb } from "../db/connection.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";
import { renderPdf } from "./export.mjs";

function dossierError(message, code = "BAD_DOSSIER_ARTIFACT") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function within(root, target) {
  const rel = relative(root, target);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function canonicalDossierSource(workspaceDir, storedPath) {
  const value = String(storedPath || "").trim();
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (
    !value.startsWith("workspace/interview-prep/") ||
    !/\.(?:md|markdown)$/i.test(value) ||
    value.includes("\\") ||
    hasControlCharacter
  ) {
    throw dossierError("interview dossier path is not a safe workspace markdown artifact");
  }
  const workspaceRelative = value.slice("workspace/".length);
  const normalized = normalize(workspaceRelative);
  const canonical = `workspace/${normalized.split(sep).join("/")}`;
  if (canonical !== value || normalized.startsWith("..") || isAbsolute(normalized)) {
    throw dossierError("interview dossier path is not a safe workspace markdown artifact");
  }

  const source = join(workspaceDir, normalized);
  if (!existsSync(source) || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) {
    throw dossierError("interview dossier source artifact is unavailable");
  }
  const realWorkspace = realpathSync(workspaceDir);
  const realSource = realpathSync(source);
  if (!within(realWorkspace, realSource)) {
    throw dossierError("interview dossier source artifact is outside the workspace");
  }
  const realParent = realpathSync(dirname(source));
  if (!within(realWorkspace, realParent)) {
    throw dossierError("interview dossier output directory is outside the workspace");
  }
  return { value, source, parent: dirname(source), realWorkspace };
}

function applicationDossier(db, applicationId) {
  const id = String(applicationId || "").trim();
  if (!id || id.length > 200 || id.includes("\0")) {
    throw dossierError("applicationId is required", "BAD_REQUEST");
  }
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get(id);
  if (!row) throw dossierError(`no application with id "${id}"`, "NOT_FOUND");
  const application = JSON.parse(row.data);
  const dossier = application.artifacts?.interviewDossier;
  if (!dossier || typeof dossier !== "object" || Array.isArray(dossier)) {
    throw dossierError("application has no canonical interview dossier", "NOT_FOUND");
  }
  const markdown = String(dossier.markdown || "").trim();
  if (!markdown) throw dossierError("canonical interview dossier has no markdown");
  return { id, application, dossier, markdown };
}

export async function exportInterviewDossierPdf({
  repoRoot,
  env = process.env,
  applicationId,
  artifactPath,
  renderPdfImpl = renderPdf,
} = {}) {
  const db = requireDb({ repoRoot, env });
  const canonical = applicationDossier(db, applicationId);
  const storedPath = String(canonical.dossier.path || "").trim();
  if (artifactPath != null && String(artifactPath).trim() !== storedPath) {
    throw dossierError("requested artifact path does not match the canonical interview dossier");
  }
  const workspaceDir = resolveUserPaths({ repoRoot, env }).workspaceDir;
  const source = canonicalDossierSource(workspaceDir, storedPath);
  const stem = basename(source.source, extname(source.source));
  const filename = `${stem}.pdf`;
  const output = join(source.parent, filename);
  const temporary = join(source.parent, `.${stem}.${randomUUID()}.pdf`);

  try {
    await renderPdfImpl({
      markdown: canonical.markdown,
      outPath: temporary,
      title: canonical.dossier.title || `${canonical.application.company || "Interview"} dossier`,
      ats: false,
      env,
    });
    if (!existsSync(temporary)) {
      throw dossierError("interview dossier PDF renderer produced no file", "INVALID_DOSSIER_PDF");
    }
    const rendered = readFileSync(temporary);
    if (rendered.length < 8 || rendered.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw dossierError(
        "interview dossier PDF renderer produced invalid bytes",
        "INVALID_DOSSIER_PDF"
      );
    }
    renameSync(temporary, output);
    const buffer = readFileSync(output);
    return {
      applicationId: canonical.id,
      sourcePath: source.value,
      path: `workspace/${relative(workspaceDir, output).split(sep).join("/")}`,
      filename,
      buffer,
    };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
