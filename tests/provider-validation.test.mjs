import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAnthropicApiKeyShape,
  validateAiProviderKey,
  validateAnthropicApiKey,
} from "../src/core/ai/provider-validation.mjs";

test("isAnthropicApiKeyShape accepts only sk-ant keys without whitespace", () => {
  assert.equal(isAnthropicApiKeyShape("sk-ant-valid-looking-key-123456"), true);
  assert.equal(isAnthropicApiKeyShape("sk-ant has spaces"), false);
  assert.equal(isAnthropicApiKeyShape("sk-openai-valid-looking-key-123456"), false);
  assert.equal(isAnthropicApiKeyShape(""), false);
});

test("validateAnthropicApiKey checks Anthropic models with key headers", async () => {
  const calls = [];
  const result = await validateAnthropicApiKey({
    apiKey: "sk-ant-valid-looking-key-123456",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "anthropic");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/models?limit=1");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers["x-api-key"], "sk-ant-valid-looking-key-123456");
  assert.equal(calls[0].options.headers["anthropic-version"], "2023-06-01");
});

test("validateAnthropicApiKey maps authentication failures without echoing the key", async () => {
  const result = await validateAnthropicApiKey({
    apiKey: "sk-ant-invalid-looking-key-123456",
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { type: "authentication_error" } }), { status: 401 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, "authentication_error");
  assert.equal(JSON.stringify(result).includes("sk-ant-invalid-looking-key-123456"), false);
});

test("validateAiProviderKey rejects unsupported providers before fetch", async () => {
  let called = false;
  const result = await validateAiProviderKey({
    provider: "openai",
    apiKey: "sk-ant-valid-looking-key-123456",
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "unsupported_provider");
  assert.equal(called, false);
});
