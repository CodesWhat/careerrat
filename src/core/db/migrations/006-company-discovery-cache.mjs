// migrations/006-company-discovery-cache.mjs — DB-owned company discovery
// cache/proposal state. Source-config and sourced rows remain confirmation-only
// writes; these tables store resolver cache rows and pending proposal batches.
export const migration006 = {
  id: 6,
  name: "company-discovery-cache",
  up(db) {
    db.exec(`
CREATE TABLE company_board_resolutions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  company_key TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.company_key') END) STORED,
  company_domain TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.company_domain') END) STORED,
  ats_provider TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.ats_provider') END) STORED,
  status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END) STORED,
  last_verified_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.last_verified_at') END) STORED,
  next_refresh_reason TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.next_refresh_reason') END) STORED,
  failure_count INTEGER GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.failure_count'), 0) END) STORED,
  zero_job_count INTEGER GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.zero_job_count'), 0) END) STORED,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_company_board_resolutions_company_key
  ON company_board_resolutions(company_key);
CREATE INDEX idx_company_board_resolutions_due_refresh
  ON company_board_resolutions(next_refresh_reason, failure_count, zero_job_count, status, last_verified_at);
CREATE INDEX idx_company_board_resolutions_last_verified
  ON company_board_resolutions(last_verified_at);
CREATE INDEX idx_company_board_resolutions_provider
  ON company_board_resolutions(ats_provider);
CREATE INDEX idx_company_board_resolutions_status
  ON company_board_resolutions(status);

CREATE TABLE company_discovery_proposals (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END) STORED,
  version INTEGER GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.version'), 0) END) STORED,
  created_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.created_at'), json_extract(data,'$.createdAt')) END) STORED,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_company_discovery_proposals_latest_pending
  ON company_discovery_proposals(status, created_at DESC, updated_at DESC);
`);
  },
};
