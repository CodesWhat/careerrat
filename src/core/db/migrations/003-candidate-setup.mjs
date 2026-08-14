// migrations/003-candidate-setup.mjs — app-first candidate setup state.
//
// Tracker workflow data moved to SQLite in M6, but candidate setup remained
// YAML-primary. This migration makes SQLite the source of truth for the app
// onboarding/profile/targeting path. Compatibility YAML can still be exported,
// but app writes land here.
export const migration003 = {
  id: 3,
  name: "candidate-setup",
  up(db) {
    db.exec(`
CREATE TABLE candidate_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE candidate_targeting (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE candidate_honesty (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE candidate_form_defaults (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE candidate_modes (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE candidate_automation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE candidate_search_tracks (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  name TEXT GENERATED ALWAYS AS (json_extract(data,'$.name')) STORED,
  priority TEXT GENERATED ALWAYS AS (json_extract(data,'$.priority')) STORED,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_candidate_tracks_priority ON candidate_search_tracks(priority, sort_order);

CREATE TABLE candidate_target_companies (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('target','excluded')),
  sort_order INTEGER NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  name TEXT GENERATED ALWAYS AS (json_extract(data,'$.name')) STORED,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_candidate_companies_kind ON candidate_target_companies(kind, sort_order, name);

CREATE TABLE candidate_evidence_claims (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  claim TEXT GENERATED ALWAYS AS (json_extract(data,'$.claim')) STORED,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE candidate_artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_candidate_artifacts_kind ON candidate_artifacts(kind);

CREATE TABLE candidate_setup (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);
  },
};
