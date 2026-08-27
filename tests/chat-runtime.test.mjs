// tests/chat-runtime.test.mjs
// node:test suite for the M2 conversational (multi-turn) skill runtime
// (src/core/ai/chat-runtime.mjs). Hermetic: no network, no real Anthropic
// key for the non-INTEGRATION tests — `createChatRuntime`'s `loadSdk` param
// is stubbed with a hand-rolled fake STREAMING SDK whose generator pulls
// messages from the push-queue passed in as `options.prompt` itself (the
// AsyncIterable, not a callback), so these tests exercise the actual
// multi-turn pump loop (event mapping, state transitions, byok usage
// write-back, abort/close/interrupt) without spawning a CLI subprocess.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isPlainYesNoQuestion, parseChatAnswerMode } from "../src/core/ai/chat-answer-mode.mjs";
import {
  buildChatKickoffPrompt,
  classifyChatEvent,
  createChatRuntime,
  resolveAllowedChatSkills,
  resolveCandidateChatContext,
  resolveDirectChatSkills,
} from "../src/core/ai/chat-runtime.mjs";
import { CHAT_SESSION_RUNTIME_TIMEOUT_MS } from "../src/core/ai/installed-runtimes.mjs";
import { writeInstalledRuntimeSelection } from "../src/core/ai/runtime-selection.mjs";
import { APP_SAFE_RUNTIME_TOOLS, CHAT_RUNTIME_TOOLS } from "../src/core/ai/runtime-tools.mjs";
import { readUsageEvents } from "../src/core/ai/usage-log.mjs";
import { openDb } from "../src/core/db/connection.mjs";
import {
  candidateArtifactPut,
  candidateConfigPatch,
  candidateEvidenceMerge,
  candidateSetupInitialize,
  skillChatThreadRead,
} from "../src/core/db/verbs.mjs";

const VERIFIED_CAPABILITIES = Object.freeze({
  completion: true,
  structuredOutput: true,
  appWorkflows: true,
  exactRead: true,
  publicWeb: true,
  liveActivity: true,
  resumable: true,
});

function runtimeVerification(path) {
  return {
    path,
    capabilities: VERIFIED_CAPABILITIES,
    checkedAt: "2026-08-25T12:00:00.000Z",
  };
}

// Forces resolveAIRoute() to resolve route.type === "installed" deterministically
// without depending on any real CLI actually being on this machine's PATH.
// The helper uses a real registry id ("codex") so the production route remains
// identical to the route used outside tests. resolveAIRoute's installed-runtime
// branch calls detectInstalledRuntimes({env}), which walks env.PATH plus
// CAREERRAT_RUNTIME_EXTRA_PATHS (installed-runtimes.mjs's runtimeSearchDirectories).
// Pointing both at a throwaway bin dir containing a fake "codex" executable
// makes detection resolve route.runtime = { id: "codex", name: "Codex", ... }
// without depending on any real CLI being on this machine's PATH — needed
// here (unlike selectInstalledRuntime's "custom" shortcut) because this
// suite's tool-profile-boundary test asserts on the registry's real "Codex"
// display name inside the user-facing error message.
function selectFakeCodexRuntime({ repoRoot, env }) {
  const binDir = mkdtempSync(join(tmpdir(), "careerrat-fake-codex-bin-"));
  const codexPath = join(binDir, "codex");
  writeFileSync(codexPath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(codexPath, 0o755);
  env.PATH = "";
  env.CAREERRAT_RUNTIME_EXTRA_PATHS = binDir;
  writeInstalledRuntimeSelection({
    repoRoot,
    env,
    runtimeId: "codex",
    verification: runtimeVerification(codexPath),
  });
  return binDir;
}

function selectInstalledRuntime({ repoRoot, env }) {
  const binDir = join(repoRoot, ".internal", "fake-runtime-bin");
  mkdirSync(binDir, { recursive: true });
  const codexPath = join(binDir, "codex");
  writeFileSync(codexPath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(codexPath, 0o755);
  env.PATH = "";
  env.CAREERRAT_RUNTIME_EXTRA_PATHS = binDir;
  writeInstalledRuntimeSelection({
    repoRoot,
    env,
    runtimeId: "codex",
    verification: runtimeVerification(codexPath),
  });
}

// Same deterministic-route trick as selectFakeCodexRuntime, but for "claude" —
// the one registry entry supportsInstalledRuntimeStreaming() actually returns
// true for. Needed for the streaming-turn coverage below, which asserts
// runInstalledTurn dispatches over runInstalledRuntimeStreamImpl (never the
// one-shot runInstalledRuntimeImpl) once route.runtime.id === "claude".
function selectFakeClaudeRuntime({ repoRoot, env }) {
  const binDir = mkdtempSync(join(tmpdir(), "careerrat-fake-claude-bin-"));
  const claudePath = join(binDir, "claude");
  writeFileSync(claudePath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(claudePath, 0o755);
  env.PATH = "";
  env.CAREERRAT_RUNTIME_EXTRA_PATHS = binDir;
  writeInstalledRuntimeSelection({
    repoRoot,
    env,
    runtimeId: "claude",
    verification: runtimeVerification(claudePath),
  });
  return binDir;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tempRepoWithSkill(skillNames = "ingest-profile") {
  const names = Array.isArray(skillNames) ? skillNames : [skillNames];
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-chat-runtime-"));
  for (const skillName of names) {
    const skillDir = join(repoRoot, ".agents/skills", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\n---\n# ${skillName}\n`,
      "utf8"
    );
  }
  return repoRoot;
}

function cleanup(repoRoot) {
  rmSync(repoRoot, { recursive: true, force: true });
}

function waitForPredicate(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function poll() {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("timed out waiting for predicate"));
        return;
      }
      setTimeout(poll, intervalMs);
    })();
  });
}

// A fake query() shaped like the real streaming Query: its generator yields
// an init frame immediately, then pulls one message at a time off the
// pushed-in `prompt` (our push-queue) — one pulled message == one "turn" —
// emitting the scripted messages for that turn before looping back to pull
// the next one. This is what actually exercises "long-lived query() with
// streaming input" rather than a one-shot fake.
function fakeStreamingSdk(turns, { onClose, onInterrupt, onTurnInput } = {}) {
  return {
    query: ({ prompt, options }) => {
      const { signal } = options.abortController;
      let turnIndex = 0;
      async function* gen() {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-1",
          skills: options.skills,
        };
        for await (const turnInput of prompt) {
          onTurnInput?.(turnInput);
          if (signal.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
          const messages = turns[turnIndex] || [];
          turnIndex++;
          for (const m of messages) {
            if (signal.aborted) {
              const err = new Error("aborted");
              err.name = "AbortError";
              throw err;
            }
            yield m;
          }
        }
      }
      const it = gen();
      it.interrupt = async () => {
        if (onInterrupt) onInterrupt();
      };
      it.close = () => {
        if (onClose) onClose();
      };
      it.return = async () => ({ value: undefined, done: true });
      return it;
    },
  };
}

// One turn: an assistant text reply + a successful result carrying usage —
// enough for both classifyChatEvent's idle transition and writeByokUsage's
// per-model row.
function turnMessages(n) {
  return [
    {
      type: "assistant",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: `Reply ${n}` }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 100 * n,
      num_turns: n,
      session_id: "sdk-session-1",
      usage: {
        input_tokens: 10 * n,
        output_tokens: 5 * n,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 10 * n,
          outputTokens: 5 * n,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    },
  ];
}

function turnMessagesWithReply(text, n = 1) {
  const messages = turnMessages(n);
  messages[0] = {
    ...messages[0],
    message: { content: [{ type: "text", text }] },
  };
  return messages;
}

// Subscribes a fake `res` (matching http.ServerResponse's writeHead/write/on/
// end surface) to a session and parses each write() call — always exactly
// one complete SSE frame per call, since recordAndBroadcast() writes one
// frame at a time — into {type, data, id}.
function subscribeCollect(chatRuntime, chatId) {
  const events = [];
  const res = {
    writeHead() {},
    write(chunk) {
      const frame = parseSseFrame(chunk);
      if (frame) events.push(frame);
    },
    on() {},
    end() {},
  };
  chatRuntime.subscribe(chatId, res, {});
  return events;
}

function parseSseFrame(chunk) {
  const text = String(chunk);
  const lines = text.split("\n");
  let type = null;
  let id = null;
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    else if (line.startsWith("id:")) id = Number(line.slice(3).trim());
  }
  if (!type) return null;
  let data;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    data = dataLines.join("\n");
  }
  return { type, data, id };
}

function stripJavaScriptComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// resolveAllowedChatSkills
// ---------------------------------------------------------------------------

test("resolveAllowedChatSkills: defaults only to the visible installed chat surfaces", () => {
  const repoRoot = tempRepoWithSkill([
    "ingest-profile",
    "research-boards",
    "research-company",
    "research-comp",
    "company-health",
  ]);
  try {
    assert.deepEqual(resolveAllowedChatSkills({ repoRoot, env: {} }), [
      "ingest-profile",
      "research-boards",
      "research-company",
      "research-comp",
      "company-health",
    ]);
    assert.deepEqual(
      resolveDirectChatSkills({
        repoRoot,
        env: { CAREERRAT_CHAT_SKILLS: "research-boards,discover-companies" },
      }),
      ["research-boards"]
    );
  } finally {
    cleanup(repoRoot);
  }
});

test("resolveAllowedChatSkills: an explicit empty env value locks everything out", () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    assert.deepEqual(
      resolveAllowedChatSkills({ repoRoot, env: { CAREERRAT_CHAT_SKILLS: "" } }),
      []
    );
  } finally {
    cleanup(repoRoot);
  }
});

