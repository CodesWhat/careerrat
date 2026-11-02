import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { currentPerson } from "../paths/people.mjs";

const ARCHIVED_STATUSES = new Set(["rejected", "withdrawn", "cut", "closed"]);

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safeCompanySegment(value) {
  const cleaned = String(value ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are invalid in Windows path segments
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .trim()
    .replace(/[. ]+$/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return "unknown";
  const stem = cleaned.split(".")[0].trimEnd();
  return WINDOWS_RESERVED_NAME.test(stem) ? `_${cleaned}` : cleaned;
}

// The folder under ~/Documents/careerrat that holds every person's documents. The
// owner's own company folders sit directly in ~/Documents/careerrat, and a company
// would have to be literally named "_people" to meet it, so a person named like one of
// the owner's companies no longer shares a folder with it.
const PEOPLE_DOCUMENTS_DIR = "_people";

// Where one person's generated documents live (unless a downloads directory is set).
export function personDocumentsRoot(person) {
  return join(homedir(), "Documents", "careerrat", PEOPLE_DOCUMENTS_DIR, person);
}

// The pre-namespace location, where a person's folder sat beside the owner's companies.
export function legacyPersonDocumentsRoot(person) {
  return join(homedir(), "Documents", "careerrat", person);
}

export function jobDocumentPaths({ application, env = process.env }) {
  if (!application?.id) throw new Error("A job id is required for its document folder");
  const companyName = safeCompanySegment(application.company || "unknown");
  // Encode uppercase too so distinct ids cannot collide on APFS or NTFS.
  const jobId = Array.from(String(application.id), (character) =>
    /[A-Z.!'()*]/.test(character)
      ? `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      : encodeURIComponent(character)
  ).join("");
  const job = `job-${jobId}`;
  // A selected person gets their own folder so two people's documents never mix,
  // unless the downloads directory was set explicitly.
  const person = currentPerson(env);
  const root =
    String(env.CAREERRAT_DOWNLOADS_DIR || "").trim() ||
    (person ? personDocumentsRoot(person) : join(homedir(), "Documents", "careerrat"));
  const active = join(root, companyName, job);
  const archive = join(root, "_archive", companyName, job);
  const archived = ARCHIVED_STATUSES.has(
    String(application.status || "")
      .trim()
      .toLowerCase()
  );
  return { active, archive, archived, path: archived ? archive : active, companyName };
}

export function syncJobDocumentFolder({ application, env }) {
  const paths = jobDocumentPaths({ application, env });
  const source = paths.archived ? paths.active : paths.archive;
  if (!existsSync(source))
    return existsSync(paths.path)
      ? { path: paths.path, archived: paths.archived, changed: false }
      : null;
  if (!lstatSync(source).isDirectory())
    throw new Error("The job document folder is not a directory");
  if (existsSync(paths.path))
    throw new Error("Both active and archived job folders exist; neither was overwritten");
  mkdirSync(dirname(paths.path), { recursive: true });
  renameSync(source, paths.path);
  // Leave another job's files alone; remove only an empty company directory.
  if (readdirSync(dirname(source)).length === 0) rmdirSync(dirname(source));
  return { path: paths.path, archived: paths.archived, changed: true };
}
