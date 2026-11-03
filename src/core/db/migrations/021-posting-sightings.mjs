// migrations/021-posting-sightings.mjs — one row per company+role key seen in
// a scan, so a later scan can tell a posting that keeps coming back (evergreen)
// or keeps changing URL (reposted) from a fresh one. Used only to demote in
// ranking, never to cut.
export const migration021 = {
  id: 21,
  name: "posting-sightings",
  up(db) {
    db.exec(`
CREATE TABLE posting_sightings (
  key TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  scan_count INTEGER NOT NULL DEFAULT 1,
  url_count INTEGER NOT NULL DEFAULT 1,
  last_url TEXT
);
`);
  },
};