test("resolveAllowedChatSkills: respects a comma-list override and filters to what's discoverable", () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    assert.deepEqual(
      resolveAllowedChatSkills({
        repoRoot,
        env: { CAREERRAT_CHAT_SKILLS: "ingest-profile, evaluate-job" },
      }),
      ["ingest-profile"] // evaluate-job has no SKILL.md under this fixture repoRoot
    );
  } finally {
    cleanup(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// classifyChatEvent — pure table lookup
// ---------------------------------------------------------------------------

test("classifyChatEvent: a result event (any subtype) transitions to idle", () => {
  assert.equal(classifyChatEvent({ type: "result", data: { subtype: "success" } }), "idle");
  assert.equal(
    classifyChatEvent({ type: "result", data: { subtype: "error_during_execution" } }),
    "idle"
  );
});

test("classifyChatEvent: system/session_state_changed idle+running map through; requires_action does not", () => {
  assert.equal(
    classifyChatEvent({
      type: "system",
      data: { subtype: "session_state_changed", state: "idle" },
    }),
    "idle"
  );
  assert.equal(
    classifyChatEvent({
      type: "system",
      data: { subtype: "session_state_changed", state: "running" },
    }),
    "running"
  );
  assert.equal(
    classifyChatEvent({
      type: "system",
      data: { subtype: "session_state_changed", state: "requires_action" },
    }),
    null
  );
});

test("classifyChatEvent: every other event type/subtype (including plain system init) is not a transition", () => {
  assert.equal(classifyChatEvent({ type: "assistant", data: {} }), null);
  assert.equal(classifyChatEvent({ type: "tool_use", data: {} }), null);
  assert.equal(classifyChatEvent({ type: "tool_result", data: {} }), null);
  assert.equal(classifyChatEvent({ type: "system", data: { subtype: "init" } }), null);
  assert.equal(classifyChatEvent({ type: "error", data: {} }), null);
  assert.equal(classifyChatEvent(null), null);
  assert.equal(classifyChatEvent(undefined), null);
});

// ---------------------------------------------------------------------------
// buildChatKickoffPrompt — conversational posture text
// ---------------------------------------------------------------------------

test("buildChatKickoffPrompt: asks ONE question at a time and drops the one-shot headless framing", () => {
  const prompt = buildChatKickoffPrompt({ skill: "ingest-profile" });
  assert.match(prompt, /ONE question/);
  assert.match(prompt, /careerrat:answer/);
  assert.match(prompt, /genuinely answerable with Yes or No/i);
  assert.match(prompt, /ingest-profile/);
  assert.doesNotMatch(prompt, /non-interactive, headless/);
});

test("buildChatKickoffPrompt: an 8-of-8 candidate gets a deterministic completion boundary", () => {
  const prompt = buildChatKickoffPrompt({
    skill: "ingest-profile",
    input: "No, I do not want a concurrent secondary position.",
    candidateContext: { setupProgress: { completedCount: 8, total: 8, complete: true } },
  });

  assert.match(prompt, /initial setup is complete/i);
  assert.match(prompt, /answers a question you asked before completion/i);
  assert.match(prompt, /emit the required confirmation block before ending/i);
  assert.match(prompt, /do not claim it is noted or saved/i);
  assert.match(prompt, /ask no new setup questions/i);
  assert.match(prompt, /optional enrichment belongs after onboarding/i);
});

test("buildChatKickoffPrompt: prioritizes explicit work-mode confirmation over optional enrichment", () => {
  const prompt = buildChatKickoffPrompt({
    skill: "ingest-profile",
    input: "The metrics on my résumé are accurate.",
    candidateContext: {
      profile: {
        location: {
          home: "Brooklyn, NY",
          remote: true,
          remote_scope: "home-country",
          hybrid: false,
          onsite: false,
        },
      },
      setupProgress: {
        items: [
          { key: "quickFacts", done: false },
          { key: "authorization", done: true },
        ],
        completedCount: 7,
        total: 8,
        complete: false,
      },
    },
  });

  assert.match(prompt, /highest-priority missing setup item/i);
  assert.match(prompt, /remote, hybrid, on-site, or relocation/i);
  assert.match(prompt, /do not infer those preferences from the résumé/i);
  assert.match(prompt, /before any optional enrichment/i);
});

test("buildChatKickoffPrompt: routes notice period to its real profile schema path", () => {
  const prompt = buildChatKickoffPrompt({ skill: "ingest-profile" });
  assert.match(prompt, /profile\.authorization\.notice_period/i);
  assert.match(prompt, /never form-defaults\.notice_period/i);
  assert.match(prompt, /do not collect an earliest start date during initial setup/i);
});

test("buildChatKickoffPrompt: gives the agent the exact location patch shape", () => {
  const prompt = buildChatKickoffPrompt({ skill: "ingest-profile" });

  assert.match(prompt, /profile\.location\.relocation.*array/i);
  assert.match(prompt, /no relocation.*\[\]/i);
  assert.match(prompt, /profile\.location\.max_commute_days_per_week/i);
});

test("buildChatKickoffPrompt: never models final submission as a candidate setting", () => {
  const prompt = buildChatKickoffPrompt({ skill: "ingest-profile" });

  assert.match(prompt, /final application submission always requires a separate user action/i);
  assert.match(prompt, /form-defaults contains ATS answers only and has no submission setting/i);
});

// ---------------------------------------------------------------------------
// startSession — validation ordering (mirrors skill-runtime.test.mjs's own
// runSkillStream validation-order coverage)
// ---------------------------------------------------------------------------

test("createChatRuntime.startSession: rejects an empty skill before touching the SDK loader", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  let loadSdkCalled = false;
  try {
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      loadSdk: async () => {
        loadSdkCalled = true;
        throw new Error("should never be called");
      },
    });
    await assert.rejects(
      chatRuntime.startSession({ skill: "" }),
      (err) => err.code === "SKILL_REQUIRED"
    );
    assert.equal(loadSdkCalled, false);
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime.startSession: rejects a skill outside the chat allowlist before touching the SDK loader", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  let loadSdkCalled = false;
  try {
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      loadSdk: async () => {
        loadSdkCalled = true;
        throw new Error("should never be called");
      },
    });
    await assert.rejects(
      chatRuntime.startSession({ skill: "not-a-chat-skill" }),
      (err) => err.code === "SKILL_NOT_ALLOWED"
    );
    assert.equal(loadSdkCalled, false);
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime.startSession: installed chat rejects search-jobs even when an env override opts it in", async () => {
  const repoRoot = tempRepoWithSkill("search-jobs");
  const env = { CAREERRAT_CHAT_SKILLS: "search-jobs" };
  const binDir = selectFakeClaudeRuntime({ repoRoot, env });
  let spawned = false;
  const runtime = createChatRuntime({
    repoRoot,
    env,
    runInstalledRuntimeStreamImpl: async () => {
      spawned = true;
      throw new Error("must not spawn");
    },
  });
  try {
    await assert.rejects(
      runtime.startSession({ skill: "search-jobs", input: "search" }),
      (error) =>
        error.code === "SKILL_NOT_ALLOWED" && /dedicated CareerRat workflow/i.test(error.message)
    );
    assert.equal(spawned, false);
  } finally {
    runtime.shutdown();
    cleanup(repoRoot);
    cleanup(binDir);
  }
});

