// migrations/004-application-limits.mjs — DB-backed application caps/cooldowns.
//
// Candidate setup moved to SQLite in migration 003; this adds the remaining
// gate document that controls per-company apply caps and cooldowns.
export const migration004 = {
  id: 4,
  name: "application-limits",
  up(db) {
    db.exec(`
CREATE TABLE candidate_application_limits (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);
  },
};
