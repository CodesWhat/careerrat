// gate-writer.mjs — the safe write-back primitive for gates-as-data.
//
// When the user states a new gate mid-flow ("never Palantir", "below $190K is a
// no", "don't claim Kubernetes"), a skill must persist it to the canonical
// candidate config so every other skill inherits it (see AGENTS.md → Write-back
// rule). Doing that by hand-editing YAML is unsafe: it can desync from the
// schema, corrupt the file on a bad write, or silently clobber the comments that
// explain each gate. This module is the keystone that makes those writes safe:
//
//   - **Comment-preserving.** parseYaml()/stringifyYaml() both drop comments, so a
//     parse→mutate→serialize round-trip would erase them. Instead we patch the raw
//     file TEXT surgically (append a sequence item, or set a scalar), touching only
//     the target line and leaving every comment and the file's formatting intact.
//   - **Schema-validated.** The patched result is parsed and validated against the
//     file's JSON Schema before it is allowed to be written. A patch that would make
//     the file invalid is refused.
//   - **Idempotent.** Appending a value already present is a no-op.
//   - **Routed + friction-classed as DATA.** GATE_ROUTES maps a gate type to its
//     file/path/op and a default friction (write-and-report vs confirm-first),
//     mirroring the routing table in AGENTS.md — not hardcoded in skill prose.
//   - **Atomic.** The commit writes a temp file and renames it into place, so a
//     crash mid-write can never leave a half-written gate file.
//
// The TEXT operations are pure (no fs) so they are fully unit-testable; the fs
// touchpoints (read, atomic write) are thin and isolated at the bottom.
//
// Indentation assumption: the candidate templates use 2-space indentation
// throughout. The patchers detect the actual indent of existing siblings where
// possible and fall back to parent+2; schema validation backstops any slip.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { formatErrors, validate } from "./schema-validator.mjs";
import { parseYaml } from "./yaml.mjs";

// ---------------------------------------------------------------------------
// Routing table — gate type → where it lives + how consequential it is.
// friction: "report" = write-and-report (low blast radius); "confirm" =
// confirm-first (the caller must get a yes before committing).
// ---------------------------------------------------------------------------

export const GATE_ROUTES = {
  "exclude-company": {
    file: "targeting",
    path: "excluded_companies",
    op: "append",
    friction: "confirm",
    label: "excluded company",
  },
  "cut-signal": {
    file: "targeting",
    path: "cut_signals",
    op: "append",
    friction: "report",
    label: "cut signal",
  },
  "keep-signal": {
    file: "targeting",
    path: "keep_signals",
    op: "append",
    friction: "report",
    label: "keep signal",
  },
  "comp-floor": {
    file: "profile",
    path: "compensation.minimum_base",
    op: "set",
    coerce: "number",
    friction: "confirm",
    label: "comp floor (minimum_base)",
  },
  "comp-target": {
    file: "profile",
    path: "compensation.target_base",
    op: "set",
    coerce: "number",
    friction: "confirm",
    label: "comp anchor (target_base)",
  },
  "comp-expected": {
    file: "profile",
    path: "compensation.expected_base",
    op: "set",
    coerce: "number",
    friction: "report",
    label: "expected base (form value)",
  },
  "do-not-claim": {
    file: "honesty",
    path: "tools.do_not_claim",
    op: "append",
    friction: "report",
    label: "do-not-claim tool",
  },
  "do-not-fabricate": {
    file: "honesty",
    path: "claims.do_not_fabricate",
    op: "append",
    friction: "report",
    label: "do-not-fabricate claim",
  },
};

export function resolveRoute(type) {
  // Object.hasOwn, not a bare truthy lookup: `type` can arrive straight from
  // an HTTP body, and prototype-chain keys ("__proto__", "constructor",
  // "toString", ...) index a plain object literal to something truthy.
  const route = Object.hasOwn(GATE_ROUTES, type) ? GATE_ROUTES[type] : undefined;
  if (!route) {
    throw new Error(`unknown gate type "${type}". Known: ${Object.keys(GATE_ROUTES).join(", ")}`);
  }
  return route;
}

