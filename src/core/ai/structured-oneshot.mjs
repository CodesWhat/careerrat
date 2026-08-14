// structured-oneshot.mjs — the shared "buffer model text → extract one fenced
// JSON block → validate against a schema → one corrective retry" loop used by
// every small, bounded, structured-output-only AI route this milestone adds:
// POST /api/onboard/resume-ai (src/cli/onboard-route.mjs, via the
// resume-extract skill) and POST /api/assist/suggest (src/cli/assist-route.mjs,
// a bare no-tool one-shot). Both are a materially different shape from
// POST /api/skill/run: that route is a raw SSE passthrough by design
// (evaluate-job/tailor-application need live tool-call visibility for a human
// watching); these two are small, live-token-stream-adds-no-value calls where
// buffering server-side and replying once is the right shape (see
// skill-runtime.mjs's own header comment on the same distinction).
//
// This module knows nothing about *how* a model call is actually made — it
// takes an `invoke({ attempt, correction })` callback that returns the
// buffered raw text of one attempt, and never touches runSkillStream, the
// Agent SDK, or fetch itself. That keeps it callable from two genuinely
// different invocation mechanisms (a skill run with a restricted tool
// surface, and a bare tool-less query()) without coupling either to the
// other.
//
// Schema validation reuses the exact same validate()/formatErrors()
// primitive every candidate/config file already validates against
// (schema-validator.mjs) — no second validation engine.

import { formatErrors, validate } from "../profile/schema-validator.mjs";

// Matches every fenced ```json ... ``` block in a text blob (case-insensitive
// on the "json" tag, since a model occasionally writes ```JSON). Regex is
// reset per call (module-level regex with the "g" flag carries state across
// calls otherwise — a real bug class if this constant were reused directly).
function fencedJsonBlocks(text) {
  const re = /```json\s*\n?([\s\S]*?)```/gi;
  const blocks = [];
  let match = re.exec(text);
  while (match !== null) {
    blocks.push(match[1]);
    match = re.exec(text);
  }
  return blocks;
}

// Extract the JSON payload from a model's raw reply text: the LAST fenced
// ```json block if one or more exist (a model that narrates before
// concluding still resolves correctly; one that follows instructions and
// emits only the block also resolves correctly, since there's only one) —
// falling back to the whole trimmed text when no fence is present at all (a
// model that ignored the fence instruction but still replied with bare JSON).
export function extractFencedJson(rawText) {
  const text = String(rawText ?? "");
  const blocks = fencedJsonBlocks(text);
  if (blocks.length) return blocks[blocks.length - 1].trim();
  return text.trim();
}

// Parse `rawText`'s extracted JSON payload and validate it against `schema`.
// Never throws — parse/validate failures come back as { ok: false, errors }
// so callers can build a corrective retry prompt from them.
export function parseStructuredJson(rawText, schema) {
  const candidate = extractFencedJson(rawText);
  if (!candidate) {
    return { ok: false, errors: [{ path: "", message: "reply contained no text to parse" }] };
  }
  let data;
  try {
    data = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, errors: [{ path: "", message: `invalid JSON: ${err.message}` }] };
  }
  const { valid, errors } = validate(data, schema);
  if (!valid) return { ok: false, data, errors };
  return { ok: true, data };
}

// The corrective instruction appended to a retry prompt — embeds the actual
// parse/validation error so the model can see exactly what it got wrong,
// rather than a generic "try again."
export function buildCorrectiveAddendum(errors) {
  const detail = formatErrors(errors || []);
  return (
    "Your previous reply did not parse as valid JSON, or failed schema validation:\n" +
    `${detail}\n\n` +
    "Reply again with ONLY one fenced ```json code block matching the schema exactly " +
    "— no prose outside the fence, no markdown headers, nothing else."
  );
}

// Drives up to `1 + maxRetries` attempts via `invoke`, parsing/validating
// each attempt's raw text against `schema`. Returns:
//   - { ok: true, data, retried: boolean, raw } on the first attempt that
//     parses and validates.
//   - { ok: false, error, raw, errors } once every attempt is exhausted —
//     an EXPECTED failure mode (the model never produced valid structured
//     output), not something this function throws on. `invoke` itself
//     throwing (e.g. runSkillStream rejecting on a config error like
//     NO_AI_ROUTE/SDK_NOT_INSTALLED) is NOT caught here — it propagates to
//     the caller, which is what lets a route tell "the model replied badly"
//     (422-shaped) apart from "the AI route isn't configured" (501-shaped).
export async function runStructuredOneshot({ schema, maxRetries = 1, invoke }) {
  if (typeof invoke !== "function") {
    throw new TypeError("runStructuredOneshot: invoke callback is required");
  }

  let attempt = 0;
  let lastRaw = "";
  let lastErrors = null;
  while (attempt <= maxRetries) {
    const correction = attempt === 0 ? null : buildCorrectiveAddendum(lastErrors);
    const rawText = await invoke({ attempt, correction });
    lastRaw = rawText;
    const result = parseStructuredJson(rawText, schema);
    if (result.ok) {
      return { ok: true, data: result.data, retried: attempt > 0, raw: rawText };
    }
    lastErrors = result.errors;
    attempt++;
  }
  return {
    ok: false,
    error: "structured output failed to parse/validate",
    raw: lastRaw,
    errors: lastErrors,
  };
}
