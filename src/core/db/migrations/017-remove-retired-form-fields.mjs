export const migration017 = {
  id: 17,
  name: "remove-retired-form-fields",
  up(db) {
    db.exec(`
UPDATE candidate_form_defaults
SET data = json_remove(data, '$.auto_submit'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE json_type(data, '$.auto_submit') IS NOT NULL;
`);
  },
};
