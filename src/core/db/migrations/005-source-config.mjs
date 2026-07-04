// migrations/005-source-config.mjs — SQLite-owned search/source setup.
//
// App onboarding moved candidate/profile state into SQLite first; this closes
// the adjacent setup gap for generated search-sources.yml and sourced-scan.json.
// Compatibility files can still be exported, but DB-mode writers land here.
export const migration005 = {
  id: 5,
  name: "source-config",
  up(db) {
    db.exec(`
CREATE TABLE candidate_source_configs (
  name TEXT PRIMARY KEY CHECK (name IN ('search-sources','sourced-scan')),
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);
  },
};
