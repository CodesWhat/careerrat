// tests/skill-runtime.test.mjs
// node:test suite for the embedded AI skill runtime (Productization Phase 0,
// P0-4 — src/core/ai/skill-runtime.mjs). Hermetic: no network, no real
// Anthropic key, and the real @anthropic-ai/claude-agent-sdk devDependency is
// never invoked — `runSkillStream`'s optional `loadSdk` param is stubbed with
// a hand-rolled async generator standing in for query(), so these tests
// exercise the actual driving loop (event mapping, BYOK usage write-back,
// abort handling) without spawning a CLI subprocess.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildChildEnv,
  discoverSkillDirs,
  loadClaudeAgentSdk,
  mapSdkMessage,
  RUNTIME_TOOLS,
  resolveAllowedSkills,
  runSkillStream,
} from "../src/core/ai/skill-runtime.mjs";
import { computeCost, readUsageEvents } from "../src/core/ai/usage-log.mjs";

// `skillNames` accepts a single name (most tests only need one) or an array
// — the default-allowlist tests need "evaluate-job", "answer-question",
// "tailor-application", and "resume-extract" fixtures present since
// DEFAULT_RUNTIME_SKILLS now names all four (resolveAllowedSkills filters the
// default against discovered dirs, so a fixture missing one of them would
// silently under-assert the real default).
function tempRepoWithSkill(skillNames = "test-skill") {
  const names = Array.isArray(skillNames) ? skillNames : [skillNames];
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-skill-runtime-"));
  for (const skillName of names) {
    const skillDir = join(repoRoot, ".agents/skills", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\n---\n# ${skillName}\n`,
      "utf8"
    );
  }
  // A second skill dir with no SKILL.md — must never be discovered.
  mkdirSync(join(repoRoot, ".agents/skills/not-a-skill"), { recursive: true });
  return repoRoot;
}

// ---------------------------------------------------------------------------
// discoverSkillDirs
// ---------------------------------------------------------------------------

