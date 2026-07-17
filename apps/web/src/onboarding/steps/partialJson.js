// apps/web/src/onboarding/steps/partialJson.js — best-effort repair + parse
// of an INCOMPLETE JSON document. Feeds ResumeStep's "reading takeover": the
// resume-ai-stream route's {"type":"json","chunk"} frames carry the raw
// assistant text as it streams (see the route's frozen contract), and this
// module lets the UI progressively preview that text before the terminal
// {"type":"done"} frame lands with the authoritative, fully-parsed result.
//
// The streamed text is the resume-extract skill's raw model output: a single
// fenced ```json block matching config/resume-extract.schema.json's
// snake_case top-level shape (full_text, resume_document, candidate, claims,
// sections, targeting_suggestions) — NOT the camelCase done-payload shape
// (fullText, profileSeed, evidenceSeed, ...) that the buffered
// POST /api/onboard/resume-ai / streamed "done" event return. Callers that
// want the done shape use the done event directly; this module only ever
// deals in the raw model schema's field names.

const FENCE_OPEN = /^\s*```(?:json)?\s*\n?/;
const FENCE_CLOSE = /\n?\s*```\s*$/;

// candidate/sections mirror config/resume-extract.schema.json's
// `candidate` and `sections` property lists exactly.
const CANDIDATE_FIELDS = [
  "full_name",
  "email",
  "phone",
  "location",
  "linkedin",
  "github",
  "portfolio",
  "domain",
];
const SECTION_FIELDS = ["experience", "education", "skills", "projects", "other"];

export function parsePartialResumeJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;

  const candidate = text.replace(FENCE_OPEN, "").replace(FENCE_CLOSE, "").trim();
  if (!candidate) return null;

  // The common "one giant chunk near the end" case: the accumulated text is
  // already a complete document, so a plain parse succeeds and the repair
  // pass below never runs.
  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through to the repair pass */
  }

  const repaired = repairPartialJson(candidate);
  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

// Single pass over the text tracking: (a) in-string/escape state, (b) a
// stack of open "{"/"[" frames, and (c) for object frames only, whether the
// next token at that depth is a "key" (right after "{"/",") or a "value"
// (right after ":"). At end of scan the top-of-stack frame tells us exactly
// what kind of thing got truncated:
//   - mid-string that's a KEY (no ":" seen yet) -> the whole dangling key is
//     discarded (a key with no value is never valid JSON, unlike a value cut
//     mid-string, which we can just close).
//   - mid-string that's a VALUE -> close it with a trailing quote.
//   - not in a string, expecting a value (":" was seen but the value never
//     finished — including a bare number/true/false/null cut mid-token,
//     which this doesn't attempt to detect precisely) -> discard back to the
//     start of that member.
//   - not in a string, expecting a key (nothing started yet at this depth)
//     -> nothing to discard, the prefix is already safe.
// Every dropped field simply reappears once the next chunk completes it —
// this only ever loses the LATEST, still-in-flight field for one re-parse.
function repairPartialJson(text) {
  const stack = []; // '{' | '['
  const expectStack = []; // 'key' | 'colon' | 'value' per object frame; null for array frames
  const memberStart = []; // index where the next key/element at this depth would start
  let inString = false;
  let escaped = false;
  let stringStart = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        const depth = stack.length - 1;
        if (depth >= 0 && stack[depth] === "{") {
          if (expectStack[depth] === "key") {
            expectStack[depth] = "colon"; // that string was a key
          } else if (expectStack[depth] === "value") {
            expectStack[depth] = "key"; // that string was a value, now complete
          }
        }
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      stringStart = i;
      continue;
    }
    if (/\s/.test(ch)) continue;

    if (ch === "{") {
      stack.push("{");
      expectStack.push("key");
      memberStart.push(i + 1);
      continue;
    }
    if (ch === "[") {
      stack.push("[");
      expectStack.push(null);
      memberStart.push(i + 1);
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      expectStack.pop();
      memberStart.pop();
      const depth = stack.length - 1;
      if (depth >= 0 && stack[depth] === "{" && expectStack[depth] === "value") {
        expectStack[depth] = "key"; // the container we just closed WAS the value
      }
      continue;
    }
    if (ch === ":") {
      const depth = stack.length - 1;
      if (depth >= 0 && stack[depth] === "{") expectStack[depth] = "value";
      continue;
    }
    if (ch === ",") {
      const depth = stack.length - 1;
      if (depth >= 0) {
        if (stack[depth] === "{") expectStack[depth] = "key";
        memberStart[depth] = i + 1;
      }
    }

    // Any other char is part of a bare literal/number token — no bookkeeping
    // needed; completeness is inferred retroactively at the next delimiter
    // (",", "}", "]") above, or discarded as incomplete at end-of-scan below.
  }

  let out = text;
  const topDepth = stack.length - 1;

  if (inString) {
    if (escaped) out = out.slice(0, -1); // drop a trailing lone backslash
    const wasKey = topDepth >= 0 && stack[topDepth] === "{" && expectStack[topDepth] === "key";
    out = wasKey ? out.slice(0, stringStart) : `${out}"`;
  } else if (topDepth >= 0) {
    out = out.slice(0, memberStart[topDepth]);
  }

  out = out.replace(/,\s*$/, "");

  for (let d = stack.length - 1; d >= 0; d--) {
    out += stack[d] === "{" ? "}" : "]";
  }

  return out;
}

// Maps a (possibly partial) parsed raw-schema object to the subset ResumeStep
// live-fills during the takeover: candidate fields actually present so far,
// claims found so far, and sections if the model has emitted that block yet.
// Field names deliberately match ResumeStep's PROFILE_FIELDS/SECTION_KEYS so
// callers can drop the result straight into that state.
export function extractProgressiveSeed(obj) {
  if (!obj || typeof obj !== "object") return { candidate: {}, claims: [], sections: null };

  const rawCandidate = obj.candidate && typeof obj.candidate === "object" ? obj.candidate : {};
  const candidate = {};
  for (const key of CANDIDATE_FIELDS) {
    const value = rawCandidate[key];
    if (typeof value === "string" && value.trim()) candidate[key] = value;
  }

  const rawClaims = Array.isArray(obj.claims) ? obj.claims : [];
  const claims = rawClaims
    .filter(
      (claim) =>
        claim && typeof claim === "object" && typeof claim.claim === "string" && claim.claim.trim()
    )
    .map((claim) => ({
      claim: claim.claim,
      evidence: typeof claim.evidence === "string" ? claim.evidence : "",
    }));

  let sections = null;
  if (obj.sections && typeof obj.sections === "object") {
    sections = {};
    for (const key of SECTION_FIELDS) {
      if (typeof obj.sections[key] === "number") sections[key] = obj.sections[key];
    }
  }

  return { candidate, claims, sections };
}
