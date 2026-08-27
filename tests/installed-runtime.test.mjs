import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildInstalledRuntimeChildEnv,
  buildInstalledRuntimeInvocation,
  CHAT_SESSION_RUNTIME_TIMEOUT_MS,
  detectInstalledRuntimes,
  fetchInstalledRuntimePublicUrl,
  hasCompleteCareerRatCapabilities,
  INSTALLED_RUNTIME_DEFINITIONS,
  installedRuntimeCapabilities,
  installedRuntimeSignInCommand,
  materializeIsolatedSkillCwd,
  ONE_SHOT_RUNTIME_TIMEOUT_MS,
  parseCustomCommandString,
  probeCustomRuntimeCommand,
  probeInstalledRuntime,
  RUNTIME_TOOL_PROFILE_UNSUPPORTED,
  readInstalledRuntimeScopedFile,
  runInstalledRuntime,
  runInstalledRuntimeStream,
  runtimeSearchDirectories,
  startInstalledRuntimeGuidedSetup,
  startInstalledRuntimeSignIn,
  stopInstalledRuntimeSignIns,
  supportsInstalledRuntimeStreaming,
} from "../src/core/ai/installed-runtimes.mjs";
import {
  runtimeProcessInvocation,
  scheduleRuntimeProcessKill,
} from "../src/core/ai/runtime-process.mjs";
import {
  loadInstalledRuntimeSelection,
  writeInstalledRuntimeSelection,
} from "../src/core/ai/runtime-selection.mjs";

// A minimal fake child_process for runInstalledRuntime's spawnImpl injection
// point — an EventEmitter with stdout/stderr/stdin EventEmitters, mirroring
// the shape probeCustomRuntimeCommand's own tests fake below. `stdin.end()`
// is the spawn's actual write, so that's what schedules the fake process's
// stdout + close.
function fakeInstalledChild({ stdout = "", status = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout, "utf8"));
      child.emit("close", status, null);
    });
  };
  child.kill = () => {};
  return child;
}

// A fake child for runInstalledRuntimeStream's spawnImpl injection point:
// like fakeInstalledChild above, but emits `chunks` one at a time (each on
// its own microtask tick, via setImmediate) rather than a single stdout
// write, so tests can exercise NDJSON line-buffering across chunk
// boundaries — including a chunk that splits a JSON object mid-line.
function fakeStreamingChild({ chunks = [], status = 0, stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {
    (async () => {
      for (const chunk of chunks) {
        await new Promise((resolve) => setImmediate(resolve));
        child.stdout.emit("data", Buffer.from(chunk, "utf8"));
      }
      if (stderr) child.stderr.emit("data", Buffer.from(stderr, "utf8"));
      await new Promise((resolve) => setImmediate(resolve));
      child.emit("close", status, null);
    })();
  };
  child.kill = () => {};
  return child;
}

function ndjson(lines) {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "careerrat-installed-runtime-"));
}

const VERIFIED_CAPABILITIES = Object.freeze({
  completion: true,
  structuredOutput: true,
  appWorkflows: true,
  exactRead: true,
  publicWeb: true,
  liveActivity: true,
  resumable: true,
});

function verifiedRuntime(runtime) {
  return { ...runtime, capabilities: VERIFIED_CAPABILITIES };
}

function executable(path) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(path, 0o755);
}

function verifiedClaudeVersion() {
  return { status: 0, stdout: "2.1.241 (Claude Code)", stderr: "" };
}

