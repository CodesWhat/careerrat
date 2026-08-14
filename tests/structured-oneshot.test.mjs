// tests/structured-oneshot.test.mjs
// node:test suite for the shared buffer→parse→validate→retry-once helper
// (src/core/ai/structured-oneshot.mjs) used by both POST /api/onboard/resume-ai
// and POST /api/assist/suggest. Fully hermetic — no network, no SDK, no
// runSkillStream: `invoke` is a plain async function the tests control
// directly.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCorrectiveAddendum,
  extractFencedJson,
  parseStructuredJson,
  runStructuredOneshot,
} from "../src/core/ai/structured-oneshot.mjs";

const SIMPLE_SCHEMA = {
  type: "object",
  required: ["suggestions"],
  additionalProperties: false,
  properties: {
    suggestions: { type: "array", items: { type: "string" } },
  },
};

// ---------------------------------------------------------------------------
// extractFencedJson
// ---------------------------------------------------------------------------

test("extractFencedJson: a single fenced block extracts cleanly", () => {
  const text = 'Here is my answer:\n```json\n{"suggestions": ["a", "b"]}\n```\nDone.';
  assert.equal(extractFencedJson(text), '{"suggestions": ["a", "b"]}');
});

test("extractFencedJson: multiple fenced blocks — the LAST one wins", () => {
  const text =
    '```json\n{"suggestions": ["draft"]}\n```\nActually, on reflection:\n' +
    '```json\n{"suggestions": ["final"]}\n```';
  assert.equal(extractFencedJson(text), '{"suggestions": ["final"]}');
});

test("extractFencedJson: no fenced block falls back to the whole trimmed text", () => {
  const text = '  {"suggestions": ["bare"]}  ';
  assert.equal(extractFencedJson(text), '{"suggestions": ["bare"]}');
});

test("extractFencedJson: an uppercase ```JSON tag is still matched", () => {
  const text = '```JSON\n{"suggestions": []}\n```';
  assert.equal(extractFencedJson(text), '{"suggestions": []}');
});

test("extractFencedJson: empty input returns an empty string", () => {
  assert.equal(extractFencedJson(""), "");
  assert.equal(extractFencedJson(undefined), "");
});

// ---------------------------------------------------------------------------
// parseStructuredJson
// ---------------------------------------------------------------------------

test("parseStructuredJson: valid JSON matching the schema returns ok:true", () => {
  const result = parseStructuredJson('```json\n{"suggestions": ["Engineer"]}\n```', SIMPLE_SCHEMA);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { suggestions: ["Engineer"] });
});

test("parseStructuredJson: malformed JSON returns ok:false with a parse error", () => {
  const result = parseStructuredJson("```json\n{not valid json\n```", SIMPLE_SCHEMA);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.match(result.errors[0].message, /invalid JSON/);
});

test("parseStructuredJson: valid JSON that fails schema validation returns ok:false + data", () => {
  const result = parseStructuredJson('```json\n{"wrong_key": []}\n```', SIMPLE_SCHEMA);
  assert.equal(result.ok, false);
  assert.deepEqual(result.data, { wrong_key: [] });
  assert.ok(result.errors.some((e) => /suggestions/.test(e.message)));
});

test("parseStructuredJson: whitespace-only reply returns ok:false without throwing", () => {
  const result = parseStructuredJson("   \n  ", SIMPLE_SCHEMA);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// buildCorrectiveAddendum
// ---------------------------------------------------------------------------

test("buildCorrectiveAddendum: embeds the actual error message and instructs a fence-only retry", () => {
  const addendum = buildCorrectiveAddendum([
    { path: "suggestions", message: "expected type array" },
  ]);
  assert.match(addendum, /expected type array/);
  assert.match(addendum, /```json/);
  assert.match(addendum, /no prose/i);
});

// ---------------------------------------------------------------------------
// runStructuredOneshot
// ---------------------------------------------------------------------------

test("runStructuredOneshot: succeeds on the first attempt — invoke called once, retried:false", async () => {
  let calls = 0;
  const result = await runStructuredOneshot({
    schema: SIMPLE_SCHEMA,
    maxRetries: 1,
    invoke: async () => {
      calls++;
      return '```json\n{"suggestions": ["a"]}\n```';
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.retried, false);
  assert.deepEqual(result.data, { suggestions: ["a"] });
});

test("runStructuredOneshot: fails once, succeeds on retry — invoke called twice, retried:true, correction carries the error", async () => {
  const prompts = [];
  const corrections = [];
  const result = await runStructuredOneshot({
    schema: SIMPLE_SCHEMA,
    maxRetries: 1,
    invoke: async ({ attempt, correction }) => {
      prompts.push(attempt);
      corrections.push(correction);
      if (attempt === 0) return "not json at all";
      return '```json\n{"suggestions": ["fixed"]}\n```';
    },
  });
  assert.deepEqual(prompts, [0, 1]);
  assert.equal(corrections[0], null);
  assert.match(corrections[1], /invalid JSON/);
  assert.equal(result.ok, true);
  assert.equal(result.retried, true);
  assert.deepEqual(result.data, { suggestions: ["fixed"] });
});

test("runStructuredOneshot: fails on every attempt — returns ok:false with the last raw text and errors", async () => {
  let calls = 0;
  const result = await runStructuredOneshot({
    schema: SIMPLE_SCHEMA,
    maxRetries: 1,
    invoke: async ({ attempt }) => {
      calls++;
      return `still not json (attempt ${attempt})`;
    },
  });
  assert.equal(calls, 2); // one original + exactly one retry
  assert.equal(result.ok, false);
  assert.equal(result.raw, "still not json (attempt 1)");
  assert.ok(result.errors.length > 0);
});

test("runStructuredOneshot: maxRetries:0 makes exactly one attempt, no retry even on failure", async () => {
  let calls = 0;
  const result = await runStructuredOneshot({
    schema: SIMPLE_SCHEMA,
    maxRetries: 0,
    invoke: async () => {
      calls++;
      return "nope";
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
});

test("runStructuredOneshot: invoke throwing (e.g. a config error) propagates rather than being swallowed", async () => {
  const err = new Error("no AI route configured");
  err.code = "NO_AI_ROUTE";
  await assert.rejects(
    runStructuredOneshot({
      schema: SIMPLE_SCHEMA,
      maxRetries: 1,
      invoke: async () => {
        throw err;
      },
    }),
    (thrown) => thrown === err
  );
});

test("runStructuredOneshot: throws a TypeError when invoke is not a function", async () => {
  await assert.rejects(
    runStructuredOneshot({ schema: SIMPLE_SCHEMA, invoke: null }),
    /invoke callback is required/
  );
});
