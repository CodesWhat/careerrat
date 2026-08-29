import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  acpPermissionDecision,
  buildAcpRuntimeInvocation,
  probeAcpRuntime,
  runAcpRuntime,
} from "../src/core/ai/acp-runtime.mjs";

function hermesRuntime(extra = {}) {
  return {
    id: "hermes",
    path: "/safe/hermes",
    acpArgs: ["--ignore-rules", "acp"],
    ...extra,
  };
}

function fakeAcpChild(handleMessage) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  let buffer = "";

  const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      handleMessage(JSON.parse(line), send, child);
    }
  });
  child.kill = () => {
    if (child.killed) return;
    child.killed = true;
    child.stdin.destroy();
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit("close", 0, null));
  };
  return child;
}

function successfulAcpChild({ onPrompt } = {}) {
  return fakeAcpChild((message, send) => {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: "fixture-agent", version: "1.0.0" },
        },
      });
      return;
    }
    if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
      return;
    }
    if (message.method !== "session/prompt") return;
    onPrompt?.(message, send);
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ACP " },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "works" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
      },
    });
  });
}

test("buildAcpRuntimeInvocation uses the registry-owned ACP argv and keeps prompts off it", () => {
  assert.deepEqual(
    buildAcpRuntimeInvocation({
      runtimeId: "fixture",
      executablePath: "/fixture",
      args: ["--ignore-rules", "acp"],
    }),
    {
      command: "/fixture",
      args: ["--ignore-rules", "acp"],
      options: { shell: false, windowsHide: true },
    }
  );
  assert.deepEqual(
    buildAcpRuntimeInvocation({
      runtimeId: "gemini",
      executablePath: "/gemini",
      args: ["--acp"],
    }).args,
    ["--acp"]
  );
  assert.deepEqual(
    buildAcpRuntimeInvocation({
      runtimeId: "opencode",
      executablePath: "/opencode",
      args: ["acp"],
    }).args,
    ["acp"]
  );
  assert.deepEqual(
    buildAcpRuntimeInvocation({
      runtimeId: "copilot",
      executablePath: "/copilot",
      args: ["--acp", "--stdio"],
    }).args,
    ["--acp", "--stdio"]
  );
  assert.throws(
    () =>
      buildAcpRuntimeInvocation({
        runtimeId: "unknown",
        executablePath: "/unknown",
        args: [],
      }),
    { code: "RUNTIME_ACP_UNSUPPORTED" }
  );
});

test("runAcpRuntime rechecks the frozen executable immediately before spawn", async () => {
  const changed = Object.assign(new Error("runtime changed"), {
    code: "RUNTIME_EXECUTABLE_CHANGED",
  });
  let checked = false;
  let spawned = false;

  await assert.rejects(
    runAcpRuntime({
      runtime: hermesRuntime(),
      prompt: "hello",
      cwd: "/safe/task",
      beforeSpawn() {
        checked = true;
        throw changed;
      },
      spawnImpl() {
        spawned = true;
        return successfulAcpChild();
      },
    }),
    (error) => error === changed
  );
  assert.equal(checked, true);
  assert.equal(spawned, false);
});

test("Windows ACP runtimes launch npm cmd shims through the fixed command boundary", async () => {
  const calls = [];
  const comspec = "C:\\Windows\\System32\\cmd.exe";
  const child = successfulAcpChild();

  const result = await runAcpRuntime({
    runtime: hermesRuntime({
      path: "C:\\Users\\Taylor Smith\\AppData\\Roaming\\npm\\hermes.cmd",
    }),
    prompt: "hello",
    cwd: "C:\\safe\\task",
    platform: "win32",
    env: { COMSPEC: comspec },
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });

  assert.equal(result.text, "ACP works");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, comspec);
  assert.deepEqual(calls[0].args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
  assert.equal(calls[0].args.length, 5);
  assert.match(calls[0].args[4], /hermes\.cmd/i);
  assert.equal(calls[0].args[4].includes("Taylor Smith"), false);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
});

