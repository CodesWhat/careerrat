// patchFields.js — Lane A, generic confirm kinds. Pure helper that flattens
// a candidate_patch block's nested payload.patch object into the leaf
// path/value pairs a ConfirmPill needs to show WHAT is being saved before
// the click. Never hardcodes a lookup of known field names (profile,
// targeting, honesty, and form-defaults patches all shapes differ, and new
// fields land in those docs independently of this file) — each leaf's label
// is derived generically from its own key.

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function humanizeKey(key) {
  const spaced = String(key).replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : spaced;
}

function formatLeafValue(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined) return "";
  return String(value);
}

// Walks `patch` (a plain object, arbitrarily nested) and returns an ordered
// list of { path, label, value } for every leaf — a leaf is anything that
// isn't itself a plain object (arrays and primitives are both leaves; an
// array renders as a comma-joined string rather than being walked
// element-wise). `label` humanizes only the leaf's own key, not its full
// path, since that's what reads naturally in a pill ("Email: x", not
// "Candidate > Email: x").
export function flattenPatchLeaves(patch) {
  const leaves = [];
  function walk(node, path) {
    if (!isPlainObject(node)) {
      leaves.push({
        path,
        label: humanizeKey(path[path.length - 1]),
        value: formatLeafValue(node),
      });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, [...path, key]);
    }
  }
  if (isPlainObject(patch)) {
    for (const [key, value] of Object.entries(patch)) walk(value, [key]);
  }
  return leaves;
}