test("createChatRuntime.startSession: rejects with NO_AI_ROUTE before touching the SDK loader", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  let loadSdkCalled = false;
  try {
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: {},
      loadSdk: async () => {
        loadSdkCalled = true;
        throw new Error("should never be called");
      },
    });
    await assert.rejects(
      chatRuntime.startSession({ skill: "ingest-profile" }),
      (err) => err.code === "NO_AI_ROUTE"
    );
    assert.equal(loadSdkCalled, false);
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime.startSession: SDK_NOT_INSTALLED from a rejecting loadSdk propagates its code", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      loadSdk: async () => {
        const err = new Error("@anthropic-ai/claude-agent-sdk is not installed");
        err.code = "SDK_NOT_INSTALLED";
        throw err;
      },
    });
    await assert.rejects(
      chatRuntime.startSession({ skill: "ingest-profile" }),
      (err) => err.code === "SDK_NOT_INSTALLED"
    );
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime.startSession: a live duplicate for the same skill is rejected with the existing chatId", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      loadSdk: async () => fakeStreamingSdk([[]]),
    });
    try {
      const first = await chatRuntime.startSession({ skill: "ingest-profile" });
      await assert.rejects(
        chatRuntime.startSession({ skill: "ingest-profile" }),
        (err) => err.code === "DUPLICATE_SESSION" && err.chatId === first.chatId
      );
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime.startSession: the session past maxSessions is rejected MAX_SESSIONS", async () => {
  const repoRoot = tempRepoWithSkill(["a", "b", "c"]);
  try {
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test", CAREERRAT_CHAT_SKILLS: "a,b,c" },
      maxSessions: 2,
      loadSdk: async () => fakeStreamingSdk([[]]),
    });
    try {
      await chatRuntime.startSession({ skill: "a" });
      await chatRuntime.startSession({ skill: "b" });
      await assert.rejects(
        chatRuntime.startSession({ skill: "c" }),
        (err) => err.code === "MAX_SESSIONS"
      );
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("chat-runtime source resolves a local-read or network-only profile per skill", () => {
  const source = stripJavaScriptComments(readFileSync("src/core/ai/chat-runtime.mjs", "utf8"));
  assert.match(source, /resolveChatRuntimeTools/);
  assert.doesNotMatch(source, /\bRUNTIME_TOOLS\b/);
});

test("createChatRuntime.startSession: visible board research gets network-only tools while onboarding keeps local reads", async () => {
  const repoRoot = tempRepoWithSkill(["ingest-profile", "research-boards", "discover-companies"]);
  try {
    const seenToolsBySkill = new Map();
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        CAREERRAT_CHAT_SKILLS: "ingest-profile,research-boards,discover-companies",
      },
      loadSdk: async () => ({
        query: (args) => {
          seenToolsBySkill.set(args.options.skills[0], [...args.options.tools]);
          return fakeStreamingSdk([[]]).query(args);
        },
      }),
    });
    try {
      await chatRuntime.startSession({ skill: "ingest-profile" });
      await chatRuntime.startSession({ skill: "research-boards" });
      assert.deepEqual(seenToolsBySkill.get("ingest-profile"), [...APP_SAFE_RUNTIME_TOOLS]);
      assert.deepEqual(seenToolsBySkill.get("research-boards"), [...CHAT_RUNTIME_TOOLS]);
      assert.equal(seenToolsBySkill.has("discover-companies"), false);
      assert.equal(seenToolsBySkill.get("research-boards").includes("Read"), false);
      assert.equal(seenToolsBySkill.get("ingest-profile").includes("WebSearch"), false);
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Happy path — the full multi-turn pump loop
// ---------------------------------------------------------------------------

test("createChatRuntime: 3 turns drive 3 idle transitions and write 3 byok usage rows (temp repoRoot)", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const turns = [turnMessages(1), turnMessages(2), turnMessages(3)];
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      loadSdk: async () => fakeStreamingSdk(turns),
    });
    try {
      const { chatId, state } = await chatRuntime.startSession({ skill: "ingest-profile" });
      assert.equal(state, "running");

      const events = subscribeCollect(chatRuntime, chatId);
      const idleCount = () =>
        events.filter((e) => e.type === "chat_state" && e.data.state === "idle").length;
      const runningCount = () =>
        events.filter((e) => e.type === "chat_state" && e.data.state === "running").length;

      await waitForPredicate(() => idleCount() >= 1);
      chatRuntime.postMessage(chatId, "answer 1");
      await waitForPredicate(() => idleCount() >= 2);
      chatRuntime.postMessage(chatId, "answer 2");
      await waitForPredicate(() => idleCount() >= 3);

      assert.equal(idleCount(), 3);
      // Only two postMessage() calls happened (the session starts already
      // "running" from session creation, so that first turn's completion is
      // the only idle transition not preceded by a postMessage-driven
      // "running" broadcast).
      assert.equal(runningCount(), 2);
      assert.equal(chatRuntime.getSession(chatId).state, "idle");

      const rows = readUsageEvents({ root: repoRoot });
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.equal(row.source, "byok");
        assert.equal(row.skill, "ingest-profile");
        assert.equal(row.model, "claude-sonnet-5");
      }
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime: broadcasts a typed yes-no mode and strips its control fence", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
  candidateSetupInitialize({ repoRoot, env });
  try {
    const reply = [
      "Do you require employment sponsorship?",
      "```careerrat:answer",
      '{"mode":"yes-no"}',
      "```",
    ].join("\n");
    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => fakeStreamingSdk([turnMessagesWithReply(reply)]),
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      const events = subscribeCollect(chatRuntime, chatId);
      await waitForPredicate(() => events.some((event) => event.type === "assistant"));

      const assistant = events.find((event) => event.type === "assistant");
      assert.equal(assistant.data.answerMode, "yes-no");
      assert.equal(
        assistant.data.message.content[0].text,
        "Do you require employment sponsorship?"
      );
      const stored = skillChatThreadRead({ repoRoot, env, skill: "ingest-profile" }).messages[0];
      assert.equal(stored.text, "Do you require employment sponsorship?");
      assert.equal(stored.metadata.answerMode, undefined);
      assert.equal(stored.metadata.choicePrompt.mode, "binary");
      assert.equal(stored.metadata.choicePrompt.messageId, stored.id);
      assert.equal(stored.metadata.choicePrompt.state, "pending");
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("binary fallback rejects compound questions whose clauses can have different answers", () => {
  assert.equal(
    isPlainYesNoQuestion(
      "Are you authorized to work in the US and will you need employment sponsorship?"
    ),
    false
  );
  assert.equal(
    isPlainYesNoQuestion("Do you want remote work and are you open to relocating?"),
    false
  );
});

test("binary fallback accepts a short lead-in before the terminal yes-or-no question", () => {
  assert.equal(isPlainYesNoQuestion("One quick check: should I save these settings?"), true);
  assert.equal(
    isPlainYesNoQuestion("I have the search details I need.\nShould I start the search now?"),
    true
  );
});

test("explicit answer metadata cannot turn an either-or choice into Yes and No", () => {
  const parsed = parseChatAnswerMode(
    [
      "Should I keep waiting or focus on the job boards?",
      "```careerrat:answer",
      '{"mode":"yes-no"}',
      "```",
    ].join("\n")
  );

  assert.equal(parsed.text, "Should I keep waiting or focus on the job boards?");
  assert.equal(parsed.answerMode, null);
});

test("createChatRuntime: a replacement process waits on the durable unanswered assistant question and resumes with full history", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
  candidateSetupInitialize({ repoRoot, env });
  try {
    const firstRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () =>
        fakeStreamingSdk([
          turnMessagesWithReply("Which locations work for you?", 1),
          turnMessagesWithReply("What is your minimum base salary?", 2),
        ]),
    });
    const first = await firstRuntime.startSession({ skill: "ingest-profile" });
    await waitForPredicate(() => firstRuntime.getSession(first.chatId)?.state === "idle");
    firstRuntime.postMessage(first.chatId, "Remote in the US works for me.");
    await waitForPredicate(() => firstRuntime.getSession(first.chatId)?.state === "idle");
    firstRuntime.shutdown();

    const resumedInputs = [];
    const replacementRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () =>
        fakeStreamingSdk([turnMessagesWithReply("Thanks, I have the full context.", 3)], {
          onTurnInput: (input) => resumedInputs.push(input.message.content),
        }),
    });
    try {
      const resumed = await replacementRuntime.startSession({ skill: "ingest-profile" });
      assert.equal(resumed.state, "idle");
      assert.equal(resumedInputs.length, 0, "reopening must not duplicate an unanswered question");

      replacementRuntime.postMessage(resumed.chatId, "$200,000 base.");
      await waitForPredicate(() => replacementRuntime.getSession(resumed.chatId)?.state === "idle");
      assert.equal(resumedInputs.length, 1);
      assert.match(resumedInputs[0], /Which locations work for you\?/);
      assert.match(resumedInputs[0], /Remote in the US works for me\./);
      assert.match(resumedInputs[0], /What is your minimum base salary\?/);
      assert.match(resumedInputs[0], /\$200,000 base\./);
      assert.match(resumedInputs[0], /durable conversation/i);
    } finally {
      replacementRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime: visible research chats persist their typed handoff and reopen without duplicating the finished turn", async () => {
  const repoRoot = tempRepoWithSkill("research-company");
  const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
  candidateSetupInitialize({ repoRoot, env });
  const typedReply =
    'Research ready.\n\n```careerrat:discovery\n{"kind":"company_research_result","company":"Acme","slug":"acme","markdown":"research"}\n```';
  try {
    const firstRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => fakeStreamingSdk([turnMessagesWithReply(typedReply, 1)]),
    });
    const first = await firstRuntime.startSession({ skill: "research-company" });
    await waitForPredicate(() => firstRuntime.getSession(first.chatId)?.state === "idle");
    firstRuntime.shutdown();

    const stored = skillChatThreadRead({ repoRoot, env, skill: "research-company" });
    assert.equal(stored.messages.length, 1);
    assert.equal(stored.messages[0].text, typedReply);
    assert.equal(stored.thread.turnState, "awaiting-user");

    const resumedInputs = [];
    const replacementRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () =>
        fakeStreamingSdk([turnMessagesWithReply("Continued.", 2)], {
          onTurnInput: (input) => resumedInputs.push(input.message.content),
        }),
    });
    try {
      const resumed = await replacementRuntime.startSession({ skill: "research-company" });
      assert.equal(resumed.state, "idle");
      assert.equal(resumedInputs.length, 0);
    } finally {
      replacementRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime: board research persists one validated review artifact instead of model tables or ledgers", async () => {
  const repoRoot = tempRepoWithSkill("research-boards");
  const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
  candidateSetupInitialize({ repoRoot, env });
  const candidates = [
    ["LandEarly", "https://www.landearly.com/remote-jobs/platform-engineer", "url-query", "high"],
    ["4 Day Week", "https://4dayweek.io/platform-engineering-jobs", "url-query", "high"],
    [
      "TrulyRemote Dev",
      "https://trulyremote.dev/remote-backend-engineer-jobs",
      "url-query",
      "high",
    ],
    [
      "Built In",
      "https://builtin.com/jobs/remote/dev-engineering/search/platform-engineer",
      "url-query",
      "high",
    ],
    [
      "RemotePilot",
      "https://remotepilot.dev/categories/backend-engineering/",
      "url-query",
      "borderline",
    ],
    ["DevJobsList", "https://www.devjobslist.com/", "browser", "borderline"],
  ].map(([label, url, sourceType, confidence]) => ({
    label,
    url,
    sourceType,
    why: `${label} has dated relevant listings`,
    status: "proposed",
    confidence,
  }));
  candidates.push({
    label: "Anywhere Devs",
    url: "https://anywheredevs.com/",
    sourceType: "browser",
    why: "The landing page exposes no specific listings",
    status: "rejected",
    rejectionReason: "no visible dated listing",
  });
  const reply = [
    "| # | Board | Status |",
    "|---|---|---|",
    "| 1 | LandEarly | NEW |",
    "BOARDS FOUND: 7 screened",
    "```careerrat:discovery",
    JSON.stringify({ kind: "source_review", candidates }),
    "```",
  ].join("\n");
  try {
    const runtime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => fakeStreamingSdk([turnMessagesWithReply(reply, 1)]),
    });
    const started = await runtime.startSession({ skill: "research-boards" });
    await waitForPredicate(() => runtime.getSession(started.chatId)?.state === "idle");
    runtime.shutdown();

    const stored = skillChatThreadRead({ repoRoot, env, skill: "research-boards" });
    assert.equal(stored.messages.length, 1);
    assert.equal(stored.messages[0].text, "I found 6 useful sources. Nothing has been added yet.");
    assert.equal(stored.messages[0].artifacts.length, 1);
    assert.equal(stored.messages[0].artifacts[0].kind, "source_review");
    assert.equal(stored.messages[0].artifacts[0].candidates.length, 7);
    assert.equal(
      stored.messages[0].artifacts[0].candidates[6].rejectionReason,
      "no visible dated listing"
    );
    assert.doesNotMatch(JSON.stringify(stored), /BOARDS FOUND|\| # \| Board|careerrat:discovery/);
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime: malformed board-review output persists a readable retry without protocol", async () => {
  const repoRoot = tempRepoWithSkill("research-boards");
  const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
  candidateSetupInitialize({ repoRoot, env });
  const reply = [
    "```careerrat:discovery",
    '{"kind":"source_review","candidates":[{"label":"Bad","url":"file:///etc/passwd"}]}',
    "```",
  ].join("\n");
  try {
    const runtime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => fakeStreamingSdk([turnMessagesWithReply(reply, 1)]),
    });
    const started = await runtime.startSession({ skill: "research-boards" });
    await waitForPredicate(() => runtime.getSession(started.chatId)?.state === "idle");
    runtime.shutdown();

    const stored = skillChatThreadRead({ repoRoot, env, skill: "research-boards" });
    assert.equal(stored.messages[0].text, "I couldn't prepare the source review. Run it again.");
    assert.deepEqual(stored.messages[0].artifacts, []);
    assert.doesNotMatch(JSON.stringify(stored), /file:\/\/|careerrat:discovery/);
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime: board research suppresses intermediate prose and persists one fallback when no artifact arrives", async () => {
  const repoRoot = tempRepoWithSkill("research-boards");
  const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
  candidateSetupInitialize({ repoRoot, env });
  const result = turnMessages(1)[1];
  const assistant = (text) => ({
    type: "assistant",
    session_id: "sdk-session-1",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text }] },
  });
  try {
    const runtime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () =>
        fakeStreamingSdk([
          [assistant("Searching the web now."), assistant("I found some sources."), result],
        ]),
    });
    const started = await runtime.startSession({ skill: "research-boards" });
    const events = subscribeCollect(runtime, started.chatId);
    await waitForPredicate(() => runtime.getSession(started.chatId)?.state === "idle");
    runtime.shutdown();

    const stored = skillChatThreadRead({ repoRoot, env, skill: "research-boards" });
    assert.equal(stored.messages.length, 1);
    assert.equal(stored.messages[0].text, "I couldn't prepare the source review. Run it again.");
    assert.equal(
      events.filter((event) => event.type === "assistant").length,
      1,
      "intermediate model narration must not become transcript messages"
    );
    assert.doesNotMatch(JSON.stringify(stored), /Searching the web now|I found some sources/);
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime: visible research chats persist terminal runtime errors", async () => {
  const repoRoot = tempRepoWithSkill("research-company");
  const env = {};
  candidateSetupInitialize({ repoRoot, env });
  selectInstalledRuntime({ repoRoot, env });
  try {
    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => {
        throw new Error("Agent SDK must not load for an installed route");
      },
      runInstalledRuntimeImpl: async () => {
        throw new Error("Research timed out.");
      },
    });
    try {
      const started = await chatRuntime.startSession({ skill: "research-company" });
      await waitForPredicate(() => chatRuntime.getSession(started.chatId)?.state === "idle");
      const stored = skillChatThreadRead({ repoRoot, env, skill: "research-company" });
      assert.equal(stored.messages.length, 1);
      assert.equal(stored.messages[0].kind, "agent_error");
      assert.equal(stored.messages[0].text, "Research timed out.");
      assert.equal(stored.thread.turnState, "failed");
    } finally {
      chatRuntime.shutdown();
    }

    let resumedRuns = 0;
    const replacementRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => {
        throw new Error("Agent SDK must not load for an installed route");
      },
      runInstalledRuntimeImpl: async () => {
        resumedRuns += 1;
        return { text: "Retried.", model: null, usage: null };
      },
    });
    try {
      const resumed = await replacementRuntime.startSession({ skill: "research-company" });
      assert.equal(resumed.state, "idle");
      assert.equal(resumedRuns, 0, "reopening a failed thread must not start a hidden retry");
    } finally {
      replacementRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime: SDK pump failures persist once and reopen visibly without a hidden retry", async () => {
  const repoRoot = tempRepoWithSkill("research-company");
  const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
  candidateSetupInitialize({ repoRoot, env });
  const failingSdk = {
    query: () => {
      async function* events() {
        yield { type: "system", subtype: "init", session_id: "sdk-failed" };
        throw new Error("SDK research connection failed.");
      }
      const stream = events();
      stream.interrupt = async () => {};
      stream.close = () => {};
      return stream;
    },
  };
  try {
    const chatRuntime = createChatRuntime({ repoRoot, env, loadSdk: async () => failingSdk });
    const started = await chatRuntime.startSession({ skill: "research-company" });
    await waitForPredicate(() => chatRuntime.getSession(started.chatId)?.state === "closed");
    chatRuntime.shutdown();

    const stored = skillChatThreadRead({ repoRoot, env, skill: "research-company" });
    assert.equal(stored.messages.length, 1);
    assert.equal(stored.messages[0].kind, "agent_error");
    assert.equal(stored.messages[0].text, "SDK research connection failed.");
    assert.equal(stored.thread.turnState, "failed");

    const resumedInputs = [];
    const replacementRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () =>
        fakeStreamingSdk([turnMessagesWithReply("Retried.", 2)], {
          onTurnInput: (input) => resumedInputs.push(input.message.content),
        }),
    });
    try {
      const resumed = await replacementRuntime.startSession({ skill: "research-company" });
      assert.equal(resumed.state, "idle");
      assert.equal(resumedInputs.length, 0);
    } finally {
      replacementRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime: a user answer committed before process death is answered after restart", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
  candidateSetupInitialize({ repoRoot, env });
  try {
    let secondTurnReceived = false;
    const firstRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () =>
        fakeStreamingSdk([turnMessagesWithReply("Which locations work for you?", 1), []], {
          onTurnInput: () => {
            if (firstRuntime.listSessions()[0]?.state === "running") {
              secondTurnReceived = true;
            }
          },
        }),
    });
    const first = await firstRuntime.startSession({ skill: "ingest-profile" });
    await waitForPredicate(() => firstRuntime.getSession(first.chatId)?.state === "idle");
    secondTurnReceived = false;
    firstRuntime.postMessage(first.chatId, "Remote in the US works for me.");
    await waitForPredicate(() => secondTurnReceived);
    firstRuntime.shutdown();

    const resumedInputs = [];
    const replacementRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () =>
        fakeStreamingSdk([turnMessagesWithReply("What is your minimum base salary?", 2)], {
          onTurnInput: (input) => resumedInputs.push(input.message.content),
        }),
    });
    try {
      const resumed = await replacementRuntime.startSession({ skill: "ingest-profile" });
      assert.equal(resumed.state, "running");
      await waitForPredicate(() => replacementRuntime.getSession(resumed.chatId)?.state === "idle");
      assert.equal(resumedInputs.length, 1);
      assert.match(resumedInputs[0], /Which locations work for you\?/);
      assert.match(resumedInputs[0], /Remote in the US works for me\./);
    } finally {
      replacementRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime: installed runtime replacement also waits and replays the durable onboarding thread", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const env = {};
  candidateSetupInitialize({ repoRoot, env });
  selectInstalledRuntime({ repoRoot, env });
  const prompts = [];
  try {
    const firstRuntime = createChatRuntime({
      repoRoot,
      env,
      runInstalledRuntimeImpl: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          text:
            prompts.length === 1
              ? "Which locations work for you?"
              : "What is your minimum base salary?",
          usage: null,
          model: null,
        };
      },
    });
    const first = await firstRuntime.startSession({ skill: "ingest-profile" });
    await waitForPredicate(() => firstRuntime.getSession(first.chatId)?.state === "idle");
    firstRuntime.postMessage(first.chatId, "Remote in the US works for me.");
    await waitForPredicate(() => firstRuntime.getSession(first.chatId)?.state === "idle");
    firstRuntime.shutdown();

    const replacementRuntime = createChatRuntime({
      repoRoot,
      env,
      runInstalledRuntimeImpl: async ({ prompt }) => {
        prompts.push(prompt);
        return { text: "Thanks, I have the full context.", usage: null, model: null };
      },
    });
    try {
      const resumed = await replacementRuntime.startSession({ skill: "ingest-profile" });
      assert.equal(resumed.state, "idle");
      assert.equal(prompts.length, 2, "reopening must not invoke the installed runtime");

      replacementRuntime.postMessage(resumed.chatId, "$200,000 base.");
      await waitForPredicate(() => replacementRuntime.getSession(resumed.chatId)?.state === "idle");
      assert.equal(prompts.length, 3);
      assert.match(prompts[2], /Which locations work for you\?/);
      assert.match(prompts[2], /Remote in the US works for me\./);
      assert.match(prompts[2], /What is your minimum base salary\?/);
      assert.match(prompts[2], /\$200,000 base\./);
      assert.match(prompts[2], /durable history/i);
    } finally {
      replacementRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime: ignores an obsolete onboarding draft when the canonical thread is empty", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
  candidateSetupInitialize({ repoRoot, env });
  const internalDir = join(repoRoot, ".careerrat", "internal");
  mkdirSync(internalDir, { recursive: true });
  writeFileSync(
    join(internalDir, "onboarding-draft.json"),
    JSON.stringify({
      transcript: [
        { role: "assistant", text: "Which locations work for you?" },
        { role: "user", text: "Remote in the US works for me." },
        { role: "assistant", text: "What is your minimum base salary?" },
      ],
    }),
    "utf8"
  );
  const chatRuntime = createChatRuntime({
    repoRoot,
    env,
    loadSdk: async () => {
      throw new Error("intentional SDK load failure");
    },
  });
  try {
    await assert.rejects(
      chatRuntime.startSession({ skill: "ingest-profile" }),
      /intentional SDK load failure/
    );
    const db = openDb({ repoRoot, env });
    assert.equal(db.prepare("SELECT count(*) AS count FROM skill_chat_threads").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM skill_chat_messages").get().count, 0);
  } finally {
    chatRuntime.shutdown();
    cleanup(repoRoot);
  }
});

