// migrations/002-intake.mjs — M9 Universal Intake's queue table.
//
// Same M6 shape as 001-init.mjs: one JSON blob column (`data`) holding the
// whole intake item verbatim, plus GENERATED ALWAYS AS (json_extract(...))
// STORED columns for the two fields the Inbox actually filters/sorts by
// (`kind`, `status`). Everything else the item carries (raw input, the
// classification result, tracker-match reference, dispatch result/error)
// stays inside the blob — no wide hand-modeled columns, matching 001-init's
// own restraint.
//
// `created_at`/`updated_at` are real (non-generated) columns, not derived
// from the blob — the Inbox list needs to ORDER BY created_at DESC and this
// is cheaper/simpler than a generated-column index over a JSON path that
// never changes after insert. `created_at` gets its DEFAULT only on INSERT
// (verbs/intake.mjs never includes it in an UPDATE's column list, so it's
// immutable after creation); `updated_at` is refreshed on every write.
//
// intake_items is workflow/queue state, not tracker-visible domain data (see
// verbs/intake.mjs's own header comment): it never bumps meta.version/
// last_updated_at and is never exported to workspace/tracker.json — so unlike
// applications/sourced/communications, this table has no legacy-JSON
// dual-mode to preserve parity with. A pre-M9 workspace simply doesn't have
// an intake queue until it runs this migration.
export const migration002 = {
  id: 2,
  name: "intake",
  up(db) {
    db.exec(`
CREATE TABLE intake_items (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  kind       TEXT GENERATED ALWAYS AS (json_extract(data,'$.kind')) STORED,
  status     TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED
             CHECK (status IN ('captured','classifying','proposed','confirmed',
                                'running','done','needs_you','dismissed','error')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_intake_status  ON intake_items(status);
CREATE INDEX idx_intake_kind    ON intake_items(kind);
CREATE INDEX idx_intake_created ON intake_items(created_at DESC);
`);
  },
};
