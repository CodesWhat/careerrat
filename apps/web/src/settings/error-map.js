// apps/web/src/settings/error-map.js — maps onboard-route.mjs's schema
// validation errors ({ path, message }[], dot-notation paths per
// src/core/profile/schema-validator.mjs's joinPath()) onto the field ids each
// Settings section's inputs use, so a given error renders inline under its
// own field. `fieldMap` is a plain { schemaPath: fieldId } object built per
// section (see SettingsPage.jsx). Anything that doesn't map to a known field
// id (cross-field errors, e.g. a missing required top-level property) is
// returned as `unmapped` for the caller to show as a page-level banner.

export function mapErrors(errors, fieldMap = {}) {
  const byField = {};
  const unmapped = [];
  for (const err of errors || []) {
    const fieldId = fieldMap[err.path];
    if (fieldId) {
      byField[fieldId] = err.message;
    } else {
      unmapped.push(err);
    }
  }
  return { byField, unmapped };
}
