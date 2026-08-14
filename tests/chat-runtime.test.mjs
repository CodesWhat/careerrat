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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildChatKickoffPrompt,
  classifyChatEvent,
  createChatRuntime,
  resolveAllowedChatSkills,
  resolveCandidateChatContext,
} from "../src/core/ai/chat-runtime.mjs";
import { writeInstalledRuntimeSelection } from "../src/core/ai/runtime-selection.mjs";
import { APP_SAFE_RUNTIME_TOOLS, CHAT_RUNTIME_TOOLS } from "../src/core/ai/runtime-tools.mjs";
import { readUsageEvents } from "../src/core/ai/usage-log.mjs";
import {
  candidateArtifactPut,
  candidateConfigPatch,
  candidateEvidenceMerge,
  candidateSetupInitialize,
} from "../src/core/db/verbs.mjs";

// Forces resolveAIRoute() to resolve route.type === "installed" deterministically
// (no dependency on any real CLI actually being on this machine's PATH) — the
// "custom" runtimeId short-circuits straight to a fixed { id: "custom", path:
// customCommand } runtime (see call-ai.mjs's resolveAIRoute), same trick
// tests/skill-runtime.test.mjs uses for its own installed-route coverage.
function selectInstalledRuntime({ repoRoot, env }) {
  writeInstalledRuntimeSelection({
    repoRoot,
    env,
    runtimeId: "custom",
    customCommand: "/fake/bin/custom-agent",
  });
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

test("resolveAllowedChatSkills: defaults to onboarding, discovery, and intake chat skills when CAREERRAT_CHAT_SKILLS is unset", () => {
  const repoRoot = tempRepoWithSkill([
    "ingest-profile",
    "research-boards",
    "discover-companies",
    "search-jobs",
    "email-comms",
    "track-outcomes",
  ]);
  try {
    assert.deepEqual(resolveAllowedChatSkills({ repoRoot, env: {} }), [
      "ingest-profile",
      "research-boards",
      "discover-companies",
      "search-jobs",
      "email-comms",
      "track-outcomes",
    ]);
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

test("buildChatKickoffPrompt: routes notice period to its real profile schema path", () => {
  const prompt = buildChatKickoffPrompt({ skill: "ingest-profile" });
  assert.match(prompt, /profile\.authorization\.notice_period/i);
  assert.match(prompt, /never form-defaults\.notice_period/i);
  assert.match(prompt, /do not collect an earliest start date during initial setup/i);
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

test("createChatRuntime.startSession: discovery gets network-only tools while onboarding keeps local reads", async () => {
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
      await chatRuntime.startSession({ skill: "discover-companies" });
      assert.deepEqual(seenToolsBySkill.get("ingest-profile"), [...APP_SAFE_RUNTIME_TOOLS]);
      assert.deepEqual(seenToolsBySkill.get("research-boards"), [...CHAT_RUNTIME_TOOLS]);
      assert.deepEqual(seenToolsBySkill.get("discover-companies"), [...CHAT_RUNTIME_TOOLS]);
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
// onClose — the M10 Lane-C completion-loop hook (intake-route.mjs's
// executeLaneC registers one of these per confirmed intake item so a chat
// session's terminal transition can map to an intake done/error outcome).
// ---------------------------------------------------------------------------

test("createChatRuntime.onClose: fires with {chatId, reason, lastError:null} on a user-initiated close", async () => {
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

      let payload = null;
      chatRuntime.onClose(chatId, (p) => {
        payload = p;
      });
      chatRuntime.closeSession(chatId, "closed");

      assert.deepEqual(payload, { chatId, reason: "closed", lastError: null });
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime.onClose: an 'error' close carries the session's last error-event message as lastError", async () => {
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
      let payload = null;
      chatRuntime.onClose(chatId, (p) => {
        payload = p;
      });
      await waitForPredicate(() => chatRuntime.getSession(chatId)?.state === "closed");

      assert.equal(payload.chatId, chatId);
      assert.equal(payload.reason, "error");
      assert.match(payload.lastError, /boom mid-turn/);
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime.onClose: a throwing callback never breaks the close path, and a second registered callback still fires", async () => {
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

      let secondFired = false;
      chatRuntime.onClose(chatId, () => {
        throw new Error("listener blew up");
      });
      chatRuntime.onClose(chatId, () => {
        secondFired = true;
      });

      assert.doesNotThrow(() => chatRuntime.closeSession(chatId, "closed"));
      assert.equal(secondFired, true);
      assert.equal(chatRuntime.getSession(chatId).state, "closed");
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("createChatRuntime.onClose: never double-fires — a repeated close() call is a no-op per closeSessionInternal's idempotency guard", async () => {
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

      let fireCount = 0;
      chatRuntime.onClose(chatId, () => {
        fireCount++;
      });
      chatRuntime.closeSession(chatId, "closed");
      chatRuntime.closeSession(chatId, "closed"); // already closed — no-op

      assert.equal(fireCount, 1);
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
      assert.equal(calls[0].runtime.id, "custom");
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
      assert.equal(calls[1].runtime.id, "custom");
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
        location: { home: "Austin, TX" },
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
      assert.equal(rows[0].upstream, "local-cli:custom");
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