test("createChatRuntime: assistant text without a terminal result resumes the interrupted turn", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
  candidateSetupInitialize({ repoRoot, env });
  try {
    let assistantWasEmitted = false;
    const firstRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () =>
        fakeStreamingSdk([[turnMessagesWithReply("I found your resume. Checking it now.", 1)[0]]], {
          onTurnInput: () => {
            assistantWasEmitted = true;
          },
        }),
    });
    await firstRuntime.startSession({ skill: "ingest-profile" });
    await waitForPredicate(() => assistantWasEmitted);
    await waitForPredicate(() => {
      const db = openDb({ repoRoot, env });
      return db.prepare("SELECT count(*) AS count FROM skill_chat_messages").get().count === 1;
    });
    firstRuntime.shutdown();

    const resumedInputs = [];
    const replacementRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () =>
        fakeStreamingSdk([turnMessagesWithReply("What role are you targeting?", 2)], {
          onTurnInput: (input) => resumedInputs.push(input.message.content),
        }),
    });
    try {
      const resumed = await replacementRuntime.startSession({ skill: "ingest-profile" });
      assert.equal(resumed.state, "running");
      await waitForPredicate(() => replacementRuntime.getSession(resumed.chatId)?.state === "idle");
      assert.equal(resumedInputs.length, 1);
      assert.match(resumedInputs[0], /I found your resume\. Checking it now\./);
    } finally {
      replacementRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime: proxy route writes NO usage_event of its own (the proxy already metered it)", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: {
        CAREERRAT_AI_PROXY_URL: "http://127.0.0.1:7788",
        CAREERRAT_AI_PROXY_TOKEN: "devtoken",
      },
      loadSdk: async () => fakeStreamingSdk([turnMessages(1)]),
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "idle");
      assert.deepEqual(readUsageEvents({ root: repoRoot }), []);
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Mid-turn throw -> closed + error event
// ---------------------------------------------------------------------------

