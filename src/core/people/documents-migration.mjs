import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { dbExists, requireDb } from "../db/connection.mjs";
import { assembleTrackerObject } from "../db/export-to-tracker.mjs";
import {
  legacyPersonDocumentsRoot,
  personDocumentsRoot,
  safeCompanySegment,
} from "../documents/job-folders.mjs";
import { authorizationPath } from "./authorization.mjs";

// Person documents used to live at ~/Documents/careerrat/<name>, beside the owner's
// company folders. Move such a folder into the person namespace, but only when it is
// unambiguously theirs: they have an authorization record (they were added through
// `people add`), and no company in the owner's workspace maps to the same folder name.
// Anything doubtful stays where it is and is reported, never moved or deleted.
function ownerHasCompanyFolder({ repoRoot, base, name }) {
  const env = { CAREERRAT_HOME: base };
  // No owner database means no owner documents were exported through it.
  if (!dbExists({ repoRoot, env })) return false;
  let tracker;
  try {
    tracker = assembleTrackerObject(requireDb({ repoRoot, env }));
  } catch {
    return true; // can't tell, so treat it as ambiguous
  }
  const wanted = name.toLowerCase();
  return [...(tracker.applications || []), ...(tracker.sourced || [])].some(
    (row) => safeCompanySegment(row?.company || "unknown").toLowerCase() === wanted
  );
}

export function migratePersonDocuments({ repoRoot, base, name }) {
  const from = legacyPersonDocumentsRoot(name);
  const to = personDocumentsRoot(name);
  if (!existsSync(from) || !lstatSync(from).isDirectory()) return { status: "none" };
  if (existsSync(to))
    return { status: "skipped", reason: "namespaced folder already exists", from };
  if (!existsSync(authorizationPath(base, name))) {
    return { status: "skipped", reason: "no authorization record for this person", from };
  }
  if (ownerHasCompanyFolder({ repoRoot, base, name })) {
    return { status: "skipped", reason: "an owner company has the same folder name", from };
  }
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return { status: "moved", from, to };
}