test("probeAcpRuntime verifies initialize, authentication, and session creation without prompting", async () => {
  let promptStarted = false;
  const child = successfulAcpChild({
    onPrompt() {
      promptStarted = true;
    },
  });

  const result = await probeAcpRuntime({
    runtime: hermesRuntime({ name: "Hermes" }),
    cwd: "/safe/task",
    timeoutMs: 5000,
    spawnImpl: () => child,
  });

  assert.deepEqual(result, {
    ready: true,
    agentCapabilities: { loadSession: true },
    agentInfo: { name: "fixture-agent", version: "1.0.0" },
  });
  assert.equal(promptStarted, false);
  assert.equal(child.killed, true);
});

test("acpPermissionDecision grants only scoped MCP reads and scoped public-web fetches", () => {
  const options = [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ];
  assert.deepEqual(
    acpPermissionDecision({ tools: ["Read"], request: { toolCall: { kind: "read" }, options } }),
    { outcome: { outcome: "selected", optionId: "reject" } }
  );
  assert.deepEqual(
    acpPermissionDecision({
      tools: ["Read"],
      request: {
        toolCall: { kind: "read", name: "read_staged_input", rawInput: {} },
        options,
      },
    }),
    { outcome: { outcome: "selected", optionId: "allow" } }
  );
  assert.deepEqual(
    acpPermissionDecision({
      tools: ["WebSearch", "WebFetch"],
      request: {
        toolCall: { kind: "fetch", rawInput: { url: "https://github.com/CodesWhat" } },
        options,
      },
    }),
    { outcome: { outcome: "selected", optionId: "reject" } }
  );
  assert.deepEqual(
    acpPermissionDecision({
      tools: ["WebSearch", "WebFetch"],
      request: {
        toolCall: {
          kind: "search",
          name: "web_search",
          rawInput: { query: "CareerRat" },
        },
        options,
      },
    }),
    { outcome: { outcome: "selected", optionId: "reject" } }
  );
  assert.deepEqual(
    acpPermissionDecision({
      tools: ["WebSearch", "WebFetch"],
      request: {
        toolCall: {
          kind: "fetch",
          name: "mcp__careerrat_scoped_tools__fetch",
          rawInput: { url: "https://github.com/CodesWhat" },
        },
        options,
      },
    }),
    { outcome: { outcome: "selected", optionId: "allow" } }
  );
  assert.deepEqual(
    acpPermissionDecision({
      tools: ["WebSearch", "WebFetch"],
      request: {
        toolCall: {
          kind: "fetch",
          name: "mcp__careerrat_scoped_tools__fetch",
          rawInput: { url: "http://localhost:7777/private" },
        },
        options,
      },
    }),
    { outcome: { outcome: "selected", optionId: "reject" } }
  );
  assert.deepEqual(
    acpPermissionDecision({
      tools: ["WebFetch"],
      request: { toolCall: { kind: "fetch", name: "fetch", rawInput: {} }, options },
    }),
    { outcome: { outcome: "selected", optionId: "reject" } }
  );
  assert.deepEqual(
    acpPermissionDecision({
      tools: ["WebSearch", "WebFetch"],
      request: { toolCall: { kind: "execute" }, options },
    }),
    { outcome: { outcome: "selected", optionId: "reject" } }
  );
  assert.deepEqual(
    acpPermissionDecision({ tools: [], request: { toolCall: { kind: "read" }, options } }),
    { outcome: { outcome: "selected", optionId: "reject" } }
  );
  assert.deepEqual(
    acpPermissionDecision({
      tools: ["Read"],
      cwd: "/safe/task",
      request: {
        toolCall: { kind: "read", rawInput: { path: "../private.txt" } },
        options,
      },
    }),
    { outcome: { outcome: "selected", optionId: "reject" } }
  );
});

test("runAcpRuntime attaches the app-owned scoped MCP server to the session", async () => {
  let sessionRequest = null;
  const child = fakeAcpChild((message, send) => {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      });
      return;
    }
    if (message.method === "session/new") {
      sessionRequest = message.params;
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
      return;
    }
    if (message.method === "session/prompt") {
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
  });
  const scopedServer = {
    name: "careerrat_scoped_tools",
    command: "/safe/runtime",
    args: ["/safe/installed-runtimes.mjs", "--careerrat-scoped-tools"],
    env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }],
  };

  await runAcpRuntime({
    runtime: hermesRuntime(),
    prompt: "read",
    cwd: "/safe/task",
    tools: ["Read"],
    mcpServers: [scopedServer],
    spawnImpl: () => child,
  });

  assert.deepEqual(sessionRequest.mcpServers, [scopedServer]);
});

