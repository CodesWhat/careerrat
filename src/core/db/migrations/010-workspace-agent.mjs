// migrations/010-workspace-agent.mjs — one durable, user-facing workspace
// conversation. Buttons and free-form chat both append to this same thread;
// backend operations may be isolated, but their result is recorded here.
export const migration010 = {
  id: 10,
  name: "workspace-agent",
  up(db) {
    db.exec(`
CREATE TABLE workspace_threads (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END) STORED,
  created_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.createdAt') END) STORED,
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.updatedAt') END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_workspace_threads_updated
  ON workspace_threads(status, updated_at DESC);

CREATE TABLE workspace_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES workspace_threads(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  data TEXT NOT NULL CHECK (json_valid(data)),
  role TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.role') END) STORED,
  kind TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.kind') END) STORED,
  created_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.createdAt') END) STORED,
  UNIQUE(thread_id, sequence)
) WITHOUT ROWID;
CREATE INDEX idx_workspace_messages_thread_sequence
  ON workspace_messages(thread_id, sequence ASC);
CREATE INDEX idx_workspace_messages_kind
  ON workspace_messages(thread_id, kind, created_at ASC);
`);
  },
};
