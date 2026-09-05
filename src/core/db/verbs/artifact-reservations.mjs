// verbs/artifact-reservations.mjs — a short-lived, synchronous claim on a
// canonical workspace-relative destination path, held across an export
// batch's asynchronous rendering window (packet/exports.mjs) so a second
// concurrent export for a DIFFERENT application can never promote a staged
// file onto the same path a first export already claimed but hasn't
// finished rendering yet.
//
// A reservation is NOT a permanent registration — the durable claim is the
// `applications.artifacts` row appRegisterPacketArtifacts writes once
// promotion and registration commit — so every reservation this module
// hands out MUST be released (artifactReservationRelease) once the batch
// that took it finishes, success or failure. node:sqlite's DatabaseSync
// makes this reservation genuinely synchronous and atomic: the INSERT ...
// ON CONFLICT below either claims the row or it doesn't, with no window a
// second caller (in this process or another) can land in between.
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";
import { nowIso } from "./shared.mjs";

// Atomically claims `path` for `applicationId`. Re-reserving a path this
// SAME application already holds is a no-op success — a batch that
// reserves the same destination twice (e.g. the packet manifest, claimed
// once up front and implicitly revalidated later) must not be treated as a
// foreign collision against itself. Reserving a path currently held by a
// DIFFERENT application throws, without touching the existing reservation.
export function artifactReservationClaim({ repoRoot, env, path, applicationId } = {}) {
  if (!path || !applicationId) {
    throw new Error("artifactReservationClaim: path and applicationId are required");
  }
  const db = requireDb({ repoRoot, env });
  withTransaction(db, () => {
    const result = db
      .prepare(
        `INSERT INTO artifact_reservations (path, application_id, reserved_at)
         VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET reserved_at = excluded.reserved_at
         WHERE artifact_reservations.application_id = excluded.application_id`
      )
      .run(path, String(applicationId), nowIso());
    if (result.changes === 0) {
      const owner = db
        .prepare("SELECT application_id FROM artifact_reservations WHERE path = ?")
        .get(path);
      const err = new Error(
        `export destination "${path}" is already reserved by another application`
      );
      err.code = "ARTIFACT_OWNED_BY_ANOTHER_APPLICATION";
      err.path = path;
      err.ownerApplicationId = owner?.application_id || null;
      throw err;
    }
  });
}

// Reads the current holder of `path`, or null if nothing has reserved it.
// Callers use this to revalidate an earlier reservation still belongs to
// them immediately before a final durable write, closing the window
// between an early reservation and a slow asynchronous render.
export function artifactReservationOwner({ repoRoot, env, path } = {}) {
  if (!path) return null;
  const db = requireDb({ repoRoot, env });
  const row = db
    .prepare("SELECT application_id FROM artifact_reservations WHERE path = ?")
    .get(path);
  return row?.application_id || null;
}

// Releases this application's claim on `path`. A no-op if the reservation
// is already gone, or is currently held by a different application — this
// never releases a claim `applicationId` doesn't itself hold.
export function artifactReservationRelease({ repoRoot, env, path, applicationId } = {}) {
  if (!path || !applicationId) return;
  const db = requireDb({ repoRoot, env });
  db.prepare("DELETE FROM artifact_reservations WHERE path = ? AND application_id = ?").run(
    path,
    String(applicationId)
  );
}

// Unconditionally clears every reservation row, regardless of owner. A
// reservation only means something inside a live export invocation — it is
// released by that invocation's own finally block once the batch finishes,
// success or failure. A row that's still there at workspace boot can only
// belong to a process that never got to run that finally block (crashed,
// force-killed, power loss), so it is by definition abandoned. Callers MUST
// invoke this once per workspace startup, after acquiring exclusive
// workspace-runtime ownership and before any worker resumes, so an
// abandoned reservation never outlives the process that took it and blocks
// a future application from exporting to the same destination.
export function artifactReservationReleaseAll({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  db.prepare("DELETE FROM artifact_reservations").run();
}