test("createChatRuntime: a mid-turn throw (not our own abort) closes the session and emits an error event", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      loadSdk: async () => ({
        query: () => {
          async function* gen() {
            yield { type: "system", subtype: "init", session_id: "s1" };
            throw new Error("boom mid-turn");
          }
          const it = gen();
          it.interrupt = async () => {};
          it.close = () => {};
          it.return = async () => ({ value: undefined, done: true });
          return it;
        },
      }),
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      const events = subscribeCollect(chatRuntime, chatId);
      await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "closed");

      const errorEvt = events.find((e) => e.type === "error");
      assert.ok(errorEvt, "expected an error event");
      assert.match(errorEvt.data.message, /boom mid-turn/);

      const lastChatState = events.filter((e) => e.type === "chat_state").pop();
      assert.equal(lastChatState.data.state, "closed");
      assert.equal(lastChatState.data.reason, "error");
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// postMessage / interrupt / closeSession error codes
// ---------------------------------------------------------------------------

test("createChatRuntime.postMessage: empty text is rejected EMPTY_TEXT", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      loadSdk: async () => fakeStreamingSdk([turnMessages(1)]),
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      assert.throws(
        () => chatRuntime.postMessage(chatId, "   "),
        (err) => err.code === "EMPTY_TEXT"
      );
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime.postMessage: unknown chatId is NOT_FOUND, closed session is SESSION_CLOSED", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      loadSdk: async () => fakeStreamingSdk([turnMessages(1)]),
    });
    try {
      assert.throws(
        () => chatRuntime.postMessage("nope", "hi"),
        (err) => err.code === "NOT_FOUND"
      );
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      chatRuntime.closeSession(chatId);
      assert.throws(
        () => chatRuntime.postMessage(chatId, "hi"),
        (err) => err.code === "SESSION_CLOSED"
      );
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime.interrupt: not-running is NOT_RUNNING, unknown chatId is NOT_FOUND", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      loadSdk: async () => fakeStreamingSdk([turnMessages(1)]),
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "idle");
      await assert.rejects(chatRuntime.interrupt(chatId), (err) => err.code === "NOT_RUNNING");
      await assert.rejects(chatRuntime.interrupt("nope"), (err) => err.code === "NOT_FOUND");
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime.closeSession: calls the fake query's close()+abort, unknown chatId is NOT_FOUND", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    let closeCalled = false;
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      loadSdk: async () =>
        fakeStreamingSdk([turnMessages(1)], { onClose: () => (closeCalled = true) }),
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      const result = chatRuntime.closeSession(chatId, "user_closed");
      assert.equal(result.state, "closed");
      assert.equal(closeCalled, true);
      assert.throws(
        () => chatRuntime.closeSession("nope"),
        (err) => err.code === "NOT_FOUND"
      );
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// sweepOnce — injected `now`, idle eviction, closed-record pruning
// ---------------------------------------------------------------------------

test("createChatRuntime.sweepOnce: evicts an idle session past idleTtlMs via the real close path", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    let closeCalled = false;
    let t = 1000;
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      now: () => t,
      idleTtlMs: 1000,
      closedTtlMs: 500,
      loadSdk: async () =>
        fakeStreamingSdk([turnMessages(1)], { onClose: () => (closeCalled = true) }),
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "idle");

      t += 5000; // well past idleTtlMs
      chatRuntime.sweepOnce();

      assert.equal(chatRuntime.getSession(chatId).state, "closed");
      assert.equal(closeCalled, true);

      t += 5000; // well past closedTtlMs too
      chatRuntime.sweepOnce();
      assert.equal(chatRuntime.getSession(chatId), null); // pruned out of the map
    } finally {
      chatRuntime.stopSweep();
    }
  } finally {
    cleanup(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// shutdown — closes every live session, stops the sweep timer
// ---------------------------------------------------------------------------

test("createChatRuntime.shutdown: closes every live session (fake close called for each)", async () => {
  const repoRoot = tempRepoWithSkill(["ingest-profile", "evaluate-job"]);
  try {
    let closeCount = 0;
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        CAREERRAT_CHAT_SKILLS: "ingest-profile,evaluate-job",
      },
      loadSdk: async () => fakeStreamingSdk([[]], { onClose: () => closeCount++ }),
    });
    const a = await chatRuntime.startSession({ skill: "ingest-profile" });
    const b = await chatRuntime.startSession({ skill: "evaluate-job" });

    chatRuntime.shutdown();

    assert.equal(chatRuntime.getSession(a.chatId).state, "closed");
    assert.equal(chatRuntime.getSession(b.chatId).state, "closed");
    assert.equal(closeCount, 2);
  } finally {
    cleanup(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// route.type === "installed" — the HIGH-severity fix: a chat session must
// run turns through the selected installed CLI, never fall into the Agent
// SDK child (which only ever knows byok/proxy, and would otherwise silently
// use whatever local `claude` CLI happens to be logged in).
// ---------------------------------------------------------------------------

test("createChatRuntime.startSession (installed route): runs turns through the stubbed installed runtime, never touches loadSdk, and turn 2's prompt carries the prior transcript", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const env = {};
    selectInstalledRuntime({ repoRoot, env });

    const calls = [];
    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => {
        throw new Error("Agent SDK must not load for an installed route");
      },
      runInstalledRuntimeImpl: async (args) => {
        calls.push(args);
        return { text: `Reply ${calls.length}`, usage: null, model: null };
      },
    });
    try {
      const { chatId, state } = await chatRuntime.startSession({ skill: "ingest-profile" });
      assert.equal(state, "running");

      const events = subscribeCollect(chatRuntime, chatId);
      const idleCount = () =>
        events.filter((e) => e.type === "chat_state" && e.data.state === "idle").length;

      await waitForPredicate(() => idleCount() >= 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].runtime.id, "codex");
      assert.deepEqual(calls[0].tools, ["Skill"]);
      assert.equal(
        calls[0].tools.some((tool) => ["Read", "Glob", "Grep"].includes(tool)),
        false
      );
      assert.match(calls[0].prompt, /can only return its bounded model result/i);
      assert.doesNotMatch(calls[0].prompt, /\.agents\/skills\/ingest-profile\/SKILL\.md/);
      assert.doesNotMatch(calls[0].prompt, /Reply 1/); // turn 1 has no prior transcript yet
      // Chat-appropriate closing instruction, never the one-shot
      // buildInstalledRuntimePrompt line — that line would tell the model to
      // dump a single final answer instead of asking one question and
      // waiting, fighting the CONVERSATIONAL_POSTURE text baked into system.
      assert.match(calls[0].prompt, /ask exactly one question/);
      assert.doesNotMatch(calls[0].prompt, /return only the requested final answer/);

      chatRuntime.postMessage(chatId, "answer 1");
      await waitForPredicate(() => idleCount() >= 2);

      assert.equal(calls.length, 2);
      assert.equal(calls[1].runtime.id, "codex");
      // Turn 2's prompt replays turn 1's reply plus the just-posted user
      // message — the "stateless statelessly-replayed transcript" this fix
      // requires, since the installed-runtime call itself is one-shot.
      assert.match(calls[1].prompt, /Reply 1/);
      assert.match(calls[1].prompt, /answer 1/);
      assert.match(calls[1].prompt, /ask exactly one question/);
      assert.doesNotMatch(calls[1].prompt, /return only the requested final answer/);

      const assistantEvents = events.filter((e) => e.type === "assistant");
      assert.equal(assistantEvents.length, 2);
      assert.equal(assistantEvents[0].data.message.content[0].text, "Reply 1");
      assert.equal(assistantEvents[1].data.message.content[0].text, "Reply 2");

      assert.equal(idleCount(), 2);
      assert.equal(chatRuntime.getSession(chatId).state, "idle");
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

// P0 regression — a CHAT_RUNTIME_TOOLS session (research-company,
// research-comp, company-health, research-boards) grants only WebSearch/
// WebFetch/Skill, never Read, so it depends entirely on the Skill tool to
// reach its own SKILL.md through the installed "claude" CLI. That only works
// if runInstalledTurn threads `skill` + `repoRoot` through to
// runInstalledRuntimeImpl on every turn, so installed-runtimes.mjs can
// materialize an isolated cwd and swap --safe-mode for --setting-sources
// project (see tests/installed-runtime.test.mjs for that half of the fix).
// This test pins the wiring at the chat-runtime layer: both the session's
// kickoff call and every follow-up postMessage() turn must carry them.
test("createChatRuntime.startSession (installed route): threads skill + repoRoot + the extended chat-session timeout into every runInstalledRuntimeImpl call so the CLI can materialize an isolated skill cwd and finish real research", async () => {
  const repoRoot = tempRepoWithSkill("research-company");
  try {
    const env = {};
    selectInstalledRuntime({ repoRoot, env });
    const calls = [];
    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      runInstalledRuntimeImpl: async (args) => {
        calls.push(args);
        return { text: `Reply ${calls.length}`, usage: null, model: null };
      },
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "research-company" });
      const events = subscribeCollect(chatRuntime, chatId);
      const idleCount = () =>
        events.filter((e) => e.type === "chat_state" && e.data.state === "idle").length;
      await waitForPredicate(() => idleCount() >= 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].skill, "research-company");
      assert.equal(calls[0].repoRoot, repoRoot);
      assert.deepEqual(calls[0].tools, [...CHAT_RUNTIME_TOOLS]);
      assert.match(calls[0].prompt, /Research is read-only.*visible app-owned action/i);
      // P0 regression: a live six-axis research turn over WebSearch/WebFetch
      // reliably exceeds runInstalledRuntime's ONE_SHOT_RUNTIME_TIMEOUT_MS
      // default (wave-4 packaged QA: two consecutive SSE-confirmed
      // "Installed AI request timed out." failures on research-company and
      // research-comp). Every chat-session turn must opt into the wider
      // CHAT_SESSION_RUNTIME_TIMEOUT_MS tier instead of the one-shot default.
      assert.equal(calls[0].timeoutMs, CHAT_SESSION_RUNTIME_TIMEOUT_MS);

      chatRuntime.postMessage(chatId, "keep going");
      await waitForPredicate(() => idleCount() >= 2);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].skill, "research-company");
      assert.equal(calls[1].repoRoot, repoRoot);
      assert.equal(calls[1].timeoutMs, CHAT_SESSION_RUNTIME_TIMEOUT_MS);
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// The bug this fix closes: startInstalledSession never called loadSdk, so an
// installed "claude" chat turn only ever had ONE json envelope to work with,
// at process exit — no tool_use/tool_result activity ever rendered while a
// turn was running (PR #171's ChatActivityLine had nothing to draw on this
// route). runInstalledTurn now calls runInstalledRuntimeStreamImpl instead of
// runInstalledRuntimeImpl whenever supportsInstalledRuntimeStreaming(runtime.id)
// is true (today, only "claude"), dispatching each tool_use/tool_result frame
// (mapped via skill-runtime.mjs's own mapSdkMessage — the same mapper the SDK
// route's pump() uses) the moment it arrives, while the final assistant
// message/usage/chat_state transition stay sourced from the resolved
// {text, usage, model}, exactly like the one-shot path.
// ---------------------------------------------------------------------------

