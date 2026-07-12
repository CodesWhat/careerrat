import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyNonStreamUsage,
  applySSEUsageEvent,
  authenticate,
  buildCapExceededBody,
  buildResponseHeaders,
  buildTokenEntries,
  buildUpstreamHeaders,
  buildUsageRow,
  newUsageAccumulator,
  parseProxyTokensEnv,
  parseUpstreamHeadersEnv,
  parseUserCapsEnv,
  parseUserCapUsdEnv,
  reportingUserId,
  resolveUserCap,
} from "../src/cli/proxy-core.mjs";

test("authenticate accepts the map + legacy token union in Bearer and x-api-key forms", () => {
  const entries = buildTokenEntries(" legacy-token ", {
    alice: " alice-token ",
    empty: " ",
  });
  assert.deepEqual(entries, [
    { label: "default", token: "legacy-token" },
    { label: "alice", token: "alice-token" },
  ]);
  assert.deepEqual(authenticate({ authorization: "Bearer legacy-token" }, entries), {
    label: "default",
    token: "legacy-token",
  });
  assert.deepEqual(authenticate({ "x-api-key": "alice-token" }, entries), {
    label: "alice",
    token: "alice-token",
  });
  assert.equal(authenticate({}, entries), null);
  assert.equal(authenticate({ authorization: "Bearer wrong" }, entries), null);
  assert.equal(authenticate({ "x-api-key": "wrong" }, entries), null);
});

test("header pipeline strips transport, auth, and Rolester labels and gates attribution", () => {
  const inbound = {
    authorization: "Bearer caller-secret",
    "x-api-key": "caller-api-key",
    host: "proxy.test",
    connection: "keep-alive",
    "content-length": "123",
    "transfer-encoding": "chunked",
    "x-rolester-skill": "evaluate-job",
    "x-rolester-action": "gate",
    "x-safe": "kept",
  };
  const off = buildUpstreamHeaders(inbound, "fake-upstream-key", {}, { env: {} });
  assert.deepEqual(off, {
    "x-safe": "kept",
    "x-api-key": "fake-upstream-key",
    "anthropic-version": "2023-06-01",
  });
  const on = buildUpstreamHeaders(
    inbound,
    "fake-upstream-key",
    {},
    {
      env: { ROLESTER_UPSTREAM_REPORTING: "1" },
    }
  );
  assert.equal(on["ai-reporting-user"], reportingUserId("caller-secret"));
  assert.equal(on["ai-reporting-tags"], "skill:evaluate-job,action:gate");
  assert.match(on["ai-reporting-user"], /^[0-9a-f]{12}$/);
  assert.equal(reportingUserId("caller-secret"), reportingUserId("caller-secret"));

  const response = buildResponseHeaders(
    new Headers({
      connection: "close",
      "content-length": "9",
      "content-encoding": "gzip",
      "x-ok": "yes",
    })
  );
  assert.deepEqual(response, { "x-ok": "yes" });
});

test("cap resolution honors overrides, global fallback, and absent/disabled values", () => {
  assert.equal(resolveUserCap({ label: "alice", globalUserCap: 10, userCaps: { alice: 2 } }), 2);
  assert.equal(resolveUserCap({ label: "bob", globalUserCap: 10, userCaps: { alice: 2 } }), 10);
  assert.equal(resolveUserCap({ label: "alice", globalUserCap: 10, userCaps: { alice: 0 } }), null);
  assert.equal(resolveUserCap({ label: "bob", globalUserCap: null }), null);
  assert.deepEqual(buildCapExceededBody(), {
    type: "error",
    error: {
      type: "cap_exceeded",
      message:
        "This beta account has reached its usage cap. Contact the person who invited you to raise it.",
    },
  });
});

test("usage parsing accumulates SSE events and parses a non-stream response", () => {
  const sse = newUsageAccumulator();
  applySSEUsageEvent(sse, {
    type: "message_start",
    message: {
      model: "claude-test-sse",
      usage: {
        input_tokens: 11,
        output_tokens: 1,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      },
    },
  });
  applySSEUsageEvent(sse, { type: "message_delta", usage: { output_tokens: 7 } });
  assert.deepEqual(sse, {
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    },
    modelSeen: "claude-test-sse",
    sawUsage: true,
  });

  const plain = newUsageAccumulator();
  applyNonStreamUsage(plain, {
    model: "claude-test-json",
    usage: {
      input_tokens: 20,
      output_tokens: 8,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    },
  });
  assert.equal(plain.modelSeen, "claude-test-json");
  assert.deepEqual(plain.usage, {
    input_tokens: 20,
    output_tokens: 8,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1,
  });
});

test("buildUsageRow emits exactly the canonical pre-canonicalization allowlist", () => {
  const row = buildUsageRow({
    model: "claude-test",
    feature: "feature",
    skill: "skill",
    action: "action",
    operation: "operation",
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    },
    user: "abc123def456",
    userLabel: "alice",
    upstreamHost: "upstream.test",
  });
  assert.deepEqual(Object.keys(row), [
    "source",
    "feature",
    "skill",
    "action",
    "operation",
    "model",
    "upstream",
    "user",
    "userLabel",
    "tokens_in",
    "tokens_out",
    "cache_read_tokens",
    "cache_creation_tokens",
  ]);
  assert.equal(JSON.stringify(row).includes("content"), false);
});

test("parse env helpers accept valid JSON, return empty values for malformed/empty input, and never throw", () => {
  let errors = 0;
  const opts = { onError: () => errors++ };
  assert.deepEqual(parseUpstreamHeadersEnv('{"x-test":"yes"}', opts), { "x-test": "yes" });
  assert.deepEqual(parseProxyTokensEnv('{"alice":" token ","empty":""}', opts), { alice: "token" });
  assert.deepEqual(parseUserCapsEnv('{"alice":"2.5","zero":0,"bad":"x"}', opts), { alice: 2.5 });
  assert.deepEqual(parseUpstreamHeadersEnv("{bad", opts), {});
  assert.deepEqual(parseProxyTokensEnv("[1,2]", opts), {});
  assert.deepEqual(parseUserCapsEnv(undefined, opts), {});
  assert.deepEqual(parseUpstreamHeadersEnv("", opts), {});
  assert.equal(errors, 1);
  assert.equal(parseUserCapUsdEnv("3.25"), 3.25);
  assert.equal(parseUserCapUsdEnv("0"), null);
  assert.equal(parseUserCapUsdEnv("bad"), null);
  assert.equal(parseUserCapUsdEnv(undefined), null);
});
