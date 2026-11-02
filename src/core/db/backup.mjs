// backup.mjs — point-in-time copies of the sqlite database, and restoring one.
//
// The database is canonical, so workspace/tracker.json snapshots can't recover
// it. A backup is a consistent single-file copy made with VACUUM INTO (it
// includes anything still in the WAL), stored under <dataRoot>/db/backups.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataPath } from "../paths/workspace.mjs";
import { closeAll, dbExists, dbFilePath, openDb } from "./connection.mjs";
import { ALL_MIGRATIONS } from "./migrations.mjs";

const BACKUP_REL_DIR = "db/backups";
const DEFAULT_KEEP = 10;
const BACKUP_NAME = /^careerrat-.*\.db$/;

function backupDir(ctx = {}) {
  return dataPath(ctx, BACKUP_REL_DIR);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function vacuumInto(db, target) {
  // VACUUM INTO takes a string literal, not a bound parameter.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  chmodSync(target, 0o600);
}

export function listBackups(ctx = {}) {
  const dir = backupDir(ctx);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .map((name) => {
      const full = join(dir, name);
      return { name, full, size: statSync(full).size, mtime: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
}

export function createBackup(ctx = {}, { keep = DEFAULT_KEEP } = {}) {
  if (!dbExists(ctx)) {
    const error = new Error("no database to back up yet");
    error.code = "NO_DATABASE";
    throw error;
  }
  if (!Number.isInteger(keep) || keep < 1)
    throw new Error("keep must be a whole number of 1 or more");
  const db = openDb(ctx);
  const dir = backupDir(ctx);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `careerrat-${stamp()}.db`);
  vacuumInto(db, target);
  const pruned = [];
  for (const old of listBackups(ctx).slice(keep)) {
    rmSync(old.full, { force: true });
    pruned.push(old.name);
  }
  return { path: target, name: basename(target), size: statSync(target).size, pruned };
}

// Resolve a backup by 1-based index (newest = 1), exact name, or name prefix.
function resolveBackup(ctx = {}, selector) {
  const backups = listBackups(ctx);
  const index = /^\d+$/.test(String(selector)) ? Number(selector) : Number.NaN;
  if (index >= 1 && index <= backups.length) return backups[index - 1];
  const found =
    backups.find((b) => b.name === selector) ||
    backups.find((b) => b.name.startsWith(String(selector)));
  if (!found) {
    const error = new Error(
      `no backup matching "${selector}". Run 'careerrat data restore' to list them`
    );
    error.code = "NO_SUCH_BACKUP";
    throw error;
  }
  return found;
}

function assertUsableBackup(file) {
  let probe;
  try {
    probe = new DatabaseSync(file, { readOnly: true });
    const check = probe.prepare("PRAGMA integrity_check").get();
    if (Object.values(check)[0] !== "ok") throw new Error("integrity check failed");
    const version = probe.prepare("PRAGMA user_version").get().user_version;
    const latest = ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1].id;
    if (version > latest) {
      throw new Error(
        `it was made by a newer CareerRat (schema ${version}, this build knows up to ${latest})`
      );
    }
    probe.prepare("SELECT COUNT(*) FROM applications").get();
  } catch (err) {
    const error = new Error(`that backup can't be used: ${err.message}`);
    error.code = "BAD_BACKUP";
    throw error;
  } finally {
    try {
      probe?.close();
    } catch {
      /* nothing to close */
    }
  }
}

// Replace the live database with a backup. The database being replaced is
// itself copied into the backups folder first, so a restore can be undone.
export function restoreBackup(ctx = {}, selector) {
  const chosen = resolveBackup(ctx, selector);
  assertUsableBackup(chosen.full);

  const live = dbFilePath(ctx);
  let safetyCopy = null;
  if (existsSync(live)) {
    const dir = backupDir(ctx);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    safetyCopy = join(dir, `careerrat-before-restore-${stamp()}.db`);
    vacuumInto(openDb(ctx), safetyCopy);
  }
  closeAll();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${live}${suffix}`, { force: true });
  mkdirSync(dirname(live), { recursive: true, mode: 0o700 });
  copyFileSync(chosen.full, live);
  chmodSync(live, 0o600);
  // Reopen so migrations bring an older backup up to date.
  openDb(ctx);
  return { restored: chosen.name, safetyCopy: safetyCopy ? basename(safetyCopy) : null };
}
