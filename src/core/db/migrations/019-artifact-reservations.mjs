// migrations/019-artifact-reservations.mjs — a short-lived claim on a
// canonical workspace-relative export destination path, held across a
// packet export batch's asynchronous rendering window
// (packet/exports.mjs, verbs/artifact-reservations.mjs).
//
// One row per currently-claimed path: `application_id` is whichever
// application currently holds it. This is NOT the permanent artifact
// registry (that's the JSON `artifacts` column on `applications`) — a row
// here always gets deleted once the batch that claimed it finishes,
// success or failure, so the table is expected to sit empty between
// exports.
export const migration019 = {
  id: 19,
  name: "artifact-reservations",
  up(db) {
    db.exec(`
CREATE TABLE artifact_reservations (
  path TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  reserved_at TEXT NOT NULL
);
`);
  },
};