test("createChatRuntime (installed route, claude): streams tool_use/tool_result frames as they arrive, then the same final assistant/result/usage shape as the one-shot path", async () => {
  const repoRoot = tempRepoWithSkill("research-company");
  try {
    const env = {};
    selectFakeClaudeRuntime({ repoRoot, env });
    const calls = [];
    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      runInstalledRuntimeImpl: async () => {
        throw new Error(
          "the one-shot runtime must never be called for a streaming-capable runtime"
        );
      },
      runInstalledRuntimeStreamImpl: async (args) => {
        calls.push(args);
        // Simulate the real CLI's NDJSON arriving one message at a time,
        // synchronously — same as installed-runtimes.mjs's real pump calling
        // onMessage off each parsed stdout line.
        args.onMessage({
          type: "assistant",
          session_id: "sess-1",
          message: {
            content: [{ type: "tool_use", id: "tu1", name: "WebSearch", input: { q: "acme" } }],
          },
        });
        args.onMessage({
          type: "user",
          session_id: "sess-1",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tu1", content: "acme is fine", is_error: false },
            ],
          },
        });
        return {
          text: "Acme looks healthy.",
          usage: { input_tokens: 12, output_tokens: 6 },
          model: "claude-sonnet",
        };
      },
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "research-company" });
      const events = subscribeCollect(chatRuntime, chatId);
      await waitForPredicate(() =>
        events.some((e) => e.type === "chat_state" && e.data.state === "idle")
      );

      assert.equal(calls.length, 1, "the streaming impl must be called, not the one-shot impl");
      assert.equal(calls[0].skill, "research-company");
      assert.equal(calls[0].timeoutMs, CHAT_SESSION_RUNTIME_TIMEOUT_MS);
      assert.equal(typeof calls[0].onMessage, "function");

      const toolUse = events.find((e) => e.type === "tool_use");
      assert.ok(toolUse, "expected a tool_use frame streamed before the turn finished");
      assert.equal(toolUse.data.id, "tu1");
      assert.equal(toolUse.data.name, "WebSearch");

      const toolResult = events.find((e) => e.type === "tool_result");
      assert.ok(toolResult, "expected a tool_result frame streamed before the turn finished");
      assert.equal(toolResult.data.toolUseId, "tu1");
      assert.equal(toolResult.data.isError, false);

      // tool_use must land before tool_result, and both before the final
      // assistant/result pair — same call order the SDK route's pump()
      // guarantees via mapSdkMessage + dispatchEvents.
      const order = events.map((e) => e.type);
      assert.ok(order.indexOf("tool_use") < order.indexOf("tool_result"));
      assert.ok(order.indexOf("tool_result") < order.indexOf("assistant"));
      assert.ok(order.indexOf("assistant") < order.indexOf("result"));

      const assistantEvent = events.find((e) => e.type === "assistant");
      assert.equal(assistantEvent.data.message.content[0].text, "Acme looks healthy.");

      const resultEvent = events.find((e) => e.type === "result");
      assert.deepEqual(resultEvent.data, { ok: true });
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime (installed route, claude): a stream with an isError tool_result still surfaces it as isError:true before the turn completes", async () => {
  const repoRoot = tempRepoWithSkill("research-company");
  try {
    const env = {};
    selectFakeClaudeRuntime({ repoRoot, env });
    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      runInstalledRuntimeStreamImpl: async (args) => {
        args.onMessage({
          type: "assistant",
          session_id: "sess-1",
          message: { content: [{ type: "tool_use", id: "tu1", name: "WebFetch", input: {} }] },
        });
        args.onMessage({
          type: "user",
          session_id: "sess-1",
          message: {
            content: [{ type: "tool_result", tool_use_id: "tu1", content: "boom", is_error: true }],
          },
        });
        return { text: "Could not fetch that.", usage: null, model: null };
      },
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "research-company" });
      const events = subscribeCollect(chatRuntime, chatId);
      await waitForPredicate(() =>
        events.some((e) => e.type === "chat_state" && e.data.state === "idle")
      );
      const toolResult = events.find((e) => e.type === "tool_result");
      assert.equal(toolResult.data.isError, true);
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime (installed route): refreshes canonical onboarding state before every turn", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const env = {};
    selectInstalledRuntime({ repoRoot, env });
    let candidateContext = { profile: { candidate: { location: "Austin, TX" } } };
    const calls = [];
    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      resolveCandidateContextImpl: () => candidateContext,
      runInstalledRuntimeImpl: async (args) => {
        calls.push(args);
        return { text: `Reply ${calls.length}`, usage: null, model: null };
      },
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      const events = subscribeCollect(chatRuntime, chatId);
      const idleCount = () =>
        events.filter((event) => event.type === "chat_state" && event.data.state === "idle").length;
      await waitForPredicate(() => idleCount() >= 1);
      assert.match(calls[0].prompt, /Canonical candidate state for this turn/);
      assert.match(calls[0].prompt, /Austin, TX/);

      candidateContext = {
        profile: {
          candidate: { full_name: "Riley Chen", location: "Austin, TX" },
          compensation: { minimum_base: 190000 },
        },
      };
      chatRuntime.postMessage(chatId, "next answer");
      await waitForPredicate(() => idleCount() >= 2);
      assert.match(calls[1].prompt, /Riley Chen/);
      assert.match(calls[1].prompt, /190000/);
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("resolveCandidateChatContext includes saved evidence facts during onboarding", () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    candidateSetupInitialize({ repoRoot });
    candidateEvidenceMerge({
      repoRoot,
      claims: [
        {
          claim: "Staff Software Engineer at Acme Robotics from January 2021 through July 2026",
          evidence: "Candidate-stated during setup interview",
        },
      ],
    });

    const context = resolveCandidateChatContext({ repoRoot, skill: "ingest-profile" });
    assert.match(JSON.stringify(context), /Staff Software Engineer at Acme Robotics/);
  } finally {
    cleanup(repoRoot);
  }
});

test("resolveCandidateChatContext redacts voluntary self-identification settings", () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    candidateSetupInitialize({ repoRoot });
    candidateConfigPatch({
      repoRoot,
      name: "form-defaults",
      patch: {
        voluntary_self_identification: {
          enabled: true,
          default_action: "leave_blank",
          confirmed_at: "2026-08-26T12:00:00Z",
          answers: {
            "race ethnicity": {
              value: "private demographic answer",
              confirmed_at: "2026-08-26T12:00:00Z",
            },
          },
        },
      },
    });

    const context = resolveCandidateChatContext({ repoRoot, skill: "ingest-profile" });
    const serialized = JSON.stringify(context);
    assert.doesNotMatch(serialized, /voluntary_self_identification/);
    assert.doesNotMatch(serialized, /private demographic answer/);
    assert.doesNotMatch(serialized, /eeo_default/);
  } finally {
    cleanup(repoRoot);
  }
});

test("resolveCandidateChatContext uses the sanitized legacy candidate surface", () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    mkdirSync(join(repoRoot, "candidate"), { recursive: true });
    writeFileSync(
      join(repoRoot, "candidate/form-defaults.yml"),
      [
        "expected_base: 175000",
        "voluntary_self_identification:",
        "  enabled: true",
        "  default_action: decline_when_available",
        '  confirmed_at: "2026-08-26T12:00:00Z"',
        "  answers:",
        "    race ethnicity:",
        '      value: "private legacy demographic answer"',
        '      confirmed_at: "2026-08-26T12:00:00Z"',
        "",
      ].join("\n"),
      "utf8"
    );

    const context = resolveCandidateChatContext({ repoRoot, skill: "ingest-profile" });
    const serialized = JSON.stringify(context);
    assert.equal(context["form-defaults"].expected_base, 175000);
    assert.doesNotMatch(serialized, /voluntary_self_identification/);
    assert.doesNotMatch(serialized, /private legacy demographic answer/);
  } finally {
    cleanup(repoRoot);
  }
});

