import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { personDocumentsRoot } from "../documents/job-folders.mjs";
import { personExists, personRoot, validatePersonName } from "../paths/people.mjs";

// CR101: remove everything CareerRat holds for one person: their data root (database,
// evidence, search runs, board-profiles browser profile, AI key) and their generated
// documents folder. A backup of both is written next to the people directory first, so
// a purge is recoverable until the operator deletes the backup.
export const PEOPLE_BACKUP_DIR = "people-backups";

function stamp(now) {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function purgePerson({ base, name, env = process.env, now = new Date() }) {
  validatePersonName(name);
  if (!personExists(base, name)) throw new Error(`No workspace for "${name}".`);
  const root = personRoot(base, name);
  const peopleDir = join(base, "people");
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error(`Refusing to purge ${root}: it is a symlink.`);
  }
  const realRoot = realpathSync(root);
  if (!realRoot.startsWith(`${realpathSync(peopleDir)}${sep}`)) {
    throw new Error(`Refusing to purge ${root}: it resolves outside the people directory.`);
  }

  // An explicit downloads directory is shared on purpose, so it is never touched.
  const explicitDownloads = String(env.CAREERRAT_DOWNLOADS_DIR || "").trim();
  const documents = explicitDownloads ? null : personDocumentsRoot(name);
  const hasDocuments = Boolean(documents) && existsSync(documents);

  const backup = join(base, PEOPLE_BACKUP_DIR, `${name}-${stamp(now)}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  cpSync(root, join(backup, "workspace"), { recursive: true });
  if (hasDocuments) cpSync(documents, join(backup, "documents"), { recursive: true });
  if (!existsSync(join(backup, "workspace"))) {
    throw new Error("Backup failed; nothing was removed.");
  }

  rmSync(root, { recursive: true, force: true });
  if (hasDocuments) rmSync(documents, { recursive: true, force: true });
  return {
    removed: [root, ...(hasDocuments ? [documents] : [])],
    backup,
    documentsSkipped: explicitDownloads || null,
  };
}