test("runAcpRuntime streams text and tool activity through one provider-neutral client", async () => {
  const calls = [];
  const activity = [];
  let promptFromProtocol = null;
  const child = successfulAcpChild({
    onPrompt(message, send) {
      promptFromProtocol = message.params.prompt[0].text;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "fetch-1",
            title: "Fetch CareerRat",
            name: "mcp__careerrat_scoped_tools__fetch",
            kind: "fetch",
            status: "in_progress",
            rawInput: { url: "https://careerrat.dev" },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "fetch-1",
            status: "completed",
          },
        },
      });
    },
  });

  const result = await runAcpRuntime({
    runtime: hermesRuntime({ name: "Hermes" }),
    prompt: "research CareerRat",
    cwd: "/safe/task",
    tools: ["WebSearch", "WebFetch"],
    timeoutMs: 5000,
    onMessage: (message) => activity.push(message),
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });

  assert.equal(promptFromProtocol, "research CareerRat");
  assert.equal(calls[0].args.includes("research CareerRat"), false);
  assert.equal(calls[0].options.shell, false);
  assert.equal(result.text, "ACP works");
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 2, total_tokens: 14 });
  assert.equal(result.sessionId, "session-1");
  assert.equal(result.runtimeId, "hermes");
  assert.deepEqual(activity, [
    {
      type: "assistant",
      session_id: "session-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "fetch-1",
            name: "WebFetch",
            input: { url: "https://careerrat.dev" },
          },
        ],
      },
    },
    {
      type: "user",
      session_id: "session-1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "fetch-1",
            content: "Fetch CareerRat completed",
            is_error: false,
          },
        ],
      },
    },
  ]);
  assert.equal(child.killed, true);
});

test("runAcpRuntime closes any tool activity the provider leaves open at end of turn", async () => {
  const activity = [];
  const child = successfulAcpChild({
    onPrompt(_message, send) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "read-1",
            title: "Read staged input",
            name: "read_staged_input",
            kind: "read",
            status: "in_progress",
            rawInput: {},
          },
        },
      });
    },
  });

  await runAcpRuntime({
    runtime: hermesRuntime(),
    prompt: "read",
    cwd: "/safe/task",
    tools: ["Read"],
    onMessage: (message) => activity.push(message),
    spawnImpl: () => child,
  });

  assert.equal(activity.length, 2);
  assert.deepEqual(activity[0].message.content, [
    {
      type: "tool_use",
      id: "read-1",
      name: "Read",
      input: {},
    },
  ]);
  assert.deepEqual(activity[1].message.content, [
    {
      type: "tool_result",
      tool_use_id: "read-1",
      content: "Read staged input completed",
      is_error: false,
    },
  ]);
});

test("runAcpRuntime honors cancellation triggered by the terminal activity callback", async () => {
  const controller = new AbortController();
  const activity = [];
  const child = successfulAcpChild({
    onPrompt(_message, send) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "think-1",
            title: "Think",
            kind: "think",
            status: "in_progress",
          },
        },
      });
    },
  });

  await assert.rejects(
    runAcpRuntime({
      runtime: hermesRuntime(),
      prompt: "think",
      cwd: "/safe/task",
      signal: controller.signal,
      onMessage(message) {
        activity.push(message);
        if (message.type === "user") controller.abort();
      },
      spawnImpl: () => child,
    }),
    { code: "RUNTIME_CANCELLED" }
  );
  assert.deepEqual(
    activity.map(({ type }) => type),
    ["assistant", "user"]
  );
});

test("runAcpRuntime cancels a provider tool outside the granted request capabilities", async () => {
  const child = successfulAcpChild({
    onPrompt(_message, send) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "execute-1",
            title: "terminal: cat ~/.ssh/config",
            kind: "execute",
            status: "in_progress",
          },
        },
      });
    },
  });

  await assert.rejects(
    runAcpRuntime({
      runtime: hermesRuntime(),
      prompt: "answer",
      cwd: "/safe/task",
      tools: ["WebSearch", "WebFetch"],
      spawnImpl: () => child,
    }),
    { code: "RUNTIME_TOOL_BOUNDARY" }
  );
  assert.equal(child.killed, true);
});