test("resolveCandidateChatContext carries the same exact 8-of-8 completion used by onboarding", () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const env = {};
    candidateSetupInitialize({ repoRoot, env });
    selectInstalledRuntime({ repoRoot, env });
    candidateConfigPatch({
      repoRoot,
      env,
      name: "profile",
      patch: {
        compensation: { minimum_base: 190000 },
        location: { home: "Austin, TX", mode_preferences_confirmed: true },
        authorization: { work_authorized: true, requires_sponsorship: false },
      },
    });
    candidateConfigPatch({
      repoRoot,
      env,
      name: "targeting",
      patch: {
        role_buckets: [
          { name: "Platform", priority: "primary", titles: ["Staff Platform Engineer"] },
        ],
        tracked_companies: ["Acme"],
        cut_signals: ["Below compensation floor"],
      },
    });
    candidateEvidenceMerge({
      repoRoot,
      env,
      claims: [{ claim: "Led a platform migration", evidence: "Resume" }],
    });
    candidateArtifactPut({
      repoRoot,
      env,
      id: "source-resume",
      kind: "source-resume",
      data: { source: "test" },
    });

    const context = resolveCandidateChatContext({ repoRoot, env, skill: "ingest-profile" });
    assert.equal(context.setupProgress.completedCount, 8);
    assert.equal(context.setupProgress.complete, true);
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime (SDK route): refreshes canonical onboarding state in every user turn", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    let candidateContext = { profile: { candidate: { location: "Austin, TX" } } };
    const turnInputs = [];
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      resolveCandidateContextImpl: () => candidateContext,
      loadSdk: async () =>
        fakeStreamingSdk([turnMessages(1), turnMessages(2)], {
          onTurnInput: (input) => turnInputs.push(input),
        }),
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      const events = subscribeCollect(chatRuntime, chatId);
      const idleCount = () =>
        events.filter((event) => event.type === "chat_state" && event.data.state === "idle").length;
      await waitForPredicate(() => idleCount() >= 1);
      assert.match(turnInputs[0].message.content, /Austin, TX/);

      candidateContext = { profile: { candidate: { full_name: "Riley Chen" } } };
      chatRuntime.postMessage(chatId, "next answer");
      await waitForPredicate(() => idleCount() >= 2);
      assert.match(turnInputs[1].message.content, /Riley Chen/);
      assert.match(turnInputs[1].message.content, /Candidate's new message:\nnext answer/);
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime (installed route): a runtime failure surfaces as an error event without closing the session, and the session keeps taking turns afterward", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const env = {};
    selectInstalledRuntime({ repoRoot, env });

    let callCount = 0;
    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => {
        throw new Error("Agent SDK must not load for an installed route");
      },
      runInstalledRuntimeImpl: async () => {
        callCount++;
        if (callCount === 1) return { text: "Reply 1", usage: null, model: null };
        if (callCount === 2) throw new Error("installed CLI exited with status 1");
        return { text: "Reply 3", usage: null, model: null };
      },
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      const events = subscribeCollect(chatRuntime, chatId);
      const idleCount = () =>
        events.filter((e) => e.type === "chat_state" && e.data.state === "idle").length;

      await waitForPredicate(() => idleCount() >= 1);

      // Turn 2 fails.
      chatRuntime.postMessage(chatId, "answer 1");
      await waitForPredicate(() => idleCount() >= 2);

      const errorEvt = events.find((e) => e.type === "error");
      assert.ok(errorEvt, "expected an error event");
      assert.match(errorEvt.data.message, /installed CLI exited with status 1/);

      // The session state machine survives: still idle, not closed, and no
      // "closed" chat_state was ever broadcast.
      assert.equal(chatRuntime.getSession(chatId).state, "idle");
      assert.equal(
        events.some((e) => e.type === "chat_state" && e.data.state === "closed"),
        false
      );

      // Turn 3 succeeds — proof the runtime actually keeps taking turns.
      chatRuntime.postMessage(chatId, "answer 2");
      await waitForPredicate(() => idleCount() >= 3);
      assert.equal(callCount, 3);
      const lastAssistant = events.filter((e) => e.type === "assistant").pop();
      assert.equal(lastAssistant.data.message.content[0].text, "Reply 3");
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime does not pass a Claude model override into a selected Codex runtime", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const env = { ANTHROPIC_MODEL: "claude-only-model" };
  const binDir = selectFakeCodexRuntime({ repoRoot, env });
  const calls = [];
  try {
    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => {
        throw new Error("Agent SDK must not load for an installed route");
      },
      runInstalledRuntimeStreamImpl: async (options) => {
        calls.push(options);
        return { text: "Reply", usage: null, model: null };
      },
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "idle");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].runtime.id, "codex");
      assert.equal(calls[0].model, undefined);
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("createChatRuntime lets Codex complete a network research skill through live activity", async () => {
  const repoRoot = tempRepoWithSkill("company-health");
  const env = {};
  const binDir = selectFakeCodexRuntime({ repoRoot, env });
  try {
    let streamCalls = 0;
    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => {
        throw new Error("Agent SDK must not load for an installed route");
      },
      runInstalledRuntimeStreamImpl: async ({ onMessage }) => {
        streamCalls++;
        onMessage({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "search-1",
                name: "WebSearch",
                input: { query: "company health" },
              },
            ],
          },
        });
        onMessage({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "search-1",
                content: "Search completed",
                is_error: false,
              },
            ],
          },
        });
        return { text: "Company health research complete.", usage: null, model: null };
      },
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "company-health" });
      const events = subscribeCollect(chatRuntime, chatId);
      await waitForPredicate(() =>
        events.some((e) => e.type === "chat_state" && e.data.state === "idle")
      );

      assert.equal(streamCalls, 1);
      assert.equal(
        events.some((event) => event.type === "error"),
        false
      );
      assert.equal(
        events.some((event) => event.type === "tool_use"),
        true
      );
      assert.equal(
        events.some((event) => event.type === "tool_result"),
        true
      );
      assert.equal(
        events.find((event) => event.type === "assistant").data.message.content[0].text,
        "Company health research complete."
      );
      assert.equal(chatRuntime.getSession(chatId).state, "idle");
      const resultEvt = events.filter((e) => e.type === "result").pop();
      assert.equal(resultEvt.data.ok, true);
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("createChatRuntime.startSession: a byok route never touches runInstalledRuntimeImpl (SDK path unchanged)", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      loadSdk: async () => fakeStreamingSdk([turnMessages(1)]),
      runInstalledRuntimeImpl: async () => {
        throw new Error("must not be called for a byok route");
      },
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "idle");
      assert.equal(chatRuntime.getSession(chatId).state, "idle");
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime (installed route): writes a usage_event per turn, mirroring runSkillStream's own installed-branch metering", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const env = {};
    selectInstalledRuntime({ repoRoot, env });

    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => {
        throw new Error("Agent SDK must not load for an installed route");
      },
      runInstalledRuntimeImpl: async () => ({
        text: "Reply 1",
        model: "custom-model",
        usage: { input_tokens: 42, output_tokens: 7 },
      }),
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "idle");

      const rows = readUsageEvents({ root: repoRoot });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source, "installed");
      assert.equal(rows[0].skill, "ingest-profile");
      assert.equal(rows[0].model, "custom-model");
      assert.equal(rows[0].upstream, "local-cli:codex");
      assert.equal(rows[0].tokens_in, 42);
      assert.equal(rows[0].tokens_out, 7);
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime (installed route): a result with no usage payload writes no usage_event", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const env = {};
    selectInstalledRuntime({ repoRoot, env });

    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => {
        throw new Error("Agent SDK must not load for an installed route");
      },
      runInstalledRuntimeImpl: async () => ({ text: "Reply 1", model: null, usage: null }),
    });
    try {
      const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
      await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "idle");
      assert.deepEqual(readUsageEvents({ root: repoRoot }), []);
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime.interrupt (installed route): aborts only the in-flight turn — session returns to idle (not closed), accepts a subsequent turn, and closeSession still tears down cleanly", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const env = {};
    selectInstalledRuntime({ repoRoot, env });

    const calls = [];
    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => {
        throw new Error("Agent SDK must not load for an installed route");
      },
      // Turn 1 hangs until its signal aborts, then rejects the way the real
      // runInstalledRuntime does on cancellation (installed-runtimes.mjs's
      // own RUNTIME_CANCELLED error). Later turns resolve normally.
      runInstalledRuntimeImpl: async (args) => {
        calls.push(args);
        if (calls.length === 1) {
          await new Promise((_resolve, reject) => {
            args.signal.addEventListener("abort", () => {
              const err = new Error("Installed AI request was cancelled.");
              err.code = "RUNTIME_CANCELLED";
              reject(err);
            });
          });
        }
        return { text: `Reply ${calls.length}`, usage: null, model: null };
      },
    });
    try {
      const { chatId, state } = await chatRuntime.startSession({ skill: "ingest-profile" });
      assert.equal(state, "running");

      const events = subscribeCollect(chatRuntime, chatId);
      const idleCount = () =>
        events.filter((e) => e.type === "chat_state" && e.data.state === "idle").length;

      await waitForPredicate(() => calls.length >= 1);
      assert.equal(chatRuntime.getSession(chatId).state, "running");

      const interruptResult = await chatRuntime.interrupt(chatId);
      assert.equal(interruptResult.chatId, chatId);
      await waitForPredicate(() => idleCount() >= 1);
      assert.equal(chatRuntime.getSession(chatId).state, "idle");

      const abortedResult = events.find((e) => e.type === "result" && e.data.aborted === true);
      assert.ok(abortedResult, "expected an aborted result event, not a closed session");
      assert.equal(
        events.some((e) => e.type === "chat_state" && e.data.state === "closed"),
        false
      );

      // The session accepts a subsequent turn after the interrupt.
      chatRuntime.postMessage(chatId, "answer 1");
      await waitForPredicate(() => idleCount() >= 2);
      assert.equal(calls.length, 2);
      const lastAssistant = events.filter((e) => e.type === "assistant").pop();
      assert.equal(lastAssistant.data.message.content[0].text, "Reply 2");

      // closeSession still tears down cleanly afterward.
      const closeResult = chatRuntime.closeSession(chatId, "closed");
      assert.equal(closeResult.state, "closed");
      assert.equal(chatRuntime.getSession(chatId).state, "closed");
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// CodeRabbit Major, PR #92: postMessage used to push straight onto
// session.transcript and kick a second concurrent runInstalledTurn even
// while a first installed turn was still mid-flight, so two overlapping
// calls could both replay the transcript and append assistant replies out
// of order. Fix: queue onto session.pendingMessages while a turn is in
// flight, and drain that queue into exactly one follow-up turn (never one
// turn per queued message) once the in-flight turn finishes.
// ---------------------------------------------------------------------------

test("createChatRuntime.postMessage (installed route): a message submitted mid-turn is queued, not raced, one runtime call in flight at a time, transcript order preserved, and both messages get answered", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const env = {};
    selectInstalledRuntime({ repoRoot, env });

    const calls = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirstCall;
    const firstCallGate = new Promise((resolve) => {
      releaseFirstCall = resolve;
    });

    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => {
        throw new Error("Agent SDK must not load for an installed route");
      },
      // Turn 1 blocks until the test releases it, turn 2 resolves immediately,
      // exercising the exact overlap window the fix closes.
      runInstalledRuntimeImpl: async (args) => {
        active++;
        maxActive = Math.max(maxActive, active);
        calls.push(args);
        const callIndex = calls.length;
        if (callIndex === 1) {
          await firstCallGate;
        }
        active--;
        return { text: `Reply ${callIndex}`, usage: null, model: null };
      },
    });
    try {
      const { chatId, state } = await chatRuntime.startSession({ skill: "ingest-profile" });
      assert.equal(state, "running");

      const events = subscribeCollect(chatRuntime, chatId);
      const idleCount = () =>
        events.filter((e) => e.type === "chat_state" && e.data.state === "idle").length;

      await waitForPredicate(() => calls.length >= 1);
      assert.equal(chatRuntime.getSession(chatId).state, "running");

      // The regression: submit a second message while turn 1 is still mid-flight.
      const postResult = chatRuntime.postMessage(chatId, "message 2");
      assert.deepEqual(postResult, { accepted: true });

      // Queued, not raced: still only one runtime call, session still "running"
      // (no idle flicker for a queued drain), and turn 1's own prompt was
      // already built before the queued message arrived so it can't leak in.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(calls.length, 1);
      assert.equal(maxActive, 1);
      assert.equal(chatRuntime.getSession(chatId).state, "running");
      assert.doesNotMatch(calls[0].prompt, /message 2/);

      releaseFirstCall();
      await waitForPredicate(() => calls.length >= 2);
      // The second call only ever started after the first one completed.
      assert.equal(maxActive, 1);

      await waitForPredicate(() => idleCount() >= 1);
      assert.equal(chatRuntime.getSession(chatId).state, "idle");

      // Exactly one follow-up turn drained the queue (not one per message):
      // turn 2's prompt carries assistant 1's reply BEFORE the queued user
      // message, proving transcript order (user1, assistant1, user2) was
      // preserved through the drain, and assistant2 lands as its reply.
      assert.match(calls[1].prompt, /ASSISTANT:\nReply 1[\s\S]*USER:\nmessage 2/);

      const assistantEvents = events.filter((e) => e.type === "assistant");
      assert.equal(assistantEvents.length, 2);
      assert.equal(assistantEvents[0].data.message.content[0].text, "Reply 1");
      assert.equal(assistantEvents[1].data.message.content[0].text, "Reply 2");

      // No idle flicker in between: the session stayed "running" across the
      // whole drain-and-follow-up chain, so there's exactly one idle
      // transition total (after the follow-up turn's own result), not two.
      assert.equal(idleCount(), 1);
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime.postMessage (installed route): durably replays a queued message after the assistant turn that preceded it", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  const env = {};
  candidateSetupInitialize({ repoRoot, env });
  selectInstalledRuntime({ repoRoot, env });

  let chatRuntime;
  let replacementRuntime;
  try {
    const calls = [];
    let releaseFirstCall;
    const firstCallGate = new Promise((resolve) => {
      releaseFirstCall = resolve;
    });
    chatRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => {
        throw new Error("Agent SDK must not load for an installed route");
      },
      runInstalledRuntimeImpl: async (args) => {
        calls.push(args);
        if (calls.length === 1) await firstCallGate;
        return { text: `Reply ${calls.length}`, usage: null, model: null };
      },
    });

    const { chatId } = await chatRuntime.startSession({ skill: "ingest-profile" });
    await waitForPredicate(() => calls.length === 1);
    chatRuntime.postMessage(chatId, "message 2");
    releaseFirstCall();
    await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "idle");

    const stored = skillChatThreadRead({ repoRoot, env, skill: "ingest-profile" });
    assert.deepEqual(
      stored.messages.map(({ role, text }) => ({ role, text })),
      [
        { role: "assistant", text: "Reply 1" },
        { role: "user", text: "message 2" },
        { role: "assistant", text: "Reply 2" },
      ]
    );

    chatRuntime.shutdown();
    chatRuntime = null;

    const restartCalls = [];
    replacementRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => {
        throw new Error("Agent SDK must not load for an installed route");
      },
      runInstalledRuntimeImpl: async (args) => {
        restartCalls.push(args);
        return { text: "Reply 3", usage: null, model: null };
      },
    });
    const replacement = await replacementRuntime.startSession({ skill: "ingest-profile" });
    assert.equal(replacement.state, "idle");
    replacementRuntime.postMessage(replacement.chatId, "message 3");
    await waitForPredicate(() => restartCalls.length === 1);
    assert.match(
      restartCalls[0].prompt,
      /ASSISTANT:\nReply 1[\s\S]*USER:\nmessage 2[\s\S]*ASSISTANT:\nReply 2[\s\S]*USER:\nmessage 3/
    );
  } finally {
    chatRuntime?.shutdown();
    replacementRuntime?.shutdown();
    cleanup(repoRoot);
  }
});