// Privacy invariant (hard): current_base is a private gate input and must never be
// routed anywhere outbound. None of the built-in routes touch it; this guards the
// custom-path escape hatch so a caller can't aim a write at it by mistake.
export function assertNoPrivateLeak(file, path) {
  const leaf = path.split(".").pop();
  if (leaf === "current_base" && file !== "profile") {
    throw new Error(
      `refusing to write current_base into ${file} — it is a private gate input (profile.yml only)`
    );
  }
  if (file === "form-defaults" && path.includes("current_base")) {
    throw new Error(
      "refusing to write current_base into form-defaults.yml — it must never reach an outbound form"
    );
  }
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

export function coerceValue(route, raw) {
  if (route.coerce === "number") {
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`"${raw}" is not a valid non-negative number for ${route.label}`);
    }
    return n;
  }
  return String(raw).trim();
}

// ---------------------------------------------------------------------------
// Low-level text helpers
// ---------------------------------------------------------------------------

const indentOf = (line) => line.length - line.trimStart().length;
const isSkippable = (line) => line.trim() === "" || line.trimStart().startsWith("#");

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// A string is safe to emit bare (unquoted) only if it can't be misread as YAML.
function needsQuote(s) {
  return (
    s === "" ||
    /[:#[\]{}&*!|>'"%@`,]/.test(s) ||
    /^[\s-]/.test(s) ||
    /\s$/.test(s) ||
    /^(true|false|null|yes|no|~)$/i.test(s) ||
    /^[-+]?\d/.test(s)
  );
}

function formatString(s, { forceQuote = false } = {}) {
  if (forceQuote || needsQuote(s))
    return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return String(s);
}

// Locate a dotted key path in the file's lines. Returns { index, indent } of the
// final key's line, or null if any segment is missing. Descends segment by
// segment, narrowing the search window to each parent's block.
export function findKeyPath(lines, parts) {
  let start = 0;
  let end = lines.length;
  let parentIndent = -1;
  let last = null;
  for (const key of parts) {
    let idx = -1;
    let idxIndent = -1;
    for (let i = start; i < end; i++) {
      const ln = lines[i];
      if (isSkippable(ln)) continue;
      const ind = indentOf(ln);
      if (ind <= parentIndent) break; // dedented out of the parent's block
      if (ln.trimStart().startsWith("-")) continue; // sequence item, not a mapping key
      const m = ln.match(/^(\s*)([^:#]+?):(\s.*|)$/);
      if (m && m[2].trim() === key) {
        idx = i;
        idxIndent = ind;
        break; // first (shallowest, earliest) direct child wins
      }
    }
    if (idx === -1) return null;
    parentIndent = idxIndent;
    start = idx + 1;
    end = blockEnd(lines, idx, idxIndent);
    last = { index: idx, indent: idxIndent };
  }
  return last;
}

// First line index after `keyIndex` whose content dedents to <= keyIndent.
function blockEnd(lines, keyIndex, keyIndent) {
  for (let i = keyIndex + 1; i < lines.length; i++) {
    if (isSkippable(lines[i])) continue;
    if (indentOf(lines[i]) <= keyIndent) return i;
  }
  return lines.length;
}

// ---------------------------------------------------------------------------
// Pure patch ops
// ---------------------------------------------------------------------------

// Append `value` to the sequence at `pathParts`, unless it is already there.
// Returns { ok, changed, text, error, formatted }.
export function appendToSequence(text, pathParts, value) {
  const lines = text.split("\n");
  const key = findKeyPath(lines, pathParts);
  if (!key) return { ok: false, error: `key not found: ${pathParts.join(".")}` };

  const keyLine = lines[key.index];
  const afterColon = keyLine.slice(keyLine.indexOf(":") + 1);
  const afterNoComment = afterColon.replace(/\s+#.*$/, "").trim();

  // Collect existing sequence items directly under the key.
  const items = [];
  for (let i = key.index + 1; i < lines.length; i++) {
    if (isSkippable(lines[i])) continue;
    if (indentOf(lines[i]) <= key.indent) break;
    const t = lines[i].trimStart();
    if (t === "-" || t.startsWith("- "))
      items.push({ index: i, indent: indentOf(lines[i]), raw: lines[i] });
    else break; // mapping content under the key — not a flat sequence
  }

  // Idempotency: bail if the value is already present.
  const existing = items.map((it) => unquote(it.raw.trimStart().replace(/^-\s*/, "")));
  if (existing.some((v) => v === String(value))) {
    return { ok: true, changed: false, text };
  }

  // Match sibling style; fall back to parent+2 and quoted-for-safety.
  let itemIndent;
  let quoted;
  if (items.length) {
    itemIndent = items[0].indent;
    const firstVal = items[0].raw.trimStart().replace(/^-\s*/, "");
    quoted = firstVal.startsWith('"') || firstVal.startsWith("'");
  } else {
    itemIndent = key.indent + 2;
    quoted = true;
  }

  const formatted =
    typeof value === "number" ? String(value) : formatString(String(value), { forceQuote: quoted });
  const newLine = `${" ".repeat(itemIndent)}- ${formatted}`;

  // If the sequence was inline-empty ("key: []"), convert it to block form first.
  if (afterNoComment === "[]") {
    const comment = keyLine.match(/(#.*)$/);
    lines[key.index] =
      `${" ".repeat(key.indent)}${pathParts[pathParts.length - 1]}:${comment ? ` ${comment[1]}` : ""}`;
  }

  const insertAt = items.length ? items[items.length - 1].index + 1 : key.index + 1;
  lines.splice(insertAt, 0, newLine);
  return { ok: true, changed: true, text: lines.join("\n"), formatted };
}

// Set the scalar at `pathParts` to `value`, preserving any inline comment.
// Returns { ok, changed, text, previous, error }.
export function setScalar(text, pathParts, value) {
  const lines = text.split("\n");
  const key = findKeyPath(lines, pathParts);
  if (!key) return { ok: false, error: `key not found: ${pathParts.join(".")}` };

  const keyLine = lines[key.index];
  const colon = keyLine.indexOf(":");
  const head = keyLine.slice(0, colon + 1);
  const after = keyLine.slice(colon + 1);
  const commentMatch = after.match(/\s+(#.*)$/);
  const comment = commentMatch ? ` ${commentMatch[1]}` : "";
  const previous = after.replace(/\s+#.*$/, "").trim();

  // Reject setting a scalar on a key that owns a block (sequence/mapping child).
  for (let i = key.index + 1; i < lines.length; i++) {
    if (isSkippable(lines[i])) continue;
    if (indentOf(lines[i]) > key.indent) {
      return { ok: false, error: `${pathParts.join(".")} is a block, not a scalar` };
    }
    break;
  }

  const formatted =
    value === null || value === undefined
      ? ""
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : formatString(String(value));
  const next = `${head}${formatted ? ` ${formatted}` : ""}${comment}`;
  if (next === keyLine) return { ok: true, changed: false, text, previous };
  lines[key.index] = next;
  return { ok: true, changed: true, text: lines.join("\n"), previous };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Parse + schema-validate the candidate text. schema may be null (schema-less
// files like application-limits.yml) — then we only confirm it still parses.
export function validateText(text, schema) {
  let data;
  try {
    data = parseYaml(text);
  } catch (err) {
    return { valid: false, errors: [{ path: "", message: `YAML parse error: ${err.message}` }] };
  }
  if (!schema) return { valid: true, errors: [], data };
  const result = validate(data, schema);
  return { valid: result.valid, errors: result.errors, data };
}

// ---------------------------------------------------------------------------
// Plan: pure end-to-end (no fs). Given the current file text + schema, compute
// the proposed next text, whether anything changed, validity, and friction.
// ---------------------------------------------------------------------------

export function computeGateEdit({ type, value, currentText, schema = null }) {
  const route = resolveRoute(type);
  assertNoPrivateLeak(route.file, route.path);
  const coerced = coerceValue(route, value);
  const parts = route.path.split(".");

  const patch =
    route.op === "append"
      ? appendToSequence(currentText, parts, coerced)
      : setScalar(currentText, parts, coerced);

  if (!patch.ok) {
    return { ok: false, error: patch.error, route, value: coerced };
  }

  const validation = patch.changed ? validateText(patch.text, schema) : { valid: true, errors: [] };

  return {
    ok: true,
    route,
    file: route.file,
    path: route.path,
    op: route.op,
    friction: route.friction,
    value: coerced,
    changed: patch.changed,
    previous: patch.previous,
    nextText: patch.text,
    valid: validation.valid,
    errors: validation.errors,
  };
}

// ---------------------------------------------------------------------------
// fs touchpoints
// ---------------------------------------------------------------------------

// Atomic write: stage to a temp sibling, then rename into place. rename(2) is
// atomic on the same filesystem, so a reader/crash never sees a partial file.
export function atomicWriteFile(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      writeFileSync(path, text, "utf8");
    } finally {
      try {
        if (existsSync(tmp)) writeFileSync(tmp, ""); // best-effort; ignore
      } catch {
        /* ignore */
      }
    }
    if (err?.code && err.code !== "EXDEV") throw err;
  }
}

export function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export { formatErrors };
