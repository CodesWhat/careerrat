// tests/call-ai.test.mjs
// node:test suite for callAI()'s BYOK-first routing (call-ai.mjs).
//
// A mock "Anthropic-shaped" upstream (plain node:http) stands in for both the
// real Anthropic API (BYOK path) and the managed-AI proxy (proxy path) — the
// test just points CAREERRAT_ANTHROPIC_BASE_URL / CAREERRAT_AI_PROXY_URL at it
// and inspects what callAI() actually sent. Hermetic: ephemeral port, temp
// dirs for the usage log, no network.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SMALL_FAST_MODEL } from "../src/core/ai/ai-config.mjs";
import {
  callAI,
  extractSSEEvents,
  resolveAIRoute,
  sanitizeNativeOutputSchema,
} from "../src/core/ai/call-ai.mjs";
import { writeInstalledRuntimeSelection } from "../src/core/ai/runtime-selection.mjs";
import { readUsageEvents } from "../src/core/ai/usage-log.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "careerrat-call-ai-"));
}

const NON_STREAM_BODY = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "hello RAW_MODEL_REPLY_02_07" }],
  model: "claude-haiku-4-5",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 25,
    output_tokens: 12,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 10,
  },
};

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["verdict", "confidence"],
};

test("sanitizeNativeOutputSchema closes permissive nested objects for Anthropic", () => {
  const sanitized = sanitizeNativeOutputSchema({
    type: "object",
    properties: {
      entities: {
        type: "object",
        additionalProperties: true,
        properties: { company: { type: ["string", "null"] } },
      },
    },
  });

  assert.equal(sanitized.additionalProperties, false);
  assert.equal(sanitized.properties.entities.additionalProperties, false);
});

const ALLOWED_USAGE_KEYS = [
  "id",
  "at",
  "source",
  "feature",
  "skill",
  "action",
  "operation",
  "model",
  "upstream",
  "tokens_in",
  "tokens_out",
  "cache_read_tokens",
  "cache_creation_tokens",
  "web_searches",
  "shared_cache_hit",
  "cost_usd",
  "priced",
  "user",
  "userLabel",
];
const FORBIDDEN_USAGE_KEYS = [
  "prompt",
  "body",
  "requestBody",
  "responseBody",
  "raw",
  "rawText",
  "content",
  "messages",
  "outputSchema",
  "schema",
];
const FORBIDDEN_CONTENT = [
  "PROMPT_SECRET_02_07",
  "RAW_MODEL_REPLY_02_07",
  "RESUME_SECRET_02_07",
  "JD_SECRET_02_07",
  "CANDIDATE_FACT_SECRET_02_07",
  "PAGE_BODY_SECRET_02_07",
];

function assertUsageEventIsMetadataOnly(event) {
  assert.deepEqual(Object.keys(event).sort(), [...ALLOWED_USAGE_KEYS].sort());
  for (const key of FORBIDDEN_USAGE_KEYS) {
    assert.equal(Object.hasOwn(event, key), false, `usage row leaked key ${key}`);
  }
  const serialized = JSON.stringify(event);
  for (const secret of FORBIDDEN_CONTENT) {
    assert.equal(serialized.includes(secret), false, `usage row leaked ${secret}`);
  }
}

function sseFixture(model) {
  const events = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 25,
            output_tokens: 1,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 10,
          },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 12 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

// Records every request's headers+body, replies JSON or SSE depending on the
// request body's `stream` flag — good enough to stand in for either Anthropic
// itself (BYOK) or the proxy (proxy path), since both hit the same shape.
function startMockUpstream({ status = 200, responseBody = null } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let parsed = {};
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        /* ignore */
      }
      requests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: parsed,
      });

      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(responseBody));
      } else if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseFixture(parsed.model));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ...NON_STREAM_BODY, model: parsed.model || NON_STREAM_BODY.model })
        );
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, requests, url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

// ---------------------------------------------------------------------------
// resolveAIRoute
// ---------------------------------------------------------------------------

test("resolveAIRoute: BYOK wins when ANTHROPIC_API_KEY is set", () => {
  const route = resolveAIRoute({
    ANTHROPIC_API_KEY: "sk-ant-test",
    CAREERRAT_AI_PROXY_URL: "http://proxy",
  });
  assert.equal(route.type, "byok");
  assert.equal(route.apiKey, "sk-ant-test");
  assert.equal(route.baseUrl, "https://api.anthropic.com");
});