test("createChatRuntime.interrupt (installed route): a message queued during the aborted turn is not lost, it drains into one follow-up turn instead of being dropped", async () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    const env = {};
    selectInstalledRuntime({ repoRoot, env });

    const calls = [];
    let releaseSecondCall;
    const secondCallGate = new Promise((resolve) => {
      releaseSecondCall = resolve;
    });
    const chatRuntime = createChatRuntime({
      repoRoot,
      env,
      loadSdk: async () => {
        throw new Error("Agent SDK must not load for an installed route");
      },
      // Turn 1 hangs until its signal aborts, then rejects the way the real
      // runInstalledRuntime does on cancellation. Turn 2 (the drain
      // follow-up) is gated on the test's own release so the assertions
      // below can observe the moment right after the drain kicks it;
      // without this gate turn 2 would resolve before those assertions run.
      runInstalledRuntimeImpl: async (args) => {
        calls.push(args);
        const callIndex = calls.length;
        if (callIndex === 1) {
          await new Promise((_resolve, reject) => {
            args.signal.addEventListener("abort", () => {
              const err = new Error("Installed AI request was cancelled.");
              err.code = "RUNTIME_CANCELLED";
              reject(err);
            });
          });
        } else if (callIndex === 2) {
          await secondCallGate;
        }
        return { text: `Reply ${callIndex}`, usage: null, model: null };
      },
    });
    try {
      const { chatId, state } = await chatRuntime.startSession({ skill: "ingest-profile" });
      assert.equal(state, "running");

      const events = subscribeCollect(chatRuntime, chatId);
      const idleCount = () =>
        events.filter((e) => e.type === "chat_state" && e.data.state === "idle").length;

      await waitForPredicate(() => calls.length >= 1);

      // Queue a message while turn 1 is still mid-flight, then interrupt it.
      chatRuntime.postMessage(chatId, "queued while aborting");
      assert.equal(calls.length, 1);

      const interruptResult = await chatRuntime.interrupt(chatId);
      assert.equal(interruptResult.chatId, chatId);

      // A queued message must survive the interrupt: it drains into a
      // follow-up turn rather than being dropped. The drain-triggered
      // follow-up (turn 2) is gated above, so at this point it has started
      // but not finished, the session must still read "running", with no
      // "idle" flicker in between (idle would mean the queued message was
      // stranded until some later postMessage call happened to notice
      // pendingMessages was non-empty, which the old code never checked).
      await waitForPredicate(() => calls.length >= 2);
      assert.equal(chatRuntime.getSession(chatId).state, "running");
      assert.equal(idleCount(), 0);
      assert.match(calls[1].prompt, /queued while aborting/);

      releaseSecondCall();
      await waitForPredicate(() => idleCount() >= 1);
      assert.equal(chatRuntime.getSession(chatId).state, "idle");
      // Exactly one idle transition total: the aborted turn 1 never
      // flickered idle on its own, only the drain follow-up's own result did.
      assert.equal(idleCount(), 1);

      const assistantEvents = events.filter((e) => e.type === "assistant");
      assert.equal(assistantEvents.length, 1);
      assert.equal(assistantEvents[0].data.message.content[0].text, "Reply 2");

      const closeResult = chatRuntime.closeSession(chatId, "closed");
      assert.equal(closeResult.state, "closed");
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Real end-to-end integration — the one test in this file that talks to a
// live model, gated behind ANTHROPIC_API_KEY. Mirrors
// tests/skill-runtime.test.mjs's own gated INTEGRATION test: never runs in
// CI, only when a developer sets a real key locally. Confirms the ONE thing
// a canned fake can't prove — that the long-lived query() actually survives
// past the first turn's result and accepts a second pushed message.
// ---------------------------------------------------------------------------

test("INTEGRATION (skipped without ANTHROPIC_API_KEY): a real 2-turn ping/pong chat survives past the first result and answers a second pushed message", {
  skip: !process.env.ANTHROPIC_API_KEY,
}, async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-chat-runtime-live-"));
  const skillDir = join(repoRoot, ".agents/skills/pingpong");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: pingpong\ndescription: Reply with the single word PONG to each user message.\n---\n" +
      "# pingpong\n\nFor every user message, reply with exactly the single word `PONG`. Do not call " +
      "any tools. Never end or summarize the conversation on your own — always wait for another reply.\n",
    "utf8"
  );
  const chatRuntime = createChatRuntime({
    repoRoot,
    env: { ...process.env, CAREERRAT_CHAT_SKILLS: "pingpong" },
  });
  try {
    const { chatId } = await chatRuntime.startSession({ skill: "pingpong", input: "ping" });

    let resultCount = 0;
    const res = {
      writeHead() {},
      write(chunk) {
        if (String(chunk).startsWith("event: result")) resultCount++;
      },
      on() {},
      end() {},
    };
    chatRuntime.subscribe(chatId, res, {});

    await waitForPredicate(() => resultCount >= 1, { timeoutMs: 60000, intervalMs: 100 });
    assert.equal(chatRuntime.getSession(chatId).state, "idle");

    chatRuntime.postMessage(chatId, "ping again");
    await waitForPredicate(() => resultCount >= 2, { timeoutMs: 60000, intervalMs: 100 });
    assert.equal(chatRuntime.getSession(chatId).state, "idle");
  } finally {
    chatRuntime.shutdown();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