test("runAcpRuntime rejects a private-network fetch even when web access is granted", async () => {
  const child = successfulAcpChild({
    onPrompt(_message, send) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "fetch-1",
            title: "navigate: http://127.0.0.1:7777/private",
            name: "mcp__careerrat_scoped_tools__fetch",
            kind: "fetch",
            status: "in_progress",
          },
        },
      });
    },
  });

  await assert.rejects(
    runAcpRuntime({
      runtime: hermesRuntime(),
      prompt: "research",
      cwd: "/safe/task",
      tools: ["WebSearch", "WebFetch"],
      spawnImpl: () => child,
    }),
    { code: "RUNTIME_TOOL_BOUNDARY" }
  );
});

for (const nativeCall of [
  {
    label: "provider-native public fetch",
    name: "fetch",
    kind: "fetch",
    rawInput: { url: "https://example.com/jobs" },
  },
  {
    label: "provider-native search",
    name: "web_search",
    kind: "search",
    rawInput: { query: "CareerRat jobs" },
  },
]) {
  test(`runAcpRuntime rejects ${nativeCall.label} outside the scoped MCP contract`, async () => {
    const child = successfulAcpChild({
      onPrompt(_message, send) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "native-web-1",
              title: nativeCall.label,
              name: nativeCall.name,
              kind: nativeCall.kind,
              status: "in_progress",
              rawInput: nativeCall.rawInput,
            },
          },
        });
      },
    });

    await assert.rejects(
      runAcpRuntime({
        runtime: hermesRuntime(),
        prompt: "research",
        cwd: "/safe/task",
        tools: ["WebSearch", "WebFetch"],
        spawnImpl: () => child,
      }),
      { code: "RUNTIME_TOOL_BOUNDARY" }
    );
    assert.equal(child.killed, true);
  });
}

test("runAcpRuntime surfaces ACP authentication setup before starting a session", async () => {
  let sessionStarted = false;
  const child = fakeAcpChild((message, send) => {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: "fixture-agent", version: "1.0.0" },
          authMethods: [
            {
              id: "fixture-setup",
              name: "Configure provider",
              type: "terminal",
              args: ["--setup"],
            },
          ],
        },
      });
    } else if (message.method === "session/new") {
      sessionStarted = true;
    }
  });

  await assert.rejects(
    runAcpRuntime({
      runtime: hermesRuntime(),
      prompt: "hello",
      cwd: "/safe/task",
      spawnImpl: () => child,
    }),
    { code: "RUNTIME_AUTH_REQUIRED" }
  );
  assert.equal(sessionStarted, false);
});

test("runAcpRuntime bounds a stalled provider with timeout and cancellation", async () => {
  function stalledChild(onPrompt) {
    return fakeAcpChild((message, send) => {
      if (message.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: { name: "stalled-agent", version: "1.0.0" },
          },
        });
      } else if (message.method === "session/new") {
        send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stalled-1" } });
      } else if (message.method === "session/prompt") {
        onPrompt?.();
      }
    });
  }

  const timedOut = stalledChild();
  await assert.rejects(
    runAcpRuntime({
      runtime: hermesRuntime(),
      prompt: "wait",
      cwd: "/safe/task",
      timeoutMs: 10,
      spawnImpl: () => timedOut,
    }),
    { code: "RUNTIME_TIMEOUT" }
  );
  assert.equal(timedOut.killed, true);

  const controller = new AbortController();
  const cancelled = stalledChild(() => queueMicrotask(() => controller.abort()));
  await assert.rejects(
    runAcpRuntime({
      runtime: hermesRuntime(),
      prompt: "wait",
      cwd: "/safe/task",
      timeoutMs: 5000,
      signal: controller.signal,
      spawnImpl: () => cancelled,
    }),
    { code: "RUNTIME_CANCELLED" }
  );
  assert.equal(cancelled.killed, true);
});

