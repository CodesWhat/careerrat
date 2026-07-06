// migrations/008-deep-ingest.mjs - SQLite-native Deep ingest lane state.
//
// Source, proposal, lane, and confirmed-output rows stay as JSON payloads with
// generated columns for the app's query paths. Proposal/queue state is not a
// tracker-visible mutation; confirmed candidate facts are handled by explicit
// Deep ingest verbs.
export const migration008 = {
  id: 8,
  name: "deep-ingest",
  up(db) {
    db.exec(`
CREATE TABLE deep_ingest_sources (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  target_shape TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.targetShape') END) STORED
    CHECK (target_shape IN ('auto','evidence','story','honesty_boundary','writing_voice','role_signal','gap','source','paste','link','profile','project','recruiter_context','job_context')),
  status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END) STORED
    CHECK (status IN ('captured','scanning','proposal_ready','review_needed','manual_fallback','gap','saved','deferred','not_available','failed')),
  source_kind TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.sourceKind') END) STORED
    CHECK (source_kind IN ('paste','text','url','file','repo','local_path','linkedin','portfolio','note','recruiter_context','job_context','project_link')),
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.updatedAt'), json_extract(data,'$.updated_at')) END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_deep_ingest_sources_status
  ON deep_ingest_sources(status, target_shape, updated_at DESC);
CREATE INDEX idx_deep_ingest_sources_source_kind
  ON deep_ingest_sources(source_kind, updated_at DESC);
CREATE INDEX idx_deep_ingest_sources_updated_at
  ON deep_ingest_sources(updated_at DESC);

CREATE TABLE deep_ingest_source_chunks (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  source_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.sourceId') END) STORED,
  chunk_kind TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.chunkKind') END) STORED,
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.updatedAt'), json_extract(data,'$.updated_at')) END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_deep_ingest_source_chunks_source
  ON deep_ingest_source_chunks(source_id, chunk_kind);
CREATE INDEX idx_deep_ingest_source_chunks_updated_at
  ON deep_ingest_source_chunks(updated_at DESC);

CREATE TABLE deep_ingest_proposals (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  source_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.sourceId') END) STORED,
  target_shape TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.targetShape') END) STORED,
  status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END) STORED
    CHECK (status IN ('review_needed','deferred','rejected','confirmed')),
  lane TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.lane') END) STORED,
  version INTEGER GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.version'), 0) END) STORED,
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.updatedAt'), json_extract(data,'$.updated_at')) END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_deep_ingest_proposals_status_lane
  ON deep_ingest_proposals(status, lane, updated_at DESC);
CREATE INDEX idx_deep_ingest_proposals_source
  ON deep_ingest_proposals(source_id, updated_at DESC);
CREATE INDEX idx_deep_ingest_proposals_updated_at
  ON deep_ingest_proposals(updated_at DESC);

CREATE TABLE deep_ingest_lane_states (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  lane TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.lane') END) STORED,
  status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END) STORED
    CHECK (status IN ('not_started','needs_source','scanning','review_needed','gap','completed','deferred','not_available','failed')),
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.updatedAt'), json_extract(data,'$.updated_at')) END) STORED
) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_deep_ingest_lane_states_lane
  ON deep_ingest_lane_states(lane);
CREATE INDEX idx_deep_ingest_lane_states_lane_status
  ON deep_ingest_lane_states(lane, status);
CREATE INDEX idx_deep_ingest_lane_states_updated_at
  ON deep_ingest_lane_states(updated_at DESC);

CREATE TABLE deep_ingest_story_bank (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  story_status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END) STORED,
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.updatedAt'), json_extract(data,'$.updated_at')) END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_deep_ingest_story_bank_status
  ON deep_ingest_story_bank(story_status, updated_at DESC);

CREATE TABLE deep_ingest_writing_voice (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  voice_status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END) STORED,
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.updatedAt'), json_extract(data,'$.updated_at')) END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_deep_ingest_writing_voice_status
  ON deep_ingest_writing_voice(voice_status, updated_at DESC);

CREATE TABLE deep_ingest_honesty_boundaries (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  boundary_type TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.boundaryType') END) STORED,
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.updatedAt'), json_extract(data,'$.updated_at')) END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_deep_ingest_honesty_boundaries_type
  ON deep_ingest_honesty_boundaries(boundary_type, updated_at DESC);

CREATE TABLE deep_ingest_role_signals (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  role_family TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.roleFamily') END) STORED,
  signal_type TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.signalType') END) STORED,
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.updatedAt'), json_extract(data,'$.updated_at')) END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_deep_ingest_role_signals_family_type
  ON deep_ingest_role_signals(role_family, signal_type, updated_at DESC);
`);
  },
};
