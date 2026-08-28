import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("../src/core/search/unified-job-search.mjs").catch(() => ({}));
}

test("runs deterministic search before AI top-up with one generated execution id", async () => {
  const { runUnifiedJobSearch } = await loadSubject();
  assert.equal(typeof runUnifiedJobSearch, "function");

  const events = [];
  const result = await runUnifiedJobSearch({
    createExecutionId: () => "search-generated",
    runDeterministic: async ({ searchExecutionId }) => {
      events.push(`deterministic:${searchExecutionId}`);
      return { ok: true, offers: [{ id: "configured-result" }] };
    },
    runAiWeb: async ({ searchExecutionId, deterministic }) => {
      events.push(`ai:${searchExecutionId}:${deterministic.status}`);
      return { ok: true, offers: [{ id: "ai-result" }] };
    },
  });

  assert.deepEqual(events, ["deterministic:search-generated", "ai:search-generated:succeeded"]);
  assert.deepEqual(result, {
    ok: true,
    partial: false,
    searchExecutionId: "search-generated",
    lanes: {
      deterministic: {
        status: "succeeded",
        result: { ok: true, offers: [{ id: "configured-result" }] },
      },
      aiWeb: {
        status: "succeeded",
        result: { ok: true, offers: [{ id: "ai-result" }] },
      },
    },
  });
});

test("passes one caller-supplied execution id through both lanes", async () => {
  const { runUnifiedJobSearch } = await loadSubject();
  const received = [];

  const result = await runUnifiedJobSearch({
    searchExecutionId: "search-supplied",
    createExecutionId: () => {
      throw new Error("must not replace a supplied id");
    },
    runDeterministic: async ({ searchExecutionId }) => {
      received.push(searchExecutionId);
      return { ok: true };
    },
    runAiWeb: async ({ searchExecutionId }) => {
      received.push(searchExecutionId);
      return { ok: true };
    },
  });

  assert.deepEqual(received, ["search-supplied", "search-supplied"]);
  assert.equal(result.searchExecutionId, "search-supplied");
});

test("continues to AI and returns its result when deterministic search fails", async () => {
  const { runUnifiedJobSearch } = await loadSubject();

  const result = await runUnifiedJobSearch({
    searchExecutionId: "search-deterministic-failed",
    runDeterministic: async () => {
      const error = new Error("saved source timed out");
      error.code = "SOURCE_TIMEOUT";
      throw error;
    },
    runAiWeb: async ({ deterministic }) => {
      assert.equal(deterministic.status, "failed");
      return { ok: true, offers: [{ id: "open-web-result" }] };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.deepEqual(result.lanes.deterministic, {
    status: "failed",
    error: { code: "SOURCE_TIMEOUT", message: "saved source timed out" },
  });
  assert.deepEqual(result.lanes.aiWeb, {
    status: "succeeded",
    result: { ok: true, offers: [{ id: "open-web-result" }] },
  });
});

test("keeps deterministic results when AI top-up fails", async () => {
  const { runUnifiedJobSearch } = await loadSubject();

  const result = await runUnifiedJobSearch({
    searchExecutionId: "search-ai-failed",
    runDeterministic: async () => ({ ok: true, offers: [{ id: "configured-result" }] }),
    runAiWeb: async () => ({ ok: false, error: "AI search timed out" }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.deepEqual(result.lanes.deterministic, {
    status: "succeeded",
    result: { ok: true, offers: [{ id: "configured-result" }] },
  });
  assert.deepEqual(result.lanes.aiWeb, {
    status: "failed",
    error: { message: "AI search timed out" },
    result: { ok: false, error: "AI search timed out" },
  });
});

test("does not start AI top-up after deterministic cancellation", async () => {
  const { runUnifiedJobSearch } = await loadSubject();
  const controller = new AbortController();
  let aiCalled = false;

  const result = await runUnifiedJobSearch({
    searchExecutionId: "search-cancelled",
    signal: controller.signal,
    runDeterministic: async () => {
      controller.abort("user-cancelled");
      return { ok: false, aborted: true };
    },
    runAiWeb: async () => {
      aiCalled = true;
      return { ok: true };
    },
  });

  assert.equal(aiCalled, false);
  assert.deepEqual(result, {
    ok: false,
    partial: false,
    aborted: true,
    searchExecutionId: "search-cancelled",
    lanes: {
      deterministic: {
        status: "cancelled",
        result: { ok: false, aborted: true },
      },
      aiWeb: { status: "skipped", reason: "cancelled" },
    },
  });
});

test("preserves deterministic results when cancellation stops AI top-up", async () => {
  const { runUnifiedJobSearch } = await loadSubject();
  const controller = new AbortController();

  const result = await runUnifiedJobSearch({
    searchExecutionId: "search-ai-cancelled",
    signal: controller.signal,
    runDeterministic: async () => ({ ok: true, offers: [{ id: "configured-result" }] }),
    runAiWeb: async () => {
      controller.abort("user-cancelled");
      return { ok: false, aborted: true };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(result.aborted, true);
  assert.equal(result.lanes.deterministic.status, "succeeded");
  assert.equal(result.lanes.aiWeb.status, "cancelled");
});

test("finishes successfully without invoking an unavailable AI lane", async () => {
  const { runUnifiedJobSearch } = await loadSubject();
  let aiCalled = false;

  const result = await runUnifiedJobSearch({
    searchExecutionId: "search-no-ai",
    aiAvailable: false,
    runDeterministic: async () => ({ ok: true, offers: [{ id: "configured-result" }] }),
    runAiWeb: async () => {
      aiCalled = true;
      return { ok: true };
    },
  });

  assert.equal(aiCalled, false);
  assert.deepEqual(result, {
    ok: true,
    partial: false,
    searchExecutionId: "search-no-ai",
    lanes: {
      deterministic: {
        status: "succeeded",
        result: { ok: true, offers: [{ id: "configured-result" }] },
      },
      aiWeb: { status: "skipped", reason: "unavailable" },
    },
  });
});
