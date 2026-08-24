// Durable, local-only presentation preferences for the chat-first workspace.
// Domain lifecycle state remains in its owning tables. These rows only record
// whether the user dismissed optional workspace prompts.
export const migration014 = {
  id: 14,
  name: "chat-first-preferences",
  up(db) {
    db.exec(`
CREATE TABLE chat_first_preferences (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.updatedAt')) STORED
) WITHOUT ROWID;
`);
  },
};
