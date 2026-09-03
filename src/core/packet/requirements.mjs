// requirements.mjs — normalizes the evidence-tiered requirements table the
// packet-gate AI verdict returns (src/core/packet/schemas/packet-schemas.mjs
// #packetGateAiVerdictSchema `requirements`) and derives fitRisks from it.
//
// Both functions are defensive by contract: the model's raw JSON is never
// trusted as-is, so normalizeRequirements clamps every enum, truncates every
// free-text field, dedupes, and caps — and never throws, even on garbage
// input. deriveFitRisks reads only the already-normalized table.

const IMPORTANCE_VALUES = new Set(["critical", "high", "meaningful", "preferred", "low_signal"]);
const EVIDENCE_VALUES = new Set(["stated", "structural", "inferred"]);
const MATCH_VALUES = new Set(["strong", "partial", "missing", "na"]);

const MAX_ROWS = 20;
const REQUIREMENT_MAX_CHARS = 120;
const JD_SIGNAL_MAX_CHARS = 160;
const NOTE_MAX_CHARS = 200;

// Rows whose gap is worth surfacing as a fitRisk: an unmet or partially met
// requirement the candidate actually needs to clear.
const GAP_MATCH_VALUES = new Set(["missing", "partial"]);
const HIGH_IMPORTANCE_VALUES = new Set(["critical", "high"]);

// Sort rank for the pre-cap ordering: critical before high, missing before
// partial. Lower rank sorts first, so the most severe gaps survive a
// downstream slice(0, 3) even when the model listed them last.
const IMPORTANCE_RANK = { critical: 0, high: 1 };
const MATCH_RANK = { missing: 0, partial: 1 };

function truncate(value, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= maxLength) return text;
  const sliced = text.slice(0, Math.max(0, maxLength - 1)).trimEnd();
  return `${sliced}…`;
}

function clampEnum(value, allowed, fallback) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

// collapseWhitespace(value) — whitespace-collapsed, case-insensitive form
// used to compare a jdSignal against the saved JD text without caring about
// line wraps or incidental spacing differences.
function collapseWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// verifyJdSignal(signal, collapsedJdText) — when a JD text was supplied,
// blank a jdSignal that doesn't actually occur in it (whitespace-collapsed,
// case-insensitive substring). An invented signal is dropped, not the row:
// the requirement stays, only the (wrong) quoted JD phrase is cleared. With
// no JD text supplied, the signal passes through unchecked.
function verifyJdSignal(signal, collapsedJdText) {
  if (!signal) return signal;
  if (!collapsedJdText) return signal;
  return collapsedJdText.includes(collapseWhitespace(signal)) ? signal : "";
}

// normalizeRequirements(raw, options) — accepts anything the model returned
// for `requirements` and produces a clean, bounded array. Drops rows without
// a usable requirement string, clamps every enum to its allowed set,
// truncates jdSignal/note, dedupes by lowercased requirement (first
// occurrence wins), and caps at MAX_ROWS. Never throws.
//
// options.jdText — when provided, every row's jdSignal is checked against it
// (see verifyJdSignal) and blanked if it doesn't occur in the JD; the row
// itself is always kept. Omitted or empty means no check runs.
export function normalizeRequirements(raw, options = {}) {
  try {
    if (!Array.isArray(raw)) return [];
    const jdText = typeof options?.jdText === "string" ? options.jdText : "";
    const collapsedJdText = jdText ? collapseWhitespace(jdText) : "";
    const seen = new Set();
    const rows = [];
    for (const entry of raw) {
      if (rows.length >= MAX_ROWS) break;
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.requirement !== "string") continue;
      const requirement = truncate(entry.requirement, REQUIREMENT_MAX_CHARS);
      if (!requirement) continue;
      const key = requirement.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const jdSignal = verifyJdSignal(
        truncate(entry.jdSignal, JD_SIGNAL_MAX_CHARS),
        collapsedJdText
      );
      rows.push({
        requirement,
        importance: clampEnum(entry.importance, IMPORTANCE_VALUES, "meaningful"),
        evidence: clampEnum(entry.evidence, EVIDENCE_VALUES, "inferred"),
        jdSignal,
        match: clampEnum(entry.match, MATCH_VALUES, "na"),
        note: truncate(entry.note, NOTE_MAX_CHARS),
      });
    }
    return rows;
  } catch {
    return [];
  }
}

// deriveFitRisks(requirements, existingFitRisks) — aligns fitRisks to the
// requirements table. `requirements` is assumed already normalized (a
// non-array degrades to no rows, never a throw). Qualifying gap rows (match
// missing/partial, importance critical/high) are stable-sorted critical
// before high, then missing before partial, so a downstream cap to 3 always
// keeps the most severe gaps regardless of the model's own ordering. For
// each, in that order: reuse an existing fitRisk string that already names it
// (case-insensitive substring match on the requirement text, each existing
// string consumed at most once), or else synthesize
// `"<requirement> is <missing|partial>: <note>"`.
//
// With a nonempty table, any existing risk string that never matched a
// qualifying row is dropped — the table is the grounded source of truth, so
// an ungrounded model risk doesn't survive alongside it. With an empty table
// (legacy verdict, or normalization producing no rows), there is nothing to
// ground against, so the existing risks pass through unchanged instead.
export function deriveFitRisks(requirements, existingFitRisks) {
  try {
    const rows = Array.isArray(requirements) ? requirements : [];
    const gapRows = rows
      .filter(
        (row) =>
          row && GAP_MATCH_VALUES.has(row.match) && HIGH_IMPORTANCE_VALUES.has(row.importance)
      )
      .slice()
      .sort(
        (a, b) =>
          IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance] ||
          MATCH_RANK[a.match] - MATCH_RANK[b.match]
      );
    const existing = Array.isArray(existingFitRisks)
      ? existingFitRisks.filter((value) => typeof value === "string" && value.trim())
      : [];

    const usedExistingIndexes = new Set();
    const result = [];

    for (const row of gapRows) {
      const needle = String(row.requirement || "").toLowerCase();
      const matchIndex = needle
        ? existing.findIndex(
            (risk, index) => !usedExistingIndexes.has(index) && risk.toLowerCase().includes(needle)
          )
        : -1;
      if (matchIndex >= 0) {
        usedExistingIndexes.add(matchIndex);
        result.push(existing[matchIndex]);
        continue;
      }
      const note = String(row.note || "").trim();
      result.push(`${row.requirement} is ${row.match}${note ? `: ${note}` : ""}`);
    }

    // Only pass through leftover model risks when the table itself is
    // empty — a nonempty table is the grounded source of truth, so an
    // existing risk that names nothing in it is dropped, not appended.
    if (rows.length === 0) {
      existing.forEach((risk, index) => {
        if (!usedExistingIndexes.has(index)) result.push(risk);
      });
    }

    return result;
  } catch {
    return Array.isArray(existingFitRisks)
      ? existingFitRisks.filter((value) => typeof value === "string")
      : [];
  }
}