test("runtime registry covers the supported installed CLI set", () => {
  assert.deepEqual(
    INSTALLED_RUNTIME_DEFINITIONS.map(({ id }) => id),
    [
      "claude",
      "codex",
      "gemini",
      "opencode",
      "copilot",
      "qwen",
      "antigravity",
      "hermes",
      "amp",
      "goose",
      "droid",
    ]
  );
  for (const definition of INSTALLED_RUNTIME_DEFINITIONS) {
    assert.ok(definition.name);
    assert.ok(definition.commandShape);
    assert.ok(definition.binaries.length >= 1);
    assert.ok(definition.authProbe.args.length >= 1);
    // Onboarding's not-found rows link out to each CLI's official install
    // docs (the "NOT FOUND · INSTALL GUIDE" receipt) — every registry entry
    // must carry a real, verified https:// URL, never an invented one.
    assert.ok(definition.installUrl, `${definition.id} needs an installUrl`);
    assert.match(definition.installUrl, /^https:\/\//);
  }
});

test("each ACP adapter keeps its fixed argv in the runtime registry", () => {
  const expected = {
    gemini: ["--acp"],
    opencode: ["acp"],
    copilot: ["--acp", "--stdio"],
    hermes: ["--ignore-rules", "acp"],
  };
  const definitions = INSTALLED_RUNTIME_DEFINITIONS.filter(({ protocol }) => protocol === "acp");
  assert.deepEqual(
    Object.fromEntries(definitions.map(({ id, acpArgs }) => [id, acpArgs])),
    expected
  );
});

test("supported adapters keep sign-in argv in the same runtime registry", () => {
  assert.deepEqual(
    Object.fromEntries(
      INSTALLED_RUNTIME_DEFINITIONS.filter(({ supported }) => supported).map(
        ({ id, signInArgs }) => [id, signInArgs]
      )
    ),
    {
      claude: ["auth", "login"],
      codex: ["login"],
    }
  );
});

test("runtime search adds Finder-safe user and package-manager directories", () => {
  const dirs = runtimeSearchDirectories({
    env: { PATH: "/finder/bin:/usr/bin", NPM_CONFIG_PREFIX: "/custom/npm" },
    platform: "darwin",
    homeDir: "/Users/morgan",
  });

  for (const expected of [
    "/finder/bin",
    "/usr/bin",
    "/Users/morgan/.local/bin",
    "/Users/morgan/.npm-global/bin",
    "/Users/morgan/.bun/bin",
    "/custom/npm/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]) {
    assert.ok(dirs.includes(expected), `missing ${expected}`);
  }
  assert.equal(new Set(dirs).size, dirs.length);
});

test("detectInstalledRuntimes finds multiple CLIs outside the inherited PATH", () => {
  const root = tempRoot();
  const homeDir = join(root, "home");
  const brewDir = join(root, "brew", "bin");
  const claudePath = join(homeDir, ".local", "bin", "claude");
  const codexPath = join(brewDir, "codex");
  executable(claudePath);
  executable(codexPath);
  try {
    const inventory = detectInstalledRuntimes({
      env: { PATH: "", CAREERRAT_RUNTIME_EXTRA_PATHS: brewDir },
      platform: "darwin",
      homeDir,
    });
    assert.equal(inventory.find(({ id }) => id === "claude").path, claudePath);
    assert.equal(inventory.find(({ id }) => id === "codex").path, codexPath);
    assert.equal(inventory.find(({ id }) => id === "gemini").available, false);
    // installUrl flows from the registry definition through to every
    // detected runtime, available or not.
    assert.equal(
      inventory.find(({ id }) => id === "claude").installUrl,
      INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === "claude").installUrl
    );
    assert.equal(
      inventory.find(({ id }) => id === "gemini").installUrl,
      INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === "gemini").installUrl
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detection publishes declared adapters as unverified until readiness runs", () => {
  const root = tempRoot();
  const binDir = join(root, "bin");
  executable(join(binDir, "claude"));
  executable(join(binDir, "codex"));
  executable(join(binDir, "hermes"));
  try {
    const inventory = detectInstalledRuntimes({
      env: { PATH: binDir },
      platform: "darwin",
      homeDir: join(root, "home"),
    });
    const byId = Object.fromEntries(inventory.map((runtime) => [runtime.id, runtime]));
    assert.deepEqual(byId.claude.capabilities, {
      completion: false,
      structuredOutput: false,
      appWorkflows: false,
      exactRead: false,
      publicWeb: false,
      liveActivity: false,
      resumable: false,
      taskTools: false,
      research: false,
    });
    assert.equal(byId.claude.capabilityTier, "detected_unverified");
    assert.deepEqual(byId.codex.capabilities, byId.claude.capabilities);
    assert.equal(byId.codex.capabilityTier, "detected_unverified");
    assert.deepEqual(byId.hermes.capabilities, byId.codex.capabilities);
    assert.equal(byId.hermes.capabilityTier, "detected_unverified");
    assert.equal(byId.gemini.capabilityTier, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostic adapters cannot turn claimed probe evidence into accepted workflow capabilities", () => {
  for (const definition of INSTALLED_RUNTIME_DEFINITIONS.filter(
    ({ supported }) => supported !== true
  )) {
    const capabilities = installedRuntimeCapabilities(definition.id, {
      capabilityEvidence: VERIFIED_CAPABILITIES,
    }).capabilities;
    assert.ok(
      Object.values(definition.acceptedCapabilities).every((accepted) => accepted === false),
      definition.id
    );
    assert.equal(hasCompleteCareerRatCapabilities(capabilities, definition.id), false);
  }
});

test("declared adapter support stays unverified until the readiness probe supplies evidence", () => {
  assert.deepEqual(
    installedRuntimeCapabilities("hermes", { capabilityEvidence: {} }).capabilities,
    {
      completion: false,
      structuredOutput: false,
      appWorkflows: false,
      exactRead: false,
      publicWeb: false,
      liveActivity: false,
      resumable: false,
      taskTools: false,
      research: false,
    }
  );
});

test("execution rejects a runtime whose selected record has no verified completion evidence", async () => {
  let called = false;
  await assert.rejects(
    runInstalledRuntime({
      runtime: {
        id: "hermes",
        name: "Hermes",
        path: "/safe/hermes",
        capabilities: {},
      },
      prompt: "hello",
      cwd: "/safe/task",
      runAcpRuntimeImpl: async () => {
        called = true;
        return { text: "should not run" };
      },
    }),
    { code: "RUNTIME_COMPLETION_UNSUPPORTED" }
  );
  assert.equal(called, false);
});

test("auth probe exposes only bounded readiness state, never CLI account output", async () => {
  const calls = [];
  const ready = await probeInstalledRuntime(
    { id: "codex", path: "/safe/codex", available: true },
    {
      spawnSyncImpl(executablePath, args, options) {
        calls.push({ executablePath, args, options });
        return args[0] === "--version"
          ? { status: 0, stdout: "codex-cli 0.149.1", stderr: "" }
          : { status: 0, stdout: "Logged in as morgan@example.com", stderr: "" };
      },
    }
  );
  assert.deepEqual(ready, {
    status: "ready",
    ready: true,
    action: null,
    capabilities: {
      completion: true,
      structuredOutput: true,
      appWorkflows: true,
      exactRead: true,
      publicWeb: true,
      liveActivity: true,
      resumable: true,
      taskTools: true,
      research: true,
    },
    capabilityReason: null,
  });
  assert.equal(JSON.stringify(ready).includes("morgan@example.com"), false);
  assert.equal(calls[1].executablePath, "/safe/codex");
  assert.deepEqual(
    calls.map(({ args }) => args),
    [["--version"], ["login", "status"]]
  );
  assert.equal(calls[1].options.shell, false);
  assert.ok(calls[1].options.timeout > 0);

  const signedOut = await probeInstalledRuntime(
    { id: "claude", path: "/safe/claude", available: true },
    {
      spawnSyncImpl(_path, args) {
        return args[0] === "--version"
          ? { status: 0, stdout: "2.1.241 (Claude Code)", stderr: "" }
          : { status: 1, stdout: "", stderr: "email secret" };
      },
    }
  );
  assert.deepEqual(signedOut, {
    status: "authentication_required",
    ready: false,
    action: "start_sign_in",
  });
  assert.equal(JSON.stringify(signedOut).includes("secret"), false);
});

test("Windows readiness probes launch detected Claude and Codex npm shims through fixed cmd argv", async () => {
  const comspec = "C:\\Windows\\System32\\cmd.exe";
  const cases = [
    {
      id: "claude",
      path: "C:\\Users\\Taylor Smith\\AppData\\Roaming\\npm\\claude.cmd",
      version: "2.1.241 (Claude Code)",
    },
    {
      id: "codex",
      path: "C:\\Users\\Taylor Smith\\AppData\\Roaming\\npm\\codex.BAT",
      version: "codex-cli 0.149.1",
    },
  ];

  for (const runtimeCase of cases) {
    const calls = [];
    const ready = await probeInstalledRuntime(
      { id: runtimeCase.id, path: runtimeCase.path, available: true },
      {
        platform: "win32",
        env: { COMSPEC: comspec },
        spawnImpl(command, args, options) {
          calls.push({ command, args, options });
          const child = new EventEmitter();
          child.pid = 4100 + calls.length;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => true;
          queueMicrotask(() => {
            child.stdout.emit(
              "data",
              Buffer.from(args.at(-1).includes("--version") ? runtimeCase.version : "signed in")
            );
            child.emit("close", 0, null);
          });
          return child;
        },
      }
    );

    assert.equal(ready.ready, true);
    assert.ok(calls.length >= 2);
    for (const call of calls) {
      assert.equal(call.command, comspec);
      assert.deepEqual(call.args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
      assert.equal(call.args.length, 5);
      assert.match(call.args[4], new RegExp(`${runtimeCase.id}\\.(?:cmd|bat)`, "i"));
      assert.equal(call.args[4].includes("Taylor Smith"), false);
      assert.match(call.args[4], /Taylor\^ Smith/);
      assert.equal(call.options.shell, false);
      assert.equal(call.options.windowsVerbatimArguments, true);
    }
  }
});

test("Windows readiness timeout terminates the full cmd shim probe tree", async () => {
  const treeCalls = [];
  let spawnCount = 0;
  const result = await probeInstalledRuntime(
    {
      id: "claude",
      path: "C:\\Users\\Taylor\\AppData\\Roaming\\npm\\claude.cmd",
      available: true,
    },
    {
      platform: "win32",
      env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "C:\\Windows" },
      timeoutMs: 5,
      spawnImpl() {
        spawnCount += 1;
        const child = new EventEmitter();
        child.pid = 6200 + spawnCount;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        if (spawnCount === 1) {
          queueMicrotask(() => {
            child.stdout.emit("data", Buffer.from("2.1.241 (Claude Code)"));
            child.emit("close", 0, null);
          });
        }
        return child;
      },
      treeKillImpl(command, args, options) {
        treeCalls.push({ command, args, options });
        return { status: 0 };
      },
      spawnSyncImpl() {
        throw new Error("Windows readiness probes must not use spawnSync");
      },
    }
  );

  assert.equal(result.status, "probe_failed");
  assert.deepEqual(treeCalls, [
    {
      command: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/pid", "6202", "/t", "/f"],
      options: { shell: false, windowsHide: true, stdio: "ignore" },
    },
  ]);
});

test("Windows boundary probing honors cancellation before the provider turn can spawn", async () => {
  for (const run of [runInstalledRuntime, runInstalledRuntimeStream]) {
    const controller = new AbortController();
    let spawnCount = 0;
    const pending = run({
      runtime: verifiedRuntime({
        id: "claude",
        path: "C:\\Users\\Taylor\\AppData\\Roaming\\npm\\claude.cmd",
      }),
      prompt: "do not run",
      tools: ["WebSearch"],
      platform: "win32",
      env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "C:\\Windows" },
      signal: controller.signal,
      spawnImpl() {
        spawnCount += 1;
        const child = new EventEmitter();
        child.pid = 7000 + spawnCount;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.stdin.end = () => {};
        child.kill = () => true;
        return child;
      },
      treeKillImpl: () => ({ status: 0 }),
    });
    queueMicrotask(() => controller.abort());

    await assert.rejects(pending, { code: "RUNTIME_CANCELLED" });
    assert.equal(spawnCount, 1);
  }
});

test("Windows runtime execution safely wraps cmd and bat shims while leaving executables direct", async () => {
  const comspec = "C:\\Windows\\System32\\cmd.exe";
  const cases = [
    {
      id: "claude",
      path: "C:\\Users\\Taylor Smith\\AppData\\Roaming\\npm\\claude.cmd",
      stdout: JSON.stringify({ type: "result", subtype: "success", result: "Claude works" }),
      expected: "Claude works",
    },
    {
      id: "codex",
      path: "C:\\Users\\Taylor Smith\\AppData\\Roaming\\npm\\codex.bat",
      stdout: ndjson([
        { type: "item.completed", item: { type: "agent_message", text: "Codex works" } },
        { type: "turn.completed", usage: {} },
      ]),
      expected: "Codex works",
    },
  ];

  for (const runtimeCase of cases) {
    const calls = [];
    const result = await runInstalledRuntime({
      runtime: verifiedRuntime({ id: runtimeCase.id, path: runtimeCase.path }),
      prompt: "hello",
      model: "model & echo OWNED %PATH%!",
      platform: "win32",
      env: { COMSPEC: comspec },
      spawnImpl(command, args, options) {
        calls.push({ command, args, options });
        return fakeInstalledChild({ stdout: runtimeCase.stdout });
      },
    });

    assert.equal(result.text, runtimeCase.expected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, comspec);
    assert.deepEqual(calls[0].args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
    assert.equal(calls[0].args.length, 5);
    assert.equal(calls[0].args[4].includes("model & echo OWNED %PATH%!"), false);
    assert.match(calls[0].args[4], /\^\^\^&/);
    assert.match(calls[0].args[4], /\^\^\^%/);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.windowsVerbatimArguments, true);
  }

  const directCalls = [];
  await runInstalledRuntime({
    runtime: verifiedRuntime({ id: "claude", path: "C:\\Program Files\\Claude\\claude.exe" }),
    prompt: "hello",
    platform: "win32",
    env: { COMSPEC: comspec },
    spawnImpl(command, args, options) {
      directCalls.push({ command, args, options });
      return fakeInstalledChild({
        stdout: JSON.stringify({ type: "result", subtype: "success", result: "direct" }),
      });
    },
  });
  assert.equal(directCalls[0].command, "C:\\Program Files\\Claude\\claude.exe");
  assert.ok(directCalls[0].args.includes("--output-format"));
  assert.equal(directCalls[0].options.shell, false);
  assert.equal(directCalls[0].options.windowsVerbatimArguments, undefined);
});

test("Windows batch invocation distinguishes npm shims, plain batch files, and line-break injection", () => {
  const plain = runtimeProcessInvocation("C:\\tools\\agent.bat", ["model & value"], {
    platform: "win32",
    env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
  });
  assert.match(plain.args.at(-1), /model\^&value|model\^ \^&\^ value/);
  assert.equal(plain.args.at(-1).includes("^^^&"), false);

  const npmShim = runtimeProcessInvocation(
    "C:\\Users\\Taylor\\AppData\\Roaming\\npm\\agent.cmd",
    ["model & value"],
    {
      platform: "win32",
      env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
    }
  );
  assert.match(npmShim.args.at(-1), /\^\^\^&/);

  assert.throws(
    () =>
      runtimeProcessInvocation("C:\\tools\\agent.bat", ["safe\r\necho OWNED"], {
        platform: "win32",
      }),
    /line breaks/i
  );
  assert.throws(
    () => runtimeProcessInvocation("C:\\tools\\agent\nowned.bat", [], { platform: "win32" }),
    /line breaks/i
  );
});

test("Windows forced cleanup uses fixed taskkill argv for the entire runtime process tree", async () => {
  const childSignals = [];
  const treeCalls = [];
  const child = {
    pid: 4242,
    killed: false,
    kill(signal) {
      childSignals.push(signal);
      this.killed = true;
      return true;
    },
  };

  await new Promise((resolve) => {
    scheduleRuntimeProcessKill(child, resolve, {
      platform: "win32",
      graceMs: 5,
      env: { SystemRoot: "C:\\Windows" },
      spawnSyncImpl(command, args, options) {
        treeCalls.push({ command, args, options });
        return { status: 0 };
      },
    });
  });

  assert.deepEqual(childSignals, []);
  assert.deepEqual(treeCalls, [
    {
      command: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/pid", "4242", "/t", "/f"],
      options: { shell: false, windowsHide: true, stdio: "ignore" },
    },
  ]);
});

test("Windows streaming execution launches a detected npm shim through fixed cmd argv", async () => {
  const calls = [];
  const comspec = "C:\\Windows\\System32\\cmd.exe";
  const result = await runInstalledRuntimeStream({
    runtime: verifiedRuntime({
      id: "claude",
      path: "C:\\Users\\Taylor Smith\\AppData\\Roaming\\npm\\claude.cmd",
    }),
    prompt: "hello",
    platform: "win32",
    env: { COMSPEC: comspec },
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return fakeStreamingChild({
        chunks: [
          `${JSON.stringify({
            type: "result",
            subtype: "success",
            result: "stream works",
            session_id: "session-1",
          })}\n`,
        ],
      });
    },
  });

  assert.equal(result.text, "stream works");
  assert.equal(calls[0].command, comspec);
  assert.deepEqual(calls[0].args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
});

test("an empty ACP handshake proves protocol readiness without workflow capability evidence", async () => {
  const calls = [];
  const ready = await probeInstalledRuntime(
    { id: "hermes", name: "Hermes", path: "/safe/hermes", available: true },
    {
      spawnSyncImpl() {
        throw new Error("ACP readiness must not use a launch-only version probe");
      },
      async probeAcpRuntimeImpl(input) {
        calls.push(input);
        return { ready: true, agentCapabilities: {}, agentInfo: { name: "Hermes" } };
      },
      cwd: "/safe/workspace",
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, "/safe/workspace");
  assert.equal(hasCompleteCareerRatCapabilities(ready.capabilities), false);
  assert.equal(ready.capabilities.taskTools, false);
  assert.equal(ready.capabilities.research, false);
});

test("Claude readiness fails closed below the verified CLI boundary version", async () => {
  const calls = [];
  const unsupported = await probeInstalledRuntime(
    { id: "claude", path: "/safe/claude", available: true },
    {
      spawnSyncImpl(_path, args) {
        calls.push(args);
        return { status: 0, stdout: "2.1.200 (Claude Code)", stderr: "" };
      },
    }
  );
  assert.deepEqual(unsupported, {
    status: "unsupported_capability",
    ready: false,
    action: null,
    capabilities: {
      completion: true,
      structuredOutput: true,
      appWorkflows: true,
      exactRead: false,
      publicWeb: false,
      liveActivity: true,
      resumable: true,
      taskTools: false,
      research: false,
    },
    capabilityReason: "Update Claude Code to 2.1.241 or newer for secure CareerRat tool runs.",
  });
  assert.deepEqual(calls, [["--version"]]);
});

test("Codex readiness requires the CLI version that supports the completion capsule controls", async () => {
  const calls = [];
  const unsupported = await probeInstalledRuntime(
    { id: "codex", path: "/safe/codex", available: true },
    {
      spawnSyncImpl(_path, args) {
        calls.push(args);
        return { status: 0, stdout: "codex-cli 0.148.0", stderr: "" };
      },
    }
  );
  assert.deepEqual(unsupported, {
    status: "unsupported_capability",
    ready: false,
    action: null,
    capabilities: {
      completion: false,
      structuredOutput: false,
      appWorkflows: false,
      exactRead: false,
      publicWeb: false,
      liveActivity: false,
      resumable: false,
      taskTools: false,
      research: false,
    },
    capabilityReason: "Update Codex to 0.149.1 or newer for the complete CareerRat workflow.",
  });
  assert.deepEqual(calls, [["--version"]]);
});

test("Skill-only Claude runs are completion-only and do not require the tool boundary version", async () => {
  const repoRoot = tempRepoWithOneSkill("ingest-profile");
  let spawned = false;
  try {
    const result = await runInstalledRuntime({
      runtime: verifiedRuntime({ id: "claude", name: "Claude Code", path: "/safe/claude" }),
      prompt: "onboard",
      skill: "ingest-profile",
      repoRoot,
      tools: ["Skill"],
      spawnSyncImpl: () => ({ status: 0, stdout: "2.1.200 (Claude Code)", stderr: "" }),
      spawnImpl() {
        spawned = true;
        return fakeInstalledChild({
          stdout: JSON.stringify({ type: "result", subtype: "success", result: "bad" }),
        });
      },
    });
    assert.equal(result.text, "bad");
    assert.equal(spawned, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("fixed invocation adapters pass prompts on stdin and never use a shell", () => {
  const claude = buildInstalledRuntimeInvocation({
    runtimeId: "claude",
    executablePath: "/safe/claude",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://careerrat.local/schema.json",
      type: "object",
      maxProperties: 2,
    },
    model: "sonnet",
    effort: "high",
    tools: [],
  });
  assert.equal(claude.command, "/safe/claude");
  assert.equal(claude.options.shell, false);
  assert.equal(claude.stdin, true);
  assert.ok(claude.args.includes("--json-schema"));
  const claudeSchema = JSON.parse(claude.args[claude.args.indexOf("--json-schema") + 1]);
  assert.equal(claudeSchema.$schema, undefined);
  assert.equal(claudeSchema.$id, undefined);
  assert.equal(claudeSchema.maxProperties, 2);
  assert.equal(claude.args.includes("--safe-mode"), false);
  assert.ok(claude.args.includes("--settings"));
  assert.ok(claude.args.includes("--strict-mcp-config"));
  assert.ok(claude.args.includes("--no-session-persistence"));
  assert.ok(claude.args.includes("--permission-mode"));
  assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "");
  assert.equal(claude.args.includes("--allowedTools"), false);
  assert.equal(claude.args[claude.args.indexOf("--effort") + 1], "high");
  assert.equal(claude.args.includes("PROMPT_SECRET"), false);

  const codex = buildInstalledRuntimeInvocation({
    runtimeId: "codex",
    executablePath: "/safe/codex",
    schemaPath: "/private/tmp/schema.json",
    effort: "medium",
  });
  assert.equal(codex.command, "/safe/codex");
  assert.deepEqual(codex.args.slice(0, 2), ["exec", "--json"]);
  assert.ok(codex.args.includes("--sandbox"));
  assert.ok(codex.args.includes("read-only"));
  assert.ok(codex.args.includes("--ephemeral"));
  assert.ok(
    codex.args.includes("--ignore-user-config"),
    "bounded app calls must not inherit unrelated user MCP servers or hooks"
  );
  assert.ok(codex.args.includes("--ignore-rules"));
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "apps",
    "browser_use",
    "computer_use",
    "image_generation",
    "multi_agent",
    "plugins",
    "skill_search",
    "view_image",
  ]) {
    const index = codex.args.findIndex(
      (arg, position) => arg === "--disable" && codex.args[position + 1] === feature
    );
    assert.ok(index >= 0, `Codex completion capsule must disable ${feature}`);
  }
  assert.ok(codex.args.includes("--output-schema"));
  assert.ok(codex.args.includes('model_reasoning_effort="medium"'));
  assert.equal(codex.args.at(-1), "-");
  assert.equal(codex.options.shell, false);
});

test("Codex public-web invocation uses supported per-call search and MCP config", () => {
  const invocation = buildInstalledRuntimeInvocation({
    runtimeId: "codex",
    executablePath: "/safe/codex",
    runtimeHostPath: "/safe/careerrat-runtime",
    tools: ["WebSearch", "WebFetch"],
  });

  assert.equal(invocation.args.includes("--search"), false);
  assert.ok(invocation.args.includes("--strict-config"));
  const overrides = invocation.args.flatMap((arg, index, args) =>
    arg === "-c" ? [args[index + 1]] : []
  );
  assert.ok(overrides.includes('web_search="live"'));
  assert.ok(
    overrides.includes('mcp_servers.careerrat_scoped_tools.command="/safe/careerrat-runtime"')
  );
  assert.ok(
    overrides.includes(
      `mcp_servers.careerrat_scoped_tools.args=${JSON.stringify([
        new URL("../src/core/ai/installed-runtimes.mjs", import.meta.url).pathname,
        "--careerrat-scoped-tools",
        "--allow-public-web",
      ])}`
    )
  );
  assert.ok(overrides.includes('mcp_servers.careerrat_scoped_tools.enabled_tools=["fetch"]'));
  assert.ok(overrides.includes("mcp_servers.careerrat_scoped_tools.required=true"));
  assert.ok(
    overrides.includes('mcp_servers.careerrat_scoped_tools.default_tools_approval_mode="approve"')
  );
  assert.ok(overrides.includes('mcp_servers.careerrat_scoped_tools.env.ELECTRON_RUN_AS_NODE="1"'));
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "computer_use",
    "view_image",
  ]) {
    assert.ok(
      invocation.args.some(
        (arg, index, args) => arg === "--disable" && args[index + 1] === feature
      ),
      `Codex public web must leave ${feature} disabled`
    );
  }
});

test("claude exact-read invocation approves only the uploaded file and isolated skill", () => {
  const repoRoot = tempRepoWithOneSkill("resume-extract", "Read only the supplied resume.\n");
  let isolatedCwd;
  try {
    const uploadDir = join(repoRoot, "workspace", "intake", "resume-uploads");
    mkdirSync(uploadDir, { recursive: true });
    const upload = join(uploadDir, "resume.pdf");
    const sibling = join(uploadDir, "other.pdf");
    writeFileSync(upload, "resume", "utf8");
    writeFileSync(sibling, "private sibling", "utf8");
    isolatedCwd = materializeIsolatedSkillCwd({ repoRoot, skill: "resume-extract" });

    const invocation = buildInstalledRuntimeInvocation({
      runtimeId: "claude",
      executablePath: "/safe/claude",
      repoRoot,
      isolatedCwd,
      approvedReadPaths: [upload],
      tools: ["Read", "Skill"],
      skill: "resume-extract",
    });
    const settings = JSON.parse(invocation.args[invocation.args.indexOf("--settings") + 1]);
    assert.deepEqual(settings.sandbox.filesystem.denyRead, ["//**"]);
    assert.deepEqual(
      new Set(settings.sandbox.filesystem.allowRead),
      new Set([realpathSync(upload), realpathSync(isolatedCwd)])
    );
    assert.equal(settings.sandbox.filesystem.allowRead.includes(sibling), false);
    assert.equal(
      settings.sandbox.filesystem.allowRead.includes(join(repoRoot, "workspace")),
      false
    );
    assert.equal(
      settings.sandbox.filesystem.allowRead.includes(join(repoRoot, "candidate")),
      false
    );
    assert.equal(invocation.args.includes("--safe-mode"), false);
    assert.ok(invocation.args.includes("--strict-mcp-config"));
    assert.ok(invocation.args.includes("--no-chrome"));
    const allowed = invocation.args[invocation.args.indexOf("--allowedTools") + 1];
    assert.doesNotMatch(
      allowed,
      /(?:^|,)Read(?:,|$)/,
      "Read must never be approved without a path"
    );
    assert.match(allowed, /Read\(\/\//);
    assert.match(allowed, /Skill\(resume-extract\)/);
  } finally {
    if (isolatedCwd) rmSync(isolatedCwd, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("claude exact-read invocation fails closed for missing, outside, and symlink-aliased paths", () => {
  const repoRoot = tempRepoWithOneSkill("resume-extract");
  const uploadDir = join(repoRoot, "workspace", "intake", "resume-uploads");
  const outside = join(repoRoot, "workspace", "tracker.json");
  const target = join(uploadDir, "resume.pdf");
  const alias = join(uploadDir, "alias.pdf");
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(outside, "tracker", "utf8");
  writeFileSync(target, "resume", "utf8");
  symlinkSync(target, alias);

  try {
    for (const approvedReadPaths of [[], [join(uploadDir, "missing.pdf")], [outside], [alias]]) {
      assert.throws(
        () =>
          buildInstalledRuntimeInvocation({
            runtimeId: "claude",
            executablePath: "/safe/claude",
            repoRoot,
            approvedReadPaths,
            tools: ["Read", "Skill"],
            skill: "resume-extract",
          }),
        { code: "RUNTIME_READ_BOUNDARY_INVALID" }
      );
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("claude exact-read invocation resolves uploads from CAREERRAT_HOME in packaged layout", () => {
  const repoRoot = tempRepoWithOneSkill("resume-extract");
  const privateHome = tempRoot();
  const uploadDir = join(privateHome, "workspace", "intake", "resume-uploads");
  const upload = join(uploadDir, "resume.pdf");
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(upload, "resume", "utf8");
  let isolatedCwd;
  try {
    isolatedCwd = materializeIsolatedSkillCwd({ repoRoot, skill: "resume-extract" });
    const invocation = buildInstalledRuntimeInvocation({
      runtimeId: "claude",
      executablePath: "/safe/claude",
      repoRoot,
      env: { CAREERRAT_HOME: privateHome },
      isolatedCwd,
      approvedReadPaths: [upload],
      tools: ["Read", "Skill"],
      skill: "resume-extract",
    });
    const settings = JSON.parse(invocation.args[invocation.args.indexOf("--settings") + 1]);
    assert.ok(settings.sandbox.filesystem.allowRead.includes(realpathSync(upload)));
    assert.equal(
      settings.sandbox.filesystem.allowRead.some((path) =>
        path.startsWith(join(repoRoot, "workspace"))
      ),
      false
    );
  } finally {
    if (isolatedCwd) rmSync(isolatedCwd, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(privateHome, { recursive: true, force: true });
  }
});

test("claude web invocation replaces native WebFetch with the guarded CareerRat MCP fetch tool", () => {
  const repoRoot = tempRepoWithOneSkill("research-company");
  try {
    const invocation = buildInstalledRuntimeInvocation({
      runtimeId: "claude",
      executablePath: "/safe/claude",
      repoRoot,
      tools: ["WebSearch", "WebFetch", "Skill"],
      skill: "research-company",
    });
    const visible = invocation.args[invocation.args.indexOf("--tools") + 1].split(",");
    assert.ok(visible.includes("WebSearch"));
    assert.ok(visible.includes("Skill"));
    assert.equal(visible.includes("WebFetch"), false);
    const mcp = JSON.parse(invocation.args[invocation.args.indexOf("--mcp-config") + 1]);
    assert.deepEqual(Object.keys(mcp.mcpServers), ["careerrat_scoped_tools"]);
    const allowed = invocation.args[invocation.args.indexOf("--allowedTools") + 1];
    assert.match(allowed, /mcp__careerrat_scoped_tools__fetch/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("CareerRat public-web fetch rejects private targets before invoking the network helper", async () => {
  let called = false;
  const result = await fetchInstalledRuntimePublicUrl("http://127.0.0.1/private", {
    fetchPublicHttpTextImpl: async () => {
      called = true;
      return { ok: true };
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /private|local|non-public/i);
  assert.equal(called, false);
});

test("CareerRat public-web fetch delegates public URLs to the DNS-pinned guarded fetch", async () => {
  const calls = [];
  const result = await fetchInstalledRuntimePublicUrl("https://example.com/jobs", {
    fetchPublicHttpTextImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        finalUrl: url,
        status: 200,
        contentType: "text/html",
        rawText: "Remote role",
      };
    },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      url: "https://example.com/jobs",
      options: { timeoutMs: 15000, maxBytes: 512 * 1024, maxRedirects: 4 },
    },
  ]);
  assert.match(result.content[0].text, /Remote role/);
});

test("CareerRat scoped read returns only the staged input and rejects alternate or unsafe inputs", () => {
  const root = tempRoot();
  const input = join(root, "resume.md");
  const sibling = join(root, "private.md");
  const alias = join(root, "alias.md");
  writeFileSync(input, "approved resume evidence", "utf8");
  writeFileSync(sibling, "private sibling", "utf8");
  symlinkSync(sibling, alias);

  try {
    const accepted = readInstalledRuntimeScopedFile(input);
    assert.equal(accepted.isError, undefined);
    assert.deepEqual(accepted.content, [{ type: "text", text: "approved resume evidence" }]);

    for (const rejected of [
      readInstalledRuntimeScopedFile(input, { input: { path: sibling } }),
      readInstalledRuntimeScopedFile(input, { input: { path: "../private.md" } }),
      readInstalledRuntimeScopedFile(alias),
      readInstalledRuntimeScopedFile(input, { maxBytes: 4 }),
    ]) {
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, /rejected/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the scoped-tools child speaks MCP JSON-RPC for discovery, staged read, and rejection", async () => {
  const root = tempRoot();
  const stagedPath = join(root, "approved.txt");
  writeFileSync(stagedPath, "approved staged input", "utf8");
  const modulePath = fileURLToPath(
    new URL("../src/core/ai/installed-runtimes.mjs", import.meta.url)
  );
  const child = spawn(
    process.execPath,
    [
      modulePath,
      "--careerrat-scoped-tools",
      "--allow-public-web",
      "--approved-read-file",
      stagedPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"], shell: false }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    child.stdin.write("not-json\n");
    for (const message of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "read_staged_input", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "not_available", arguments: {} },
      },
      { jsonrpc: "2.0", id: 5, method: "ping", params: {} },
    ]) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    const deadline = Date.now() + 3000;
    while (stdout.trim().split("\n").filter(Boolean).length < 5 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const replies = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(replies.length, 5, stderr || stdout);
    const byId = new Map(replies.map((reply) => [reply.id, reply]));
    assert.equal(byId.get(1).result.serverInfo.name, "careerrat_scoped_tools");
    assert.deepEqual(
      byId
        .get(2)
        .result.tools.map(({ name }) => name)
        .sort(),
      ["fetch", "read_staged_input"]
    );
    assert.equal(byId.get(3).result.content[0].text, "approved staged input");
    assert.equal(byId.get(4).error.code, -32601);
    assert.deepEqual(byId.get(5).result, {});
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex exact-read work still fails before spawn without one approved upload", async () => {
  const repoRoot = tempRepoWithOneSkill("resume-extract");
  let spawned = false;
  try {
    await assert.rejects(
      runInstalledRuntime({
        runtime: verifiedRuntime({ id: "codex", name: "Codex", path: "/safe/codex" }),
        prompt: "read the workspace",
        skill: "resume-extract",
        repoRoot,
        tools: ["Read"],
        spawnImpl() {
          spawned = true;
          return fakeInstalledChild();
        },
      }),
      { code: "RUNTIME_READ_BOUNDARY_INVALID" }
    );
    assert.equal(spawned, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runtime sign-in starts the resolved CLI directly without a shell or terminal app", () => {
  const calls = [];
  const listeners = {};
  const child = {
    unref() {},
    once(event, listener) {
      listeners[event] = listener;
    },
    kill(signal) {
      calls.push({ signal });
    },
  };
  const result = startInstalledRuntimeSignIn(
    { id: "claude", path: "/safe/claude" },
    {
      spawnImpl(command, args, options) {
        calls.push({ command, args, options });
        return child;
      },
    }
  );

  assert.equal(result.signInCommand, "claude auth login");
  assert.equal(result.reused, false);
  assert.equal(calls[0].command, "/safe/claude");
  assert.deepEqual(calls[0].args, ["auth", "login"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.detached, true);
  stopInstalledRuntimeSignIns();
  assert.deepEqual(calls.at(-1), { signal: "SIGTERM" });
});

test("guided Claude setup runs the fixed installer and streams its output", async () => {
  const calls = [];
  const output = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const resultPromise = startInstalledRuntimeGuidedSetup("claude", {
    platform: "darwin",
    onOutput: (line) => output.push(line),
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => {
        child.emit("spawn");
        child.stdout.emit("data", Buffer.from("Installing Claude Code…\n"));
        child.stderr.emit("data", Buffer.from("Finishing setup\n"));
        child.emit("close", 0, null);
      });
      return child;
    },
  });
  const result = await resultPromise;

  assert.equal(result.runtimeId, "claude");
  assert.equal(result.installCommand, "curl -fsSL https://claude.ai/install.sh | bash");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/bin/sh");
  assert.deepEqual(calls[0].args, ["-c", "curl -fsSL https://claude.ai/install.sh | bash"]);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.deepEqual(output, ["Installing Claude Code…", "Finishing setup"]);
  assert.doesNotMatch(calls[0].args.join("\n"), /referral\/rOLHwxlsfA/);
});

test("guided Claude setup rejects when macOS cannot launch the installer", async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const result = startInstalledRuntimeGuidedSetup("claude", {
    platform: "darwin",
    spawnImpl() {
      queueMicrotask(() => child.emit("error", new Error("installer process could not start")));
      return child;
    },
  });

  await assert.rejects(result, {
    code: "RUNTIME_GUIDED_SETUP_LAUNCH_FAILED",
  });
});

test("guided Claude setup rejects when the installer exits unsuccessfully", async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const result = startInstalledRuntimeGuidedSetup("claude", {
    platform: "darwin",
    spawnImpl() {
      queueMicrotask(() => child.emit("close", 1, null));
      return child;
    },
  });

  await assert.rejects(result, {
    code: "RUNTIME_GUIDED_SETUP_LAUNCH_FAILED",
  });
});

test("guided runtime setup is limited to Claude on macOS", async () => {
  await assert.rejects(startInstalledRuntimeGuidedSetup("codex", { platform: "darwin" }), {
    code: "RUNTIME_GUIDED_SETUP_UNSUPPORTED",
  });
  await assert.rejects(startInstalledRuntimeGuidedSetup("claude", { platform: "win32" }), {
    code: "RUNTIME_GUIDED_SETUP_UNSUPPORTED",
  });
});

test("runtime sign-in exposes only accepted product engines", () => {
  assert.equal(installedRuntimeSignInCommand("claude"), "claude auth login");
  assert.equal(installedRuntimeSignInCommand("codex"), "codex login");
  for (const runtimeId of [
    "gemini",
    "opencode",
    "copilot",
    "qwen",
    "antigravity",
    "hermes",
    "amp",
    "goose",
    "droid",
  ]) {
    assert.equal(installedRuntimeSignInCommand(runtimeId), null);
  }
});

test("Codex sign-in uses the resolved executable with fixed argv", () => {
  const calls = [];
  const child = {
    unref() {},
    once() {},
    kill() {},
  };
  const result = startInstalledRuntimeSignIn(
    { id: "codex", path: "/safe/codex" },
    {
      spawnImpl(command, args, options) {
        calls.push({ command, args, options });
        return child;
      },
    }
  );

  assert.equal(result.signInCommand, "codex login");
  assert.equal(calls[0].command, "/safe/codex");
  assert.deepEqual(calls[0].args, ["login"]);
  assert.equal(calls[0].options.shell, false);
  stopInstalledRuntimeSignIns();
});

test("Windows sign-in launches a detected npm shim through the same fixed cmd boundary", () => {
  const calls = [];
  const comspec = "C:\\Windows\\System32\\cmd.exe";
  const child = {
    unref() {},
    once() {},
    kill() {},
  };
  startInstalledRuntimeSignIn(
    {
      id: "codex",
      path: "C:\\Users\\Taylor Smith\\AppData\\Roaming\\npm\\codex.cmd",
    },
    {
      platform: "win32",
      env: { COMSPEC: comspec },
      spawnImpl(command, args, options) {
        calls.push({ command, args, options });
        return child;
      },
    }
  );

  assert.equal(calls[0].command, comspec);
  assert.deepEqual(calls[0].args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
  assert.match(calls[0].args[4], /codex\.cmd/i);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  stopInstalledRuntimeSignIns();
});

test("Windows sign-in timeout and explicit stop terminate the whole cmd shim process tree", async () => {
  const treeCalls = [];
  let nextPid = 5000;
  const spawnSyncImpl = (command, args, options) => {
    treeCalls.push({ command, args, options });
    return { status: 0 };
  };
  const spawnImpl = () => ({
    pid: nextPid++,
    unref() {},
    once() {},
    kill() {
      throw new Error("Windows cleanup must use taskkill for the process tree");
    },
  });
  const runtime = {
    id: "codex",
    path: "C:\\Users\\Taylor\\AppData\\Roaming\\npm\\codex.cmd",
  };
  const options = {
    platform: "win32",
    env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "C:\\Windows" },
    spawnImpl,
    spawnSyncImpl,
  };

  startInstalledRuntimeSignIn(runtime, options);
  stopInstalledRuntimeSignIns();
  await new Promise((resolve) => setTimeout(resolve, 275));

  startInstalledRuntimeSignIn(runtime, { ...options, timeoutMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 275));
  stopInstalledRuntimeSignIns();

  assert.deepEqual(
    treeCalls.map(({ command, args, options: callOptions }) => ({
      command,
      args,
      options: callOptions,
    })),
    [
      {
        command: "C:\\Windows\\System32\\taskkill.exe",
        args: ["/pid", "5000", "/t", "/f"],
        options: { shell: false, windowsHide: true, stdio: "ignore" },
      },
      {
        command: "C:\\Windows\\System32\\taskkill.exe",
        args: ["/pid", "5001", "/t", "/f"],
        options: { shell: false, windowsHide: true, stdio: "ignore" },
      },
    ]
  );
});

test("installed runtime selection persists under the active private CareerRat home", () => {
  const root = tempRoot();
  const env = { CAREERRAT_HOME: join(root, "private") };
  try {
    assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: root, env }), {
      runtimeId: null,
      providerFallback: false,
      customCommand: null,
      verification: null,
    });
    writeInstalledRuntimeSelection({
      repoRoot: root,
      env,
      runtimeId: "codex",
      providerFallback: false,
    });
    assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: root, env }), {
      runtimeId: "codex",
      providerFallback: false,
      customCommand: null,
      verification: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed runtime selection rejects adapters that have not passed product acceptance", () => {
  const root = tempRoot();
  try {
    assert.throws(
      () =>
        writeInstalledRuntimeSelection({
          repoRoot: root,
          env: {},
          runtimeId: "hermes",
        }),
      /unsupported installed AI runtime: hermes/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude adapter buffers structured output while keeping the prompt off argv", async () => {
  const root = tempRoot();
  const executablePath = join(root, "claude");
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const leaked = process.argv.some((arg) => arg.includes("PROMPT_SECRET"));
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    result: "ignored",
    structured_output: { verdict: "keep", promptWasOnArgv: leaked, gotPrompt: input.includes("PROMPT_SECRET") },
  }));
});
`,
    "utf8"
  );
  chmodSync(executablePath, 0o755);
  try {
    const result = await runInstalledRuntime({
      runtime: verifiedRuntime({ id: "claude", path: executablePath }),
      prompt: "PROMPT_SECRET",
      outputSchema: { type: "object" },
      timeoutMs: 2000,
    });
    assert.deepEqual(JSON.parse(result.text), {
      verdict: "keep",
      promptWasOnArgv: false,
      gotPrompt: true,
    });
    assert.equal(result.runtimeId, "claude");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex adapter reads the final agent message from JSONL", async () => {
  const root = tempRoot();
  const executablePath = join(root, "codex");
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  const schemaPath = process.argv[process.argv.indexOf("--output-schema") + 1];
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "secret-session" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ required: schema.required, candidateRequired: schema.properties.candidate.required, candidateAdditionalProperties: schema.properties.candidate.additionalProperties }) } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }) + "\\n");
});
`,
    "utf8"
  );
  chmodSync(executablePath, 0o755);
  try {
    const result = await runInstalledRuntime({
      runtime: verifiedRuntime({ id: "codex", path: executablePath }),
      prompt: "classify",
      outputSchema: {
        type: "object",
        properties: {
          candidate: {
            type: "object",
            properties: {
              full_name: { type: ["string", "null"] },
              domain: { type: "string" },
            },
          },
        },
      },
      timeoutMs: 2000,
    });
    assert.deepEqual(JSON.parse(result.text), {
      required: ["candidate"],
      candidateRequired: ["full_name", "domain"],
      candidateAdditionalProperties: false,
    });
    assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 2 });
    assert.equal(JSON.stringify(result).includes("secret-session"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex adapter rejects unconstrained object output instead of silently making it empty-only", async () => {
  const root = tempRoot();
  const executablePath = join(root, "codex");
  executable(executablePath);
  try {
    await assert.rejects(
      runInstalledRuntime({
        runtime: verifiedRuntime({ id: "codex", path: executablePath }),
        prompt: "classify",
        outputSchema: {
          type: "object",
          required: ["proposal"],
          properties: { proposal: { type: "object" } },
        },
        timeoutMs: 2000,
      }),
      (error) => error?.code === "RUNTIME_OUTPUT_SCHEMA_UNSUPPORTED"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ACP adapter runs a staged CareerRat skill through protocol stdin instead of provider argv", async () => {
  const repoRoot = tempRepoWithOneSkill(
    "answer-question",
    "Use only the supplied evidence. Marker: ACP_SKILL_CONTEXT.\n"
  );
  let call;
  let isolatedCwd;
  try {
    const result = await runInstalledRuntime({
      runtime: verifiedRuntime({ id: "hermes", name: "Hermes Agent", path: "/safe/hermes" }),
      prompt: "Answer the screening question.",
      skill: "answer-question",
      repoRoot,
      tools: ["Skill"],
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
      runAcpRuntimeImpl: async (options) => {
        call = options;
        isolatedCwd = options.cwd;
        return {
          text: '{"answer":"done"}',
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          model: null,
          sessionId: "acp-1",
          runtimeId: "hermes",
        };
      },
    });
    assert.equal(result.text, '{"answer":"done"}');
    assert.equal(result.runtimeId, "hermes");
    assert.equal(call.runtime.path, "/safe/hermes");
    assert.deepEqual(call.tools, []);
    assert.notEqual(call.cwd, repoRoot);
    assert.match(call.prompt, /ACP_SKILL_CONTEXT/);
    assert.match(call.prompt, /"required":\["answer"\]/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
  assert.ok(isolatedCwd);
  assert.equal(existsSync(isolatedCwd), false);
});

test("installed runtime failures distinguish nonzero exit, timeout, and cancellation", async () => {
  const root = tempRoot();
  const failedPath = join(root, "failed-claude");
  const hangingPath = join(root, "hanging-claude");
  writeFileSync(
    failedPath,
    '#!/bin/sh\nread ignored\necho "sign in required" >&2\nexit 7\n',
    "utf8"
  );
  writeFileSync(hangingPath, "#!/bin/sh\nread ignored\nsleep 10\n", "utf8");
  chmodSync(failedPath, 0o755);
  chmodSync(hangingPath, 0o755);
  try {
    await assert.rejects(
      runInstalledRuntime({
        runtime: verifiedRuntime({ id: "claude", path: failedPath }),
        prompt: "hello",
        timeoutMs: 2000,
      }),
      (error) =>
        error.code === "RUNTIME_EXIT" &&
        error.exitStatus === 7 &&
        /sign in required/.test(error.message)
    );

    await assert.rejects(
      runInstalledRuntime({
        runtime: verifiedRuntime({ id: "claude", path: hangingPath }),
        prompt: "hello",
        timeoutMs: 20,
      }),
      (error) => error.code === "RUNTIME_TIMEOUT"
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runInstalledRuntime({
        runtime: verifiedRuntime({ id: "claude", path: hangingPath }),
        prompt: "hello",
        timeoutMs: 2000,
        signal: controller.signal,
      }),
      (error) => error.code === "RUNTIME_CANCELLED"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed runtime cancellation escalates to SIGKILL when the CLI ignores SIGTERM", async () => {
  function termIgnoringChild(signals) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    };
    return child;
  }

  for (const run of [runInstalledRuntime, runInstalledRuntimeStream]) {
    const signals = [];
    const controller = new AbortController();
    const pending = run({
      runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
      prompt: "hello",
      timeoutMs: 2000,
      signal: controller.signal,
      spawnImpl: () => termIgnoringChild(signals),
    });

    controller.abort();
    await assert.rejects(pending, (error) => error.code === "RUNTIME_CANCELLED");
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  }
});

test("installed runtime cancellation stays authoritative when the killed child emits an error", async () => {
  for (const run of [runInstalledRuntime, runInstalledRuntimeStream]) {
    const controller = new AbortController();
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => queueMicrotask(() => controller.abort());
    child.kill = () => {
      queueMicrotask(() => child.emit("error", new Error("process terminated")));
      return true;
    };

    await assert.rejects(
      run({
        runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
        prompt: "hello",
        timeoutMs: 2000,
        signal: controller.signal,
        spawnImpl: () => child,
      }),
      (error) => error.code === "RUNTIME_CANCELLED"
    );
  }
});

test("installed runtime cancellation suppresses late output and activity callbacks", async () => {
  function lateOutputChild(controller, payload) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => queueMicrotask(() => controller.abort());
    child.kill = (signal) => {
      if (signal === "SIGTERM") queueMicrotask(() => child.stdout.emit("data", payload));
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    };
    return child;
  }

  const oneShotController = new AbortController();
  const outputEvents = [];
  await assert.rejects(
    runInstalledRuntime({
      runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
      prompt: "hello",
      signal: oneShotController.signal,
      onEvent: (event) => outputEvents.push(event),
      spawnImpl: () => lateOutputChild(oneShotController, Buffer.from("late")),
    }),
    { code: "RUNTIME_CANCELLED" }
  );
  assert.deepEqual(outputEvents, []);

  const streamController = new AbortController();
  const messages = [];
  const lateResult = Buffer.from(
    `${JSON.stringify({ type: "result", subtype: "success", result: "late" })}\n`
  );
  await assert.rejects(
    runInstalledRuntimeStream({
      runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
      prompt: "hello",
      signal: streamController.signal,
      onMessage: (message) => messages.push(message),
      spawnImpl: () => lateOutputChild(streamController, lateResult),
    }),
    { code: "RUNTIME_CANCELLED" }
  );
  assert.deepEqual(messages, []);

  const bufferedController = new AbortController();
  const bufferedMessages = [];
  const bufferedChild = lateOutputChild(bufferedController, Buffer.alloc(0));
  bufferedChild.stdin.end = () => {
    bufferedChild.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ type: "result", subtype: "success", result: "late" }))
    );
    bufferedController.abort();
  };
  bufferedChild.kill = (signal) => {
    if (signal === "SIGTERM") queueMicrotask(() => bufferedChild.emit("close", null, "SIGTERM"));
    return true;
  };
  await assert.rejects(
    runInstalledRuntimeStream({
      runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
      prompt: "hello",
      signal: bufferedController.signal,
      onMessage: (message) => bufferedMessages.push(message),
      spawnImpl: () => bufferedChild,
    }),
    { code: "RUNTIME_CANCELLED" }
  );
  assert.deepEqual(bufferedMessages, []);
});

test("installed runtime preserves the first stop cause when a later abort races cleanup", async () => {
  function stoppedChild({ onStart, controller }) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => onStart(child);
    child.kill = (signal) => {
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    };
    setTimeout(() => controller.abort(), 30).unref?.();
    return child;
  }

  for (const run of [runInstalledRuntime, runInstalledRuntimeStream]) {
    const timeoutController = new AbortController();
    await assert.rejects(
      run({
        runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
        prompt: "hello",
        timeoutMs: 5,
        signal: timeoutController.signal,
        spawnImpl: () =>
          stoppedChild({
            controller: timeoutController,
            onStart() {},
          }),
      }),
      (error) => error.code === "RUNTIME_TIMEOUT"
    );

    const overflowController = new AbortController();
    await assert.rejects(
      run({
        runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
        prompt: "hello",
        timeoutMs: 2000,
        signal: overflowController.signal,
        spawnImpl: () =>
          stoppedChild({
            controller: overflowController,
            onStart(child) {
              child.stdout.emit("data", Buffer.alloc(10 * 1024 * 1024 + 1));
            },
          }),
      }),
      (error) => error.code === "RUNTIME_OUTPUT_LIMIT"
    );
  }
});

test("runInstalledRuntime surfaces a redacted Claude JSON failure from stdout on nonzero exit", async () => {
  const exposedCredential = "sk-ant-api03-should-not-escape";
  await assert.rejects(
    runInstalledRuntime({
      runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
      prompt: "hello",
      timeoutMs: 2000,
      spawnImpl: () =>
        fakeInstalledChild({
          status: 1,
          stdout: JSON.stringify({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: `Not logged in. Run /login. ${exposedCredential}`,
            session_id: "private-session-id",
          }),
        }),
    }),
    (error) => {
      assert.equal(error.code, "RUNTIME_EXIT");
      assert.match(error.message, /Not logged in\. Run \/login\./);
      assert.match(error.message, /\[redacted\]/);
      assert.doesNotMatch(error.message, new RegExp(exposedCredential));
      assert.doesNotMatch(error.message, /private-session-id/);
      return true;
    }
  );
});

test("runInstalledRuntime classifies a provider usage cap without exposing raw CLI text", async () => {
  await assert.rejects(
    runInstalledRuntime({
      runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
      prompt: "hello",
      timeoutMs: 2000,
      spawnImpl: () =>
        fakeInstalledChild({
          status: 1,
          stdout: JSON.stringify({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result:
              "You've hit your weekly limit · resets 4pm (America/New_York) · internal schema secret",
          }),
        }),
    }),
    (error) => {
      assert.equal(error.code, "RUNTIME_USAGE_LIMIT");
      assert.equal(
        error.message,
        "Claude Code has reached its usage limit. It resets at 4pm (America/New_York). Try again after the reset."
      );
      assert.equal(error.resetAt, "4pm (America/New_York)");
      assert.doesNotMatch(error.message, /weekly|schema|secret|exited with status/i);
      return true;
    }
  );
});

// P0 regression: runInstalledRuntime's `timeoutMs` has two named tiers (see
// installed-runtimes.mjs's own comment above their definitions). Bounded
// one-shot calls (evaluate-job, tailor-application, resume-extract, ...) must
// keep the exact ~120s bound they always had. A chat session opts into the
// wider tier per-call (see tests/chat-runtime.test.mjs's own pin of that
// wiring); it is never the shared default.
test("runInstalledRuntime's default timeoutMs is the byte-identical one-shot 120s bound; the chat-session tier is a separate, wider, explicitly-opted-into constant", () => {
  assert.equal(ONE_SHOT_RUNTIME_TIMEOUT_MS, 120000);
  assert.equal(CHAT_SESSION_RUNTIME_TIMEOUT_MS, 9 * 60 * 1000);
  assert.ok(CHAT_SESSION_RUNTIME_TIMEOUT_MS > ONE_SHOT_RUNTIME_TIMEOUT_MS);
});

test("parseCustomCommandString splits on whitespace and keeps quoted segments intact", () => {
  assert.deepEqual(parseCustomCommandString("my-agent --flag value"), [
    "my-agent",
    "--flag",
    "value",
  ]);
  assert.deepEqual(parseCustomCommandString('~/bin/my-agent --name "my agent"'), [
    "~/bin/my-agent",
    "--name",
    "my agent",
  ]);
  assert.deepEqual(parseCustomCommandString("agent --name 'solo quoted'"), [
    "agent",
    "--name",
    "solo quoted",
  ]);
  assert.deepEqual(parseCustomCommandString("agent \"first arg\" 'second arg'"), [
    "agent",
    "first arg",
    "second arg",
  ]);
  assert.deepEqual(parseCustomCommandString("  agent   --flag   "), ["agent", "--flag"]);
});

test("parseCustomCommandString returns an empty argv for empty or garbage-only input", () => {
  assert.deepEqual(parseCustomCommandString(""), []);
  assert.deepEqual(parseCustomCommandString("   "), []);
  assert.deepEqual(parseCustomCommandString(null), []);
  assert.deepEqual(parseCustomCommandString(undefined), []);
  assert.deepEqual(parseCustomCommandString('""'), [""]);
});

test("probeCustomRuntimeCommand reports ok:true with measured latency on a successful run", async () => {
  const root = tempRoot();
  const executablePath = join(root, "custom-agent");
  writeFileSync(
    executablePath,
    '#!/bin/sh\nread ignored\nsleep 0.05\necho "ack"\nexit 0\n',
    "utf8"
  );
  chmodSync(executablePath, 0o755);
  try {
    const result = await probeCustomRuntimeCommand({ command: executablePath });
    assert.equal(result.ok, true);
    assert.equal(typeof result.elapsedMs, "number");
    assert.ok(result.elapsedMs >= 0);
    assert.ok(result.output.includes("ack"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probeCustomRuntimeCommand reports ok:false with stderr diagnostic on a non-zero exit", async () => {
  const root = tempRoot();
  const executablePath = join(root, "failing-agent");
  writeFileSync(executablePath, '#!/bin/sh\nread ignored\necho "boom" >&2\nexit 3\n', "utf8");
  chmodSync(executablePath, 0o755);
  try {
    const result = await probeCustomRuntimeCommand({ command: executablePath });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("boom"));
    assert.equal(typeof result.elapsedMs, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probeCustomRuntimeCommand reports ok:false without a latency reading on empty input", async () => {
  const result = await probeCustomRuntimeCommand({ command: "" });
  assert.deepEqual(result, { ok: false, error: "Enter a command to test." });
});

test("probeCustomRuntimeCommand reports ok:false when the command cannot be spawned at all", async () => {
  const result = await probeCustomRuntimeCommand({
    command: "totally-not-a-real-binary --flag",
    spawnImpl() {
      throw new Error("spawn ENOENT");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.elapsedMs, null);
  assert.ok(result.error.includes("totally-not-a-real-binary"));
  assert.ok(result.error.includes("spawn ENOENT"));
});

test("probeCustomRuntimeCommand reports ok:false when the process emits an error event", async () => {
  const { EventEmitter } = await import("node:events");
  const result = await probeCustomRuntimeCommand({
    command: "custom-agent",
    spawnImpl() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.end = () => {
        queueMicrotask(() => child.emit("error", new Error("spawn EACCES")));
      };
      child.kill = () => {};
      return child;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.elapsedMs, null);
  assert.ok(result.error.includes("EACCES"));
});

test("probeCustomRuntimeCommand routes Windows cmd shims through the fixed launcher", async () => {
  const calls = [];
  const result = await probeCustomRuntimeCommand({
    command: '"C:\\Users\\Taylor Smith\\AppData\\Roaming\\npm\\custom-agent.cmd" --probe',
    platform: "win32",
    env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return fakeInstalledChild({ stdout: "ack" });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(calls[0].args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
});

test("probeCustomRuntimeCommand times out a hanging command using the caller-supplied timeoutMs", async () => {
  const root = tempRoot();
  const hangingPath = join(root, "hanging-custom-agent");
  writeFileSync(hangingPath, "#!/bin/sh\nread ignored\nsleep 10\n", "utf8");
  chmodSync(hangingPath, 0o755);
  try {
    const result = await probeCustomRuntimeCommand({ command: hangingPath, timeoutMs: 30 });
    assert.equal(result.ok, false);
    assert.equal(result.error, "Timed out after 15s.");
    assert.equal(typeof result.elapsedMs, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P0 regression — the installed "claude" runtime's Skill tool coming up
// empty under --safe-mode. CHAT_RUNTIME_TOOLS chat sessions (research-company,
// research-comp, company-health, research-boards) grant only WebSearch/
// WebFetch/Skill — no Read — so when --safe-mode blanks the Skill tool's
// registry, the skill is unreachable and the session freelances instead of
// emitting its typed careerrat:discovery result. --safe-mode's own --help
// text says it disables "skills" outright; verified empirically against the
// real installed CLI that a --safe-mode run's Skill tool lists only
// Anthropic's fixed built-ins, never a project skill. The fix: when a
// specific skill is given, spawn against an isolated cwd containing nothing
// but that skill (materializeIsolatedSkillCwd) with --setting-sources
// project instead of --safe-mode — verified empirically to expose exactly
// that one skill at --safe-mode's own ~5k-token baseline cost, not the
// ~136k a real project cwd produces.
// ---------------------------------------------------------------------------

function tempRepoWithOneSkill(skillName, body = `# ${skillName}\n`) {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-installed-skill-repo-"));
  const skillDir = join(repoRoot, ".agents", "skills", skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skillName}\n---\n${body}`, "utf8");
  return repoRoot;
}

test("buildInstalledRuntimeInvocation: a claude call with a materialized skill trades --safe-mode for --setting-sources project", () => {
  const withSkill = buildInstalledRuntimeInvocation({
    runtimeId: "claude",
    executablePath: "/safe/claude",
    tools: ["WebSearch", "WebFetch", "Skill"],
    skill: "research-company",
  });
  assert.equal(withSkill.args.includes("--safe-mode"), false);
  const idx = withSkill.args.indexOf("--setting-sources");
  assert.ok(idx >= 0, "expected --setting-sources in argv");
  assert.equal(withSkill.args[idx + 1], "project");

  // No skill gets an empty project setting source and no visible tools.
  const withoutSkill = buildInstalledRuntimeInvocation({
    runtimeId: "claude",
    executablePath: "/safe/claude",
    tools: [],
  });
  assert.equal(withoutSkill.args.includes("--safe-mode"), false);
  const noSkillSettings = withoutSkill.args.indexOf("--setting-sources");
  assert.ok(noSkillSettings >= 0);
  assert.equal(withoutSkill.args[noSkillSettings + 1], "");
});

test("materializeIsolatedSkillCwd exposes one canonical skill to Claude and provider-neutral discovery", () => {
  const repoRoot = tempRepoWithOneSkill("research-company", "Trigger word PROBE.\n");
  let isolated;
  try {
    isolated = materializeIsolatedSkillCwd({ repoRoot, skill: "research-company" });
    assert.ok(isolated, "expected an isolated cwd path");
    const claudeSkill = join(isolated, ".claude", "skills", "research-company", "SKILL.md");
    const canonicalSkill = join(isolated, ".agents", "skills", "research-company", "SKILL.md");
    assert.ok(existsSync(claudeSkill));
    assert.ok(existsSync(canonicalSkill));
    assert.equal(readFileSync(claudeSkill, "utf8"), readFileSync(canonicalSkill, "utf8"));
    assert.equal(existsSync(join(isolated, "CLAUDE.md")), false);
  } finally {
    if (isolated) rmSync(isolated, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("materializeIsolatedSkillCwd: returns null (never throws) when the skill or repoRoot is missing", () => {
  const repoRoot = tempRepoWithOneSkill("research-company");
  try {
    assert.equal(materializeIsolatedSkillCwd({ repoRoot, skill: "not-a-real-skill" }), null);
    assert.equal(materializeIsolatedSkillCwd({ repoRoot: null, skill: "research-company" }), null);
    assert.equal(materializeIsolatedSkillCwd({ repoRoot, skill: null }), null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("buildInstalledRuntimeChildEnv retains only process/auth paths, locale, and model selectors", () => {
  const childEnv = buildInstalledRuntimeChildEnv({
    env: {
      PATH: "/usr/bin",
      HOME: "/Users/morgan",
      USER: "morgan",
      LOGNAME: "morgan",
      TMPDIR: "/private/tmp",
      LANG: "en_US.UTF-8",
      CAREERRAT_HOME: "/Users/morgan/CareerRat",
      ANTHROPIC_MODEL: "claude-sonnet",
      CLAUDE_CONFIG_DIR: "/Users/morgan/.config/claude",
      ANTHROPIC_API_KEY: "sentinel-anthropic",
      GH_TOKEN: "sentinel-github",
      AWS_SECRET_ACCESS_KEY: "sentinel-aws",
      APPLE_ID_PASSWORD: "sentinel-apple",
    },
  });
  assert.deepEqual(childEnv, {
    PATH: "/usr/bin",
    HOME: "/Users/morgan",
    USER: "morgan",
    LOGNAME: "morgan",
    TMPDIR: "/private/tmp",
    LANG: "en_US.UTF-8",
    CAREERRAT_HOME: "/Users/morgan/CareerRat",
    ANTHROPIC_MODEL: "claude-sonnet",
    CLAUDE_CONFIG_DIR: "/Users/morgan/.config/claude",
  });
});

test("runInstalledRuntime scrubs server secrets from a completion-only Claude child", async () => {
  const repoRoot = tempRepoWithOneSkill("ingest-profile");
  const env = {
    PATH: "/usr/bin",
    HOME: "/Users/morgan",
    USER: "morgan",
    LOGNAME: "morgan",
    TMPDIR: "/private/tmp",
    LANG: "en_US.UTF-8",
    CAREERRAT_HOME: join(repoRoot, "private"),
    ANTHROPIC_API_KEY: "sentinel-anthropic",
    GH_TOKEN: "sentinel-github",
    AWS_SECRET_ACCESS_KEY: "sentinel-aws",
    APPLE_ID_PASSWORD: "sentinel-apple",
  };
  const seenEnvs = [];
  try {
    await runInstalledRuntime({
      runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
      prompt: "onboard",
      skill: "ingest-profile",
      repoRoot,
      tools: ["Skill"],
      env,
      timeoutMs: 2000,
      spawnSyncImpl(_command, _args, options) {
        seenEnvs.push(options.env);
        return verifiedClaudeVersion();
      },
      spawnImpl(_command, _args, options) {
        seenEnvs.push(options.env);
        return fakeInstalledChild({
          stdout: JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
        });
      },
    });
    assert.equal(seenEnvs.length, 1);
    for (const childEnv of seenEnvs) {
      assert.equal(childEnv.HOME, "/Users/morgan");
      assert.equal(childEnv.USER, "morgan");
      assert.equal(childEnv.LOGNAME, "morgan");
      assert.equal(childEnv.PATH, "/usr/bin");
      assert.equal(childEnv.CAREERRAT_HOME, env.CAREERRAT_HOME);
      assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
      assert.equal(childEnv.GH_TOKEN, undefined);
      assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(childEnv.APPLE_ID_PASSWORD, undefined);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntime (claude + skill): spawns against the isolated skill cwd with --setting-sources project, and cleans it up after", async () => {
  const repoRoot = tempRepoWithOneSkill("research-company", "Trigger word PROBE.\n");
  const executablePath = join(repoRoot, "fake-claude");
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
process.stdin.resume();
process.stdin.on("end", () => {
  const cwd = process.cwd();
  const skillPath = join(cwd, ".claude", "skills", "research-company", "SKILL.md");
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    result: "ignored",
    structured_output: {
      cwd,
      usedSettingSources: process.argv.includes("--setting-sources"),
      usedSafeMode: process.argv.includes("--safe-mode"),
      skillVisible: existsSync(skillPath),
      skillContent: existsSync(skillPath) ? readFileSync(skillPath, "utf8") : null,
    },
  }));
});
`,
    "utf8"
  );
  chmodSync(executablePath, 0o755);
  let capturedIsolatedCwd = null;
  try {
    const result = await runInstalledRuntime({
      runtime: verifiedRuntime({ id: "claude", path: executablePath }),
      prompt: "run research-company",
      skill: "research-company",
      repoRoot,
      cwd: repoRoot, // the caller's ordinary cwd — must be overridden, not used
      tools: ["WebSearch", "WebFetch", "Skill"],
      timeoutMs: 5000,
      spawnSyncImpl: verifiedClaudeVersion,
    });
    const data = JSON.parse(result.text);
    capturedIsolatedCwd = data.cwd;
    assert.notEqual(
      data.cwd,
      repoRoot,
      "must spawn against the isolated cwd, not the caller's repoRoot"
    );
    assert.equal(data.usedSettingSources, true);
    assert.equal(data.usedSafeMode, false);
    assert.equal(data.skillVisible, true);
    assert.match(data.skillContent, /PROBE/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
  // The isolated temp cwd is app-owned and ephemeral — cleaned up once the
  // call finishes, same contract as the codex output-schema temp dir above.
  assert.ok(capturedIsolatedCwd, "fixture didn't report a cwd");
  assert.equal(existsSync(capturedIsolatedCwd), false);
});

test("runInstalledRuntime (claude exact-read skill): isolates cwd and passes only one approved upload", async () => {
  const repoRoot = tempRepoWithOneSkill("resume-extract", "Trigger word PROBE.\n");
  const uploadDir = join(repoRoot, "workspace", "intake", "resume-uploads");
  const upload = join(uploadDir, "resume.pdf");
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(upload, "resume", "utf8");
  const executablePath = join(repoRoot, "fake-claude-read");
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    result: "ignored",
    structured_output: {
      cwd: process.cwd(),
      usedSafeMode: process.argv.includes("--safe-mode"),
      usedSettingSources: process.argv.includes("--setting-sources"),
      settings: JSON.parse(process.argv[process.argv.indexOf("--settings") + 1]),
    },
  }));
});
`,
    "utf8"
  );
  chmodSync(executablePath, 0o755);
  try {
    const result = await runInstalledRuntime({
      runtime: verifiedRuntime({ id: "claude", path: executablePath }),
      prompt: "run resume-extract",
      skill: "resume-extract",
      repoRoot,
      cwd: repoRoot,
      tools: ["Read", "Skill"],
      approvedReadPaths: [upload],
      timeoutMs: 5000,
      spawnSyncImpl: verifiedClaudeVersion,
    });
    const data = JSON.parse(result.text);
    assert.notEqual(data.cwd, realpathSync(repoRoot));
    assert.equal(data.usedSafeMode, false);
    assert.equal(data.usedSettingSources, true);
    assert.deepEqual(
      new Set(data.settings.sandbox.filesystem.allowRead),
      new Set([realpathSync(upload), data.cwd])
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntime rejects broad Glob/Grep tools before spawning Claude", async () => {
  const repoRoot = tempRepoWithOneSkill("evaluate-job", "Trigger word PROBE.\n");
  let spawned = false;
  try {
    await assert.rejects(
      runInstalledRuntime({
        runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
        prompt: "run evaluate-job",
        skill: "evaluate-job",
        repoRoot,
        cwd: repoRoot,
        tools: ["Glob", "Grep", "Skill"],
        spawnSyncImpl: verifiedClaudeVersion,
        spawnImpl() {
          spawned = true;
          return fakeInstalledChild();
        },
      }),
      { code: "RUNTIME_READ_BOUNDARY_INVALID" }
    );
    assert.equal(spawned, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntime (claude, no skill): uses an ephemeral completion cwd", async () => {
  const root = tempRoot();
  const executablePath = join(root, "fake-claude-plain");
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    result: "ignored",
    structured_output: { cwd: process.cwd(), usedSafeMode: process.argv.includes("--safe-mode") },
  }));
});
`,
    "utf8"
  );
  chmodSync(executablePath, 0o755);
  try {
    const result = await runInstalledRuntime({
      runtime: verifiedRuntime({ id: "claude", path: executablePath }),
      prompt: "no skill given",
      cwd: root,
      timeoutMs: 5000,
    });
    const data = JSON.parse(result.text);
    // macOS resolves the tmp dir's /var symlink to /private/var inside the
    // child (process.cwd() reports the real path) — compare realpaths rather
    // than the raw strings so this isn't platform-flaky.
    assert.notEqual(data.cwd, realpathSync(root));
    assert.match(data.cwd, /careerrat-task-cwd-/);
    assert.equal(existsSync(data.cwd), false);
    assert.equal(data.usedSafeMode, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Chat-tool-profile boundary — RUNTIME_TOOL_PROFILE_UNSUPPORTED.
//
// Codex `exec` (and every other non-claude installed runtime) has no
// tool-allowlist mechanism at all: `--sandbox read-only` scopes shell writes
// and network, it does not remove the shell tool or restrict what gets read.
// CHAT_RUNTIME_TOOLS (runtime-tools.mjs) is a deliberate structural
// prompt-injection boundary — WebSearch/WebFetch/Skill, never Read — that
// only the "claude" runtime's `--tools`/`--allowedTools` flags can actually
// enforce. runInstalledRuntime must fail closed BEFORE spawning whenever a
// non-claude runtime is asked to run that restricted profile, and must never
// affect the app-safe one-shot profile those same runtimes already run for
// evaluate-job/tailor-application/resume-extract.
// ---------------------------------------------------------------------------

test("runInstalledRuntime maps Codex public-web work to supported search and MCP config", async () => {
  const repoRoot = tempRepoWithOneSkill("research-company");
  const calls = [];
  try {
    const result = await runInstalledRuntime({
      runtime: verifiedRuntime({ id: "codex", path: "/safe/codex" }),
      prompt: "research this company",
      skill: "research-company",
      repoRoot,
      cwd: repoRoot,
      tools: ["WebSearch", "WebFetch", "Skill"],
      spawnImpl(command, args, options) {
        calls.push({ command, args, options });
        return fakeInstalledChild({
          stdout: ndjson([
            {
              type: "item.completed",
              item: { type: "agent_message", text: "research complete" },
            },
            { type: "turn.completed", usage: { input_tokens: 8, output_tokens: 2 } },
          ]),
        });
      },
    });
    assert.equal(result.text, "research complete");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.includes("--search"), false);
    assert.ok(calls[0].args.includes('web_search="live"'));
    assert.ok(calls[0].args.includes("mcp_servers.careerrat_scoped_tools.required=true"));
    assert.equal(calls[0].options.shell, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntime fails closed for a runtime without a verified adapter", async () => {
  let spawnCalls = 0;
  await assert.rejects(
    runInstalledRuntime({
      runtime: { id: "qwen", path: "/safe/qwen" },
      prompt: "research this company",
      tools: ["WebSearch", "WebFetch", "Skill"],
      spawnImpl: () => {
        spawnCalls++;
        throw new Error("spawn must never be reached for an unsupported chat tool profile");
      },
    }),
    (error) => error.code === "RUNTIME_COMPLETION_UNSUPPORTED" && error.runtimeId === "qwen"
  );
  assert.equal(spawnCalls, 0, "the spawn was invoked despite the guard");
});

test("runInstalledRuntime preserves a probe downgrade and rejects web work before execution", async () => {
  let called = false;
  await assert.rejects(
    runInstalledRuntime({
      runtime: {
        id: "hermes",
        name: "Hermes",
        path: "/safe/hermes",
        capabilities: {
          ...VERIFIED_CAPABILITIES,
          publicWeb: false,
        },
      },
      prompt: "research",
      cwd: "/safe/task",
      tools: ["WebSearch"],
      runAcpRuntimeImpl: async () => {
        called = true;
        return { text: "should not run" };
      },
    }),
    (error) => error.code === RUNTIME_TOOL_PROFILE_UNSUPPORTED && error.capability === "publicWeb"
  );
  assert.equal(called, false);
});

test("runInstalledRuntime: claude + the same restricted chat tool profile is unaffected, and still builds --tools/--allowedTools", async () => {
  const spawnCalls = [];
  const repoRoot = tempRepoWithOneSkill("research-company");
  try {
    const result = await runInstalledRuntime({
      runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
      prompt: "research this company",
      skill: "research-company",
      repoRoot,
      tools: ["WebSearch", "WebFetch", "Skill"],
      timeoutMs: 2000,
      spawnSyncImpl: verifiedClaudeVersion,
      spawnImpl: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return fakeInstalledChild({
          stdout: JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
        });
      },
    });
    assert.equal(spawnCalls.length, 1, "claude must still spawn for the chat tool profile");
    const args = spawnCalls[0].args;
    const toolsIdx = args.indexOf("--tools");
    assert.ok(toolsIdx >= 0, "expected --tools in argv");
    assert.equal(args[toolsIdx + 1], "WebSearch");
    const allowed = args[args.indexOf("--allowedTools") + 1];
    assert.match(allowed, /WebSearch/);
    assert.doesNotMatch(allowed, /Skill\(research-company\)/);
    assert.match(allowed, /mcp__careerrat_scoped_tools__fetch/);
    assert.doesNotMatch(allowed, /WebFetch/);
    assert.equal(result.text, "ok");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntime stages one approved upload for Codex exact-read work", async () => {
  const repoRoot = tempRepoWithOneSkill("resume-extract");
  const uploadDir = join(repoRoot, "workspace", "intake", "resume-uploads");
  const upload = join(uploadDir, "resume.pdf");
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(upload, "resume evidence", "utf8");
  const calls = [];
  let writtenPrompt = "";
  try {
    const result = await runInstalledRuntime({
      runtime: verifiedRuntime({ id: "codex", path: "/safe/codex" }),
      prompt: "extract this resume",
      skill: "resume-extract",
      repoRoot,
      tools: ["Read", "Skill"],
      approvedReadPaths: [upload],
      spawnImpl(command, args, options) {
        const stagedUpload = join(options.cwd, "input", "resume.pdf");
        calls.push({ command, args, options, stagedUpload, staged: existsSync(stagedUpload) });
        const child = fakeInstalledChild();
        child.stdin.end = (value) => {
          writtenPrompt = String(value);
          queueMicrotask(() => {
            child.stdout.emit(
              "data",
              Buffer.from(
                ndjson([
                  {
                    type: "item.completed",
                    item: { type: "agent_message", text: "resume extracted" },
                  },
                  { type: "turn.completed" },
                ])
              )
            );
            child.emit("close", 0, null);
          });
        };
        return child;
      },
    });
    assert.equal(result.text, "resume extracted");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].staged, true);
    assert.match(writtenPrompt, /read_staged_input/);
    assert.doesNotMatch(writtenPrompt, /input[/\\]resume\.pdf/);
    assert.equal(calls[0].args.includes("--sandbox"), true);
    assert.equal(calls[0].args.includes("read-only"), true);
    for (const feature of ["shell_tool", "unified_exec", "view_image"]) {
      assert.ok(
        calls[0].args.some(
          (arg, index, args) => arg === "--disable" && args[index + 1] === feature
        ),
        `Codex exact read must not re-enable ${feature}`
      );
    }
    const overrides = calls[0].args.flatMap((arg, index, args) =>
      arg === "-c" ? [args[index + 1]] : []
    );
    assert.ok(
      overrides.some((value) => value?.startsWith("mcp_servers.careerrat_scoped_tools.command=")),
      "Codex exact read must use the scoped CareerRat MCP server"
    );
    assert.ok(
      overrides.includes('mcp_servers.careerrat_scoped_tools.enabled_tools=["read_staged_input"]')
    );
    assert.equal(overrides.includes('web_search="live"'), false);
    assert.equal(
      overrides.some((value) => value?.includes("--allow-public-web")),
      false
    );
    assert.equal(existsSync(calls[0].options.cwd), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntime treats Skill-only Codex work as an isolated completion", async () => {
  const repoRoot = tempRepoWithOneSkill(
    "answer-question",
    "Answer only from the supplied evidence. Marker: CAREERRAT_SKILL_CONTEXT.\n"
  );
  const calls = [];
  let writtenPrompt = "";
  let isolatedAtSpawn = false;
  let spawnedCwd = null;
  try {
    const result = await runInstalledRuntime({
      runtime: verifiedRuntime({ id: "codex", name: "Codex", path: "/safe/codex" }),
      prompt: "Draft the answer.",
      skill: "answer-question",
      repoRoot,
      cwd: repoRoot,
      tools: ["Skill"],
      spawnImpl(command, args, options) {
        calls.push({ command, args, options });
        spawnedCwd = options.cwd;
        isolatedAtSpawn = realpathSync(options.cwd) !== realpathSync(repoRoot);
        const child = fakeInstalledChild();
        child.stdin.end = (value) => {
          writtenPrompt = String(value);
          queueMicrotask(() => {
            child.stdout.emit(
              "data",
              Buffer.from(
                ndjson([
                  {
                    type: "item.completed",
                    item: { type: "agent_message", text: "bounded answer" },
                  },
                  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
                ])
              )
            );
            child.emit("close", 0, null);
          });
        };
        return child;
      },
    });
    assert.equal(result.text, "bounded answer");
    assert.equal(calls.length, 1);
    assert.equal(isolatedAtSpawn, true);
    assert.equal(existsSync(spawnedCwd), false);
    assert.equal(calls[0].args.includes("--ignore-user-config"), true);
    assert.match(writtenPrompt, /CAREERRAT_SKILL_CONTEXT/);
    assert.match(writtenPrompt, /Draft the answer\./);
    assert.equal(writtenPrompt.includes(repoRoot), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntime rejects an unverified completion adapter before spawn", async () => {
  let spawned = false;
  await assert.rejects(
    runInstalledRuntime({
      runtime: { id: "qwen", name: "Qwen Code", path: "/safe/qwen" },
      prompt: "Draft an answer.",
      tools: [],
      spawnImpl() {
        spawned = true;
        return fakeInstalledChild();
      },
    }),
    { code: "RUNTIME_COMPLETION_UNSUPPORTED" }
  );
  assert.equal(spawned, false);
});

// ---------------------------------------------------------------------------
// runInstalledRuntimeStream — the streaming sibling used by chat-runtime.mjs's
// runInstalledTurn so an installed "claude" chat turn surfaces real-time
// tool_use/tool_result activity instead of going dark until process exit (the
// bug: startInstalledSession never called loadSdk, so this route's chat had
// no streaming envelope at all). Fixture NDJSON in, one onMessage call per
// parsed line, hermetic — no real CLI spawned.
// ---------------------------------------------------------------------------

test("supportsInstalledRuntimeStreaming follows each adapter's live-activity capability", () => {
  const liveRuntimes = ["claude", "codex", "hermes", "gemini", "opencode", "copilot"];
  for (const id of liveRuntimes) assert.equal(supportsInstalledRuntimeStreaming(id), true, id);
  for (const { id } of INSTALLED_RUNTIME_DEFINITIONS) {
    if (liveRuntimes.includes(id)) continue;
    assert.equal(supportsInstalledRuntimeStreaming(id), false, `${id} must not support streaming`);
  }
  assert.equal(supportsInstalledRuntimeStreaming("not-a-real-runtime"), false);
});

test("runInstalledRuntimeStream routes ACP tool activity through the shared stream contract", async () => {
  const repoRoot = tempRepoWithOneSkill("research-company");
  const received = [];
  let call;
  try {
    const result = await runInstalledRuntimeStream({
      runtime: verifiedRuntime({ id: "opencode", path: "/safe/opencode", name: "OpenCode" }),
      prompt: "research CareerRat",
      skill: "research-company",
      repoRoot,
      tools: ["WebSearch", "WebFetch", "Skill"],
      onMessage: (message) => received.push(message),
      runAcpRuntimeImpl: async (options) => {
        call = options;
        options.onMessage({
          type: "assistant",
          session_id: "acp-2",
          message: {
            content: [
              {
                type: "tool_use",
                id: "search-1",
                name: "WebSearch",
                input: { query: "CareerRat" },
              },
            ],
          },
        });
        return {
          text: "Research complete",
          usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
          model: null,
          sessionId: "acp-2",
          runtimeId: "opencode",
        };
      },
    });
    assert.equal(result.text, "Research complete");
    assert.deepEqual(call.tools, ["WebSearch", "WebFetch"]);
    assert.notEqual(call.cwd, repoRoot);
    assert.equal(received[0].message.content[0].name, "WebSearch");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("buildInstalledRuntimeInvocation: streaming:true swaps --output-format json for stream-json --verbose on claude only", () => {
  const streaming = buildInstalledRuntimeInvocation({
    runtimeId: "claude",
    executablePath: "/safe/claude",
    streaming: true,
  });
  const formatIdx = streaming.args.indexOf("--output-format");
  assert.ok(formatIdx >= 0);
  assert.equal(streaming.args[formatIdx + 1], "stream-json");
  assert.ok(streaming.args.includes("--verbose"), "stream-json requires --verbose in print mode");

  const nonStreaming = buildInstalledRuntimeInvocation({
    runtimeId: "claude",
    executablePath: "/safe/claude",
  });
  const nonStreamingFormatIdx = nonStreaming.args.indexOf("--output-format");
  assert.equal(nonStreaming.args[nonStreamingFormatIdx + 1], "json");
  assert.equal(nonStreaming.args.includes("--verbose"), false);
});

test("runInstalledRuntimeStream normalizes Codex activity and resolves its terminal turn", async () => {
  const received = [];
  const calls = [];
  const result = await runInstalledRuntimeStream({
    runtime: verifiedRuntime({ id: "codex", path: "/safe/codex", name: "Codex" }),
    prompt: "research CareerRat",
    tools: ["WebSearch", "WebFetch", "Skill"],
    onMessage: (message) => received.push(message),
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return fakeStreamingChild({
        chunks: [
          ndjson([
            { type: "thread.started", thread_id: "thread-1" },
            { type: "turn.started" },
            {
              type: "item.started",
              item: { id: "search-1", type: "web_search", query: "CareerRat" },
            },
            {
              type: "item.completed",
              item: {
                id: "search-1",
                type: "web_search",
                query: "CareerRat",
                status: "completed",
              },
            },
            {
              type: "item.completed",
              item: { id: "message-1", type: "agent_message", text: "Research complete" },
            },
            {
              type: "turn.completed",
              usage: { input_tokens: 12, output_tokens: 3 },
            },
          ]),
        ],
      });
    },
  });

  assert.equal(result.text, "Research complete");
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 3 });
  assert.equal(result.sessionId, "thread-1");
  assert.equal(result.runtimeId, "codex");
  assert.equal(calls[0].args.includes("--search"), false);
  assert.ok(calls[0].args.includes('web_search="live"'));
  assert.ok(calls[0].args.includes("mcp_servers.careerrat_scoped_tools.required=true"));
  assert.deepEqual(received, [
    {
      type: "assistant",
      session_id: "thread-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "search-1",
            name: "WebSearch",
            input: { query: "CareerRat" },
          },
        ],
      },
    },
    {
      type: "user",
      session_id: "thread-1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "search-1",
            content: "Search completed for CareerRat",
            is_error: false,
          },
        ],
      },
    },
  ]);
});

test("runInstalledRuntimeStream normalizes Codex CareerRat fetch activity", async () => {
  const received = [];
  const result = await runInstalledRuntimeStream({
    runtime: verifiedRuntime({ id: "codex", path: "/safe/codex", name: "Codex" }),
    prompt: "fetch CareerRat",
    tools: ["WebFetch"],
    onMessage: (message) => received.push(message),
    spawnImpl() {
      return fakeStreamingChild({
        chunks: [
          ndjson([
            { type: "thread.started", thread_id: "thread-fetch" },
            {
              type: "item.started",
              item: {
                id: "fetch-1",
                type: "mcp_tool_call",
                server: "careerrat_scoped_tools",
                tool: "fetch",
                arguments: { url: "https://example.com/job" },
                result: null,
                error: null,
                status: "in_progress",
              },
            },
            {
              type: "item.completed",
              item: {
                id: "fetch-1",
                type: "mcp_tool_call",
                server: "careerrat_scoped_tools",
                tool: "fetch",
                arguments: { url: "https://example.com/job" },
                result: { content: [{ type: "text", text: "large page body omitted" }] },
                error: null,
                status: "completed",
              },
            },
            {
              type: "item.completed",
              item: { id: "message-1", type: "agent_message", text: "Fetched" },
            },
            { type: "turn.completed" },
          ]),
        ],
      });
    },
  });

  assert.equal(result.text, "Fetched");
  assert.deepEqual(received, [
    {
      type: "assistant",
      session_id: "thread-fetch",
      message: {
        content: [
          {
            type: "tool_use",
            id: "fetch-1",
            name: "WebFetch",
            input: { url: "https://example.com/job" },
          },
        ],
      },
    },
    {
      type: "user",
      session_id: "thread-fetch",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "fetch-1",
            content: "Fetched https://example.com/job",
            is_error: false,
          },
        ],
      },
    },
  ]);
});

test("runInstalledRuntimeStream gives Codex only the selected CareerRat skill workspace", async () => {
  const repoRoot = tempRepoWithOneSkill("research-company", "Marker: CODEX_SKILL_SCOPE.\n");
  let spawnedCwd = null;
  let spawnedCanonical = null;
  let skillVisible = false;
  let receivedPrompt = null;
  try {
    const result = await runInstalledRuntimeStream({
      runtime: verifiedRuntime({ id: "codex", path: "/safe/codex", name: "Codex" }),
      prompt: "research CareerRat",
      skill: "research-company",
      repoRoot,
      cwd: repoRoot,
      tools: ["WebSearch", "WebFetch", "Skill"],
      spawnImpl(_command, _args, options) {
        spawnedCwd = options.cwd;
        spawnedCanonical = realpathSync(options.cwd);
        skillVisible = existsSync(
          join(options.cwd, ".agents", "skills", "research-company", "SKILL.md")
        );
        const child = fakeStreamingChild({
          chunks: [
            ndjson([
              { type: "thread.started", thread_id: "thread-scope" },
              {
                type: "item.completed",
                item: { id: "message-1", type: "agent_message", text: "Scoped" },
              },
              { type: "turn.completed" },
            ]),
          ],
        });
        const end = child.stdin.end;
        child.stdin.end = (value) => {
          receivedPrompt = String(value || "");
          end.call(child.stdin, value);
        };
        return child;
      },
    });
    assert.equal(result.text, "Scoped");
    assert.notEqual(spawnedCanonical, realpathSync(repoRoot));
    assert.equal(skillVisible, true);
    assert.match(receivedPrompt, /CODEX_SKILL_SCOPE/);
  } finally {
    assert.equal(spawnedCwd ? existsSync(spawnedCwd) : null, false);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntimeStream tells Codex to use its staged-read tool", async () => {
  const repoRoot = tempRepoWithOneSkill("resume-extract", "Marker: CODEX_READ_SCOPE.\n");
  const uploadDir = join(repoRoot, "workspace", "intake", "resume-uploads");
  const upload = join(uploadDir, "resume.pdf");
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(upload, "resume", "utf8");
  let receivedPrompt = null;
  try {
    const result = await runInstalledRuntimeStream({
      runtime: verifiedRuntime({ id: "codex", path: "/safe/codex", name: "Codex" }),
      prompt: "extract this resume",
      skill: "resume-extract",
      repoRoot,
      cwd: repoRoot,
      tools: ["Read", "Skill"],
      approvedReadPaths: [upload],
      spawnImpl() {
        const child = fakeStreamingChild({
          chunks: [
            ndjson([
              { type: "thread.started", thread_id: "thread-read" },
              {
                type: "item.completed",
                item: { id: "message-1", type: "agent_message", text: "Read" },
              },
              { type: "turn.completed" },
            ]),
          ],
        });
        const end = child.stdin.end;
        child.stdin.end = (value) => {
          receivedPrompt = String(value || "");
          end.call(child.stdin, value);
        };
        return child;
      },
    });
    assert.equal(result.text, "Read");
    assert.match(receivedPrompt, /CODEX_READ_SCOPE/);
    assert.match(receivedPrompt, /read_staged_input/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntimeStream re-verifies Claude's boundary version before a chat spawn", async () => {
  const repoRoot = tempRepoWithOneSkill("research-company");
  let spawned = false;
  try {
    await assert.rejects(
      runInstalledRuntimeStream({
        runtime: verifiedRuntime({ id: "claude", name: "Claude Code", path: "/safe/claude" }),
        prompt: "research",
        skill: "research-company",
        repoRoot,
        tools: ["WebSearch", "WebFetch", "Skill"],
        spawnSyncImpl: () => ({ status: 0, stdout: "2.1.200 (Claude Code)", stderr: "" }),
        spawnImpl() {
          spawned = true;
          return fakeStreamingChild();
        },
      }),
      { code: RUNTIME_TOOL_PROFILE_UNSUPPORTED }
    );
    assert.equal(spawned, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntimeStream: a text-only turn calls onMessage once per NDJSON line, in order, and resolves the terminal result's text/usage/model/sessionId", async () => {
  const lines = [
    { type: "system", subtype: "init", session_id: "sess-1" },
    {
      type: "assistant",
      session_id: "sess-1",
      message: { content: [{ type: "text", text: "Hello there" }] },
    },
    {
      type: "result",
      subtype: "success",
      result: "Hello there",
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet",
      session_id: "sess-1",
    },
  ];
  const received = [];
  const result = await runInstalledRuntimeStream({
    runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
    prompt: "hi",
    timeoutMs: 2000,
    onMessage: (message) => received.push(message),
    spawnImpl: () => fakeStreamingChild({ chunks: [ndjson(lines)] }),
  });
  assert.deepEqual(received, lines);
  assert.equal(result.text, "Hello there");
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal(result.model, "claude-sonnet");
  assert.equal(result.sessionId, "sess-1");
  assert.equal(result.runtimeId, "claude");
});

test("runInstalledRuntimeStream scrubs server secrets while retaining HOME-based CLI auth", async () => {
  const repoRoot = tempRepoWithOneSkill("ingest-profile");
  const env = {
    PATH: "/usr/bin",
    HOME: "/Users/morgan",
    TEMP: "/tmp",
    CAREERRAT_HOME: join(repoRoot, "private"),
    ANTHROPIC_API_KEY: "sentinel-anthropic",
    GITHUB_TOKEN: "sentinel-github",
    NPM_TOKEN: "sentinel-npm",
    APPLE_ID_PASSWORD: "sentinel-apple",
  };
  const seenEnvs = [];
  const terminal = {
    type: "result",
    subtype: "success",
    result: "ok",
    session_id: "sess-safe-env",
  };
  try {
    await runInstalledRuntimeStream({
      runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
      prompt: "onboard",
      skill: "ingest-profile",
      repoRoot,
      tools: ["Skill"],
      env,
      timeoutMs: 2000,
      spawnSyncImpl(_command, _args, options) {
        seenEnvs.push(options.env);
        return verifiedClaudeVersion();
      },
      spawnImpl(_command, _args, options) {
        seenEnvs.push(options.env);
        return fakeStreamingChild({ chunks: [ndjson([terminal])] });
      },
    });
    assert.equal(seenEnvs.length, 2);
    for (const childEnv of seenEnvs) {
      assert.equal(childEnv.HOME, "/Users/morgan");
      assert.equal(childEnv.PATH, "/usr/bin");
      assert.equal(childEnv.CAREERRAT_HOME, env.CAREERRAT_HOME);
      assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
      assert.equal(childEnv.GITHUB_TOKEN, undefined);
      assert.equal(childEnv.NPM_TOKEN, undefined);
      assert.equal(childEnv.APPLE_ID_PASSWORD, undefined);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntimeStream: a turn with two tool calls (one isError result) streams every message, mappable via mapSdkMessage into the same tool_use/tool_result frames the SDK path produces", async () => {
  const lines = [
    { type: "system", subtype: "init", session_id: "sess-2" },
    {
      type: "assistant",
      session_id: "sess-2",
      message: { content: [{ type: "tool_use", id: "tu1", name: "WebSearch", input: { q: "x" } }] },
    },
    {
      type: "user",
      session_id: "sess-2",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "result1", is_error: false }],
      },
    },
    {
      type: "assistant",
      session_id: "sess-2",
      message: {
        content: [{ type: "tool_use", id: "tu2", name: "WebFetch", input: { url: "y" } }],
      },
    },
    {
      type: "user",
      session_id: "sess-2",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu2", content: "boom", is_error: true }],
      },
    },
    {
      type: "assistant",
      session_id: "sess-2",
      message: { content: [{ type: "text", text: "Done" }] },
    },
    {
      type: "result",
      subtype: "success",
      result: "Done",
      usage: { input_tokens: 20, output_tokens: 8 },
      session_id: "sess-2",
    },
  ];
  const received = [];
  const result = await runInstalledRuntimeStream({
    runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
    prompt: "research this",
    timeoutMs: 2000,
    onMessage: (message) => received.push(message),
    spawnImpl: () => fakeStreamingChild({ chunks: [ndjson(lines)] }),
  });
  assert.equal(received.length, lines.length);

  const { mapSdkMessage } = await import("../src/core/ai/skill-runtime.mjs");
  const frames = received.flatMap((message) => mapSdkMessage(message, { env: {} }));
  const toolFrames = frames.filter((f) => f.type === "tool_use" || f.type === "tool_result");
  assert.deepEqual(
    toolFrames.map((f) => f.type),
    ["tool_use", "tool_result", "tool_use", "tool_result"]
  );
  assert.equal(toolFrames[0].data.id, "tu1");
  assert.equal(toolFrames[0].data.name, "WebSearch");
  assert.equal(toolFrames[1].data.toolUseId, "tu1");
  assert.equal(toolFrames[1].data.isError, false);
  assert.equal(toolFrames[2].data.id, "tu2");
  assert.equal(toolFrames[3].data.toolUseId, "tu2");
  assert.equal(toolFrames[3].data.isError, true);
  assert.equal(result.text, "Done");
});

test("runInstalledRuntimeStream buffers a JSON object split across two stdout chunks into exactly one onMessage call", async () => {
  const resultLine = {
    type: "result",
    subtype: "success",
    result: "reassembled",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const whole = `${JSON.stringify({ type: "system", subtype: "init" })}\n${JSON.stringify(resultLine)}\n`;
  // Split mid-object: right after the opening of the result line's JSON.
  const splitPoint = whole.indexOf('"type":"result"') + 5;
  const chunks = [whole.slice(0, splitPoint), whole.slice(splitPoint)];
  const received = [];
  const result = await runInstalledRuntimeStream({
    runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
    prompt: "hi",
    timeoutMs: 2000,
    onMessage: (message) => received.push(message),
    spawnImpl: () => fakeStreamingChild({ chunks }),
  });
  assert.equal(received.length, 2);
  assert.deepEqual(received[1], resultLine);
  assert.equal(result.text, "reassembled");
});

test("runInstalledRuntimeStream skips a malformed line mid-stream without crashing the turn", async () => {
  const goodFirst = { type: "system", subtype: "init" };
  const goodResult = { type: "result", subtype: "success", result: "survived" };
  const chunks = [
    `${JSON.stringify(goodFirst)}\n`,
    "{not valid json at all\n",
    `${JSON.stringify(goodResult)}\n`,
  ];
  const received = [];
  const result = await runInstalledRuntimeStream({
    runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
    prompt: "hi",
    timeoutMs: 2000,
    onMessage: (message) => received.push(message),
    spawnImpl: () => fakeStreamingChild({ chunks }),
  });
  assert.deepEqual(received, [goodFirst, goodResult]);
  assert.equal(result.text, "survived");
});

test("runInstalledRuntimeStream rejects with RUNTIME_EXIT on a nonzero exit, same shape as runInstalledRuntime", async () => {
  await assert.rejects(
    runInstalledRuntimeStream({
      runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
      prompt: "hi",
      timeoutMs: 2000,
      spawnImpl: () =>
        fakeStreamingChild({
          chunks: [`${JSON.stringify({ type: "system", subtype: "init" })}\n`],
          status: 7,
          stderr: "sign in required",
        }),
    }),
    (error) =>
      error.code === "RUNTIME_EXIT" &&
      error.exitStatus === 7 &&
      /sign in required/.test(error.message)
  );
});

test("runInstalledRuntimeStream rejects with RUNTIME_RESULT_MISSING when the process exits 0 with no terminal result line", async () => {
  await assert.rejects(
    runInstalledRuntimeStream({
      runtime: verifiedRuntime({ id: "claude", path: "/safe/claude" }),
      prompt: "hi",
      timeoutMs: 2000,
      spawnImpl: () =>
        fakeStreamingChild({
          chunks: [`${JSON.stringify({ type: "system", subtype: "init" })}\n`],
        }),
    }),
    (error) => error.code === "RUNTIME_RESULT_MISSING"
  );
});