test("resolveAIRoute: falls back to the proxy when no API key is set", () => {
  const route = resolveAIRoute({
    CAREERRAT_AI_PROXY_URL: "http://127.0.0.1:7788",
    CAREERRAT_AI_PROXY_TOKEN: "tok",
  });
  assert.equal(route.type, "proxy");
  assert.equal(route.baseUrl, "http://127.0.0.1:7788");
  assert.equal(route.token, "tok");
});

test("resolveAIRoute: neither set -> an actionable error naming both options", () => {
  const route = resolveAIRoute({});
  assert.equal(route.type, "none");
  assert.match(route.error, /ANTHROPIC_API_KEY/);
  assert.match(route.error, /CAREERRAT_AI_PROXY_URL/);
});

test("resolveAIRoute: selected installed CLI wins in desktop even when a provider key exists", () => {
  const root = tempRoot();
  try {
    writeInstalledRuntimeSelection({ repoRoot: root, env: {}, runtimeId: "codex" });
    const route = resolveAIRoute(
      { CAREERRAT_DESKTOP_SHELL: "1", ANTHROPIC_API_KEY: "sk-ant-test" },
      {
        repoRoot: root,
        runtimeInventory: [{ id: "codex", name: "Codex", path: "/safe/codex", available: true }],
      }
    );
    assert.equal(route.type, "installed");
    assert.equal(route.runtime.id, "codex");
    assert.equal(route.runtime.path, "/safe/codex");
    assert.equal(Object.hasOwn(route, "apiKey"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAIRoute: explicit Advanced provider fallback retains BYOK", () => {
  const root = tempRoot();
  try {
    writeInstalledRuntimeSelection({
      repoRoot: root,
      env: {},
      runtimeId: null,
      providerFallback: true,
    });
    const route = resolveAIRoute(
      { CAREERRAT_DESKTOP_SHELL: "1", ANTHROPIC_API_KEY: "sk-ant-test" },
      {
        repoRoot: root,
        runtimeInventory: [{ id: "codex", name: "Codex", path: "/safe/codex", available: true }],
      }
    );
    assert.equal(route.type, "byok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("callAI: throws the resolveAIRoute error when no route is configured", async () => {
  await assert.rejects(
    () => callAI({ model: "claude-haiku-4-5", messages: [], maxTokens: 8, env: {} }),
    /no AI route configured/
  );
});

test("callAI: routes a structured request through the selected CLI without a provider key", async () => {
  const root = tempRoot();
  try {
    writeInstalledRuntimeSelection({ repoRoot: root, env: {}, runtimeId: "codex" });
    const calls = [];
    const result = await callAI({
      messages: [{ role: "user", content: "PROMPT_SECRET_02_07" }],
      system: "Return a verdict.",
      maxTokens: 32,
      outputSchema: OUTPUT_SCHEMA,
      outputMode: "native",
      root,
      env: { CAREERRAT_DESKTOP_SHELL: "1" },
      runtimeInventory: [{ id: "codex", name: "Codex", path: "/safe/codex", available: true }],
      runInstalledRuntimeImpl: async (input) => {
        calls.push(input);
        return {
          text: '{"verdict":"keep","confidence":0.9}',
          runtimeId: "codex",
          usage: { input_tokens: 5, output_tokens: 3 },
        };
      },
    });
    assert.equal(result.content[0].text, '{"verdict":"keep","confidence":0.9}');
    assert.equal(result.model, "installed:codex");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].runtime.id, "codex");
    assert.match(calls[0].prompt, /PROMPT_SECRET_02_07/);
    assert.deepEqual(calls[0].outputSchema, OUTPUT_SCHEMA);
    assert.equal(calls[0].model, undefined);
    const events = readUsageEvents({ root });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "installed");
    assert.equal(JSON.stringify(events[0]).includes("PROMPT_SECRET_02_07"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Installed-CLI model tiering — runInstalledAI() must resolve `model`/`tier`
// the same way the non-installed branch does (config/ai.json#smallFastModel
// for tier: "smallFast"), threading the result through
// buildInstalledRuntimeInvocation's existing per-call `--model` flag, rather
// than pinning every installed call to CAREERRAT_INSTALLED_AI_MODEL.
// ---------------------------------------------------------------------------

test("callAI (installed): an explicit model always wins", async () => {
  const root = tempRoot();
  try {
    writeInstalledRuntimeSelection({ repoRoot: root, env: {}, runtimeId: "codex" });
    const calls = [];
    await callAI({
      model: "explicit-model",
      tier: "smallFast",
      messages: [{ role: "user", content: "hi" }],
      root,
      env: { CAREERRAT_DESKTOP_SHELL: "1", CAREERRAT_INSTALLED_AI_MODEL: "base-default" },
      runtimeInventory: [{ id: "codex", name: "Codex", path: "/safe/codex", available: true }],
      runInstalledRuntimeImpl: async (input) => {
        calls.push(input);
        return { text: "ok", runtimeId: "codex", usage: null };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, "explicit-model");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("callAI (installed): tier smallFast on the claude runtime resolves config/ai.json#smallFastModel, not the env base default", async () => {
  const root = tempRoot();
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "ai.json"),
    JSON.stringify({ smallFastModel: "configured-small-fast" }),
    "utf8"
  );
  try {
    writeInstalledRuntimeSelection({ repoRoot: root, env: {}, runtimeId: "claude" });
    const calls = [];
    await callAI({
      tier: "smallFast",
      messages: [{ role: "user", content: "hi" }],
      root,
      env: { CAREERRAT_DESKTOP_SHELL: "1", CAREERRAT_INSTALLED_AI_MODEL: "base-default" },
      runtimeInventory: [{ id: "claude", name: "Claude", path: "/safe/claude", available: true }],
      runInstalledRuntimeImpl: async (input) => {
        calls.push(input);
        return { text: "ok", runtimeId: "claude", usage: null };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, "configured-small-fast");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("callAI (installed): tier smallFast on the claude runtime with no config file falls back to the shipped small-fast default", async () => {
  const root = tempRoot();
  try {
    writeInstalledRuntimeSelection({ repoRoot: root, env: {}, runtimeId: "claude" });
    const calls = [];
    await callAI({
      tier: "smallFast",
      messages: [{ role: "user", content: "hi" }],
      root,
      env: { CAREERRAT_DESKTOP_SHELL: "1" },
      runtimeInventory: [{ id: "claude", name: "Claude", path: "/safe/claude", available: true }],
      runInstalledRuntimeImpl: async (input) => {
        calls.push(input);
        return { text: "ok", runtimeId: "claude", usage: null };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, DEFAULT_SMALL_FAST_MODEL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("callAI (installed): tier smallFast on a non-claude runtime ignores the Anthropic-shaped smallFastModel config", async () => {
  const root = tempRoot();
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "ai.json"),
    JSON.stringify({ smallFastModel: "configured-small-fast" }),
    "utf8"
  );
  try {
    writeInstalledRuntimeSelection({ repoRoot: root, env: {}, runtimeId: "codex" });
    const calls = [];
    await callAI({
      tier: "smallFast",
      messages: [{ role: "user", content: "hi" }],
      root,
      env: { CAREERRAT_DESKTOP_SHELL: "1", CAREERRAT_INSTALLED_AI_MODEL: "base-default" },
      runtimeInventory: [{ id: "codex", name: "Codex", path: "/safe/codex", available: true }],
      runInstalledRuntimeImpl: async (input) => {
        calls.push(input);
        return { text: "ok", runtimeId: "codex", usage: null };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, "base-default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("callAI (installed): tier smallFast on a non-claude runtime with no base default omits --model entirely", async () => {
  const root = tempRoot();
  try {
    writeInstalledRuntimeSelection({ repoRoot: root, env: {}, runtimeId: "codex" });
    const calls = [];
    await callAI({
      tier: "smallFast",
      messages: [{ role: "user", content: "hi" }],
      root,
      env: { CAREERRAT_DESKTOP_SHELL: "1" },
      runtimeInventory: [{ id: "codex", name: "Codex", path: "/safe/codex", available: true }],
      runInstalledRuntimeImpl: async (input) => {
        calls.push(input);
        return { text: "ok", runtimeId: "codex", usage: null };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("callAI (installed): no model/tier falls back to CAREERRAT_INSTALLED_AI_MODEL, the installed path's own base default", async () => {
  const root = tempRoot();
  try {
    writeInstalledRuntimeSelection({ repoRoot: root, env: {}, runtimeId: "codex" });
    const calls = [];
    await callAI({
      messages: [{ role: "user", content: "hi" }],
      root,
      env: { CAREERRAT_DESKTOP_SHELL: "1", CAREERRAT_INSTALLED_AI_MODEL: "base-default" },
      runtimeInventory: [{ id: "codex", name: "Codex", path: "/safe/codex", available: true }],
      runInstalledRuntimeImpl: async (input) => {
        calls.push(input);
        return { text: "ok", runtimeId: "codex", usage: null };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, "base-default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("callAI: maps proxy cap responses to a friendly non-retryable AI_CAP_EXCEEDED error", async () => {
  const upstream = await startMockUpstream({
    status: 402,
    responseBody: {
      type: "error",
      error: {
        type: "cap_exceeded",
        message:
          "This beta account has reached its usage cap. Contact the person who invited you to raise it.",
      },
    },
  });
  try {
    await assert.rejects(
      () =>
        callAI({
          model: "claude-haiku-4-5",
          messages: [],
          maxTokens: 8,
          env: { CAREERRAT_AI_PROXY_URL: upstream.url, CAREERRAT_AI_PROXY_TOKEN: "fake-token" },
        }),
      (err) => {
        assert.equal(err.code, "AI_CAP_EXCEEDED");
        assert.equal(err.retryable, false);
        assert.match(err.message, /reached its usage cap/i);
        return true;
      }
    );
  } finally {
    upstream.close();
  }
});

test("callAI: non-cap proxy errors retain the generic failure behavior", async () => {
  const upstream = await startMockUpstream({
    status: 402,
    responseBody: { type: "error", error: { type: "payment_required", message: "generic" } },
  });
  try {
    await assert.rejects(
      () =>
        callAI({
          model: "claude-haiku-4-5",
          messages: [],
          maxTokens: 8,
          env: { CAREERRAT_AI_PROXY_URL: upstream.url, CAREERRAT_AI_PROXY_TOKEN: "fake-token" },
        }),
      (err) => {
        assert.equal(err.code, undefined);
        assert.match(err.message, /AI request failed: 402/);
        return true;
      }
    );
  } finally {
    upstream.close();
  }
});

// ---------------------------------------------------------------------------
// BYOK path
// ---------------------------------------------------------------------------

test("callAI (BYOK, non-stream): hits the mock Anthropic base URL with x-api-key, returns raw usage", async () => {
  const upstream = await startMockUpstream();
  try {
    const result = await callAI({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
      env: { ANTHROPIC_API_KEY: "sk-ant-test", CAREERRAT_ANTHROPIC_BASE_URL: upstream.url },
    });
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.usage.input_tokens, 25);
    assert.equal(result.usage.output_tokens, 12);

    assert.equal(upstream.requests.length, 1);
    const [req] = upstream.requests;
    assert.equal(req.url, "/v1/messages");
    assert.equal(req.headers["x-api-key"], "sk-ant-test");
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    assert.equal(req.headers.authorization, undefined);
  } finally {
    upstream.close();
  }
});

test("callAI (BYOK, native output): sends Anthropic json_schema output_config", async () => {
  const upstream = await startMockUpstream();
  try {
    await callAI({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "classify" }],
      maxTokens: 16,
      outputMode: "native",
      effort: "low",
      outputName: "classification",
      outputSchema: OUTPUT_SCHEMA,
      skill: "discover-companies",
      action: "seed-generate",
      env: { ANTHROPIC_API_KEY: "sk-ant-test", CAREERRAT_ANTHROPIC_BASE_URL: upstream.url },
    });

    assert.equal(upstream.requests.length, 1);
    const [req] = upstream.requests;
    assert.equal(req.headers["x-api-key"], "sk-ant-test");
    assert.equal(req.body.output_config.effort, "low");
    assert.equal(req.body.output_config.format.type, "json_schema");
    // format.name is never sent natively — the Anthropic API 400s on it
    // ("Extra inputs are not permitted"); outputName only matters to the
    // tool-based fallback mode. See src/core/ai/call-ai.mjs buildRequest().
    assert.equal(Object.hasOwn(req.body.output_config.format, "name"), false);
    assert.deepEqual(req.body.output_config.format.schema, OUTPUT_SCHEMA);
  } finally {
    upstream.close();
  }
});

test("callAI (BYOK, native output): usage rows preserve labels and metadata-only keys", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  try {
    await callAI({
      model: "claude-haiku-4-5",
      messages: [
        {
          role: "user",
          content:
            "classify PROMPT_SECRET_02_07 RESUME_SECRET_02_07 JD_SECRET_02_07 " +
            "CANDIDATE_FACT_SECRET_02_07 PAGE_BODY_SECRET_02_07",
        },
      ],
      maxTokens: 16,
      outputMode: "native",
      outputName: "classification",
      outputSchema: OUTPUT_SCHEMA,
      feature: "company-discovery",
      skill: "discover-companies",
      action: "seed-generate",
      operation: "company-seeds",
      root,
      env: { ANTHROPIC_API_KEY: "sk-ant-test", CAREERRAT_ANTHROPIC_BASE_URL: upstream.url },
    });

    const events = readUsageEvents({ root });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "byok");
    assert.equal(events[0].feature, "company-discovery");
    assert.equal(events[0].skill, "discover-companies");
    assert.equal(events[0].action, "seed-generate");
    assert.equal(events[0].operation, "company-seeds");
    assert.equal(events[0].model, "claude-haiku-4-5");
    assertUsageEventIsMetadataOnly(events[0]);
  } finally {
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("callAI (BYOK, non-native): omits output_config when no outputSchema is provided", async () => {
  const upstream = await startMockUpstream();
  try {
    await callAI({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
      outputMode: "native",
      env: { ANTHROPIC_API_KEY: "sk-ant-test", CAREERRAT_ANTHROPIC_BASE_URL: upstream.url },
    });

    assert.equal(upstream.requests.length, 1);
    assert.equal(Object.hasOwn(upstream.requests[0].body, "output_config"), false);
  } finally {
    upstream.close();
  }
});

test("callAI (BYOK, non-stream): appends a usage_event when root is given", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  try {
    await callAI({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
      feature: "application-tailoring",
      skill: "apply-job",
      action: "tailor",
      operation: "packet.generate",
      root,
      env: { ANTHROPIC_API_KEY: "sk-ant-test", CAREERRAT_ANTHROPIC_BASE_URL: upstream.url },
    });
    const events = readUsageEvents({ root });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "byok");
    assert.equal(events[0].feature, "application-tailoring");
    assert.equal(events[0].skill, "apply-job");
    assert.equal(events[0].action, "tailor");
    assert.equal(events[0].operation, "packet.generate");
    assert.equal(events[0].tokens_in, 25);
    assert.equal(events[0].tokens_out, 12);
    assert.equal(events[0].cache_read_tokens, 10);
    assert.equal(events[0].cache_creation_tokens, 5);
    assert.equal(events[0].upstream, new URL(upstream.url).host); // cost-drift visibility
  } finally {
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("callAI: falls back to config/ai.json#model when the caller passes no model", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "ai.json"),
    JSON.stringify({ model: "claude-sonnet-5" }),
    "utf8"
  );
  try {
    await callAI({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
      root,
      env: { ANTHROPIC_API_KEY: "sk-ant-test", CAREERRAT_ANTHROPIC_BASE_URL: upstream.url },
    });
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0].body.model, "claude-sonnet-5");
  } finally {
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("callAI: an explicit model always wins over config/ai.json", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "ai.json"),
    JSON.stringify({ model: "claude-sonnet-5" }),
    "utf8"
  );
  try {
    await callAI({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
      root,
      env: { ANTHROPIC_API_KEY: "sk-ant-test", CAREERRAT_ANTHROPIC_BASE_URL: upstream.url },
    });
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0].body.model, "claude-opus-4-8");
  } finally {
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("callAI (BYOK, stream): yields raw SSE events and appends a usage_event on completion", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  try {
    const iterator = await callAI({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
      stream: true,
      root,
      env: { ANTHROPIC_API_KEY: "sk-ant-test", CAREERRAT_ANTHROPIC_BASE_URL: upstream.url },
    });
    const events = [];
    for await (const event of iterator) events.push(event);
    assert.equal(events[0].type, "message_start");
    assert.equal(events.at(-1).type, "message_stop");

    const usageEvents = readUsageEvents({ root });
    assert.equal(usageEvents.length, 1);
    assert.equal(usageEvents[0].tokens_in, 25);
    assert.equal(usageEvents[0].tokens_out, 12);
    assert.equal(usageEvents[0].cache_read_tokens, 10);
    assert.equal(usageEvents[0].cache_creation_tokens, 5);
    assert.equal(usageEvents[0].upstream, new URL(upstream.url).host);
  } finally {
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Proxy path
// ---------------------------------------------------------------------------

test("callAI (proxy path): sends Bearer token + x-careerrat-* labels, never appends client-side", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  try {
    await callAI({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
      feature: "application-tailoring",
      skill: "apply-job",
      action: "tailor",
      operation: "packet.generate",
      root,
      env: { CAREERRAT_AI_PROXY_URL: upstream.url, CAREERRAT_AI_PROXY_TOKEN: "proxy-tok" },
    });
    assert.equal(upstream.requests.length, 1);
    const [req] = upstream.requests;
    assert.equal(req.headers.authorization, "Bearer proxy-tok");
    assert.equal(req.headers["x-careerrat-feature"], "application-tailoring");
    assert.equal(req.headers["x-careerrat-skill"], "apply-job");
    assert.equal(req.headers["x-careerrat-action"], "tailor");
    assert.equal(req.headers["x-careerrat-operation"], "packet.generate");
    assert.equal(req.headers["x-api-key"], undefined);

    // The proxy is the one that meters — callAI must not also write client-side.
    const events = readUsageEvents({ root });
    assert.equal(events.length, 0);
  } finally {
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("callAI (proxy path, native output): forwards json_schema body plus auth and labels", async () => {
  const upstream = await startMockUpstream();
  const root = tempRoot();
  try {
    await callAI({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "classify" }],
      maxTokens: 16,
      outputMode: "native",
      outputName: "classification",
      outputSchema: OUTPUT_SCHEMA,
      feature: "company-discovery",
      skill: "discover-companies",
      action: "seed-generate",
      operation: "company-seeds",
      root,
      env: { CAREERRAT_AI_PROXY_URL: upstream.url, CAREERRAT_AI_PROXY_TOKEN: "proxy-tok" },
    });

    assert.equal(upstream.requests.length, 1);
    const [req] = upstream.requests;
    assert.equal(req.headers.authorization, "Bearer proxy-tok");
    assert.equal(req.headers["x-careerrat-feature"], "company-discovery");
    assert.equal(req.headers["x-careerrat-skill"], "discover-companies");
    assert.equal(req.headers["x-careerrat-action"], "seed-generate");
    assert.equal(req.headers["x-careerrat-operation"], "company-seeds");
    assert.equal(req.body.output_config.format.type, "json_schema");
    // format.name is never sent natively — see the BYOK native-output test above.
    assert.equal(Object.hasOwn(req.body.output_config.format, "name"), false);
    assert.deepEqual(req.body.output_config.format.schema, OUTPUT_SCHEMA);

    const events = readUsageEvents({ root });
    assert.equal(events.length, 0);
  } finally {
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// extractSSEEvents — pure chunk-boundary parser shared with ai-proxy.mjs's tee
// ---------------------------------------------------------------------------

test("extractSSEEvents: parses complete events and carries a partial one forward across a chunk split", () => {
  const full = sseFixture("claude-haiku-4-5");
  const cut = full.length - 30; // split mid-event, near the tail
  const first = extractSSEEvents(full.slice(0, cut));
  assert.ok(first.events.length >= 5);
  assert.ok(first.remainder.length > 0);

  const second = extractSSEEvents(first.remainder + full.slice(cut));
  assert.equal(second.events.at(-1).type, "message_stop");
});

test("extractSSEEvents: skips the [DONE] sentinel and malformed payloads", () => {
  const buffer = 'data: [DONE]\n\ndata: {not json\n\ndata: {"type":"message_stop"}\n\n';
  const { events } = extractSSEEvents(buffer);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "message_stop");
});
