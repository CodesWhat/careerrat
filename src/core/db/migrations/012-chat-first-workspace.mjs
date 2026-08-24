// Durable state owned by the chat-first shell. Job lifecycle facts such as
// terminal status and contact due dates stay in applications/communications;
// these tables persist only conversation membership, run progress, and mock
// interview history.
export const migration012 = {
  id: 12,
  name: "chat-first-workspace",
  up(db) {
    db.exec(`
CREATE TABLE job_threads (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
  data TEXT NOT NULL CHECK (json_valid(data)),
  status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  pinned INTEGER GENERATED ALWAYS AS (json_extract(data,'$.pinned')) STORED,
  updated_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.updatedAt')) STORED
) WITHOUT ROWID;
CREATE INDEX idx_job_threads_status_updated
  ON job_threads(status, pinned DESC, updated_at DESC);

CREATE TABLE job_thread_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES job_threads(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  data TEXT NOT NULL CHECK (json_valid(data)),
  role TEXT GENERATED ALWAYS AS (json_extract(data,'$.role')) STORED,
  kind TEXT GENERATED ALWAYS AS (json_extract(data,'$.kind')) STORED,
  created_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.createdAt')) STORED,
  UNIQUE(thread_id, sequence)
) WITHOUT ROWID;
CREATE INDEX idx_job_thread_messages_sequence
  ON job_thread_messages(thread_id, sequence ASC);

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  created_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.createdAt')) STORED,
  updated_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.updatedAt')) STORED
) WITHOUT ROWID;
CREATE INDEX idx_missions_status_updated
  ON missions(status, updated_at DESC);

CREATE TABLE mission_steps (
  id TEXT NOT NULL,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  data TEXT NOT NULL CHECK (json_valid(data)),
  status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  updated_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.updatedAt')) STORED,
  PRIMARY KEY(mission_id, id),
  UNIQUE(mission_id, sequence)
) WITHOUT ROWID;
CREATE INDEX idx_mission_steps_status
  ON mission_steps(mission_id, status, sequence ASC);

CREATE TABLE mock_interview_sessions (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  data TEXT NOT NULL CHECK (json_valid(data)),
  status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  started_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.startedAt')) STORED,
  ended_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.endedAt')) STORED,
  updated_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.updatedAt')) STORED
) WITHOUT ROWID;
CREATE INDEX idx_mock_interview_sessions_app
  ON mock_interview_sessions(application_id, status, updated_at DESC);

CREATE TABLE mock_interview_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES mock_interview_sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  data TEXT NOT NULL CHECK (json_valid(data)),
  role TEXT GENERATED ALWAYS AS (json_extract(data,'$.role')) STORED,
  kind TEXT GENERATED ALWAYS AS (json_extract(data,'$.kind')) STORED,
  created_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.createdAt')) STORED,
  UNIQUE(session_id, sequence)
) WITHOUT ROWID;
CREATE INDEX idx_mock_interview_messages_sequence
  ON mock_interview_messages(session_id, sequence ASC);

CREATE TABLE mock_interview_feedback (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES mock_interview_sessions(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES mock_interview_messages(id) ON DELETE SET NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  question_number INTEGER GENERATED ALWAYS AS (json_extract(data,'$.questionNumber')) STORED,
  created_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.createdAt')) STORED
) WITHOUT ROWID;
CREATE INDEX idx_mock_interview_feedback_question
  ON mock_interview_feedback(session_id, question_number ASC, created_at ASC);

INSERT OR IGNORE INTO job_threads (id, application_id, data)
SELECT
  'job:' || applications.id,
  applications.id,
  json_object(
    'id', 'job:' || applications.id,
    'applicationId', applications.id,
    'status', 'active',
    'pinned', json('false'),
    'earnedBy', json_array('human-entered'),
    'createdAt', applications.updated_at,
    'updatedAt', applications.updated_at
  )
FROM applications
WHERE
  coalesce(json_array_length(json_extract(applications.data, '$.conversations')), 0) > 0
  OR EXISTS (
    SELECT 1
    FROM communications
    WHERE communications.application_id = applications.id
      AND EXISTS (
        SELECT 1
        FROM json_each(json_extract(communications.data, '$.messages'))
        WHERE json_extract(json_each.value, '$.direction') = 'inbound'
      )
  );
`);
  },
};