test("runAcpRuntime escalates abort and timeout to SIGKILL and force-settles TERM-ignoring children", async () => {
  function termIgnoringChild(signals, onPrompt) {
    const child = fakeAcpChild((message, send) => {
      if (message.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: { name: "term-ignoring-agent", version: "1.0.0" },
          },
        });
      } else if (message.method === "session/new") {
        send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stalled-1" } });
      } else if (message.method === "session/prompt") {
        onPrompt?.();
      }
    });
    child.kill = (signal) => {
      signals.push(signal);
      child.killed = true;
      return true;
    };
    return child;
  }

  const abortSignals = [];
  const controller = new AbortController();
  const cancelled = termIgnoringChild(abortSignals, () => queueMicrotask(() => controller.abort()));
  await assert.rejects(
    runAcpRuntime({
      runtime: hermesRuntime(),
      prompt: "wait",
      cwd: "/safe/task",
      timeoutMs: 5000,
      signal: controller.signal,
      spawnImpl: () => cancelled,
    }),
    { code: "RUNTIME_CANCELLED" }
  );
  assert.deepEqual(abortSignals, ["SIGTERM", "SIGKILL"]);

  const timeoutSignals = [];
  const timedOut = termIgnoringChild(timeoutSignals);
  await assert.rejects(
    runAcpRuntime({
      runtime: hermesRuntime(),
      prompt: "wait",
      cwd: "/safe/task",
      timeoutMs: 5,
      spawnImpl: () => timedOut,
    }),
    { code: "RUNTIME_TIMEOUT" }
  );
  assert.deepEqual(timeoutSignals, ["SIGTERM", "SIGKILL"]);
});

test("runAcpRuntime keeps abort authoritative when a TERM-ignoring provider replies afterward", async () => {
  const controller = new AbortController();
  const signals = [];
  const activity = [];
  const permissionOutcomes = [];
  let promptRequestId = null;
  const child = fakeAcpChild((message, send) => {
    if (message.id === "late-permission" && !message.method) {
      permissionOutcomes.push(message.result?.outcome?.outcome ?? message.result?.outcome);
      send({
        jsonrpc: "2.0",
        id: promptRequestId,
        result: { stopReason: "end_turn", usage: {} },
      });
      return;
    }
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: "late-agent", version: "1.0.0" },
        },
      });
    } else if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "late-1" } });
    } else if (message.method === "session/prompt") {
      promptRequestId = message.id;
      controller.abort();
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "late-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "late-think",
            title: "Late thought",
            kind: "think",
            status: "in_progress",
          },
        },
      });
      send({
        jsonrpc: "2.0",
        id: "late-permission",
        method: "session/request_permission",
        params: {
          sessionId: "late-1",
          toolCall: {
            toolCallId: "late-permission-call",
            kind: "think",
            title: "Late permission",
          },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
    }
  });
  child.kill = (signal) => {
    signals.push(signal);
    child.killed = true;
    return true;
  };

  await assert.rejects(
    runAcpRuntime({
      runtime: hermesRuntime(),
      prompt: "wait",
      cwd: "/safe/task",
      signal: controller.signal,
      onMessage: (message) => activity.push(message),
      spawnImpl: () => child,
    }),
    { code: "RUNTIME_CANCELLED" }
  );
  await new Promise((resolve) => setTimeout(resolve, 275));
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(activity, []);
  assert.deepEqual(permissionOutcomes, ["cancelled"]);
});

test("runAcpRuntime keeps abort authoritative when transport fails during cleanup", async () => {
  const controller = new AbortController();
  const child = successfulAcpChild({
    onPrompt() {
      queueMicrotask(() => controller.abort());
    },
  });
  child.kill = () => {
    queueMicrotask(() =>
      child.stdout.emit("error", new Error("transport closed during cancellation"))
    );
    return true;
  };

  await assert.rejects(
    runAcpRuntime({
      runtime: hermesRuntime(),
      prompt: "wait",
      cwd: "/safe/task",
      timeoutMs: 5000,
      signal: controller.signal,
      spawnImpl: () => child,
    }),
    { code: "RUNTIME_CANCELLED" }
  );
});
