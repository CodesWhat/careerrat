export const migration015 = {
  id: 15,
  name: "resume-extractions",
  up(db) {
    db.exec(`
CREATE TABLE resume_extractions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  upload_digest TEXT GENERATED ALWAYS AS (json_extract(data,'$.uploadDigest')) STORED,
  status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  updated_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.updatedAt')) STORED
) WITHOUT ROWID;
CREATE INDEX idx_resume_extractions_digest
  ON resume_extractions(upload_digest, updated_at DESC);
CREATE INDEX idx_resume_extractions_status
  ON resume_extractions(status, updated_at DESC);
`);
  },
};
