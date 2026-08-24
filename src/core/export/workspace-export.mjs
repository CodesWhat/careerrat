import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import JSZip from "jszip";

import { dbFilePath, requireDb } from "../db/connection.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";

class ExportChangedError extends Error {}

class WorkspaceExportBusyError extends Error {
  constructor(message = "workspace changed repeatedly during export; try again") {
    super(message);
    this.name = "WorkspaceExportBusyError";
    this.code = "EXPORT_BUSY";
  }
}

function archivePath(...parts) {
  return parts.filter(Boolean).join("/").replaceAll(sep, "/");
}

function addDirectory(zip, sourceDir, archiveRoot) {
  let entries;
  try {
    entries = readdirSync(sourceDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }

  let count = 0;
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    let info;
    try {
      info = lstatSync(sourcePath);
    } catch (error) {
      if (error?.code === "ENOENT") throw new ExportChangedError();
      throw error;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      count += addDirectory(zip, sourcePath, archivePath(archiveRoot, entry.name));
      continue;
    }
    if (!info.isFile()) continue;
    const contents = readFileSync(sourcePath);
    let after;
    try {
      after = lstatSync(sourcePath);
    } catch (error) {
      if (error?.code === "ENOENT") throw new ExportChangedError();
      throw error;
    }
    if (
      !after.isFile() ||
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs
    ) {
      throw new ExportChangedError();
    }
    zip.file(archivePath(archiveRoot, entry.name), contents);
    count += 1;
  }
  return count;
}

function databaseRevision(db) {
  return db.prepare("PRAGMA data_version").get().data_version;
}

function canonicalVersion(db) {
  return db.prepare("SELECT version FROM meta WHERE id = 1").get()?.version ?? 0;
}

export async function buildWorkspaceExport({
  repoRoot,
  env = process.env,
  now = new Date(),
  maxAttempts = 3,
  afterFilesRead,
} = {}) {
  const db = requireDb({ repoRoot, env });
  const paths = resolveUserPaths({ repoRoot, env });
  const scratchDir = mkdtempSync(join(tmpdir(), "careerrat-export-"), { mode: 0o700 });
  const observer = new DatabaseSync(dbFilePath({ repoRoot, env }), { readOnly: true });
  observer.exec("PRAGMA busy_timeout = 5000");

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const revision = databaseRevision(observer);
      const version = canonicalVersion(db);
      const snapshotPath = join(scratchDir, `careerrat-${attempt}.db`);

      try {
        const zip = new JSZip();
        const fileCounts = {
          candidate: addDirectory(zip, paths.candidateDir, "candidate"),
          workspace: addDirectory(zip, paths.workspaceDir, "workspace"),
          config: addDirectory(zip, paths.generatedConfigDir, "config"),
        };
        await afterFilesRead?.({ attempt, version });
        if (databaseRevision(observer) !== revision || canonicalVersion(db) !== version) continue;

        await backup(db, snapshotPath);
        if (databaseRevision(observer) !== revision || canonicalVersion(db) !== version) continue;
        zip.file("database/careerrat.db", readFileSync(snapshotPath));

        const exportedAt = now.toISOString();
        const manifest = {
          format: "careerrat-workspace-export",
          version: 1,
          exportedAt,
          canonicalVersion: version,
          includes: {
            canonicalDatabase: true,
            candidateFiles: fileCounts.candidate,
            workspaceFiles: fileCounts.workspace,
            generatedConfigFiles: fileCounts.config,
          },
          excludes: {
            savedAiCredentials: true,
            runtimeLogs: true,
          },
          restoreNote:
            "The SQLite snapshot is canonical. Markdown and config files are included for portability and inspection.",
        };
        zip.file("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

        const buffer = await zip.generateAsync({
          type: "nodebuffer",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        });
        return {
          filename: `careerrat-export-${exportedAt.slice(0, 10)}.zip`,
          buffer,
          manifest,
        };
      } catch (error) {
        if (!(error instanceof ExportChangedError)) throw error;
      }
    }
    throw new WorkspaceExportBusyError();
  } finally {
    observer.close();
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
