// migrations/007-sourcing-runs.mjs — durable sourcing/search run state.
//
// The canonical row payload stays in JSON so later route/service layers can
// evolve summaries and metadata without another schema churn. Generated columns
// make the status/purpose/timestamp lookups queryable for React reloads.
export const migration007 = {
  id: 7,
  name: "sourcing-runs",
  up(db) {
    db.exec(`
CREATE TABLE sourcing_runs (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  purpose TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.purpose') END) STORED,
  status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END) STORED,
  started_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.started_at') END) STORED,
  completed_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.completed_at') END) STORED,
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.updated_at') END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_sourcing_runs_latest_purpose
  ON sourcing_runs(purpose, updated_at DESC, started_at DESC);
CREATE INDEX idx_sourcing_runs_running_status
  ON sourcing_runs(status, purpose, updated_at DESC);
`);
  },
};