test("discoverSkillDirs: only lists directories that actually have a SKILL.md", () => {
  const repoRoot = tempRepoWithSkill("evaluate-job");
  try {
    assert.deepEqual(discoverSkillDirs(repoRoot), ["evaluate-job"]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("discoverSkillDirs: returns [] when .agents/skills doesn't exist", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-skill-runtime-empty-"));
  try {
    assert.deepEqual(discoverSkillDirs(repoRoot), []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveAllowedSkills
// ---------------------------------------------------------------------------

test("resolveAllowedSkills: defaults to evaluate-job + answer-question + tailor-application + resume-extract when ROLESTER_RUNTIME_SKILLS is unset", () => {
  const repoRoot = tempRepoWithSkill([
    "evaluate-job",
    "answer-question",
    "tailor-application",
    "resume-extract",
  ]);
  try {
    assert.deepEqual(resolveAllowedSkills({ repoRoot, env: {} }), [
      "evaluate-job",
      "answer-question",
      "tailor-application",
      "resume-extract",
    ]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolveAllowedSkills: an explicit empty env value locks everything out", () => {
  const repoRoot = tempRepoWithSkill("evaluate-job");
  try {
    assert.deepEqual(resolveAllowedSkills({ repoRoot, env: { ROLESTER_RUNTIME_SKILLS: "" } }), []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolveAllowedSkills: respects a comma list and never allows an undiscovered name", () => {
  const repoRoot = tempRepoWithSkill("evaluate-job");
  try {
    assert.deepEqual(
      resolveAllowedSkills({
        repoRoot,
        env: { ROLESTER_RUNTIME_SKILLS: "evaluate-job, apply-job , not-a-skill" },
      }),
      ["evaluate-job"] // apply-job/not-a-skill have no SKILL.md under this fixture repoRoot
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildChildEnv — the AI routing decision, BYOK vs proxy vs none
// ---------------------------------------------------------------------------

test("buildChildEnv: byok route sets ANTHROPIC_API_KEY/BASE_URL, no custom headers", () => {
  const childEnv = buildChildEnv({
    route: { type: "byok", apiKey: "sk-ant-real", baseUrl: "https://api.anthropic.com" },
    skill: "evaluate-job",
    baseEnv: { PATH: "/usr/bin", SOME_OTHER: "kept" },
  });
  assert.equal(childEnv.ANTHROPIC_API_KEY, "sk-ant-real");
  assert.equal(childEnv.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal(childEnv.ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.equal(childEnv.PATH, "/usr/bin");
  assert.equal(childEnv.SOME_OTHER, "kept");
});

test("buildChildEnv: proxy route sends the proxy TOKEN as ANTHROPIC_API_KEY and labels the skill", () => {
  const childEnv = buildChildEnv({
    route: { type: "proxy", token: "devtoken", baseUrl: "http://127.0.0.1:7788" },
    skill: "evaluate-job",
    baseEnv: {},
  });
  assert.equal(childEnv.ANTHROPIC_API_KEY, "devtoken");
  assert.equal(childEnv.ANTHROPIC_BASE_URL, "http://127.0.0.1:7788");
  assert.equal(childEnv.ANTHROPIC_CUSTOM_HEADERS, "x-rolester-skill: evaluate-job");
});

test("buildChildEnv: route.type 'none' returns null", () => {
  assert.equal(
    buildChildEnv({ route: { type: "none" }, skill: "evaluate-job", baseEnv: {} }),
    null
  );
  assert.equal(buildChildEnv({ route: null, skill: "evaluate-job", baseEnv: {} }), null);
});

test("buildChildEnv: forwards the explicit model-selection env vars when the server set them", () => {
  const childEnv = buildChildEnv({
    route: { type: "byok", apiKey: "sk-ant-real", baseUrl: "https://api.anthropic.com" },
    skill: "evaluate-job",
    baseEnv: {
      ANTHROPIC_MODEL: "claude-sonnet-5",
      ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    },
  });
  assert.equal(childEnv.ANTHROPIC_MODEL, "claude-sonnet-5");
  assert.equal(childEnv.ANTHROPIC_SMALL_FAST_MODEL, "claude-haiku-4-5");
  assert.equal(childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-opus-4-8");
  assert.equal(childEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, "claude-sonnet-5");
  assert.equal(childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, "claude-haiku-4-5");
  assert.equal(childEnv.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1");
});

// ---------------------------------------------------------------------------
// buildChildEnv — no-code model-swap seam (config/ai.json via ai-config.mjs)
// ---------------------------------------------------------------------------

function tempRepoWithAiConfig(contents) {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-skill-runtime-aiconfig-"));
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  writeFileSync(join(repoRoot, "config", "ai.json"), JSON.stringify(contents), "utf8");
  return repoRoot;
}

test("buildChildEnv: config/ai.json fills ANTHROPIC_MODEL/SMALL_FAST_MODEL when unset in baseEnv", () => {
  const repoRoot = tempRepoWithAiConfig({
    model: "anthropic/claude-sonnet-4.6",
    smallFastModel: "claude-haiku-4-5",
  });
  try {
    const childEnv = buildChildEnv({
      route: { type: "byok", apiKey: "sk-ant-real", baseUrl: "https://api.anthropic.com" },
      skill: "evaluate-job",
      baseEnv: {},
      repoRoot,
    });
    assert.equal(childEnv.ANTHROPIC_MODEL, "anthropic/claude-sonnet-4.6");
    assert.equal(childEnv.ANTHROPIC_SMALL_FAST_MODEL, "claude-haiku-4-5");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("buildChildEnv: an explicit ANTHROPIC_MODEL in baseEnv wins over config/ai.json", () => {
  const repoRoot = tempRepoWithAiConfig({ model: "claude-sonnet-5" });
  try {
    const childEnv = buildChildEnv({
      route: { type: "byok", apiKey: "sk-ant-real", baseUrl: "https://api.anthropic.com" },
      skill: "evaluate-job",
      baseEnv: { ANTHROPIC_MODEL: "claude-opus-4-8" },
      repoRoot,
    });
    assert.equal(childEnv.ANTHROPIC_MODEL, "claude-opus-4-8"); // env wins, not the file's claude-sonnet-5
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("buildChildEnv: a missing config/ai.json applies no override — no ANTHROPIC_MODEL key added", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-skill-runtime-noaiconfig-"));
  try {
    const childEnv = buildChildEnv({
      route: { type: "byok", apiKey: "sk-ant-real", baseUrl: "https://api.anthropic.com" },
      skill: "evaluate-job",
      baseEnv: {},
      repoRoot,
    });
    assert.equal(childEnv.ANTHROPIC_MODEL, undefined);
    assert.equal(childEnv.ANTHROPIC_SMALL_FAST_MODEL, undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("buildChildEnv: a malformed config/ai.json applies no override, never throws", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-skill-runtime-badaiconfig-"));
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  writeFileSync(join(repoRoot, "config", "ai.json"), "{not valid json", "utf8");
  try {
    const childEnv = buildChildEnv({
      route: { type: "byok", apiKey: "sk-ant-real", baseUrl: "https://api.anthropic.com" },
      skill: "evaluate-job",
      baseEnv: {},
      repoRoot,
    });
    assert.equal(childEnv.ANTHROPIC_MODEL, undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// mapSdkMessage — pure event mapping from a stubbed message iterator
// ---------------------------------------------------------------------------

test("mapSdkMessage: assistant message with tool_use yields an assistant event + a tool_use event", () => {
  const msg = {
    type: "assistant",
    session_id: "sess-1",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "text", text: "Reading the JD now." },
        { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "workspace/jobs/x.md" } },
      ],
    },
  };
  const events = mapSdkMessage(msg);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "assistant");
  assert.equal(events[0].data, msg);
  assert.equal(events[1].type, "tool_use");
  assert.deepEqual(events[1].data, {
    id: "tu_1",
    name: "Read",
    input: { file_path: "workspace/jobs/x.md" },
    parentToolUseId: null,
    sessionId: "sess-1",
  });
});

test("mapSdkMessage: assistant message with an error field also emits an error event", () => {
  const msg = {
    type: "assistant",
    session_id: "sess-1",
    parent_tool_use_id: null,
    error: "authentication_failed",
    message: { content: [] },
  };
  const events = mapSdkMessage(msg);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "assistant");
  assert.deepEqual(events[1], {
    type: "error",
    data: { error: "authentication_failed", sessionId: "sess-1" },
  });
});

test("mapSdkMessage: user message with tool_result yields a tool_result event", () => {
  const msg = {
    type: "user",
    session_id: "sess-1",
    message: {
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false }],
    },
  };
  const events = mapSdkMessage(msg);
  assert.deepEqual(events, [
    {
      type: "tool_result",
      data: { toolUseId: "tu_1", content: "ok", isError: false, sessionId: "sess-1" },
    },
  ]);
});

test("mapSdkMessage: system message is passed through verbatim", () => {
  const msg = { type: "system", subtype: "init", skills: ["evaluate-job"], session_id: "sess-1" };
  assert.deepEqual(mapSdkMessage(msg), [{ type: "system", data: msg }]);
});

test("mapSdkMessage: an unrecognized message type is still surfaced, bucketed as system", () => {
  const msg = { type: "tool_progress", tool_use_id: "tu_1" };
  assert.deepEqual(mapSdkMessage(msg), [{ type: "system", data: msg }]);
});

test("mapSdkMessage: result (success) computes costUsd via usage-log's own pricing table", () => {
  const msg = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 4200,
    num_turns: 3,
    session_id: "sess-1",
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 200,
    },
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 200,
      },
    },
  };
  const [event] = mapSdkMessage(msg);
  const expected = computeCost("claude-sonnet-5", {
    tokens_in: 1000,
    tokens_out: 500,
    cache_read_tokens: 100,
    cache_creation_tokens: 200,
  });
  assert.equal(event.type, "result");
  assert.equal(event.data.ok, true);
  assert.equal(event.data.durationMs, 4200);
  assert.equal(event.data.sessionId, "sess-1");
  assert.deepEqual(event.data.usage, {
    tokensIn: 1000,
    tokensOut: 500,
    cacheReadTokens: 100,
    cacheCreationTokens: 200,
  });
  assert.equal(event.data.costUsd, expected.cost_usd);
});

test("mapSdkMessage: result with an unknown model is never fabricated a price", () => {
  const msg = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    duration_ms: 100,
    session_id: "sess-1",
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: { "some-unreleased-model": { inputTokens: 10, outputTokens: 5 } },
    errors: ["boom"],
  };
  const [event] = mapSdkMessage(msg);
  assert.equal(event.data.ok, false);
  assert.equal(event.data.costUsd, null);
  assert.deepEqual(event.data.errors, ["boom"]);
});

// ---------------------------------------------------------------------------
// runSkillStream — validation ordering (no SDK ever touched on these paths)
// ---------------------------------------------------------------------------

test("runSkillStream: rejects a skill outside the allowlist before touching the SDK loader", async () => {
  const repoRoot = tempRepoWithSkill("evaluate-job");
  let loadSdkCalled = false;
  try {
    await assert.rejects(
      runSkillStream({
        skill: "not-a-skill",
        input: "hi",
        repoRoot,
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
        onEvent: () => {},
        loadSdk: async () => {
          loadSdkCalled = true;
          throw new Error("should never be called");
        },
      }),
      (err) => err.code === "SKILL_NOT_ALLOWED"
    );
    assert.equal(loadSdkCalled, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runSkillStream: rejects with NO_AI_ROUTE when neither BYOK nor proxy env is configured", async () => {
  const repoRoot = tempRepoWithSkill("evaluate-job");
  let loadSdkCalled = false;
  try {
    await assert.rejects(
      runSkillStream({
        skill: "evaluate-job",
        input: "hi",
        repoRoot,
        env: {},
        onEvent: () => {},
        loadSdk: async () => {
          loadSdkCalled = true;
          throw new Error("should never be called");
        },
      }),
      (err) => err.code === "NO_AI_ROUTE"
    );
    assert.equal(loadSdkCalled, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runSkillStream — the full driving loop against a stubbed SDK query()
// ---------------------------------------------------------------------------

// A fake query() shaped like the real Query: an AsyncGenerator<SDKMessage>
// that checks the abortController's signal on every step, so aborting mid-run
// is genuinely observable (not just a promise race).
function fakeSdk(messages) {
  return {
    query: ({ options }) => {
      const { signal } = options.abortController;
      async function* gen() {
        for (const m of messages) {
          if (signal.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
          yield m;
        }
      }
      const it = gen();
      it.return = async () => ({ value: undefined, done: true });
      return it;
    },
  };
}

const SAMPLE_RUN = [
  { type: "system", subtype: "init", skills: ["evaluate-job"], session_id: "s1" },
  {
    type: "assistant",
    session_id: "s1",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] },
  },
  {
    type: "user",
    session_id: "s1",
    message: {
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "jd body", is_error: false }],
    },
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1500,
    num_turns: 2,
    session_id: "s1",
    usage: {
      input_tokens: 400,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 400,
        outputTokens: 200,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  },
];

test("runSkillStream: tools param — an unset caller gets RUNTIME_TOOLS passed to query()", async () => {
  const repoRoot = tempRepoWithSkill("evaluate-job");
  try {
    let seenTools = null;
    await runSkillStream({
      skill: "evaluate-job",
      input: "hi",
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      onEvent: () => {},
      loadSdk: async () => ({
        query: ({ options }) => {
          seenTools = options.tools;
          return fakeSdk(SAMPLE_RUN).query({ options });
        },
      }),
    });
    assert.deepEqual(seenTools, RUNTIME_TOOLS);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runSkillStream: an explicit tools override (M8's resume-extract: ['Read']) reaches query() verbatim, not RUNTIME_TOOLS", async () => {
  const repoRoot = tempRepoWithSkill(["evaluate-job", "resume-extract"]);
  try {
    let seenTools = null;
    await runSkillStream({
      skill: "resume-extract",
      input: "hi",
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      tools: ["Read"],
      onEvent: () => {},
      loadSdk: async () => ({
        query: ({ options }) => {
          seenTools = options.tools;
          return fakeSdk(SAMPLE_RUN).query({ options });
        },
      }),
    });
    assert.deepEqual(seenTools, ["Read"]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runSkillStream: drives the stubbed query to completion, in order, and returns the result data", async () => {
  const repoRoot = tempRepoWithSkill("evaluate-job");
  try {
    const events = [];
    const result = await runSkillStream({
      skill: "evaluate-job",
      input: "https://example.test/job/123",
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      onEvent: (evt) => events.push(evt.type),
      loadSdk: async () => fakeSdk(SAMPLE_RUN),
    });
    assert.deepEqual(events, ["system", "assistant", "tool_use", "tool_result", "result"]);
    assert.equal(result.ok, true);
    assert.equal(result.durationMs, 1500);
    assert.equal(result.sessionId, "s1");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runSkillStream: BYOK route writes one usage_event per model used (proxy already meters its own traffic)", async () => {
  const repoRoot = tempRepoWithSkill("evaluate-job");
  try {
    await runSkillStream({
      skill: "evaluate-job",
      input: "hi",
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      onEvent: () => {},
      loadSdk: async () => fakeSdk(SAMPLE_RUN),
    });
    const rows = readUsageEvents({ root: repoRoot });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "byok");
    assert.equal(rows[0].skill, "evaluate-job");
    assert.equal(rows[0].model, "claude-sonnet-5");
    assert.equal(rows[0].tokens_in, 400);
    assert.equal(rows[0].tokens_out, 200);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runSkillStream: proxy route writes NO usage_event of its own (the proxy already metered it)", async () => {
  const repoRoot = tempRepoWithSkill("evaluate-job");
  try {
    await runSkillStream({
      skill: "evaluate-job",
      input: "hi",
      repoRoot,
      env: { ROLESTER_AI_PROXY_URL: "http://127.0.0.1:7788", ROLESTER_AI_PROXY_TOKEN: "devtoken" },
      onEvent: () => {},
      loadSdk: async () => fakeSdk(SAMPLE_RUN),
    });
    assert.deepEqual(readUsageEvents({ root: repoRoot }), []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runSkillStream: aborting mid-run (client disconnect) stops the loop and returns {ok:false, aborted:true} with no spurious error event", async () => {
  const repoRoot = tempRepoWithSkill("evaluate-job");
  try {
    const externalController = new AbortController();
    const events = [];
    const result = await runSkillStream({
      skill: "evaluate-job",
      input: "hi",
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      signal: externalController.signal,
      onEvent: (evt) => {
        events.push(evt.type);
        // Disconnect right after the first message is observed — by the time
        // the fake generator asks "am I aborted?" on its next iteration, the
        // signal has already propagated through runSkillStream's internal
        // controller (wired synchronously via addEventListener above).
        if (evt.type === "system") externalController.abort();
      },
      loadSdk: async () => fakeSdk(SAMPLE_RUN),
    });
    assert.deepEqual(result, { ok: false, aborted: true });
    assert.deepEqual(events, ["system"]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// loadClaudeAgentSdk — sanity check against the real installed package. This
// is the one place these tests touch the actual devDependency: it only
// confirms the import resolves and exposes `query`, matching what the .d.ts
// promised (see skill-runtime.mjs's header comment) — no network, no query()
// call.
// ---------------------------------------------------------------------------

test("loadClaudeAgentSdk: resolves the real devDependency and exposes query()", async () => {
  const mod = await loadClaudeAgentSdk();
  assert.equal(typeof mod.query, "function");
});

// ---------------------------------------------------------------------------
// Real end-to-end integration — the one test in this file that actually talks
// to a live model. Gated behind ANTHROPIC_API_KEY being present in the
// environment: never runs in CI, only when a developer sets a real key
// locally. A canned mock upstream can't stand in for this (the CLI subprocess
// needs a real model to hold a real conversation), so this is deliberately
// the smallest possible live query rather than exercising evaluate-job's full
// flow.
// ---------------------------------------------------------------------------

test("INTEGRATION (skipped without ANTHROPIC_API_KEY): a real, tiny query against the live Agent SDK yields a result event", {
  skip: !process.env.ANTHROPIC_API_KEY,
}, async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-skill-runtime-live-"));
  const skillDir = join(repoRoot, ".agents/skills/ping");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: ping\ndescription: Reply with the single word OK, nothing else.\n---\n" +
      "# ping\n\nReply with exactly the single word `OK`. Do not call any tools.\n",
    "utf8"
  );
  try {
    const events = [];
    const result = await runSkillStream({
      skill: "ping",
      input: "ping",
      repoRoot,
      env: { ...process.env, ROLESTER_RUNTIME_SKILLS: "ping" },
      onEvent: (evt) => events.push(evt.type),
    });
    assert.ok(events.includes("result"), `expected a "result" event, got: ${events.join(", ")}`);
    assert.equal(typeof result.ok, "boolean");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
