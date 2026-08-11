// tests/call-ai-engine.test.mjs
// node:test coverage for W3's engine-receipt plumbing added to
// src/core/ai/call-ai.mjs (commit 95f27540): describeAIEngine()'s per-route
// shapes, and elapsedMs being threaded through callAI()'s non-streaming
// return for both the installed-runtime path and the BYOK fetch path. Split
// into its own file rather than appended to tests/call-ai.test.mjs so it can
// land without touching that file — same mock-upstream/tempRoot conventions
// that file already establishes, trimmed to just what these assertions need.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { callAI, describeAIEngine } from "../src/core/ai/call-ai.mjs";
import { writeInstalledRuntimeSelection } from "../src/core/ai/runtime-selection.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "careerrat-call-ai-engine-"));
}

function startMockUpstream() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            model: "claude-haiku-4-5",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 3 },
          })
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

// ---------------------------------------------------------------------------
// describeAIEngine — installed/byok/proxy/none route shapes
// ---------------------------------------------------------------------------

test("describeAIEngine: installed route uses the runtime's own id/name, no version invented", () => {
  const engine = describeAIEngine({
    type: "installed",
    runtime: { id: "codex", name: "Codex", path: "/safe/codex", available: true },
  });
  assert.deepEqual(engine, { id: "codex", label: "Codex" });
});

test("describeAIEngine: byok route gets the fixed Anthropic API label", () => {
  const engine = describeAIEngine({ type: "byok", baseUrl: "https://api.anthropic.com" });
  assert.deepEqual(engine, { id: "anthropic", label: "Anthropic API" });
});

test("describeAIEngine: proxy route gets the fixed Managed AI Proxy label", () => {
  const engine = describeAIEngine({ type: "proxy", baseUrl: "https://proxy.example.test" });
  assert.deepEqual(engine, { id: "proxy", label: "Managed AI Proxy" });
});

test("describeAIEngine: none route returns null rather than a fake engine", () => {
  const engine = describeAIEngine({ type: "none", error: "no AI route configured" });
  assert.equal(engine, null);
});

// ---------------------------------------------------------------------------
// callAI() — elapsedMs + engine on the non-streaming return
// ---------------------------------------------------------------------------

test("callAI (installed runtime): result carries numeric elapsedMs and the installed engine", async () => {
  const root = tempRoot();
  try {
    writeInstalledRuntimeSelection({ repoRoot: root, env: {}, runtimeId: "codex" });
    const result = await callAI({
      messages: [{ role: "user", content: "hi" }],
      system: "Answer briefly.",
      maxTokens: 16,
      root,
      env: { ROLESTER_DESKTOP_SHELL: "1" },
      runtimeInventory: [{ id: "codex", name: "Codex", path: "/safe/codex", available: true }],
      runInstalledRuntimeImpl: async () => ({
        text: "hello from codex",
        runtimeId: "codex",
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    });

    assert.equal(typeof result.elapsedMs, "number");
    assert.ok(result.elapsedMs >= 0);
    assert.deepEqual(result.engine, { id: "codex", label: "Codex" });
    assert.equal(result.model, "installed:codex");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("callAI (BYOK): result carries numeric elapsedMs and the Anthropic API engine", async () => {
  const upstream = await startMockUpstream();
  try {
    const result = await callAI({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
      env: { ANTHROPIC_API_KEY: "sk-ant-test", ROLESTER_ANTHROPIC_BASE_URL: upstream.url },
    });

    assert.equal(typeof result.elapsedMs, "number");
    assert.ok(result.elapsedMs >= 0);
    assert.deepEqual(result.engine, { id: "anthropic", label: "Anthropic API" });
  } finally {
    upstream.close();
  }
});
