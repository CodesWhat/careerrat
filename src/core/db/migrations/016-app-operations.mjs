export const migration016 = {
  id: 16,
  name: "app-operations",
  up(db) {
    db.exec(`
CREATE TABLE app_operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  request TEXT NOT NULL CHECK (json_valid(request)) CHECK (length(request) <= 65536),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  heartbeat_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  execution_plan TEXT CHECK (execution_plan IS NULL OR json_valid(execution_plan))
    CHECK (execution_plan IS NULL OR length(execution_plan) <= 16384),
  progress TEXT CHECK (progress IS NULL OR json_valid(progress))
    CHECK (progress IS NULL OR length(progress) <= 8192),
  result_ref TEXT CHECK (result_ref IS NULL OR json_valid(result_ref))
    CHECK (result_ref IS NULL OR length(result_ref) <= 8192),
  error TEXT CHECK (error IS NULL OR json_valid(error))
    CHECK (error IS NULL OR length(error) <= 4096),
  retry_of TEXT REFERENCES app_operations(id),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_app_operations_kind_digest
  ON app_operations(kind, request_digest, updated_at DESC);
CREATE INDEX idx_app_operations_status_lease
  ON app_operations(status, lease_expires_at);
CREATE INDEX idx_app_operations_retry
  ON app_operations(retry_of, attempt);
`);
  },
};
