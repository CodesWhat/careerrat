export const migration018 = {
  id: 18,
  name: "search-executions",
  up(db) {
    db.exec(`
CREATE TABLE search_executions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)) CHECK (length(data) <= 65536),
  status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END) STORED,
  deterministic_status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.lanes.deterministic.status') END) STORED,
  ai_status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.lanes.aiWeb.status') END) STORED,
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.updatedAt') END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_search_executions_recovery
  ON search_executions(status, deterministic_status, ai_status, updated_at);
`);
  },
};
