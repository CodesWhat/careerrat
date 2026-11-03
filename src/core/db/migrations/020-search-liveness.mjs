// migrations/020-search-liveness.mjs — two small ledgers for search liveness.
//
// dead_boards: one row per configured source (a tracked company or a board
// search source) whose board answered "does not exist" (HTTP 404/410). `strikes`
// counts consecutive dead answers; `dead_since` is set once it reaches 2 and
// from then on scans skip the source until `last_checked_at` is 14 days old.
// `source_key` is a digest of the source's config, so editing the source gives
// it a fresh key and an immediate re-check.
//
// job_link_checks: the last liveness answer per saved-job URL, so the next
// `check:jobs` run can say which links closed since the previous run.
export const migration020 = {
  id: 20,
  name: "search-liveness",
  up(db) {
    db.exec(`
CREATE TABLE dead_boards (
  source_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  strikes INTEGER NOT NULL DEFAULT 0,
  first_dead_at TEXT NOT NULL,
  dead_since TEXT,
  last_checked_at TEXT NOT NULL,
  last_error TEXT
);
CREATE TABLE job_link_checks (
  url TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  code TEXT,
  checked_at TEXT NOT NULL
);
`);
  },
};
