import assert from "node:assert/strict";
import { test } from "node:test";
import * as boundedAI from "../src/core/ai/bounded-ai.mjs";

const { BOUNDED_AI_CODES, BOUNDED_AI_MODES, extractAIText, requireBoundedAILabels, runBoundedAI } =
  boundedAI;

const LABELS = {
  skill: "discover-companies",
  action: "seed-generate",
  operation: "company-seeds",
};

const MANUAL = {
  available: true,
  reason: "manual-entry",
  action: "Enter suggestions manually.",
};

const SEED_SCHEMA = {
  type: "object",
  required: ["seeds"],
  additionalProperties: false,
  properties: {
    seeds: {
      type: "array",
      items: {
        type: "object",
        required: ["company", "reason"],
        additionalProperties: false,
        properties: {
          company: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
};

const ROOT = "/tmp/rolester-test-root";
const FORBIDDEN_CONTENT = [
  "PROMPT_SECRET_02_07",
  "RAW_MODEL_REPLY_02_07",
  "RESUME_SECRET_02_07",
  "JD_SECRET_02_07",
  "CANDIDATE_FACT_SECRET_02_07",
  "PAGE_BODY_SECRET_02_07",
];
const FORBIDDEN_TEXT = FORBIDDEN_CONTENT.join(" ");

function assertNoSensitiveFields(value) {
  const serialized = JSON.stringify(value);
  for (const field of ["raw", "prompt", "resume", "jd", "candidate", "bodyText", "body"]) {
    assert.doesNotMatch(serialized, new RegExp(`"${field}"\\s*:`));
  }
  for (const secret of FORBIDDEN_CONTENT) {
    assert.equal(serialized.includes(secret), false, `envelope leaked ${secret}`);
  }
}

test("extractAIText returns text from Anthropic-shaped content blocks", () => {
  assert.equal(typeof extractAIText, "function");
  assert.equal(
    extractAIText([
      { type: "tool_use", name: "ignored", input: {} },
      { type: "text", text: '{"seeds":[]}' },
      { type: "text", text: "\n" },
      { type: "text", text: '{"ignored":true}' },
    ]),
    '{"seeds":[]}\n{"ignored":true}'
  );
  assert.equal(extractAIText("already text"), "already text");
});

test("requireBoundedAILabels rejects missing or blank labels before invocation", async () => {
  const cases = [
    { name: "missing skill", labels: { action: "a", operation: "o" } },
    { name: "blank skill", labels: { skill: "", action: "a", operation: "o" } },
    { name: "whitespace skill", labels: { skill: " \n ", action: "a", operation: "o" } },
    { name: "missing action", labels: { skill: "s", operation: "o" } },
    { name: "blank action", labels: { skill: "s", action: "", operation: "o" } },
    { name: "whitespace action", labels: { skill: "s", action: " \t ", operation: "o" } },
    { name: "missing operation", labels: { skill: "s", action: "a" } },
    { name: "blank operation", labels: { skill: "s", action: "a", operation: "" } },
    { name: "whitespace operation", labels: { skill: "s", action: "a", operation: " \t " } },
  ];

  for (const { name, labels } of cases) {
    assert.throws(
      () => requireBoundedAILabels(labels),
      (err) => err?.code === BOUNDED_AI_CODES.AI_LABELS_INVALID,
      name
    );

    let invoked = false;
    const result = await runBoundedAI({
      labels,
      schema: SEED_SCHEMA,
      manual: MANUAL,
      invoke: async () => {
        invoked = true;
        return '```json\n{"seeds":[]}\n```';
      },
    });
    assert.equal(invoked, false, `${name}: invoke callback should not be called`);
    assert.equal(result.status, 400);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.code, BOUNDED_AI_CODES.AI_LABELS_INVALID);
    assert.equal(result.body.ai.used, false);
    assertNoSensitiveFields(result.body);

    let callInvoked = false;
    const nativeResult = await runBoundedAI({
      labels,
      schema: SEED_SCHEMA,
      manual: MANUAL,
      structuredMode: "native-preferred",
      call: async () => {
        callInvoked = true;
        return {
          content: [{ type: "text", text: '{"seeds":[]}' }],
          model: "claude-native-test",
        };
      },
      messages: [{ role: "user", content: "Suggest company seeds." }],
      root: ROOT,
    });
    assert.equal(callInvoked, false, `${name}: native call should not be called`);
    assert.equal(nativeResult.status, 400);
    assert.equal(nativeResult.body.code, BOUNDED_AI_CODES.AI_LABELS_INVALID);
    assert.equal(nativeResult.body.ai.used, false);
    assertNoSensitiveFields(nativeResult.body);
  }
});

test("runBoundedAI returns a success envelope with route data and non-sensitive AI metadata", async () => {
  const result = await runBoundedAI({
    labels: LABELS,
    schema: SEED_SCHEMA,
    manual: MANUAL,
    invoke: async ({ attempt, correction, labels }) => {
      assert.equal(attempt, 0);
      assert.equal(correction, null);
      assert.deepEqual(labels, LABELS);
      return {
        text: '```json\n{"seeds":[{"company":"Acme AI","reason":"agent workflow fit"}]}\n```',
        model: "claude-haiku-4-5",
      };
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    data: { seeds: [{ company: "Acme AI", reason: "agent workflow fit" }] },
    ai: {
      used: true,
      label: "discover-companies:seed-generate:company-seeds",
      skill: "discover-companies",
      action: "seed-generate",
      operation: "company-seeds",
      mode: BOUNDED_AI_MODES.fallback,
      retried: false,
      model: "claude-haiku-4-5",
    },
    manual: MANUAL,
  });
  assertNoSensitiveFields(result.body);
});

test("runBoundedAI native-preferred mode calls callAI with native output options and validates locally", async () => {
  const calls = [];
  const result = await runBoundedAI({
    labels: LABELS,
    schema: SEED_SCHEMA,
    manual: MANUAL,
    structuredMode: "native-preferred",
    call: async (options) => {
      calls.push(options);
      return {
        content: [
          {
            type: "text",
            text: '{"seeds":[{"company":"Native Labs","reason":"uses agent workflows"}]}',
          },
        ],
        model: "claude-native-test",
      };
    },
    messages: [{ role: "user", content: "Suggest company seeds." }],
    system: "Return company seed JSON.",
    model: "claude-sonnet-test",
    maxTokens: 512,
    outputName: "company_seed_response",
    root: ROOT,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    messages: [{ role: "user", content: "Suggest company seeds." }],
    system: "Return company seed JSON.",
    model: "claude-sonnet-test",
    maxTokens: 512,
    skill: LABELS.skill,
    action: LABELS.action,
    root: ROOT,
    outputMode: "native",
    outputSchema: SEED_SCHEMA,
    outputName: "company_seed_response",
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, {
    seeds: [{ company: "Native Labs", reason: "uses agent workflows" }],
  });
  assert.equal(result.body.ai.mode, "native");
  assert.equal(result.body.ai.model, "claude-native-test");
  assert.equal(result.body.ai.retried, false);
  assertNoSensitiveFields(result.body);
});

test("runBoundedAI maps parse and schema exhaustion to a safe 422 manual envelope", async () => {
  const seenCorrections = [];
  const result = await runBoundedAI({
    labels: LABELS,
    schema: SEED_SCHEMA,
    manual: MANUAL,
    maxRetries: 1,
    invoke: async ({ attempt, correction }) => {
      seenCorrections.push(correction);
      return `not json with prompt/resume/jd/candidate/bodyText details (attempt ${attempt})`;
    },
  });

  assert.equal(seenCorrections.length, 2);
  assert.equal(seenCorrections[0], null);
  assert.match(seenCorrections[1], /invalid JSON/);
  assert.equal(result.status, 422);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, BOUNDED_AI_CODES.AI_SCHEMA_INVALID);
  assert.equal(result.body.ai.used, true);
  assert.equal(result.body.ai.mode, BOUNDED_AI_MODES.fallback);
  assert.equal(result.body.ai.retried, true);
  assert.equal(result.body.manual.available, true);
  assertNoSensitiveFields(result.body);
});

test("runBoundedAI native-preferred mode locally rejects invalid native text after one retry", async () => {
  const calls = [];
  const result = await runBoundedAI({
    labels: LABELS,
    schema: SEED_SCHEMA,
    manual: MANUAL,
    structuredMode: "native-preferred",
    maxRetries: 1,
    call: async (options) => {
      calls.push(options);
      return {
        content: [
          {
            type: "text",
            text: `not json with prompt/resume/jd/candidate/bodyText details ${calls.length}`,
          },
        ],
        model: "claude-native-test",
      };
    },
    messages: [{ role: "user", content: "Suggest company seeds." }],
    model: "claude-sonnet-test",
    maxTokens: 512,
    outputName: "company_seed_response",
    root: ROOT,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].messages, [{ role: "user", content: "Suggest company seeds." }]);
  assert.match(calls[1].messages.at(-1).content, /invalid JSON/);
  assert.equal(result.status, 422);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, BOUNDED_AI_CODES.AI_SCHEMA_INVALID);
  assert.equal(result.body.ai.mode, "native");
  assert.equal(result.body.ai.retried, true);
  assert.equal(result.body.ai.model, "claude-native-test");
  assert.equal(result.body.manual.available, true);
  assertNoSensitiveFields(result.body);
});

test("runBoundedAI fallback structured mode uses invoke and does not call callAI", async () => {
  let invoked = false;
  let callInvoked = false;
  const result = await runBoundedAI({
    labels: LABELS,
    schema: SEED_SCHEMA,
    manual: MANUAL,
    structuredMode: "fallback",
    call: async () => {
      callInvoked = true;
      throw new Error("call should not be used in fallback mode");
    },
    invoke: async ({ attempt, correction, labels }) => {
      invoked = true;
      assert.equal(attempt, 0);
      assert.equal(correction, null);
      assert.deepEqual(labels, LABELS);
      return {
        text: '```json\n{"seeds":[{"company":"Fallback Co","reason":"custom route"}]}\n```',
        model: "claude-fallback-test",
      };
    },
  });

  assert.equal(invoked, true);
  assert.equal(callInvoked, false);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, {
    seeds: [{ company: "Fallback Co", reason: "custom route" }],
  });
  assert.equal(result.body.ai.mode, "fallback");
  assert.equal(result.body.ai.model, "claude-fallback-test");
  assertNoSensitiveFields(result.body);
});

test("runBoundedAI maps no-AI route errors to a 501 manual envelope without marking AI used", async () => {
  const err = new Error("no AI route configured: set ANTHROPIC_API_KEY");
  err.code = BOUNDED_AI_CODES.NO_AI_ROUTE;

  const result = await runBoundedAI({
    labels: LABELS,
    schema: SEED_SCHEMA,
    manual: MANUAL,
    invoke: async () => {
      throw err;
    },
  });

  assert.equal(result.status, 501);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, BOUNDED_AI_CODES.NO_AI_ROUTE);
  assert.equal(result.body.ai.used, false);
  assert.equal(result.body.manual.available, true);
  assertNoSensitiveFields(result.body);
});

test("runBoundedAI maps generic provider errors to a safe 502 manual envelope", async () => {
  const result = await runBoundedAI({
    labels: LABELS,
    schema: SEED_SCHEMA,
    manual: MANUAL,
    invoke: async () => {
      throw new Error("upstream leaked raw prompt and resume text");
    },
  });

  assert.equal(result.status, 502);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, BOUNDED_AI_CODES.AI_PROVIDER_FAILED);
  assert.equal(result.body.ai.used, true);
  assert.equal(result.body.manual.available, true);
  assertNoSensitiveFields(result.body);
});

