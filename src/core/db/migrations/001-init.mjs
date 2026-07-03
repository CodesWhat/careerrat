// migrations/001-init.mjs — the founding schema (M6: node:sqlite data layer).
//
// One JSON blob column per entity + GENERATED ALWAYS AS (json_extract(...))
// STORED columns for hot/queried fields, indexed. The blob is byte-shape-
// compatible with today's tracker.json items — applications[]/sourced[]/
// communications[]/sources[] rows land verbatim in `data`. No wide hand-modeled
// columns, no extra_json catch-alls, no normalized child tables for
// conversations/messages (they stay embedded in the parent blob — reads are
// always parent-scoped today). See docs/m6-db-build-spec.md's locked DDL.
//
// Also seeds meta(id=1) with version=0 so every write verb's meta bump
// (`UPDATE meta SET version = version + 1 ... WHERE id = 1`) always has a row
// to update, even on a freshly `rolester data init`ed (un-imported) DB — the
// spec's DDL alone doesn't guarantee that row exists yet.
export const migration001 = {
  id: 1,
  name: "init",
  up(db) {
    db.exec(`
CREATE TABLE applications (
  id                TEXT PRIMARY KEY,
  data              TEXT NOT NULL CHECK (json_valid(data)),
  company           TEXT GENERATED ALWAYS AS (json_extract(data,'$.company')) STORED,
  role              TEXT GENERATED ALWAYS AS (json_extract(data,'$.role')) STORED,
  status            TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  fit_score         REAL GENERATED ALWAYS AS (json_extract(data,'$.fitScore')) STORED,
  applied_at        TEXT GENERATED ALWAYS AS (json_extract(data,'$.appliedAt')) STORED,
  interview_at      TEXT GENERATED ALWAYS AS (json_extract(data,'$.interviewAt')) STORED,
  next_interview_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.nextInterviewAt')) STORED,
  follow_up_due_at  TEXT GENERATED ALWAYS AS (json_extract(data,'$.followUp.dueAt')) STORED,
  channel           TEXT GENERATED ALWAYS AS (json_extract(data,'$.channel')) STORED,
  demo              INTEGER GENERATED ALWAYS AS (json_extract(data,'$.demo')) STORED,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_apps_status  ON applications(status);
CREATE INDEX idx_apps_company ON applications(company);
CREATE INDEX idx_apps_interview ON applications(interview_at) WHERE interview_at IS NOT NULL;
CREATE INDEX idx_apps_followup  ON applications(follow_up_due_at) WHERE follow_up_due_at IS NOT NULL;

CREATE TABLE sourced (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  company    TEXT GENERATED ALWAYS AS (json_extract(data,'$.company')) STORED,
  fit_score  REAL GENERATED ALWAYS AS (json_extract(data,'$.fitScore')) STORED,
  fit_bucket TEXT GENERATED ALWAYS AS (json_extract(data,'$.fitBucket')) STORED,
  status     TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  sourced_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.sourcedAt')) STORED,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sourced_status ON sourced(status);
CREATE INDEX idx_sourced_fit    ON sourced(fit_bucket, fit_score);

CREATE TABLE communications (
  id               TEXT PRIMARY KEY,
  application_id   TEXT REFERENCES applications(id) ON DELETE SET NULL,
  data             TEXT NOT NULL CHECK (json_valid(data)),
  company          TEXT GENERATED ALWAYS AS (json_extract(data,'$.company')) STORED,
  channel          TEXT GENERATED ALWAYS AS (json_extract(data,'$.channel')) STORED,
  status           TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  next_action_due  TEXT GENERATED ALWAYS AS (json_extract(data,'$.nextActionDue')) STORED,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_comms_app      ON communications(application_id);
CREATE INDEX idx_comms_status   ON communications(status);
CREATE INDEX idx_comms_next_due ON communications(next_action_due) WHERE next_action_due IS NOT NULL;

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data))
);

CREATE TABLE activity_events (
  id         TEXT PRIMARY KEY,   -- reuses today's content-hash eventId() from activity-log.mjs; PK conflict = dedupe
  at         TEXT NOT NULL,
  type       TEXT NOT NULL,
  actor      TEXT NOT NULL,
  data       TEXT NOT NULL CHECK (json_valid(data))  -- full canonical event line
);
CREATE INDEX idx_activity_at ON activity_events(at DESC);

CREATE TABLE meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_updated_at TEXT, version INTEGER NOT NULL DEFAULT 0, last_sweep_at TEXT,
  extra TEXT  -- JSON: any other tracker.json#meta keys (e.g. demoAnchor) preserved verbatim
);

CREATE TABLE analytics (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at TEXT,
  data TEXT NOT NULL CHECK (json_valid(data))
);

CREATE TABLE kv (        -- extra top-level tracker.json keys we must preserve (e.g. strategyReview)
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data))
);

CREATE TABLE _migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, name TEXT NOT NULL);

INSERT INTO meta (id, version) VALUES (1, 0);
`);
  },
};
