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

// Paths whose leaves are internal bookkeeping rather than a user-given
// answer — a field the app itself wrote (e.g. when recording that a
// candidate declined to answer something) rather than anything the
// candidate said. Checked by key at any depth, so a subtree nested under
// one of these is dropped entirely rather than surfacing its raw internal
// shape (a timestamp, a boolean flag) as if it were the user's own input.
const SUPPRESSED_PATH_KEYS = new Set(["declined_fields"]);

// A bare (no fractional seconds beyond what's matched, offset optional)
// ISO-8601 date or date-time string. Only the date components are used for
// display — the exact instant/timezone doesn't matter for a human-readable
// pill label, so this is a literal component match rather than a `Date`
// parse (which would shift the displayed day across timezones).
const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Literal calendar-math validation (no `Date` parsing) — `new Date` silently
// rolls an out-of-range day/month over into the next one (e.g.
// "2026-02-30" becomes March 2) instead of rejecting it, which would let an
// impossible date get formatted as if it were real.
function isValidCalendarDate(year, month, day) {
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day >= 1 && day <= maxDay;
}

function formatIsoDate(value) {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  if (!isValidCalendarDate(Number(year), Number(month), Number(day))) return null;
  const monthName = MONTH_NAMES[Number(month) - 1];
  return `${monthName} ${Number(day)}, ${year}`;
}

// Keys that, when present as a string on an array element, make that
// element readable on its own (e.g. a role bucket's `name`, an evidence
// item's `title`). Checked in priority order; the first match wins.
const REPRESENTATIVE_ELEMENT_KEYS = ["name", "title", "label"];

function representativeElementText(element) {
  if (!isPlainObject(element)) return String(element);
  for (const key of REPRESENTATIVE_ELEMENT_KEYS) {
    if (typeof element[key] === "string" && element[key].trim()) return element[key];
  }
  return null;
}

// Leaf keys in the patch schemas are already plural (role_buckets,
// tracked_companies, ...), so the count fallback below needs to singularize
// for n === 1 rather than append an "s" the way onboardingSetup.js's
// `claim${n === 1 ? "" : "s"}` idiom does for its already-singular noun.
// Only the trailing word needs handling since humanizeKey never pluralizes
// anything but the schema key itself.
function singularizeNoun(noun) {
  if (noun.endsWith("ies")) return `${noun.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/.test(noun)) return noun.slice(0, -2);
  if (noun.endsWith("s") && !noun.endsWith("ss")) return noun.slice(0, -1);
  return noun;
}

// Arrays of primitives join as before. An array containing plain objects
// (e.g. `targeting.role_buckets`, each `{name, priority, titles, notes}`)
// can't just `String()` its elements — that produces "[object Object]" —
// so each element is reduced to a representative field when one is
// obviously present, and the whole array falls back to a plain count
// ("2 role buckets", the noun taken from the leaf's own key, singularized
// for a lone element so it doesn't read "1 role buckets") when it isn't.
// This is a general reduction, not a special case for any one field name.
function formatArrayValue(value, path) {
  if (value.length === 0) return "";
  if (!value.some(isPlainObject)) return value.map((v) => String(v)).join(", ");
  const representatives = value.map(representativeElementText);
  if (representatives.every((text) => text !== null)) return representatives.join(", ");
  const noun = humanizeKey(path[path.length - 1]).toLowerCase();
  return `${value.length} ${value.length === 1 ? singularizeNoun(noun) : noun}`;
}

// Pills render inline in the transcript, not in a scrollable panel — a
// single leaf's value shouldn't be able to blow out the pill's width (or
// wrap mid-token) on its own, so it's capped here regardless of which
// branch above produced it.
const MAX_VALUE_LENGTH = 48;

function truncateValue(text) {
  // Iterate whole code points rather than UTF-16 code units — a fixed-length
  // `.slice()` can land inside a surrogate pair (an emoji, some CJK/astral
  // characters) and emit a lone surrogate that renders as a replacement glyph.
  const chars = Array.from(text);
  if (chars.length <= MAX_VALUE_LENGTH) return text;
  return `${chars
    .slice(0, MAX_VALUE_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
}

function formatLeafValue(value, path) {
  if (Array.isArray(value)) return truncateValue(formatArrayValue(value, path));
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return truncateValue(formatIsoDate(value) || value);
  return truncateValue(String(value));
}

// Walks `patch` (a plain object, arbitrarily nested) and returns an ordered
// list of { path, label, value } for every leaf — a leaf is anything that
// isn't itself a plain object (arrays and primitives are both leaves; an
// array renders as a comma-joined string rather than being walked
// element-wise). `label` humanizes only the leaf's own key, not its full
// path, since that's what reads naturally in a pill ("Email: x", not
// "Candidate > Email: x"). Subtrees under a SUPPRESSED_PATH_KEYS key are
// skipped entirely rather than flattened — see that const's comment.
export function flattenPatchLeaves(patch) {
  const leaves = [];
  function walk(node, path) {
    if (!isPlainObject(node)) {
      leaves.push({
        path,
        label: humanizeKey(path[path.length - 1]),
        value: formatLeafValue(node, path),
      });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (SUPPRESSED_PATH_KEYS.has(key)) continue;
      walk(value, [...path, key]);
    }
  }
  if (isPlainObject(patch)) {
    for (const [key, value] of Object.entries(patch)) {
      if (SUPPRESSED_PATH_KEYS.has(key)) continue;
      walk(value, [key]);
    }
  }
  return leaves;
}
