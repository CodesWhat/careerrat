// migrations/011-linkedin-profile-proposals.mjs — DB-owned LinkedIn optimize
// proposal batches. Mirrors 006-company-discovery-cache.mjs's proposals-table
// shape: proposal generation is not a tracker-visible mutation, so this table
// stores confirm-first review state only — no export-to-tracker mirror.
export const migration011 = {
  id: 11,
  name: "linkedin-profile-proposals",
  up(db) {
    db.exec(`
CREATE TABLE linkedin_profile_proposals (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END) STORED,
  version INTEGER GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.version'), 0) END) STORED,
  created_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.createdAt') END) STORED,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_linkedin_profile_proposals_latest_pending
  ON linkedin_profile_proposals(status, created_at DESC, updated_at DESC);
`);
  },
};
