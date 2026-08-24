// Durable conversational skill history. Runtime process/session ids remain
// ephemeral; one logical thread per skill survives app and server restarts.
export const migration013 = {
  id: 13,
  name: "durable-skill-chat",
  up(db) {
    db.exec(`
CREATE TABLE skill_chat_threads (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  skill TEXT GENERATED ALWAYS AS (json_extract(data,'$.skill')) STORED NOT NULL UNIQUE,
  status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  created_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.createdAt')) STORED,
  updated_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.updatedAt')) STORED
) WITHOUT ROWID;
CREATE INDEX idx_skill_chat_threads_updated
  ON skill_chat_threads(status, updated_at DESC);

CREATE TABLE skill_chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES skill_chat_threads(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  data TEXT NOT NULL CHECK (json_valid(data)),
  role TEXT GENERATED ALWAYS AS (json_extract(data,'$.role')) STORED,
  created_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.createdAt')) STORED,
  UNIQUE(thread_id, sequence)
) WITHOUT ROWID;
CREATE INDEX idx_skill_chat_messages_sequence
  ON skill_chat_messages(thread_id, sequence ASC);
`);
  },
};
