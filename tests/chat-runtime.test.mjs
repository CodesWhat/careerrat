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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildChatKickoffPrompt,
  classifyChatEvent,
  createChatRuntime,
  resolveAllowedChatSkills,
} from "../src/core/ai/chat-runtime.mjs";
import { readUsageEvents } from "../src/core/ai/usage-log.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tempRepoWithSkill(skillNames = "ingest-profile") {
  const names = Array.isArray(skillNames) ? skillNames : [skillNames];
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-chat-runtime-"));
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
function fakeStreamingSdk(turns, { onClose, onInterrupt } = {}) {
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
        for await (const _turnInput of prompt) {
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

// ---------------------------------------------------------------------------
// resolveAllowedChatSkills
// ---------------------------------------------------------------------------

test("resolveAllowedChatSkills: defaults to ingest-profile when ROLESTER_CHAT_SKILLS is unset", () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    assert.deepEqual(resolveAllowedChatSkills({ repoRoot, env: {} }), ["ingest-profile"]);
  } finally {
    cleanup(repoRoot);
  }
});

test("resolveAllowedChatSkills: an explicit empty env value locks everything out", () => {
  const repoRoot = tempRepoWithSkill("ingest-profile");
  try {
    assert.deepEqual(resolveAllowedChatSkills({ repoRoot, env: { ROLESTER_CHAT_SKILLS: "" } }), []);
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
        env: { ROLESTER_CHAT_SKILLS: "ingest-profile, evaluate-job" },
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
      env: { ANTHROPIC_API_KEY: "sk-ant-test", ROLESTER_CHAT_SKILLS: "a,b,c" },
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
      env: { ROLESTER_AI_PROXY_URL: "http://127.0.0.1:7788", ROLESTER_AI_PROXY_TOKEN: "devtoken" },
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
        ROLESTER_CHAT_SKILLS: "ingest-profile,evaluate-job",
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
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-chat-runtime-live-"));
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
    env: { ...process.env, ROLESTER_CHAT_SKILLS: "pingpong" },
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
