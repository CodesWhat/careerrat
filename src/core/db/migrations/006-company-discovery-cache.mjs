// migrations/006-company-discovery-cache.mjs — DB-owned company discovery
// proposal state. Source-config and sourced rows remain confirmation-only writes;
// this table stores pending proposal batches for review.
export const migration006 = {
  id: 6,
  name: "company-discovery-cache",
  up(db) {
    db.exec(`
CREATE TABLE company_discovery_proposals (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  created_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.createdAt')) STORED,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_company_discovery_proposals_status_updated
  ON company_discovery_proposals(status, updated_at DESC);
`);
  },
};
