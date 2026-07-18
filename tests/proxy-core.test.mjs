import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  hashProxyToken,
  looksLikeMintedToken,
  mintProxyToken,
  newUsageAccumulator,
  parseProxyTokensEnv,
  parseUpstreamHeadersEnv,
  parseUserCapsEnv,
  parseUserCapUsdEnv,
  reportingUserId,
  reportingUserIdForClerk,
  resolveUserCap,
} from "../src/cli/proxy-core.mjs";

test("authenticate accepts the map + legacy token union in Bearer and x-api-key forms", async () => {
  const entries = buildTokenEntries(" legacy-token ", {
    alice: " alice-token ",
    empty: " ",
  });
  assert.deepEqual(entries, [
    { label: "default", token: "legacy-token" },
    { label: "alice", token: "alice-token" },
  ]);
  assert.deepEqual(await authenticate({ authorization: "Bearer legacy-token" }, entries), {
    label: "default",
    token: "legacy-token",
    clerkUserId: null,
  });
  assert.deepEqual(await authenticate({ "x-api-key": "alice-token" }, entries), {
    label: "alice",
    token: "alice-token",
    clerkUserId: null,
  });
  assert.equal(await authenticate({}, entries), null);
  assert.equal(await authenticate({ authorization: "Bearer wrong" }, entries), null);
  assert.equal(await authenticate({ "x-api-key": "wrong" }, entries), null);
});

test("minted token helpers produce strict token, digest, and Clerk reporting shapes", () => {
  const token = mintProxyToken();
  assert.match(token, /^rlp_[0-9a-f]{64}$/);
  assert.equal(looksLikeMintedToken(token), true);
  assert.equal(looksLikeMintedToken(`rlp_${"g".repeat(64)}`), false);
  assert.equal(looksLikeMintedToken(`rlp_${"a".repeat(63)}`), false);
  assert.equal(hashProxyToken(token), createHash("sha256").update(token, "utf8").digest("hex"));
  assert.equal(
    reportingUserIdForClerk("user_123"),
    createHash("sha256").update("clerk:user_123", "utf8").digest("hex").slice(0, 12)
  );
});

test("authenticate returns a static match without consulting minted-token storage", async () => {
  let lookups = 0;
  const token = `rlp_${"a".repeat(64)}`;
  const result = await authenticate(
    { authorization: `Bearer ${token}` },
    [{ label: "static", token }],
    { lookupMintedToken: async () => (lookups += 1) }
  );
  assert.deepEqual(result, {
    label: "static",
    token,
    clerkUserId: null,
  });
  assert.equal(lookups, 0);
});

test("authenticate hashes minted tokens before lookup and maps the stored identity", async () => {
  const token = `rlp_${"b".repeat(64)}`;
  const calls = [];
  const result = await authenticate({ authorization: `Bearer ${token}` }, [], {
    lookupMintedToken: async (tokenHash) => {
      calls.push(tokenHash);
      return { label: "beta", clerkUserId: "user_123", revokedAt: null };
    },
  });
  assert.deepEqual(calls, [hashProxyToken(token)]);
  assert.equal(calls.includes(token), false);
  assert.deepEqual(result, { label: "beta", token, clerkUserId: "user_123" });
});

test("authenticate rejects revoked, missing, and unconfigured minted tokens", async () => {
  const token = `rlp_${"c".repeat(64)}`;
  assert.equal(
    await authenticate({ "x-api-key": token }, [], {
      lookupMintedToken: async () => ({
        label: "beta",
        clerkUserId: "user_123",
        revokedAt: "2026-07-18T00:00:00Z",
      }),
    }),
    null
  );
  assert.equal(
    await authenticate({ "x-api-key": token }, [], { lookupMintedToken: async () => null }),
    null
  );
  assert.equal(await authenticate({ "x-api-key": token }, []), null);
});

test("authenticate never looks up non-minted garbage", async () => {
  let lookups = 0;
  assert.equal(
    await authenticate({ authorization: "Bearer not-a-minted-token" }, [], {
      lookupMintedToken: async () => (lookups += 1),
    }),
    null
  );
  assert.equal(lookups, 0);
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
