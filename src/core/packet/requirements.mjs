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

// normalizeRequirements(raw) — accepts anything the model returned for
// `requirements` and produces a clean, bounded array. Drops rows without a
// usable requirement string, clamps every enum to its allowed set, truncates
// jdSignal/note, dedupes by lowercased requirement (first occurrence wins),
// and caps at MAX_ROWS. Never throws.
export function normalizeRequirements(raw) {
  try {
    if (!Array.isArray(raw)) return [];
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
      rows.push({
        requirement,
        importance: clampEnum(entry.importance, IMPORTANCE_VALUES, "meaningful"),
        evidence: clampEnum(entry.evidence, EVIDENCE_VALUES, "inferred"),
        jdSignal: truncate(entry.jdSignal, JD_SIGNAL_MAX_CHARS),
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
// non-array degrades to no rows, never a throw). For every row whose match is
// missing/partial and whose importance is critical/high: reuse an existing
// fitRisk string that already names it (case-insensitive substring match on
// the requirement text, each existing string consumed at most once), or else
// synthesize `"<requirement> is <missing|partial>: <note>"`. Any existing
// risk string that never matched a qualifying row is appended at the end
// unchanged, so no prior information is silently dropped.
export function deriveFitRisks(requirements, existingFitRisks) {
  try {
    const rows = Array.isArray(requirements) ? requirements : [];
    const gapRows = rows.filter(
      (row) => row && GAP_MATCH_VALUES.has(row.match) && HIGH_IMPORTANCE_VALUES.has(row.importance)
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

    existing.forEach((risk, index) => {
      if (!usedExistingIndexes.has(index)) result.push(risk);
    });

    return result;
  } catch {
    return Array.isArray(existingFitRisks)
      ? existingFitRisks.filter((value) => typeof value === "string")
      : [];
  }
}