test("runBoundedAI failure envelopes omit raw prompts, model text, and sensitive source content", async () => {
  const schemaResult = await runBoundedAI({
    labels: LABELS,
    schema: SEED_SCHEMA,
    manual: MANUAL,
    maxRetries: 1,
    invoke: async () => `not json ${FORBIDDEN_TEXT}`,
  });
  assert.equal(schemaResult.status, 422);
  assert.equal(schemaResult.body.code, BOUNDED_AI_CODES.AI_SCHEMA_INVALID);
  assertNoSensitiveFields(schemaResult.body);

  const noAiError = new Error(`no AI route configured ${FORBIDDEN_TEXT}`);
  noAiError.code = BOUNDED_AI_CODES.NO_AI_ROUTE;
  const noAiResult = await runBoundedAI({
    labels: LABELS,
    schema: SEED_SCHEMA,
    manual: MANUAL,
    invoke: async () => {
      throw noAiError;
    },
  });
  assert.equal(noAiResult.status, 501);
  assert.equal(noAiResult.body.code, BOUNDED_AI_CODES.NO_AI_ROUTE);
  assertNoSensitiveFields(noAiResult.body);

  const providerResult = await runBoundedAI({
    labels: LABELS,
    schema: SEED_SCHEMA,
    manual: MANUAL,
    invoke: async () => {
      throw new Error(`provider echoed ${FORBIDDEN_TEXT}`);
    },
  });
  assert.equal(providerResult.status, 502);
  assert.equal(providerResult.body.code, BOUNDED_AI_CODES.AI_PROVIDER_FAILED);
  assertNoSensitiveFields(providerResult.body);
});

test("runBoundedAI native-preferred mode maps provider failures to a safe 502 manual envelope", async () => {
  const result = await runBoundedAI({
    labels: LABELS,
    schema: SEED_SCHEMA,
    manual: MANUAL,
    structuredMode: "native-preferred",
    call: async () => {
      throw new Error("provider leaked raw prompt and resume text");
    },
    messages: [{ role: "user", content: "Suggest company seeds." }],
    model: "claude-sonnet-test",
    maxTokens: 512,
    root: ROOT,
  });

  assert.equal(result.status, 502);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, BOUNDED_AI_CODES.AI_PROVIDER_FAILED);
  assert.equal(result.body.ai.used, true);
  assert.equal(result.body.ai.mode, "native");
  assert.equal(result.body.manual.available, true);
  assertNoSensitiveFields(result.body);
});
